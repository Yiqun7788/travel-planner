const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const ALLOWED_ORIGINS = [
  'https://travel-planner-livid-two.vercel.app',
  'http://localhost',
  'http://127.0.0.1'
];

function isVercelPreview(url) {
  return /^https:\/\/travel-planner[a-z0-9-]*\.vercel\.app/i.test(url);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const origin = req.headers['origin'] || '';
  const referer = req.headers['referer'] || '';
  const isAllowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o))
    || isVercelPreview(origin) || isVercelPreview(referer);
  if (!isAllowed) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  const { STRIPE_SECRET_KEY } = process.env;

  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe is not configured on the server.' });
  }

  const { sessionId } = req.body || {};

  if (!sessionId || !sessionId.startsWith('cs_')) {
    return res.status(400).json({ error: 'Invalid session ID.' });
  }

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === 'paid') {
      const credits = parseInt(session.metadata?.credits, 10) || 0;

      // If userId in metadata, add credits server-side to prevent manipulation
      const userId = session.metadata?.userId;
      if (userId && credits > 0) {
        const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
        if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
          try {
            const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

            // Check if this session was already credited to prevent replay
            const { data: profile } = await supabase
              .from('user_profiles')
              .select('credits, verified_sessions')
              .eq('id', userId)
              .single();

            if (profile) {
              const alreadyVerified = (profile.verified_sessions || []).includes(sessionId);
              if (!alreadyVerified) {
                const newCredits = (profile.credits || 0) + credits;
                const newSessions = [...(profile.verified_sessions || []), sessionId];
                await supabase
                  .from('user_profiles')
                  .update({ credits: newCredits, verified_sessions: newSessions })
                  .eq('id', userId);
              }
            }
          } catch (e) {
            console.error('Supabase credit update error:', e);
            // Non-fatal: client-side fallback will still apply credits to localStorage
          }
        }
      }

      return res.status(200).json({ verified: true, credits });
    }

    return res.status(200).json({ verified: false });
  } catch (error) {
    console.error('Stripe verify error:', error);
    return res.status(500).json({ error: 'Failed to verify payment.' });
  }
};
