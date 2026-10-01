const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendSms, SIMULATION_MODE } = require('./sms');
const { sendEmail, EMAIL_SIMULATION } = require('./email');

const app = express();
const PORT = process.env.PORT || 3000;
// Set DATA_DIR to a Railway Volume mount (e.g. /app/data) so data survives redeploys.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'db.json');
const TIMEZONE = process.env.TIMEZONE || 'America/New_York';
const ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L look-alikes
const FOLLOWUP_DELAY_HOURS = 48;
const REVIEW_REQUEST_DELAY_HOURS = 2; // sent after redemption, timed for "on their way out"
const FIRST_VISIT_EMAIL_DELAY_HOURS = 2; // thank-you + Reward ID + review link after a guest joins
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const STAGES = [
  'New Lead',
  'Discovery Call',
  'Offer Designed',
  'Onboarding',
  'Live Client',
];

// ---- tiny JSON file "database" ----
function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ leads: [], customers: [], messages: [], automations: [] }, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  if (!db.customers) db.customers = []; // upgrade older db.json files in place
  if (!db.messages) db.messages = [];
  if (!db.automations) db.automations = [];
  if (!db.redemptions) db.redemptions = [];
  if (!db.visits) db.visits = [];
  return db;
}

// ---- helpers: phones, emails, reward IDs, staff PINs ----
function normalizePhone(raw) {
  const str = String(raw || '').trim();
  const digits = str.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (str.startsWith('+') && digits.length >= 10) return '+' + digits;
  return '';
}

function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

function localDay(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
}

function randomChars(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += ID_CHARS[crypto.randomInt(ID_CHARS.length)];
  return out;
}

function newStaffPin() {
  return String(crypto.randomInt(1000, 10000));
}

// Short restaurant code used as the Reward ID prefix, e.g. "Mama's Kitchen" -> "MAMA"
function makeRewardCode(name, leads, selfId) {
  let base = String(name || 'REST').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'REST';
  while (base.length < 3) base += 'X';
  let code = base;
  let n = 2;
  while (leads.some((l) => l.id !== selfId && l.rewardCode === code)) code = base + n++;
  return code;
}

// Backfill reward fields on restaurants created before this feature existed.
function ensureRewardFields(lead, db) {
  let changed = false;
  if (!lead.rewardCode) { lead.rewardCode = makeRewardCode(lead.restaurantName, db.leads, lead.id); changed = true; }
  if (typeof lead.rewardCounter !== 'number') { lead.rewardCounter = 0; changed = true; }
  if (!lead.staffPin) { lead.staffPin = newStaffPin(); changed = true; }
  return changed;
}

// Generates the next unique Reward ID for a restaurant, e.g. MAMA-0007-K3
function nextRewardId(lead, db) {
  ensureRewardFields(lead, db);
  let id;
  do {
    lead.rewardCounter += 1;
    id = `${lead.rewardCode}-${String(lead.rewardCounter).padStart(4, '0')}-${randomChars(2)}`;
  } while (db.customers.some((c) => c.rewardId === id));
  return id;
}

function publicCustomer(c) {
  return { name: c.name, rewardId: c.rewardId, redemptionCount: c.redemptionCount || 0,
           visitNumber: c.checkinCount || 1, memberNumber: Number(String(c.rewardId || '').split('-')[1]) || null };
}

// Why the guest is here today (dropdown on the check-in page)
const VISIT_TYPES = {
  first_time: 'First time here',
  regular: "I'm a regular",
  friend: 'A friend sent me',
  takeout: 'Picking up takeout',
  celebrating: 'Celebrating something',
  social: 'Saw you on social media',
  event: 'Here for an event / game night',
};
function cleanVisitType(v) { return VISIT_TYPES[v] ? v : ''; }

// Secret token saved on the guest's phone so they never re-enter their info.
function newDeviceToken() { return crypto.randomBytes(24).toString('base64url'); }
function ensureDeviceToken(c) { if (!c.deviceToken) c.deviceToken = newDeviceToken(); return c.deviceToken; }

// One logged check-in per guest per day (the latest answer wins).
function logVisit(db, customer, visitType, via) {
  const today = localDay(new Date());
  let visit = db.visits.find((v) => v.customerId === customer.id && v.day === today);
  if (visit) {
    if (visitType) visit.visitType = visitType;
  } else {
    visit = { id: crypto.randomUUID(), restaurantId: customer.restaurantId, customerId: customer.id,
              day: today, visitType: visitType || '', via, at: new Date().toISOString() };
    db.visits.unshift(visit);
    customer.checkinCount = (customer.checkinCount || 0) + 1;
    customer.lastCheckinAt = visit.at;
  }
  if (visitType) customer.lastVisitType = visitType;
  return visit;
}

// Status the guest sees on their pass
function passStatus(customer) {
  const today = localDay(new Date());
  if (customer.lastRedemptionAt && localDay(customer.lastRedemptionAt) === today) return 'redeemed_today';
  if (localDay(customer.optedInAt) === today) return 'joined_today';
  return 'ready';
}

// Every scan (one per guest per day) gets its own visit code the server reads at a glance:
//   R-0143 = REWARD: give the reward (logged automatically, once per day)
//   N-0143 = NEW member who joined today (reward starts next visit)
//   X-0143 = reward already used today
// The number counts up with every visit at the restaurant. Re-scanning the same day shows the same code.
const SCAN_LETTERS = { reward: 'R', new: 'N', used: 'X' };
function processScan(db, restaurant, customer, visit) {
  if (!visit.code) {
    const today = localDay(new Date());
    let status = 'reward';
    if (localDay(customer.optedInAt) === today) status = 'new';
    else if (customer.lastRedemptionAt && localDay(customer.lastRedemptionAt) === today) status = 'used';
    restaurant.visitCounter = (restaurant.visitCounter || 0) + 1;
    visit.code = `${SCAN_LETTERS[status]}-${String(restaurant.visitCounter).padStart(4, '0')}`;
    visit.scanStatus = status;
    if (status === 'reward') {
      const now = new Date().toISOString();
      customer.redemptionCount = (customer.redemptionCount || 0) + 1;
      customer.lastRedemptionAt = now;
      db.redemptions.unshift({
        id: crypto.randomUUID(), restaurantId: restaurant.id, rewardIdEntered: customer.rewardId,
        result: 'valid', via: 'scan', visitCode: visit.code, customerId: customer.id, at: now,
      });
    }
  }
  return { code: visit.code, status: visit.scanStatus, at: visit.at, day: visit.day };
}

function maskPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 4 ? '•••-•••-' + d.slice(-4) : ''; }

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

app.use(express.json());

// ---- Optional admin password for the CRM itself ----
// Set ADMIN_PASSWORD in Railway Variables. Guest (check-in) and staff (redeem) pages stay open.
const PUBLIC_PREFIXES = ['/unsubscribe/', '/welcome', '/media/', '/js/welcome.js', '/checkin/', '/redeem/', '/api/public/', '/api/sms/inbound', '/js/checkin.js', '/js/redeem.js', '/favicon'];
app.use((req, res, next) => {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass || PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  const header = req.headers.authorization || '';
  const [, encoded] = header.split(' ');
  const decoded = encoded ? Buffer.from(encoded, 'base64').toString() : '';
  const given = decoded.slice(decoded.indexOf(':') + 1);
  if (given && given.length === pass.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pass))) return next();
  res.set('WWW-Authenticate', 'Basic realm="InTheLoop CRM"');
  res.status(401).send('Login required');
});

app.use(express.static(path.join(__dirname, 'public')));

// The public check-in page a QR code / NFC tag points to: /checkin/<restaurantId>
app.get('/checkin/:restaurantId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
});

// Public landing page with the VSL + booking form: /welcome
app.get('/welcome', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

// Staff-only redeem page (protected by the restaurant's 4-digit staff PIN): /redeem/<restaurantId>
app.get('/redeem/:restaurantId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'redeem.html'));
});

// One-click email unsubscribe (link in every guest email)
app.get('/unsubscribe/:token', (req, res) => {
  const db = readDB();
  const token = String(req.params.token || '');
  const me = db.customers.find((c) => c.deviceToken && c.deviceToken === token);
  if (me) {
    db.customers.filter((c) => c.email && c.email === me.email).forEach((c) => { c.emailOptOut = true; });
    if (!me.email) me.emailOptOut = true;
    writeDB(db);
  }
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <body style="font-family:Arial,sans-serif;background:#f5ead8;color:#201e1d;text-align:center;padding:60px 20px">
    <h2>You're unsubscribed</h2><p>You won't get any more emails from us. Your Reward ID still works in the restaurant.</p></body>`);
});

// ---- API: stages ----
app.get('/api/stages', (req, res) => {
  res.json(STAGES);
});

// ---- API: leads / restaurants ----
app.get('/api/leads', (req, res) => {
  const db = readDB();
  let changed = false;
  db.leads.forEach((l) => { if (ensureRewardFields(l, db)) changed = true; });
  if (changed) writeDB(db);
  res.json(db.leads);
});

app.get('/api/leads/:id', (req, res) => {
  const db = readDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(lead);
});

app.post('/api/leads', (req, res) => {
  const db = readDB();
  const now = new Date().toISOString();
  const stage = STAGES.includes(req.body.stage) ? req.body.stage : STAGES[0];
  const lead = {
    id: crypto.randomUUID(),
    restaurantName: req.body.restaurantName || 'Untitled Restaurant',
    contactName: req.body.contactName || '',
    phone: req.body.phone || '',
    email: req.body.email || '',
    slowestNight: req.body.slowestNight || '',
    currentOffer: req.body.currentOffer || '',
    googleReviewLink: req.body.googleReviewLink || '',
    stage,
    liveSince: stage === 'Live Client' ? now : null,
    notes: req.body.notes || '',
    rewardCode: makeRewardCode(req.body.restaurantName, db.leads, null),
    rewardCounter: 0,
    staffPin: newStaffPin(),
    createdAt: now,
    updatedAt: now,
  };
  db.leads.unshift(lead);
  writeDB(db);
  res.status(201).json(lead);
});

app.put('/api/leads/:id', (req, res) => {
  const db = readDB();
  const idx = db.leads.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const existing = db.leads[idx];
  const newStage = STAGES.includes(req.body.stage) ? req.body.stage : existing.stage;
  const becomingLive = newStage === 'Live Client' && existing.stage !== 'Live Client';
  const body = { ...req.body };
  delete body.rewardCode; // reward IDs already issued depend on these – never overwritten from the form
  delete body.rewardCounter;
  if (body.staffPin !== undefined && !/^\d{4}$/.test(String(body.staffPin))) delete body.staffPin;
  const updated = {
    ...existing,
    ...body,
    id: existing.id,
    stage: newStage,
    liveSince: becomingLive ? new Date().toISOString() : existing.liveSince || null,
    updatedAt: new Date().toISOString(),
  };
  db.leads[idx] = updated;
  writeDB(db);
  res.json(updated);
});

app.delete('/api/leads/:id', (req, res) => {
  const db = readDB();
  db.leads = db.leads.filter((l) => l.id !== req.params.id);
  db.customers = db.customers.filter((c) => c.restaurantId !== req.params.id);
  writeDB(db);
  res.status(204).end();
});

// ---- API: customers, scoped to one restaurant (owner-side view) ----
app.get('/api/leads/:id/customers', (req, res) => {
  const db = readDB();
  const customers = db.customers
    .filter((c) => c.restaurantId === req.params.id)
    .sort((a, b) => new Date(b.optedInAt) - new Date(a.optedInAt))
    .map(({ deviceToken, ...c }) => ({
      ...c,
      firstVisitLabel: VISIT_TYPES[c.firstVisitType] || '',
      lastVisitLabel: VISIT_TYPES[c.lastVisitType] || '',
    }));
  res.json(customers);
});

// Why guests came in, per restaurant (from the check-in dropdown)
app.get('/api/leads/:id/visit-stats', (req, res) => {
  const db = readDB();
  const counts = {};
  Object.keys(VISIT_TYPES).forEach((k) => (counts[k] = 0));
  db.visits.filter((v) => v.restaurantId === req.params.id && v.visitType).forEach((v) => counts[v.visitType]++);
  res.json(Object.entries(counts).map(([key, count]) => ({ key, label: VISIT_TYPES[key], count })));
});

// Owner manually adding a customer from inside the CRM
app.post('/api/leads/:id/customers', (req, res) => {
  const db = readDB();
  const restaurant = db.leads.find((l) => l.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Valid phone number required' });
  if (db.customers.some((c) => c.restaurantId === req.params.id && c.phone === phone)) {
    return res.status(409).json({ error: 'That phone number is already a customer here' });
  }
  const now = new Date().toISOString();
  const customer = {
    id: crypto.randomUUID(),
    restaurantId: req.params.id,
    rewardId: nextRewardId(restaurant, db),
    name: req.body.name || '',
    phone,
    email: normalizeEmail(req.body.email),
    smsConsent: false, // added by staff: no texts until the guest opts in themselves
    optedInAt: now,
    optedOut: false,
    redemptionCount: 0,
    lastRedemptionAt: null,
    followUpSentAt: null,
    reviewRequestSentAt: null,
  };
  db.customers.unshift(customer);
  writeDB(db);
  res.status(201).json(customer);
});

// ---- Messaging: text when Twilio is set up, otherwise email (free) ----
function publicBaseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${PORT}`;
}

function escHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function canText(c) { return !SIMULATION_MODE && !c.optedOut && c.smsConsent !== false && !!c.phone; }
function canEmail(c) { return !!c.email && !c.emailOptOut && c.smsConsent !== false; }
function canMessage(c) { return (!c.optedOut && c.smsConsent !== false) || canEmail(c); }

// Guest-facing email wrapper with the legally required unsubscribe link + mailing address (CAN-SPAM).
function guestEmailHtml(restaurant, customer, bodyHtml) {
  ensureDeviceToken(customer);
  const unsub = `${publicBaseUrl()}/unsubscribe/${customer.deviceToken}`;
  const address = process.env.BUSINESS_ADDRESS ? `<br>${escHtml(process.env.BUSINESS_ADDRESS)}` : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#201e1d">
    <h2 style="font-family:Georgia,serif;margin:0 0 12px">${escHtml(restaurant.restaurantName)}</h2>
    ${bodyHtml}
    <p style="font-size:11px;color:#8a8175;margin-top:28px;border-top:1px solid #e6dccb;padding-top:10px">
      You're getting this because you joined ${escHtml(restaurant.restaurantName)}'s Loop.
      <a href="${unsub}" style="color:#8a8175">Unsubscribe</a>${address}</p></div>`;
}

function rewardIdBlock(customer) {
  return `<p style="font-size:26px;font-weight:bold;letter-spacing:2px;font-family:monospace;margin:8px 0">${escHtml(customer.rewardId || '')}</p>`;
}

/**
 * Sends one message to a guest by the best available channel and logs it.
 * sms: text version; subject/html: email version (wrapped with unsubscribe footer).
 */
async function notifyGuest(db, restaurant, customer, type, { sms, subject, html, preferEmail }, extra = {}) {
  let result = { status: 'skipped' };
  let channel = 'none';
  if (preferEmail && canEmail(customer)) {
    channel = 'email';
    result = await sendEmail({
      to: customer.email, subject, fromName: restaurant.restaurantName,
      html: guestEmailHtml(restaurant, customer, html),
    });
  } else if (canText(customer)) {
    channel = 'sms';
    result = await sendSms(customer.phone, sms);
  } else if (canEmail(customer)) {
    channel = 'email';
    result = await sendEmail({
      to: customer.email, subject, fromName: restaurant.restaurantName,
      html: guestEmailHtml(restaurant, customer, html),
    });
  } else if (!customer.optedOut && customer.smsConsent !== false) {
    channel = 'sms';
    result = await sendSms(customer.phone, sms); // simulation mode: logged only
  }
  db.messages.unshift({
    id: crypto.randomUUID(), restaurantId: restaurant.id, customerId: customer.id,
    type, channel, body: sms, sentAt: new Date().toISOString(), status: result.status, ...extra,
  });
  return result;
}

// ---- PUBLIC API: called by the /checkin/:restaurantId page (QR / NFC) ----
// No auth — this is the guest-facing capture endpoint.
app.get('/api/public/restaurant/:id', (req, res) => {
  const db = readDB();
  const restaurant = db.leads.find((l) => l.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  res.json({
    id: restaurant.id,
    restaurantName: restaurant.restaurantName,
    currentOffer: restaurant.currentOffer,
    slowestNight: restaurant.slowestNight,
  });
});

app.post('/api/public/checkin', async (req, res) => {
  const db = readDB();
  const { restaurantId } = req.body;
  const restaurant = db.leads.find((l) => l.id === restaurantId);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  const visitType = cleanVisitType(req.body.visitType);

  // A guest who already gave their info at ANOTHER restaurant can join with one tap:
  // their phone saved token stands in for the form.
  let name = req.body.name;
  let phone = normalizePhone(req.body.phone);
  let email = normalizeEmail(req.body.email);
  if (req.body.token) {
    const known = db.customers.find((c) => c.deviceToken && c.deviceToken === String(req.body.token));
    if (known) { name = name || known.name; phone = phone || known.phone; email = email || known.email; }
  }
  if (!phone) return res.status(400).json({ error: 'Please enter a valid mobile number' });
  if (req.body.email && !normalizeEmail(req.body.email)) return res.status(400).json({ error: 'Please enter a valid email' });
  if (req.body.smsConsent !== true) return res.status(400).json({ error: 'Please tick the box to agree to texts' });

  // Same phone OR same email at this restaurant = same guest: no new ID, no double reward.
  let customer = db.customers.find(
    (c) => c.restaurantId === restaurantId && (c.phone === phone || (email && c.email === email))
  );
  const now = new Date().toISOString();
  const isNewCustomer = !customer;
  if (customer) {
    customer.name = name || customer.name;
    if (email && !customer.email) customer.email = email;
    if (customer.optedOut) { customer.optedOut = false; customer.smsConsent = true; customer.consentAt = now; }
  } else {
    customer = {
      id: crypto.randomUUID(),
      restaurantId,
      rewardId: nextRewardId(restaurant, db),
      name: name || '',
      phone,
      email,
      smsConsent: true,
      emailConsent: !!email,
      consentAt: now,
      optedInAt: now,
      optedOut: false,
      emailOptOut: false,
      firstVisitType: visitType,
      redemptionCount: 0,
      lastRedemptionAt: null,
      followUpSentAt: null,
      reviewRequestSentAt: null,
      firstVisitEmailSentAt: null,
    };
    db.customers.unshift(customer);
  }
  ensureDeviceToken(customer);
  const scan = processScan(db, restaurant, customer, logVisit(db, customer, visitType, 'form'));
  writeDB(db);

  // Welcome text with their Reward ID the moment a brand-new guest opts in.
  if (isNewCustomer) {
    const offer = restaurant.currentOffer ? `Your reward: ${restaurant.currentOffer}. ` : '';
    await notifyGuest(db, restaurant, customer, 'welcome', {
      sms: `Welcome to the ${restaurant.restaurantName} loop! ${offer}Your member ID is ${customer.rewardId}. Next visit, just scan the QR code or tap the tag at your table to get your reward. Reply STOP to opt out.`,
      subject: `Welcome to the ${restaurant.restaurantName} Loop! Here's your Reward ID`,
      html: `<p>Thanks for joining${customer.name ? ', ' + escHtml(customer.name) : ''}!</p>
        ${restaurant.currentOffer ? `<p>On your <b>next visit</b> you get: <b>${escHtml(restaurant.currentOffer)}</b></p>` : ''}
        <p>On your next visit, just scan the QR code or tap the tag at your table. Your phone shows a reward code for your server.</p>
        <p>Your member ID:</p>${rewardIdBlock(customer)}`,
    });
    writeDB(db);
  }

  res.status(201).json({
    customer: publicCustomer(customer),
    token: customer.deviceToken,
    status: passStatus(customer),
    isNewCustomer,
    scan,
    offer: restaurant.currentOffer,
    restaurantName: restaurant.restaurantName,
  });
});

// Returning guest: the check-in page sends the token saved on their phone, no form needed.
app.post('/api/public/returning', (req, res) => {
  const db = readDB();
  const { restaurantId } = req.body;
  const token = String(req.body.token || '');
  const restaurant = db.leads.find((l) => l.id === restaurantId);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  if (!token) return res.status(404).json({ error: 'unknown' });

  // The token identifies the person; they may already be a member here under a different record.
  const known = db.customers.find((c) => c.deviceToken === token);
  if (!known) return res.status(404).json({ error: 'unknown' });
  const here = known.restaurantId === restaurantId ? known
    : db.customers.find((c) => c.restaurantId === restaurantId && c.phone === known.phone);
  if (here) {
    // Coming back on a new day = a regular, unless they pick something else in the dropdown.
    const today = localDay(new Date());
    const alreadyToday = db.visits.some((v) => v.customerId === here.id && v.day === today);
    const visitType = cleanVisitType(req.body.visitType) || (alreadyToday ? '' : 'regular');
    const scan = processScan(db, restaurant, here, logVisit(db, here, visitType, 'saved_phone'));
    writeDB(db);
    return res.json({
      member: true,
      scan,
      customer: publicCustomer(here),
      status: passStatus(here),
      visitType: here.lastVisitType || '',
      offer: restaurant.currentOffer,
      restaurantName: restaurant.restaurantName,
    });
  }

  // Known guest from another restaurant: offer one-tap join (they still tick consent for THIS place).
  res.json({ member: false, knownGuest: true, name: known.name, phoneHint: maskPhone(known.phone) });
});

// Landing-page booking form -> becomes a New Lead in the CRM pipeline
app.post('/api/public/book', (req, res) => {
  const db = readDB();
  const restaurantName = String(req.body.restaurantName || '').trim().slice(0, 120);
  const phone = String(req.body.phone || '').trim().slice(0, 40);
  const email = normalizeEmail(req.body.email);
  const preferredTime = String(req.body.preferredTime || '').trim().slice(0, 40);
  if (!restaurantName) return res.status(400).json({ error: 'Please add your restaurant name.' });
  if (!phone && !email) return res.status(400).json({ error: 'Please add a phone number or email so we can confirm.' });
  if (req.body.email && !email) return res.status(400).json({ error: 'Please enter a valid email.' });
  let when = preferredTime;
  const d = new Date(preferredTime);
  if (preferredTime && !isNaN(d)) when = d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const now = new Date().toISOString();
  const lead = {
    id: crypto.randomUUID(),
    restaurantName,
    contactName: '',
    phone,
    email,
    slowestNight: '',
    currentOffer: '',
    googleReviewLink: '',
    stage: STAGES[0],
    liveSince: null,
    notes: `Booked a meeting from the landing page. Preferred time: ${when || 'not given'}.`,
    rewardCode: makeRewardCode(restaurantName, db.leads, null),
    rewardCounter: 0,
    staffPin: newStaffPin(),
    source: 'landing-page',
    preferredMeetingTime: preferredTime,
    createdAt: now,
    updatedAt: now,
  };
  db.leads.unshift(lead);
  writeDB(db);
  res.status(201).json({ ok: true });
});

// Staff redeem: requires the restaurant's staff PIN + the guest's Reward ID.
// A redemption counts as a RETURN visit, so it isn't allowed on the day they signed up,
// and only once per guest per day.
app.post('/api/public/redeem', (req, res) => {
  const db = readDB();
  const { restaurantId } = req.body;
  const restaurant = db.leads.find((l) => l.id === restaurantId);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  ensureRewardFields(restaurant, db);
  if (String(req.body.pin || '') !== restaurant.staffPin) {
    return res.status(401).json({ error: 'Wrong staff PIN' });
  }
  const entered = String(req.body.rewardId || '').trim().toUpperCase().replace(/\s+/g, '');
  const log = (result, customer) => {
    db.redemptions.unshift({
      id: crypto.randomUUID(), restaurantId, rewardIdEntered: entered, result,
      customerId: customer ? customer.id : null, at: new Date().toISOString(),
    });
    writeDB(db);
  };

  const customer = db.customers.find((c) => c.restaurantId === restaurantId && c.rewardId === entered);
  if (!customer) { log('invalid'); return res.status(404).json({ error: `No guest with Reward ID ${entered} at this restaurant` }); }

  const today = localDay(new Date());
  if (localDay(customer.optedInAt) === today) {
    log('same_day');
    return res.status(409).json({ error: 'Signed up today - the reward is for their NEXT visit.', customer: publicCustomer(customer) });
  }
  if (customer.lastRedemptionAt && localDay(customer.lastRedemptionAt) === today) {
    log('already_today');
    return res.status(409).json({ error: 'Already redeemed today.', customer: publicCustomer(customer) });
  }

  customer.redemptionCount = (customer.redemptionCount || 0) + 1;
  customer.lastRedemptionAt = new Date().toISOString();
  log('valid', customer);
  res.json({ ok: true, customer: publicCustomer(customer), offer: restaurant.currentOffer, visitNumber: customer.redemptionCount });
});

// Owner-side redemption log (CRM)
app.get('/api/leads/:id/redemptions', (req, res) => {
  const db = readDB();
  res.json(db.redemptions.filter((r) => r.restaurantId === req.params.id).slice(0, 100));
});

// ---- API: send a promotion to this restaurant's customers ----
app.post('/api/leads/:id/promotions', async (req, res) => {
  const db = readDB();
  const restaurant = db.leads.find((l) => l.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const { message, audience } = req.body; // audience: 'all' | 'new' | 'returning'
  if (!message) return res.status(400).json({ error: 'Message is required' });

  let recipients = db.customers.filter((c) => c.restaurantId === req.params.id && canMessage(c));
  if (audience === 'new') recipients = recipients.filter((c) => (c.redemptionCount || 0) === 0);
  if (audience === 'returning') recipients = recipients.filter((c) => (c.redemptionCount || 0) > 0);

  const results = [];
  for (const customer of recipients) {
    const result = await notifyGuest(db, restaurant, customer, 'promotion_msg', {
      sms: `${message} Reply STOP to opt out.`,
      subject: `${restaurant.restaurantName}: ${message.slice(0, 60)}`,
      html: `<p style="font-size:16px">${escHtml(message)}</p><p>Your Reward ID:</p>${rewardIdBlock(customer)}`,
    });
    results.push({ customerId: customer.id, phone: customer.phone, status: result.status });
  }

  const promotion = {
    id: crypto.randomUUID(),
    restaurantId: req.params.id,
    message,
    audience: audience || 'all',
    recipientCount: recipients.length,
    sentAt: new Date().toISOString(),
  };
  db.messages.unshift({ ...promotion, type: 'promotion' });
  writeDB(db);

  res.status(201).json({ promotion, results, simulated: SIMULATION_MODE });
});

app.get('/api/leads/:id/promotions', (req, res) => {
  const db = readDB();
  const promotions = db.messages
    .filter((m) => m.restaurantId === req.params.id && m.type === 'promotion')
    .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
  res.json(promotions);
});

// ---- Twilio inbound webhook — handles STOP replies ----
// Point your Twilio phone number's "A message comes in" webhook at:
// https://<your-domain>/api/sms/inbound
app.post('/api/sms/inbound', express.urlencoded({ extended: false }), (req, res) => {
  const from = normalizePhone(req.body.From);
  const body = (req.body.Body || '').trim().toUpperCase();
  if (from && ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(body)) {
    const db = readDB();
    db.customers
      .filter((c) => c.phone === from)
      .forEach((c) => { c.optedOut = true; c.smsConsent = false; });
    writeDB(db);
  }
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});


app.get('/api/analytics', (req, res) => {
  const db = readDB();
  const leads = db.leads;
  const total = leads.length;

  const byStage = {};
  STAGES.forEach((s) => (byStage[s] = 0));
  leads.forEach((l) => {
    if (byStage[l.stage] === undefined) byStage[l.stage] = 0;
    byStage[l.stage]++;
  });

  const liveClients = byStage['Live Client'] || 0;
  const conversionRate = total > 0 ? Math.round((liveClients / total) * 1000) / 10 : 0;

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const newThisMonth = leads.filter((l) => new Date(l.createdAt).getTime() >= thirtyDaysAgo).length;
  const dealsClosedThisMonth = leads.filter(
    (l) => l.stage === 'Live Client' && new Date(l.updatedAt).getTime() >= thirtyDaysAgo
  ).length;

  const recent = [...leads]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 5)
    .map((l) => ({ id: l.id, restaurantName: l.restaurantName, stage: l.stage, updatedAt: l.updatedAt }));

  const totalCustomers = db.customers.length;
  const totalRedemptions = db.customers.reduce((sum, c) => sum + (c.redemptionCount || 0), 0);

  res.json({
    total,
    byStage,
    liveClients,
    conversionRate,
    newThisMonth,
    dealsClosedThisMonth,
    recent,
    totalCustomers,
    totalRedemptions,
  });
});

// ---- Automated 48-hour follow-up ----
// Every 15 minutes, check for customers who opted in ~48h ago and haven't
// gotten their follow-up yet, then send it automatically.
async function runFollowUpCheck() {
  const db = readDB();
  const cutoff = Date.now() - FOLLOWUP_DELAY_HOURS * 60 * 60 * 1000;
  const due = db.customers.filter(
    (c) => canMessage(c) && !c.followUpSentAt && !(c.redemptionCount > 0) &&
      new Date(c.optedInAt).getTime() <= cutoff
  );

  for (const customer of due) {
    const restaurant = db.leads.find((l) => l.id === customer.restaurantId);
    if (!restaurant || !restaurant.currentOffer) continue;

    await notifyGuest(db, restaurant, customer, 'followup', {
      sms: `Still thinking about ${restaurant.restaurantName}? Your offer is waiting: ${restaurant.currentOffer}. Just scan the QR code at your table when you come in. Reply STOP to opt out.`,
      subject: `Your reward at ${restaurant.restaurantName} is waiting`,
      html: `<p>Your reward is still waiting: <b>${escHtml(restaurant.currentOffer)}</b></p><p>Next time you're in, just scan the QR code or tap the tag at your table and show your server the reward code.</p>`,
    });
    customer.followUpSentAt = new Date().toISOString();
  }

  if (due.length > 0) writeDB(db);
}

// ---- First-visit thank-you (2 hours after a guest joins) ----
// Emails (or texts, if no email) their Reward ID again plus the restaurant's Google review link.
// Only for guests who joined in the last 2 days, so existing members aren't emailed all at once.
async function runFirstVisitEmailCheck() {
  const db = readDB();
  const now = Date.now();
  const cutoff = now - FIRST_VISIT_EMAIL_DELAY_HOURS * 60 * 60 * 1000;
  const oldest = now - 48 * 60 * 60 * 1000;
  const due = db.customers.filter((c) => {
    const joined = new Date(c.optedInAt || 0).getTime();
    return canMessage(c) && !c.firstVisitEmailSentAt && joined <= cutoff && joined >= oldest;
  });
  for (const customer of due) {
    const restaurant = db.leads.find((l) => l.id === customer.restaurantId);
    if (!restaurant) continue;
    const link = restaurant.googleReviewLink;
    const hi = customer.name ? `Hi ${escHtml(customer.name)}, thanks` : 'Thanks';
    await notifyGuest(db, restaurant, customer, 'first_visit_followup', {
      preferEmail: true,
      sms: `Thanks for visiting ${restaurant.restaurantName}! Next visit, scan the QR code at your table${restaurant.currentOffer ? ` for ${restaurant.currentOffer}` : ' for your reward'}.${link ? ` Enjoyed it? A quick Google review helps a lot: ${link}` : ''} Reply STOP to opt out.`,
      subject: `Thanks for visiting ${restaurant.restaurantName}!`,
      html: `<p>${hi} for coming in today!</p>
        <p>On your <b>next visit</b>, just scan the QR code or tap the tag at your table${restaurant.currentOffer ? ` to get <b>${escHtml(restaurant.currentOffer)}</b>` : ''}. Your phone will show a reward code for your server.</p>
        <p>Your member ID:</p>${rewardIdBlock(customer)}
        ${link ? `<p style="margin-top:20px">Enjoyed your visit? A quick Google review helps a local restaurant more than you'd think:</p>
        <p><a href="${escHtml(link)}" style="display:inline-block;background:#c67139;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none">Leave a Google review</a></p>` : ''}`,
    }, { includesReview: !!link });
    customer.firstVisitEmailSentAt = new Date().toISOString();
  }
  if (due.length > 0) writeDB(db);
}

// ---- Automated Google review request ----
// Every 15 minutes, check for customers who redeemed ~2h ago (long enough to
// have finished their meal and left) and haven't been asked for a review yet
// for that visit, then text them the restaurant's Google review link.
async function runReviewRequestCheck() {
  const db = readDB();
  const cutoff = Date.now() - REVIEW_REQUEST_DELAY_HOURS * 60 * 60 * 1000;
  const due = db.customers.filter(
    (c) =>
      canMessage(c) &&
      c.lastRedemptionAt &&
      new Date(c.lastRedemptionAt).getTime() <= cutoff &&
      (!c.reviewRequestSentAt || new Date(c.reviewRequestSentAt) < new Date(c.lastRedemptionAt))
  );

  for (const customer of due) {
    const restaurant = db.leads.find((l) => l.id === customer.restaurantId);
    if (!restaurant || !restaurant.googleReviewLink) continue;

    await notifyGuest(db, restaurant, customer, 'review_request', {
      sms: `Thanks for stopping by ${restaurant.restaurantName}! Mind leaving us a quick Google review? ${restaurant.googleReviewLink} Reply STOP to opt out.`,
      subject: `Thanks for stopping by ${restaurant.restaurantName}!`,
      html: `<p>Thanks for coming back! If you enjoyed it, a quick Google review helps a local restaurant a lot:</p>
        <p><a href="${escHtml(restaurant.googleReviewLink)}" style="display:inline-block;background:#c67139;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none">Leave a review</a></p>`,
    });
    customer.reviewRequestSentAt = new Date().toISOString();
  }

  if (due.length > 0) writeDB(db);
}

// ---- Automated / scheduled promotions ----
// Restaurant-level recurring promotions, e.g. "every Wednesday, text all
// customers this message." Checked once a day per automation.
app.get('/api/leads/:id/automations', (req, res) => {
  const db = readDB();
  res.json(db.automations.filter((a) => a.restaurantId === req.params.id));
});

app.post('/api/leads/:id/automations', (req, res) => {
  const db = readDB();
  const restaurant = db.leads.find((l) => l.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  const { message, audience, dayOfWeek } = req.body;
  if (!message || !DAY_NAMES.includes(dayOfWeek)) {
    return res.status(400).json({ error: 'Message and a valid dayOfWeek are required' });
  }
  const automation = {
    id: crypto.randomUUID(),
    restaurantId: req.params.id,
    message,
    audience: audience || 'all',
    dayOfWeek,
    active: true,
    lastSentAt: null,
    createdAt: new Date().toISOString(),
  };
  db.automations.unshift(automation);
  writeDB(db);
  res.status(201).json(automation);
});

app.delete('/api/leads/:id/automations/:automationId', (req, res) => {
  const db = readDB();
  db.automations = db.automations.filter((a) => a.id !== req.params.automationId);
  writeDB(db);
  res.status(204).end();
});

async function runAutomationCheck() {
  const db = readDB();
  const now = new Date();
  const today = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: TIMEZONE });
  const todayKey = localDay(now);

  const due = db.automations.filter(
    (a) => a.active && a.dayOfWeek === today && (!a.lastSentAt || localDay(a.lastSentAt) !== todayKey)
  );

  for (const automation of due) {
    const restaurant = db.leads.find((l) => l.id === automation.restaurantId);
    if (!restaurant) continue;
    let recipients = db.customers.filter((c) => c.restaurantId === automation.restaurantId && canMessage(c));
    if (automation.audience === 'new') recipients = recipients.filter((c) => (c.redemptionCount || 0) === 0);
    if (automation.audience === 'returning') recipients = recipients.filter((c) => (c.redemptionCount || 0) > 0);

    for (const customer of recipients) {
      await notifyGuest(db, restaurant, customer, 'promotion', {
        sms: `${automation.message} Reply STOP to opt out.`,
        subject: `${restaurant.restaurantName}: ${automation.message.slice(0, 60)}`,
        html: `<p style="font-size:16px">${escHtml(automation.message)}</p><p>Your Reward ID:</p>${rewardIdBlock(customer)}`,
      }, { message: automation.message, audience: automation.audience, recipientCount: 1, automationId: automation.id });
    }
    automation.lastSentAt = new Date().toISOString();
  }

  if (due.length > 0) writeDB(db);
}

// =====================================================================
// Monthly owner report — emailed on the 1st to every Live Client / Onboarding
// restaurant with an email on file. Also previewable + sendable from the CRM.
// =====================================================================
const DEFAULT_AVG_CHECK = Number(process.env.DEFAULT_AVG_CHECK || 25);
const REPORT_STAGES = ['Onboarding', 'Live Client'];

function monthRange(which) {
  // Returns {start, end, label, key} in the business timezone ("last" = previous calendar month).
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  let y = nowLocal.getFullYear();
  let m = nowLocal.getMonth();
  if (which === 'last') { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const key = `${y}-${String(m + 1).padStart(2, '0')}`;
  const label = new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return { key, label, inRange: (iso) => !!iso && localDay(iso).slice(0, 7) === key };
}

function buildOwnerReport(db, lead, which) {
  const r = monthRange(which);
  const customers = db.customers.filter((c) => c.restaurantId === lead.id);
  const newSignups = customers.filter((c) => r.inRange(c.optedInAt)).length;
  const checkins = db.visits.filter((v) => v.restaurantId === lead.id && r.inRange(v.at)).length;
  const valid = db.redemptions.filter((x) => x.restaurantId === lead.id && x.result === 'valid' && r.inRange(x.at));
  const returnVisits = valid.length;
  const returningGuests = new Set(valid.map((x) => x.customerId)).size;
  const avgCheck = Number(lead.avgCheck) > 0 ? Number(lead.avgCheck) : DEFAULT_AVG_CHECK;
  const estRevenue = returnVisits * avgCheck;
  const reasons = {};
  db.visits.filter((v) => v.restaurantId === lead.id && v.visitType && r.inRange(v.at))
    .forEach((v) => { reasons[v.visitType] = (reasons[v.visitType] || 0) + 1; });
  const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${VISIT_TYPES[k] || k}: ${n}`);
  const firstTimeGuests = reasons.first_time || 0;
  const regularVisits = reasons.regular || 0;
  const messagesSent = db.messages.filter((m) => m.restaurantId === lead.id && m.customerId && r.inRange(m.sentAt)).length;
  const reviewAsks = db.messages.filter((m) => m.restaurantId === lead.id && (m.type === 'review_request' || m.includesReview) && r.inRange(m.sentAt)).length;
  const stats = { month: r.label, totalMembers: customers.length, newSignups, checkins, returnVisits, returningGuests,
                  avgCheck, estRevenue, messagesSent, reviewAsks, topReasons, firstTimeGuests, regularVisits };

  const row = (label, value) => `<tr><td style="padding:8px 0;color:#645c50">${label}</td><td style="padding:8px 0;text-align:right;font-weight:bold">${value}</td></tr>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#201e1d">
    <p style="color:#8c491a;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin:0">InTheLoop monthly report</p>
    <h2 style="font-family:Georgia,serif;margin:4px 0 4px">${escHtml(lead.restaurantName)}</h2>
    <p style="margin:0 0 18px;color:#645c50">${escHtml(r.label)}</p>
    <div style="background:#f5ead8;border-radius:16px;padding:18px;margin-bottom:18px">
      <p style="margin:0;color:#645c50">Estimated revenue from returning guests</p>
      <p style="margin:4px 0 0;font-size:34px;font-weight:bold">$${estRevenue.toLocaleString('en-US')}</p>
      <p style="margin:4px 0 0;font-size:12px;color:#645c50">${returnVisits} tracked return visits × $${avgCheck} average check</p>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      ${row('New members this month', newSignups)}
      ${row('Total members in your Loop', customers.length)}
      ${row('Check-ins (scans)', checkins)}
      ${row('First-time guests', firstTimeGuests)}
      ${row('Visits from regulars', regularVisits)}
      ${row('Tracked return visits (rewards redeemed)', returnVisits)}
      ${row('Different guests who came back', returningGuests)}
      ${row('Messages sent to your guests', messagesSent)}
      ${row('Google review requests sent', reviewAsks)}
    </table>
    ${topReasons.length ? `<p style="margin-top:18px"><b>Why guests came in:</b> ${escHtml(topReasons.join(' · '))}</p>` : ''}
    <p style="margin-top:22px;color:#645c50;font-size:13px">Questions or want to change your offer? Just reply to this email.<br>— Christopher, InTheLoop</p>
  </div>`;
  return { stats, html, subject: `${lead.restaurantName}: your InTheLoop results for ${r.label}`, monthKey: r.key };
}

async function sendOwnerReport(db, lead, which) {
  const report = buildOwnerReport(db, lead, which);
  if (!lead.email) return { status: 'no_email', report };
  const result = await sendEmail({ to: lead.email, subject: report.subject, html: report.html, fromName: 'InTheLoop' });
  if (process.env.REPORT_COPY_TO) {
    await sendEmail({ to: process.env.REPORT_COPY_TO, subject: `[copy] ${report.subject}`, html: report.html, fromName: 'InTheLoop' });
  }
  db.messages.unshift({ id: crypto.randomUUID(), restaurantId: lead.id, type: 'owner_report', channel: 'email',
                        body: report.subject, sentAt: new Date().toISOString(), status: result.status });
  if (which === 'last') lead.lastReportMonth = report.monthKey;
  return { status: result.status, report };
}

// CRM: preview (opens as a web page) — ?period=current (default) or last
app.get('/api/leads/:id/report', (req, res) => {
  const db = readDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).send('Not found');
  const { html } = buildOwnerReport(db, lead, req.query.period === 'last' ? 'last' : 'current');
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#f9f4ed;padding:24px">${html}</body>`);
});

// CRM: send now
app.post('/api/leads/:id/report/send', async (req, res) => {
  const db = readDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  if (!lead.email) return res.status(400).json({ error: 'Add the owner\'s email to this restaurant first.' });
  const which = req.body.period === 'last' ? 'last' : 'current';
  const { status, report } = await sendOwnerReport(db, lead, which);
  writeDB(db);
  res.json({ status, to: lead.email, stats: report.stats, simulated: EMAIL_SIMULATION });
});

async function runMonthlyReports() {
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  if (nowLocal.getDate() !== 1 || nowLocal.getHours() < 9) return;
  const db = readDB();
  const lastKey = monthRange('last').key;
  let changed = false;
  for (const lead of db.leads) {
    if (!REPORT_STAGES.includes(lead.stage) || !lead.email || lead.lastReportMonth === lastKey) continue;
    await sendOwnerReport(db, lead, 'last');
    changed = true;
  }
  if (changed) writeDB(db);
}

// =====================================================================
// Backups — a dated copy kept on the volume every day (last 14), emailed to
// BACKUP_EMAIL if set, plus a one-click download from the CRM.
// =====================================================================
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUPS_TO_KEEP = 14;

app.get('/api/backup', (req, res) => {
  const db = readDB();
  res.set('Content-Disposition', `attachment; filename="intheloop-backup-${localDay(new Date())}.json"`);
  res.json(db);
});

async function runDailyBackup(force) {
  const today = localDay(new Date());
  const file = path.join(BACKUP_DIR, `db-${today}.json`);
  if (!force && fs.existsSync(file)) return;
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  if (!force && nowLocal.getHours() < 3) return; // run once a day, after 3am
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const raw = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : Buffer.from('{}');
  fs.writeFileSync(file, raw);
  fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('db-')).sort().reverse()
    .slice(BACKUPS_TO_KEEP).forEach((f) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  if (process.env.BACKUP_EMAIL) {
    const db = JSON.parse(raw.toString() || '{}');
    await sendEmail({
      to: process.env.BACKUP_EMAIL,
      subject: `InTheLoop backup ${today} (${(db.leads || []).length} restaurants, ${(db.customers || []).length} guests)`,
      html: '<p>Your daily InTheLoop CRM backup is attached. Keep this email: it can rebuild everything if the server data is ever lost.</p>',
      attachments: [{ filename: `intheloop-backup-${today}.json`, content: raw.toString('base64') }],
    });
  }
  console.log(`Backup saved: ${file}`);
}

async function runScheduledJobs() {
  for (const job of [runFollowUpCheck, runFirstVisitEmailCheck, runReviewRequestCheck, runAutomationCheck, runMonthlyReports, runDailyBackup]) {
    try { await job(); } catch (err) { console.error(`Scheduled job ${job.name} failed:`, err.message); }
  }
}
setInterval(runScheduledJobs, 15 * 60 * 1000);
runScheduledJobs();

app.listen(PORT, '0.0.0.0', () => {
  const modes = [];
  if (SIMULATION_MODE) modes.push('SMS simulation mode — no Twilio credentials set');
  if (EMAIL_SIMULATION) modes.push('email simulation mode — no email API key set');
  console.log(`InTheLoop CRM running on port ${PORT}${modes.length ? ` (${modes.join('; ')})` : ''}`);
});
