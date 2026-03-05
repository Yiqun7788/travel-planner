const Stripe = require('stripe');

const ALLOWED_ORIGINS = [
  'https://travel-planner-livid-two.vercel.app',
  'http://localhost',
  'http://127.0.0.1'
];

const PRICE_CONFIG = {
  trip_pack: { credits: 1 },
  bundle:    { credits: 3 }
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const origin = req.headers['origin'] || '';
  const referer = req.headers['referer'] || '';
  const isAllowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o));
  if (!isAllowed) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  const { STRIPE_SECRET_KEY, STRIPE_PRICE_TRIP_PACK, STRIPE_PRICE_BUNDLE } = process.env;

  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe is not configured on the server.' });
  }

  const { priceType } = req.body || {};

  if (!priceType || !PRICE_CONFIG[priceType]) {
    return res.status(400).json({ error: 'Invalid price type. Must be "trip_pack" or "bundle".' });
  }

  const priceId = priceType === 'trip_pack' ? STRIPE_PRICE_TRIP_PACK : STRIPE_PRICE_BUNDLE;

  if (!priceId) {
    return res.status(500).json({ error: 'Price ID not configured for this product.' });
  }

  const credits = PRICE_CONFIG[priceType].credits;

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);

    // Determine the base URL for redirects
    const requestOrigin = ALLOWED_ORIGINS.find(o => origin.startsWith(o) || referer.startsWith(o)) || ALLOWED_ORIGINS[0];
    const baseUrl = requestOrigin.replace(/\/$/, '');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { credits: String(credits), priceType },
      success_url: `${baseUrl}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/`,
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    return res.status(500).json({ error: 'Failed to create checkout session: ' + (error.message || String(error)) });
  }
};
