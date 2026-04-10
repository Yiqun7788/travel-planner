const { createClient } = require('@supabase/supabase-js');

// ─── IP-Based Rate Limiting ───
const rateLimitMap = new Map();
const TIER_RATE_LIMITS = {
  free: { max: 3, period: 'month' },
  paid: { max: 15, period: 'day' },
};

function getRateLimitKey(id, tier) {
  const now = new Date();
  const limits = TIER_RATE_LIMITS[tier] || TIER_RATE_LIMITS.free;
  if (limits.period === 'day') {
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return `${id}:${tier}:${day}`;
  }
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `${id}:${tier}:${month}`;
}

function cleanOldEntries() {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const currentDay = `${currentMonth}-${String(now.getDate()).padStart(2, '0')}`;
  for (const [k] of rateLimitMap) {
    // Keep entries that end with current day or current month
    if (!k.endsWith(currentDay) && !k.endsWith(currentMonth)) rateLimitMap.delete(k);
  }
}

const ALLOWED_ORIGINS = [
  'https://travel-planner-livid-two.vercel.app',
  'http://localhost',
  'http://127.0.0.1'
];

// Validate JWT and get user profile if token present
async function getAuthenticatedUser(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace('Bearer ', '');
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;

    // Fetch profile for authoritative credits
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('credits, free_tier_state')
      .eq('id', data.user.id)
      .single();

    return { userId: data.user.id, profile };
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Block requests not originating from the app
  const origin = req.headers['origin'] || '';
  const referer = req.headers['referer'] || '';
  const isAllowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o));
  if (!isAllowed) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  const API_KEY = process.env.GEMINI_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  // Authenticate user if JWT present — determines authoritative tier
  const authUser = await getAuthenticatedUser(req.headers['authorization']);
  let tier;
  let rateLimitId;

  if (authUser && authUser.profile) {
    // Server-authoritative tier based on actual credits in DB
    tier = (authUser.profile.credits || 0) > 0 ? 'paid' : 'free';
    rateLimitId = authUser.userId;
  } else {
    // Anonymous fallback: IP + client-provided tier
    const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').split(',')[0].trim();
    tier = req.body?.tier === 'paid' ? 'paid' : 'free';
    rateLimitId = ip;
  }

  const tierLimits = TIER_RATE_LIMITS[tier];
  const key = getRateLimitKey(rateLimitId, tier);
  cleanOldEntries();
  const count = rateLimitMap.get(key) || 0;

  if (count >= tierLimits.max) {
    const periodLabel = tierLimits.period === 'day' ? 'daily' : 'monthly';
    return res.status(429).json({ error: `${periodLabel.charAt(0).toUpperCase() + periodLabel.slice(1)} limit reached. Please try again later or upgrade for more generations.` });
  }

  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    // Try multiple models with retry on 503 (model overloaded).
    // gemini-2.5-flash has been experiencing frequent UNAVAILABLE errors,
    // so we fall back to gemini-2.0-flash and then gemini-flash-latest.
    const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    let response;
    let lastErrorData;
    let lastStatus;
    let succeeded = false;

    // Constrained to stay within Vercel's ~10s serverless timeout.
    // Fast-fail 503s burn ~300-700ms each; a successful generation takes ~3-6s.
    outer: for (const model of MODELS) {
      // Retry each model up to 2 times on transient errors
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }]
            })
          }
        );

        if (response.ok) { succeeded = true; break outer; }

        lastStatus = response.status;
        try { lastErrorData = await response.json(); } catch { lastErrorData = {}; }

        // Only retry/fall-back on transient errors (503 UNAVAILABLE, 500, 504)
        if (lastStatus !== 503 && lastStatus !== 500 && lastStatus !== 504) break outer;

        // Small delay before retrying same model
        if (attempt === 0) await sleep(400);
      }
    }

    if (!succeeded) {
      if (lastStatus === 429) {
        return res.status(429).json({ error: 'API quota exceeded. Please try again later.' });
      }
      return res.status(lastStatus || 500).json({ error: `Gemini API error: ${JSON.stringify(lastErrorData)}` });
    }

    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts || [];

    // Gemini 2.5 Flash returns thinking parts (thought: true) before the actual content.
    // Skip thinking parts and extract only the real output.
    const contentParts = parts.filter(p => !p.thought);
    const text = contentParts.map(p => p.text || '').join('') || parts.map(p => p.text || '').join('');

    if (!text) {
      return res.status(500).json({ error: 'No text in Gemini response.' });
    }

    // Increment rate limit counter after successful generation
    rateLimitMap.set(key, count + 1);

    return res.status(200).json({ text });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};
