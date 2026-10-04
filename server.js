import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const { PORT = 3000, BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
        STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } = process.env;
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

const markPaid = (id, session_id) =>
  sb.from('listings').update({ is_paid: true, stripe_session_id: session_id }).eq('id', id);

/* --- Webhook Stripe: trebuie înainte de express.json(), cere body brut --- */
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) { return res.status(400).send(`Webhook invalid: ${e.message}`); }
  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    const s = event.data.object;
    await markPaid(s.metadata.listing_id, s.id);
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static('public'));

async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Trebuie să fii autentificat.' });
  req.user = data.user; next();
}

const createCheckout = (listing, email) => stripe.checkout.sessions.create({
  mode: 'payment',
  customer_email: email,
  line_items: [{ quantity: 1, price_data: {
    currency: 'ron', unit_amount: 500, product_data: { name: 'Taxă publicare anunț ColetGo' } } }],
  metadata: { listing_id: listing.id, user_id: listing.user_id },
  success_url: `${BASE_URL}/?paid=1&listing=${listing.id}&session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${BASE_URL}/?canceled=1`,
});

app.get('/api/config', (_, res) => res.json({ url: SUPABASE_URL, anon: SUPABASE_ANON_KEY }));

/* Căutare publică: doar anunțuri plătite */
app.get('/api/listings', async (req, res) => {
  const { from, to, date, type } = req.query;
  let q = sb.from('listings')
    .select('id,type,from_city,to_city,travel_date,travel_time,transport,size,description,price_text,created_at,profiles(full_name)')
    .eq('is_paid', true).order('created_at', { ascending: false }).limit(100);
  if (from) q = q.ilike('from_city', `%${from}%`);
  if (to) q = q.ilike('to_city', `%${to}%`);
  if (date) q = q.eq('travel_date', date);
  if (type) q = q.eq('type', type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/my-listings', auth, async (req, res) => {
  const { data, error } = await sb.from('listings').select('*').eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/* Creare anunț: primul gratuit, următoarele 5 RON */
app.post('/api/listings', auth, async (req, res) => {
  const b = req.body || {}, cut = (v, n = 300) => String(v ?? '').trim().slice(0, n);
  if (!['trip', 'request'].includes(b.type) || !cut(b.from_city) || !cut(b.to_city) || !cut(b.description))
    return res.status(400).json({ error: 'Completează tipul, orașele și descrierea.' });

  // Revendicare atomică a anunțului gratuit (evită cursele de tip race condition)
  const { data: claimed } = await sb.from('profiles')
    .update({ free_listing_used: true }).eq('id', req.user.id).eq('free_listing_used', false).select('id');
  const isFree = claimed?.length > 0;

  const { data: listing, error } = await sb.from('listings').insert({
    user_id: req.user.id, type: b.type, from_city: cut(b.from_city, 80), to_city: cut(b.to_city, 80),
    travel_date: b.travel_date || null, travel_time: cut(b.travel_time, 10), transport: cut(b.transport, 40),
    size: cut(b.size, 20), description: cut(b.description, 500), price_text: cut(b.price_text, 60),
    contact: cut(b.contact, 100), is_paid: isFree,
  }).select().single();
  if (error) {
    if (isFree) await sb.from('profiles').update({ free_listing_used: false }).eq('id', req.user.id);
    return res.status(500).json({ error: error.message });
  }
  if (isFree) return res.json({ listing, free: true });

  const session = await createCheckout(listing, req.user.email);
  await sb.from('listings').update({ stripe_session_id: session.id }).eq('id', listing.id);
  res.json({ listing, free: false, checkout_url: session.url });
});

/* Reia plata pentru un anunț nepublicat */
app.post('/api/listings/:id/checkout', auth, async (req, res) => {
  const { data: l } = await sb.from('listings').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (!l) return res.status(404).json({ error: 'Anunț inexistent.' });
  if (l.is_paid) return res.status(400).json({ error: 'Anunțul este deja activ.' });
  const session = await createCheckout(l, req.user.email);
  await sb.from('listings').update({ stripe_session_id: session.id }).eq('id', l.id);
  res.json({ checkout_url: session.url });
});

/* Confirmare după redirect (verificată la Stripe, nu se are încredere în frontend) */
app.post('/api/listings/:id/confirm', auth, async (req, res) => {
  try {
    const s = await stripe.checkout.sessions.retrieve(req.body.session_id);
    const ok = s.payment_status === 'paid' && s.metadata.listing_id === req.params.id && s.metadata.user_id === req.user.id;
    if (!ok) return res.status(400).json({ error: 'Plata nu a fost confirmată.' });
    await markPaid(req.params.id, s.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`ColetGo pe ${BASE_URL}`));
