// ─── IP-Based Rate Limiting ───
const rateLimitMap = new Map();
const TIER_RATE_LIMITS = {
  free:  { max: 3, period: 'month' },
  basic: { max: 10, period: 'day' },
  prime: { max: 100, period: 'day' },
};

function getRateLimitKey(ip, tier) {
  const now = new Date();
  const limits = TIER_RATE_LIMITS[tier] || TIER_RATE_LIMITS.free;
  if (limits.period === 'day') {
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return `${ip}:${tier}:${day}`;
  }
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `${ip}:${tier}:${month}`;
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

  // Rate limit by IP + tier
  const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').split(',')[0].trim();
  const tier = (['free', 'basic', 'prime'].includes(req.body?.tier)) ? req.body.tier : 'free';
  const tierLimits = TIER_RATE_LIMITS[tier];
  const key = getRateLimitKey(ip, tier);
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

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      const status = response.status;

      if (status === 429) {
        return res.status(429).json({ error: 'API quota exceeded. Please try again later.' });
      }

      return res.status(status).json({ error: `Gemini API error: ${JSON.stringify(errorData)}` });
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
