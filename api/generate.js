// ─── IP-Based Rate Limiting ───
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 3; // per IP per month (generous for shared IPs)

function getRateLimitKey(ip) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `${ip}:${month}`;
}

function cleanOldEntries() {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  for (const [k] of rateLimitMap) {
    if (!k.endsWith(currentMonth)) rateLimitMap.delete(k);
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

  // Rate limit by IP
  const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').split(',')[0].trim();
  const key = getRateLimitKey(ip);
  cleanOldEntries();
  const count = rateLimitMap.get(key) || 0;

  if (count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Monthly limit reached. Please try again next month or upgrade for unlimited generations.' });
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
