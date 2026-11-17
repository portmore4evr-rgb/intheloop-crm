const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendSms: sendSmsRaw, SIMULATION_MODE } = require('./sms');
// Keep texts in the plain SMS alphabet: one curly quote or long dash makes a text cost double.
const sendSms = (to, body) => sendSmsRaw(to, String(body).replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"'));
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
  if (!db.draws) db.draws = [];
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
//   S-0143 = SAVED: visit counted, but rewards wait for the Club Night window (nothing to give today)
//   W-0143 = WINNER: this guest won the monthly free-meal draw (meal up to the restaurant's cap)
const SCAN_LETTERS = { reward: 'R', new: 'N', used: 'X', bonus: 'B', saved: 'S', meal: 'W' };

// ---- Club Night window: rewards and prizes can only be used on these evenings ----
// Visits on busy nights still count (badges, streaks, draw entries) and their prizes are saved for the window.
const DEFAULT_REDEEM_DAYS = [1, 2, 3]; // Mon, Tue, Wed
const DEFAULT_REDEEM_FROM = '17:00';
const DEFAULT_REDEEM_TO = '20:00';
const BANK_DAYS = 30; // saved prizes and free-meal wins expire after this many days
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function cleanDays(v) {
  const arr = (Array.isArray(v) ? v : String(v || '').split(',')).filter((x) => String(x).trim() !== '').map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return [...new Set(arr)].sort((a, b) => a - b);
}
function cleanTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return '';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function redeemWindow(r) {
  const days = Array.isArray(r.redeemDays) && r.redeemDays.length ? r.redeemDays : DEFAULT_REDEEM_DAYS;
  const from = cleanTime(r.redeemFrom) || DEFAULT_REDEEM_FROM;
  let to = cleanTime(r.redeemTo) || DEFAULT_REDEEM_TO;
  if (toMin(to) <= toMin(from)) to = '23:59';
  return { days, from, to };
}
function localParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { dow: SHORT_DAYS.indexOf(p.weekday), minutes: Number(p.hour) * 60 + Number(p.minute), day: `${p.year}-${p.month}-${p.day}` };
}
function zonedToUtc(day, hhmm) { // local restaurant time -> real instant
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const want = Date.UTC(y, m - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(new Date(t));
    const [py, pm, pd] = p.day.split('-').map(Number);
    t += want - Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
  }
  return new Date(t);
}
function inRedeemWindow(r, date = new Date()) {
  const w = redeemWindow(r);
  const p = localParts(date);
  return w.days.includes(p.dow) && p.minutes >= toMin(w.from) && p.minutes < toMin(w.to);
}
function fmtClock(t) {
  const [h, m] = t.split(':').map(Number);
  const hr = h % 12 || 12;
  return `${hr}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}
function daysLabel(days) {
  if (days.length === 7) return 'Every day';
  const runs = [];
  days.forEach((d) => { const last = runs[runs.length - 1]; if (last && d === last[1] + 1) last[1] = d; else runs.push([d, d]); });
  const parts = runs.flatMap(([a, b]) => (a === b ? [SHORT_DAYS[a]] : b === a + 1 ? [SHORT_DAYS[a], SHORT_DAYS[b]] : [`${SHORT_DAYS[a]}–${SHORT_DAYS[b]}`]));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}` : parts[0];
}
function windowLabel(r) { const w = redeemWindow(r); return `${daysLabel(w.days)}, ${fmtClock(w.from)}–${fmtClock(w.to)}`; }
function windowInfo(r, now = new Date()) {
  const w = redeemWindow(r);
  const openNow = inRedeemWindow(r, now);
  let opensAt = null; let closesAt = null;
  for (let i = 0; i < 9; i += 1) {
    const p = localParts(new Date(now.getTime() + i * 86400000));
    if (!w.days.includes(p.dow)) continue;
    const open = zonedToUtc(p.day, w.from); const close = zonedToUtc(p.day, w.to);
    if (openNow && now >= open && now < close) { closesAt = close.toISOString(); break; }
    if (!openNow && open > now) { opensAt = open.toISOString(); break; }
  }
  return { label: windowLabel(r), days: w.days, from: w.from, to: w.to, openNow, opensAt, closesAt };
}

// Prizes and free-meal wins earned outside the window wait in the guest's "bank" until a Club Night.
function activeBank(customer) {
  const now = Date.now();
  customer.bank = (customer.bank || []).filter((b) => !b.expiresAt || Date.parse(b.expiresAt) > now);
  return customer.bank;
}
function bankItem(kind, label, extra = {}) {
  return { id: crypto.randomUUID(), kind, label, earnedAt: new Date().toISOString(),
           expiresAt: new Date(Date.now() + BANK_DAYS * 86400000).toISOString(), ...extra };
}

// ---- Monthly free-meal draw ----
// Every day a guest checks in = 1 entry (no purchase needed, see /rules). On the 1st of each month, from 9am,
// the server picks one winner per restaurant for last month, weighted by entries. The meal is capped by the owner.
const DEFAULT_DRAW_CAP = 40;
const DRAW_MONTHLY_FROM = '2026-10'; // first month drawn under monthly rules (weekly draws ran before this)
const drawOn = (r) => r.drawEnabled !== false;
const drawCap = (r) => (Number(r.drawCap) > 0 ? Number(r.drawCap) : DEFAULT_DRAW_CAP);
const monthKey = (day) => String(day).slice(0, 7); // 'YYYY-MM-DD' -> 'YYYY-MM'
function prevMonth(mk) { const [y, m] = mk.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; }
function nextMonth(mk) { const [y, m] = mk.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }
const monthName = (mk) => new Date(`${mk}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
const monthLabel = (mk) => new Date(`${mk}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const nextDrawLabel = (mk) => new Date(`${nextMonth(mk)}-01T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
function monthEntries(db, restaurantId, mk) {
  const byCustomer = new Map();
  db.visits.forEach((v) => {
    if (v.restaurantId === restaurantId && monthKey(v.day) === mk) byCustomer.set(v.customerId, (byCustomer.get(v.customerId) || 0) + 1);
  });
  return byCustomer;
}
function shortName(c) {
  const parts = String(c.name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A lucky guest';
  return parts[0] + (parts[1] ? ` ${parts[1][0].toUpperCase()}.` : '');
}
const drawSortKey = (d) => d.drawnAt || d.month || d.week || '';
function lastDraw(db, restaurantId) {
  return db.draws.filter((d) => d.restaurantId === restaurantId).sort((a, b) => (drawSortKey(a) < drawSortKey(b) ? 1 : -1))[0] || null;
}
function drawStatusFor(db, restaurant, customer) {
  if (!drawOn(restaurant)) return null;
  const mk = monthKey(localDay(new Date()));
  const entries = customer ? (monthEntries(db, restaurant.id, mk).get(customer.id) || 0) : 0;
  const last = lastDraw(db, restaurant.id);
  return { cap: drawCap(restaurant), entries, lastWinner: last && last.winnerName ? last.winnerName : '',
           month: monthName(mk), drawDate: nextDrawLabel(mk) };
}

// ---- Streaks, badges and bigger prizes ----
// Simple offer: one every-visit reward plus ONE bigger prize on the 5th visit.
// Streak prizes and extra milestones are switched off (put [2, 3, 5, 10] / [2, 4, 8] back to turn them on).
const VISIT_MILESTONES = [5];
const STREAK_BADGES = [];
const DEFAULT_PRIZES = { 2: 'Free side', 3: 'Free dessert', 5: 'Free appetizer', 10: 'Free entrée', streak2: '', streak4: 'Free drink', streak8: '' };
function prizeFor(restaurant, key) {
  const v = restaurant[`prize${key}`];
  return (v && String(v).trim()) || DEFAULT_PRIZES[key];
}
function weekStart(day) { // 'YYYY-MM-DD' -> that week's Monday
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function weeksBefore(wk, n) {
  const d = new Date(`${wk}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7 * n);
  return d.toISOString().slice(0, 10);
}
function streakFor(db, customer) {
  const weeks = new Set(db.visits.filter((v) => v.customerId === customer.id).map((v) => weekStart(v.day)));
  const thisWeek = weekStart(localDay(new Date()));
  const visitedThisWeek = weeks.has(thisWeek);
  let wk = visitedThisWeek ? thisWeek : weeksBefore(thisWeek, 1);
  let count = 0;
  while (weeks.has(wk)) { count += 1; wk = weeksBefore(wk, 1); }
  const lastWeeks = [5, 4, 3, 2, 1, 0].map((i) => {
    const w = weeksBefore(thisWeek, i);
    const label = i === 0 ? 'This wk' : new Date(`${w}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return { label, visited: weeks.has(w), current: i === 0 };
  });
  return { weeks: count, visitedThisWeek, atRisk: count > 0 && !visitedThisWeek, thisWeek, lastWeeks };
}
function progressFor(db, restaurant, customer) {
  const visits = customer.checkinCount || 1;
  const streak = streakFor(db, customer);
  const best = Math.max(customer.bestStreak || 0, streak.weeks);
  const badges = [
    ...VISIT_MILESTONES.map((n) => ({ id: `v${n}`, kind: 'visits', n, label: `${n} visits`, prize: prizeFor(restaurant, n), earned: visits >= n })),
    ...STREAK_BADGES.map((n) => ({ id: `s${n}`, kind: 'streak', n, label: `${n}-week streak`,
      prize: prizeFor(restaurant, `streak${n}`), earned: best >= n })),
  ];
  const nextVisit = VISIT_MILESTONES.find((n) => visits < n);
  return {
    visits,
    streak: STREAK_BADGES.length ? streak.weeks : 0,
    bestStreak: best,
    visitedThisWeek: streak.visitedThisWeek,
    atRisk: STREAK_BADGES.length ? streak.atRisk : false,
    lastWeeks: streak.lastWeeks,
    badges,
    next: nextVisit ? { n: nextVisit, remaining: nextVisit - visits, prize: prizeFor(restaurant, nextVisit) } : null,
    saved: activeBank(customer).map((b) => ({ kind: b.kind, label: b.label, expiresAt: b.expiresAt })),
    draw: drawStatusFor(db, restaurant, customer),
  };
}

function processScan(db, restaurant, customer, visit) {
  if (!visit.code) {
    const today = localDay(new Date());
    let status = 'reward';
    if (localDay(customer.optedInAt) === today) status = 'new';
    else if (customer.lastRedemptionAt && localDay(customer.lastRedemptionAt) === today) status = 'used';

    // New badges earned on this visit (streak badges can't be earned on join day: one week only)
    customer.awarded = customer.awarded || [];
    const visits = customer.checkinCount || 1;
    const streak = streakFor(db, customer).weeks;
    customer.bestStreak = Math.max(customer.bestStreak || 0, streak);
    const newBadges = [];
    const prizes = [];
    VISIT_MILESTONES.forEach((n) => {
      if (visits >= n && !customer.awarded.includes(`v${n}`)) {
        customer.awarded.push(`v${n}`);
        const prize = prizeFor(restaurant, n);
        newBadges.push({ id: `v${n}`, kind: 'visits', label: `${n} visits`, prize });
        if (visits === n) prizes.push(prize);
      }
    });
    STREAK_BADGES.forEach((n) => {
      if (customer.bestStreak >= n && !customer.awarded.includes(`s${n}`)) {
        customer.awarded.push(`s${n}`);
        const prize = prizeFor(restaurant, `streak${n}`);
        newBadges.push({ id: `s${n}`, kind: 'streak', label: `${n}-week streak`, prize });
        if (prize) prizes.push(prize);
      }
    });
    // Outside the Club Night window the visit still counts, but the reward waits and any prize is saved.
    let mealDrawId = null;
    let savedPrize = '';
    if (status === 'reward' && !inRedeemWindow(restaurant)) {
      status = 'saved';
      prizes.forEach((p) => activeBank(customer).push(bankItem('prize', p)));
      savedPrize = prizes.join(' + ');
      prizes.length = 0;
    } else if (status === 'reward') {
      const bank = activeBank(customer);
      const meal = bank.find((b) => b.kind === 'meal');
      bank.filter((b) => b.kind === 'prize').forEach((b) => prizes.push(b.label));
      if (meal) { prizes.unshift(meal.label); mealDrawId = meal.drawId || null; }
      customer.bank = [];
      if (meal) status = 'meal';
      else if (prizes.length) status = 'bonus';
    }

    restaurant.visitCounter = (restaurant.visitCounter || 0) + 1;
    visit.code = `${SCAN_LETTERS[status]}-${String(restaurant.visitCounter).padStart(4, '0')}`;
    visit.scanStatus = status;
    visit.newBadges = newBadges;
    if (status === 'bonus' || status === 'meal') visit.prize = prizes.join(' + ');
    if (savedPrize) visit.savedPrize = savedPrize;
    if (status === 'reward' || status === 'bonus' || status === 'meal') {
      const now = new Date().toISOString();
      customer.redemptionCount = (customer.redemptionCount || 0) + 1;
      customer.lastRedemptionAt = now;
      db.redemptions.unshift({
        id: crypto.randomUUID(), restaurantId: restaurant.id, rewardIdEntered: customer.rewardId,
        result: 'valid', via: 'scan', visitCode: visit.code, customerId: customer.id, at: now,
        ...(visit.prize ? { bonusPrize: visit.prize } : {}),
        ...(status === 'meal' ? { freeMeal: true, drawId: mealDrawId } : {}),
      });
      if (mealDrawId) {
        const draw = db.draws.find((d) => d.id === mealDrawId);
        if (draw) draw.claimedAt = now;
      }
    }
    visit.firstShown = true;
    return { code: visit.code, status: visit.scanStatus, at: visit.at, day: visit.day, prize: visit.prize || '', savedPrize: visit.savedPrize || '', newBadges };
  }
  // Same-day rescan: same code, no new celebration
  return { code: visit.code, status: visit.scanStatus, at: visit.at, day: visit.day, prize: visit.prize || '', savedPrize: visit.savedPrize || '', newBadges: [] };
}

function maskPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 4 ? '•••-•••-' + d.slice(-4) : ''; }

// Save to a temporary file first, then swap it in, so a restart mid-save can never leave a half-written database.
function writeDB(data) {
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

// ---- Force HTTPS (Railway terminates SSL and tells us the original protocol) ----
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] === 'http' && process.env.RAILWAY_PUBLIC_DOMAIN) {
    return res.redirect(308, `https://${req.headers.host}${req.originalUrl || req.url}`);
  }
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

const smallJson = express.json({ limit: '50kb' });
const logoJson = express.json({ limit: '3mb' });
// Logo uploads carry an image, so they get a bigger limit; everything else stays small.
app.use((req, res, next) => (/^\/api\/leads\/[^/]+\/logo$/.test(req.path) ? logoJson : smallJson)(req, res, next));

// ---- Spam protection: simple per-IP rate limits for public forms (in memory, resets on redeploy) ----
const hits = new Map();
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(); }
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${clientIp(req)}`;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'Too many tries. Please wait a few minutes and try again.' });
    }
    list.push(now);
    hits.set(key, list);
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600000)) hits.delete(k); }, 600000).unref();

// Pages that get the live site address (social previews) and the optional analytics snippet.
// Analytics: set PLAUSIBLE_DOMAIN (e.g. intheloop.com) or CLOUDFLARE_ANALYTICS_TOKEN in Railway. Both are cookie-free.
function analyticsSnippet() {
  if (process.env.PLAUSIBLE_DOMAIN) return `<script defer data-domain="${escHtml(process.env.PLAUSIBLE_DOMAIN)}" src="https://plausible.io/js/script.js"></script>`;
  if (process.env.CLOUDFLARE_ANALYTICS_TOKEN) return `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${escHtml(process.env.CLOUDFLARE_ANALYTICS_TOKEN)}"}'></script>`;
  return '';
}
function sendPage(res, file, { analytics = false } = {}) {
  let html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8').split('__BASE_URL__').join(publicBaseUrl());
  if (analytics) html = html.replace('</head>', `${analyticsSnippet()}\n</head>`);
  res.type('html').send(html);
}

// ---- Optional admin password for the CRM itself ----
// Set ADMIN_PASSWORD in Railway Variables. Guest (check-in) and staff (redeem) pages stay open.
const PUBLIC_PREFIXES = ['/unsubscribe/', '/welcome', '/media/', '/js/welcome.js', '/js/confetti.js', '/checkin/', '/redeem/', '/api/public/', '/api/sms/inbound', '/js/checkin.js', '/js/redeem.js', '/favicon', '/apple-touch-icon.png', '/privacy', '/terms', '/robots.txt', '/sitemap.xml', '/owner/', '/logo/', '/rules'];
app.use((req, res, next) => {
  const pass = process.env.ADMIN_PASSWORD;
  // Only the CRM itself and its data APIs need the password; every other address is public
  // (so a mistyped link shows the friendly 404 page instead of a login box).
  const p0 = req.path;
  const isAdmin = p0 === '/' || p0 === '/index.html' || p0 === '/js/app.js'
    || (p0.startsWith('/api/') && !PUBLIC_PREFIXES.some((p) => p0.startsWith(p)));
  if (!pass || !isAdmin) return next();
  const header = req.headers.authorization || '';
  const [, encoded] = header.split(' ');
  const decoded = encoded ? Buffer.from(encoded, 'base64').toString() : '';
  const given = decoded.slice(decoded.indexOf(':') + 1);
  if (given && given.length === pass.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pass))) return next();
  res.set('WWW-Authenticate', 'Basic realm="Tuesday Club CRM"');
  res.status(401).send('Login required');
});

app.use(express.static(path.join(__dirname, 'public')));

// Official rules for the monthly free-meal draw (linked from every guest page)
app.get('/rules', (req, res) => sendPage(res, 'rules.html'));

// The public check-in page a QR code / NFC tag points to: /checkin/<restaurantId>
app.get('/checkin/:restaurantId', (req, res) => {
  sendPage(res, 'checkin.html');
});

// Guest privacy policy + program terms (linked under the sign-up button and in every text registration)
app.get(['/privacy', '/terms'], (req, res) => {
  const contact = process.env.SUPPORT_CONTACT || process.env.ADMIN_EMAIL || 'reply to any message from us';
  const html = fs.readFileSync(path.join(__dirname, 'public', 'privacy.html'), 'utf8')
    .replace('{{CONTACT}}', escHtml(contact))
    .replace('{{ADDRESS}}', escHtml(process.env.BUSINESS_ADDRESS || 'Tuesday Club, Worcester, MA'));
  res.type('html').send(html);
});

// Public landing page with the VSL + booking form: /welcome
app.get('/welcome', (req, res) => {
  sendPage(res, 'welcome.html', { analytics: true });
});

// Search engines: only the landing page and privacy page should be found.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /welcome\nAllow: /privacy\nAllow: /media/\nDisallow: /\n\nSitemap: ${publicBaseUrl()}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
  const base = publicBaseUrl();
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/welcome</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${base}/privacy</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>
</urlset>`);
});

// The staff redeem page is retired: the guest's phone screen is the redemption. Old links go to the guest page.
app.get('/redeem/:restaurantId', (req, res) => {
  res.redirect(302, `/checkin/${encodeURIComponent(req.params.restaurantId)}`);
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
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed · Tuesday Club</title><link rel="icon" href="/favicon.svg?v=4" type="image/svg+xml"><link rel="icon" href="/favicon-32.png?v=4" sizes="32x32" type="image/png"><link rel="shortcut icon" href="/favicon.ico?v=4"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=4">
    <body style="font-family:Arial,sans-serif;background:#fff1d6;color:#1d1640;text-align:center;padding:60px 20px">
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
    redeemDays: cleanDays(req.body.redeemDays),
    redeemFrom: cleanTime(req.body.redeemFrom),
    redeemTo: cleanTime(req.body.redeemTo),
    drawEnabled: req.body.drawEnabled === true, // new restaurants start with the draw off
    drawCap: cleanMoney(req.body.drawCap),
    baselineWeekly: cleanAmount(req.body.baselineWeekly),
    ownerPin: cleanOwnerPin(req.body.ownerPin),
    avgCheck: cleanPrice(req.body.avgCheck), mocTier: MOC_TIERS[req.body.mocTier] ? req.body.mocTier : 'casual',
    mocReward: cleanPrice(req.body.mocReward), mocPrize: cleanPrice(req.body.mocPrize), mocFood: cleanPct(req.body.mocFood),
    ...(req.body.promoPicks !== undefined ? { promoPicks: cleanPromoPicks(req.body.promoPicks) } : {}),
    prize2: req.body.prize2 || '',
    prize3: req.body.prize3 || '',
    prize5: req.body.prize5 || '',
    prize10: req.body.prize10 || '',
    prizestreak2: req.body.prizestreak2 || '',
    prizestreak4: req.body.prizestreak4 || '',
    prizestreak8: req.body.prizestreak8 || '',
    minSpend: cleanMoney(req.body.minSpend),
    minSpendBig: cleanMoney(req.body.minSpendBig),
    smsEnabled: req.body.smsEnabled === true, // texting is a prepaid add-on; off until the owner buys it
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
  delete body.logoFile; delete body.logoVersion; delete body.ownerToken; // set only by their own endpoints
  if (body.smsEnabled !== undefined) body.smsEnabled = body.smsEnabled === true;
  if (body.minSpend !== undefined) body.minSpend = cleanMoney(body.minSpend);
  if (body.minSpendBig !== undefined) body.minSpendBig = cleanMoney(body.minSpendBig);
  if (body.redeemDays !== undefined) body.redeemDays = cleanDays(body.redeemDays);
  if (body.redeemFrom !== undefined) body.redeemFrom = cleanTime(body.redeemFrom);
  if (body.redeemTo !== undefined) body.redeemTo = cleanTime(body.redeemTo);
  if (body.drawEnabled !== undefined) body.drawEnabled = body.drawEnabled !== false;
  if (body.drawCap !== undefined) body.drawCap = cleanMoney(body.drawCap);
  if (body.baselineWeekly !== undefined) body.baselineWeekly = cleanAmount(body.baselineWeekly);
  if (body.ownerPin !== undefined) body.ownerPin = cleanOwnerPin(body.ownerPin);
  if (body.avgCheck !== undefined) body.avgCheck = cleanPrice(body.avgCheck);
  if (body.mocTier !== undefined) body.mocTier = MOC_TIERS[body.mocTier] ? body.mocTier : 'casual';
  if (body.mocReward !== undefined) body.mocReward = cleanPrice(body.mocReward);
  if (body.mocPrize !== undefined) body.mocPrize = cleanPrice(body.mocPrize);
  if (body.mocFood !== undefined) body.mocFood = cleanPct(body.mocFood);
  if (body.promoPicks !== undefined) body.promoPicks = cleanPromoPicks(body.promoPicks);
  delete body.promoSent;
  delete body.bank;
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

// Delete one guest for good (privacy requests, test sign-ups). Removes their visits and messages;
// past redemptions stay in the totals but no longer point to the person.
app.delete('/api/leads/:id/customers/:customerId', (req, res) => {
  const db = readDB();
  const c = db.customers.find((x) => x.id === req.params.customerId && x.restaurantId === req.params.id);
  if (!c) return res.status(404).json({ error: 'Guest not found' });
  db.customers = db.customers.filter((x) => x.id !== c.id);
  db.visits = db.visits.filter((v) => v.customerId !== c.id);
  db.messages = db.messages.filter((m) => m.customerId !== c.id);
  db.redemptions.forEach((r) => { if (r.customerId === c.id) { r.customerId = null; r.rewardIdEntered = 'deleted'; delete r.name; delete r.phone; } });
  db.draws.forEach((d) => { if (d.winnerId === c.id) { d.winnerId = null; d.winnerName = 'Removed guest'; } });
  writeDB(db);
  res.json({ ok: true });
});

// Guest list export (CSV opens in Excel, Numbers or Google Sheets).
function guestCsv(db, lead) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^(=|@|[+\-](?!\d))/.test(s)) s = "'" + s; // stop spreadsheet formulas from running (phone numbers like +1508 are left alone)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
  const header = ['Name', 'Phone', 'Email', 'Reward ID', 'Joined', 'Visits', 'Rewards redeemed', 'First visit reason', 'OK to text', 'Unsubscribed from email'];
  const rows = db.customers
    .filter((c) => c.restaurantId === lead.id)
    .sort((a, b) => new Date(a.optedInAt) - new Date(b.optedInAt))
    .map((c) => [c.name, c.phone, c.email, c.rewardId, day(c.optedInAt), c.checkinCount || 1, c.redemptionCount || 0,
      VISIT_TYPES[c.firstVisitType] || '', c.smsConsent === true && !c.optedOut ? 'Yes' : 'No', c.emailOptOut ? 'Yes' : 'No']);
  return '\ufeff' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
function sendCsv(res, lead, csv) {
  const safe = lead.restaurantName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'restaurant';
  res.set('Content-Disposition', `attachment; filename="${safe}-guest-list.csv"`);
  res.type('text/csv').send(csv);
}
// CRM (login required)
app.get('/api/leads/:id/customers.csv', (req, res) => {
  const db = readDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).send('Not found');
  sendCsv(res, lead, guestCsv(db, lead));
});

// ---- Restaurant logos: uploaded in the CRM, stored on the data volume, shown on the guest page and owner page ----
const LOGO_DIR = path.join(DATA_DIR, 'logos');
const LOGO_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
function logoUrl(lead) { return lead && lead.logoFile ? `/logo/${lead.id}?v=${lead.logoVersion || 1}` : null; }
function sniffImage(buf) { // trust the file's bytes, not its name
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
app.post('/api/leads/:id/logo', (req, res) => {
  const db = readDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const m = /^data:[^;]+;base64,(.+)$/.exec(String(req.body.dataUrl || ''));
  if (!m) return res.status(400).json({ error: 'Pick a PNG, JPG or WEBP image.' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'That image is over 2 MB. Try a smaller one.' });
  const ext = sniffImage(buf);
  if (!ext) return res.status(400).json({ error: 'That file is not a PNG, JPG or WEBP image.' });
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  if (lead.logoFile) { try { fs.unlinkSync(path.join(LOGO_DIR, lead.logoFile)); } catch (e) {} }
  lead.logoFile = `${lead.id}.${ext}`;
  lead.logoVersion = Date.now();
  fs.writeFileSync(path.join(LOGO_DIR, lead.logoFile), buf);
  writeDB(db);
  res.json({ logoUrl: logoUrl(lead) });
});
app.delete('/api/leads/:id/logo', (req, res) => {
  const db = readDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  if (lead.logoFile) { try { fs.unlinkSync(path.join(LOGO_DIR, lead.logoFile)); } catch (e) {} }
  lead.logoFile = null;
  writeDB(db);
  res.json({ logoUrl: null });
});
app.get('/logo/:id', (req, res) => {
  const db = readDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  const file = lead && lead.logoFile ? path.join(LOGO_DIR, path.basename(String(lead.logoFile))) : null;
  if (!file || !fs.existsSync(file)) return res.status(404).send('No logo');
  res.set('Cache-Control', 'public, max-age=604800');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(LOGO_TYPES[lead.logoFile.split('.').pop()] || 'application/octet-stream').send(fs.readFileSync(file));
});

// ---- Owner page: a private, read-only link per restaurant (no password). The secret link is the key. ----
function ensureOwnerToken(lead) {
  if (!lead.ownerToken) lead.ownerToken = crypto.randomBytes(18).toString('base64url');
  return lead.ownerToken;
}
const ownerUrl = (lead) => `${publicBaseUrl()}/owner/${lead.ownerToken}`;
function leadByOwnerToken(db, token) {
  const t = String(token || '');
  return t.length >= 20 ? db.leads.find((l) => l.ownerToken && l.ownerToken === t) : null;
}
app.get('/api/leads/:id/owner-link', (req, res) => {
  const db = readDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const had = !!lead.ownerToken;
  ensureOwnerToken(lead);
  if (!had) writeDB(db);
  res.json({ url: ownerUrl(lead) });
});
app.post('/api/leads/:id/owner-link/reset', (req, res) => {
  const db = readDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  lead.ownerToken = null;
  ensureOwnerToken(lead);
  writeDB(db);
  res.json({ url: ownerUrl(lead) });
});
// Optional owner PIN (4-6 digits, set in the CRM). The link alone is no longer enough when a PIN is set.
function cleanOwnerPin(v) { const t = String(v == null ? '' : v).trim(); return /^\d{4,6}$/.test(t) ? t : ''; }
const ownerPinKey = (lead) => crypto.createHash('sha256').update(`${lead.ownerToken}:${lead.ownerPin}:${process.env.ADMIN_PASSWORD || 'tc'}`).digest('base64url').slice(0, 32);
const ownerCookieName = (lead) => `tc_owner_${String(lead.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
function readCookie(req, name) {
  const m = String(req.headers.cookie || '').split(/;\s*/).find((p) => p.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
const ownerUnlocked = (req, lead) => !lead.ownerPin || readCookie(req, ownerCookieName(lead)) === ownerPinKey(lead);
function ownerPinPage(lead, wrong) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(lead.restaurantName)} · Tuesday Club results</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg?v=4" type="image/svg+xml"><link rel="icon" href="/favicon-32.png?v=4" sizes="32x32" type="image/png"><link rel="shortcut icon" href="/favicon.ico?v=4"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=4">
</head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#fff6e6;color:#1d1640;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;padding:16px;box-sizing:border-box">
<form method="post" action="/owner/${encodeURIComponent(lead.ownerToken)}/pin" style="background:#fff;border:1px solid #ece4f7;border-radius:22px;padding:26px 22px;max-width:340px;width:100%;text-align:center;box-shadow:0 10px 30px rgba(61,26,168,.08)">
<div style="font-weight:800;letter-spacing:.06em;font-size:14px;color:#5b2ee5">TUESDAY<span style="color:#d81b6a"> CLUB</span></div>
${lead.logoFile ? `<img src="${logoUrl(lead)}" alt="" style="display:block;max-height:64px;max-width:180px;margin:14px auto 0;border-radius:10px">` : ''}
<h1 style="font-size:20px;margin:14px 0 4px">${escHtml(lead.restaurantName)}</h1>
<p style="margin:0 0 16px;color:#5c5578">Enter your PIN to see your results.</p>
<input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="current-password" autofocus required aria-label="PIN"
 style="width:100%;box-sizing:border-box;font-size:26px;letter-spacing:10px;text-align:center;padding:12px;border:2px solid #ece4f7;border-radius:14px">
${wrong ? '<p style="color:#d81b6a;margin:10px 0 0;font-weight:700">That PIN didn\'t match. Try again.</p>' : ''}
<button style="margin-top:16px;width:100%;padding:13px;border:0;border-radius:999px;background:#5b2ee5;color:#fff;font-weight:800;font-size:16px">Open</button>
<p style="margin:14px 0 0;font-size:12px;color:#5c5578">Forgot it? Ask your Tuesday Club contact.</p></form></body></html>`;
}
app.post('/owner/:token/pin', rateLimit('ownerpin', 10, 15 * 60 * 1000), express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  const db = readDB();
  const lead = leadByOwnerToken(db, req.params.token);
  if (!lead) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  const base = `/owner/${encodeURIComponent(lead.ownerToken)}`;
  if (!lead.ownerPin) return res.redirect(303, base);
  const given = String((req.body && req.body.pin) || '').trim();
  const ok = given.length === lead.ownerPin.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(lead.ownerPin));
  if (!ok) { res.set('Cache-Control', 'no-store'); return res.status(401).send(ownerPinPage(lead, true)); }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.set('Set-Cookie', `${ownerCookieName(lead)}=${ownerPinKey(lead)}; Path=${base}; Max-Age=${90 * 24 * 3600}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  res.redirect(303, base);
});
app.post('/owner/:token/messages', rateLimit('owner', 60, 10 * 60 * 1000), express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const db = readDB();
  const lead = leadByOwnerToken(db, req.params.token);
  if (!lead) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  const base = `/owner/${encodeURIComponent(lead.ownerToken)}`;
  if (!ownerUnlocked(req, lead)) return res.redirect(303, base);
  lead.promoPicks = cleanPromoPicks(req.body && req.body.picks);
  lead.updatedAt = new Date().toISOString();
  writeDB(db);
  res.redirect(303, `${base}?saved=1#messages`);
});
app.post('/owner/:token/draw', rateLimit('owner', 60, 10 * 60 * 1000), express.urlencoded({ extended: false, limit: '1kb' }), (req, res) => {
  const db = readDB();
  const lead = leadByOwnerToken(db, req.params.token);
  if (!lead) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  const base = `/owner/${encodeURIComponent(lead.ownerToken)}`;
  if (!ownerUnlocked(req, lead)) return res.redirect(303, base);
  lead.drawEnabled = String(req.body && req.body.on) === '1';
  lead.updatedAt = new Date().toISOString();
  writeDB(db);
  res.redirect(303, `${base}?draw=1#draw`);
});
// CRM: the same message menu with previews
app.get('/api/leads/:id/promos', (req, res) => {
  const db = readDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json({ cap: PROMO_MONTHLY_CAP, items: promoMenu(lead) });
});
app.get('/owner/:token/guests.csv', rateLimit('owner', 60, 10 * 60 * 1000), (req, res) => {
  const db = readDB();
  const lead = leadByOwnerToken(db, req.params.token);
  if (!lead) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  if (!ownerUnlocked(req, lead)) return res.redirect(303, `/owner/${encodeURIComponent(lead.ownerToken)}`);
  sendCsv(res, lead, guestCsv(db, lead));
});
function ownerDrawBox(db, lead, drawSaved) {
  const w = windowLabel(lead);
  const mk = monthKey(localDay(new Date()));
  const entries = monthEntries(db, lead.id, mk);
  const total = [...entries.values()].reduce((a, b) => a + b, 0);
  const last = lastDraw(db, lead.id);
  const on = drawOn(lead);
  const drawLine = !on ? 'The monthly free-meal draw is off. Guests see nothing about it.'
    : `${total} ${total === 1 ? 'entry' : 'entries'} from ${entries.size} ${entries.size === 1 ? 'guest' : 'guests'} so far in ${monthName(mk)}. Winner picked ${nextDrawLabel(mk)} (meal up to $${drawCap(lead)}).`;
  const lastLine = last ? (last.winnerName ? `Last winner: <b>${escHtml(last.winnerName)}</b> · ${last.claimedAt ? 'claimed' : 'not claimed yet'}` : 'Last month: no entries, no winner.') : '';
  return `<div style="background:#5b2ee5;color:#fff;border-radius:18px;padding:16px 18px;margin-bottom:16px">
    <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#ffc83d;font-weight:700">Rewards are used</p>
    <p style="margin:2px 0 10px;font-size:22px;font-weight:800">${escHtml(w)}</p>
    <p style="margin:0">${drawLine}</p>${lastLine ? `<p style="margin:6px 0 0">${lastLine}</p>` : ''}
    <form method="post" action="/owner/${encodeURIComponent(lead.ownerToken)}/draw" id="draw" style="margin:12px 0 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <input type="hidden" name="on" value="${on ? '0' : '1'}">
      <button style="padding:9px 16px;border:0;border-radius:999px;font-weight:800;font-size:14px;cursor:pointer;${on ? 'background:transparent;color:#fff;box-shadow:inset 0 0 0 2px #fff' : 'background:#ffc83d;color:#1d1640'}">${on ? 'Turn the free-meal draw off' : 'Turn the free-meal draw on'}</button>
      ${drawSaved ? `<span style="font-weight:700;color:#ffc83d">${on ? 'Draw is on.' : 'Draw is off.'}</span>` : ''}
    </form>
    <p style="margin:8px 0 0;font-size:12px;opacity:.85">${on ? 'Turning it off stops new entries. A winner who already won can still claim their meal.' : `Turn it on and every check-in is an entry. One winner a month gets their meal free, up to $${drawCap(lead)}.`}</p></div>`;
}
app.get('/owner/:token', rateLimit('owner', 60, 10 * 60 * 1000), (req, res) => {
  const db = readDB();
  const lead = leadByOwnerToken(db, req.params.token);
  if (!lead) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  if (!ownerUnlocked(req, lead)) { res.set('Cache-Control', 'no-store'); return res.send(ownerPinPage(lead, false)); }
  const which = req.query.period === 'last' ? 'last' : 'current';
  const { html } = buildOwnerReport(db, lead, which);
  const members = db.customers.filter((c) => c.restaurantId === lead.id).length;
  const base = `/owner/${encodeURIComponent(lead.ownerToken)}`;
  const tab = (p, label) => `<a href="${base}${p === 'last' ? '?period=last' : ''}" style="padding:8px 14px;border-radius:999px;text-decoration:none;font-weight:700;${which === p ? 'background:#5b2ee5;color:#fff1d6' : 'color:#5b2ee5;border:1px solid #e6dcf7'}">${label}</a>`;
  res.set('Cache-Control', 'no-store');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(lead.restaurantName)} · Tuesday Club results</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg?v=4" type="image/svg+xml"><link rel="icon" href="/favicon-32.png?v=4" sizes="32x32" type="image/png"><link rel="shortcut icon" href="/favicon.ico?v=4"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=4">
</head><body style="margin:0;background:#fff6e6;color:#1d1640;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<header style="background:#5b2ee5;color:#fff1d6;padding:20px 16px"><div style="max-width:640px;margin:0 auto">
<div style="font-weight:800;letter-spacing:.06em;font-size:14px">TUESDAY<span style="color:#ffc83d"> CLUB</span></div>
${lead.logoFile ? `<img src="${logoUrl(lead)}" alt="${escHtml(lead.restaurantName)} logo" style="display:block;max-height:64px;max-width:200px;margin-top:12px;border-radius:10px;background:#fff;padding:6px">` : ''}
<h1 style="font-weight:400;font-size:28px;margin:6px 0 2px">${escHtml(lead.restaurantName)}</h1>
<p style="margin:0;opacity:.85">${members} ${members === 1 ? 'guest' : 'guests'} in your club · updated live</p></div></header>
<main style="max-width:640px;margin:0 auto;padding:18px 16px 40px">
<nav style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">${tab('current', 'This month')}${tab('last', 'Last month')}
<a href="${base}/guests.csv" style="padding:8px 14px;border-radius:999px;text-decoration:none;font-weight:700;background:#d81b6a;color:#fff">Download guest list</a></nav>
${ownerDrawBox(db, lead, req.query.draw === '1')}
${ownerMathBox(lead)}
${ownerMessagesBox(db, lead, req.query.saved === '1')}
${html}
<p style="color:#5c5578;font-size:13px;margin-top:24px">This page is private to your restaurant. Don't share the link. Questions? Text or email Christopher.</p>
</main></body></html>`);
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

// Minimum order to redeem: a whole-dollar amount, or null for no minimum.
// Whole-dollar amounts with no small cap (weekly sales figures).
function cleanAmount(v) {
  const n = Math.round(Number(String(v ?? '').replace(/[^0-9.]/g, '')));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10000000) : null;
}
function cleanMoney(v) {
  const n = Math.round(Number(String(v ?? '').replace(/[^0-9.]/g, '')));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : null;
}
// Menu prices and checks keep cents (to the nearest 50c).
function cleanPrice(v) {
  const n = Math.round(Number(String(v ?? '').replace(/[^0-9.]/g, '')) * 2) / 2;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : null;
}
function cleanPct(v) {
  const n = Math.round(Number(String(v ?? '').replace(/[^0-9.]/g, '')));
  return Number.isFinite(n) && n >= 5 && n <= 80 ? n : null;
}

// ---- Minimum order calculator: the math runs in the CRM (public/js/app.js); these are the saved inputs ----
const MOC_TIERS = { cafe: { label: 'Café / quick', share: 0.60, big: 1.0 }, casual: { label: 'Casual', share: 0.65, big: 1.0 },
  mid: { label: 'Mid-range', share: 0.70, big: 1.1 }, high: { label: 'High-end', share: 0.75, big: 1.2 } };
const money2 = (n) => `$${(Math.round(n * 100) / 100).toFixed(n % 1 ? 2 : 0)}`;
// Owner page card: the minimums and what a reward really costs them
function ownerMathBox(lead) {
  const A = Number(lead.minSpend) || 0;
  if (!A) return '';
  const B = 0; // one minimum for everything
  const reward = Number(lead.mocReward) || 0; const prize = Number(lead.mocPrize) || 0;
  const f = (Number(lead.mocFood) || 30) / 100;
  const lines = [];
  if (reward) {
    const cost = reward * f;
    lines.push(`A ${money2(reward)} reward costs you about <b>${money2(cost)}</b> in food, ${Math.round(cost / A * 100)}% of a minimum order.`);
    lines.push(`Left on a ${money2(A)} order after food cost and the reward: about <b>${money2(Math.max(0, A * (1 - f) - cost))}</b> (before labor and rent).`);
  }
  if (prize) {
    const pmin = B || A;
    lines.push(`The 5th-visit prize (${money2(prize)} on the menu) costs you about <b>${money2(prize * f)}</b>, once every 5 visits, on a ${money2(pmin)}+ order.`);
  }
  return `<div style="background:#fff;border:1px solid #ece4f7;border-radius:18px;padding:16px 18px;margin:16px 0">
    <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#0b8a74;font-weight:700">Your reward math</p>
    <p style="margin:4px 0 8px;font-size:20px;font-weight:800">Rewards need a ${money2(A)}+ order${B ? `. Prizes need ${money2(B)}+.` : '.'}</p>
    ${lines.map((l) => `<p style="margin:6px 0;font-size:15px">${l}</p>`).join('')}
    <p style="margin:8px 0 0;font-size:13px;color:#5c5578">Guests see the minimum on their screen. If someone shares a code, you still get a paying order${lines.length ? `, worked out at ${Math.round(f * 100)}% food cost` : ''}.</p></div>`;
}

function escHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Texts need: the restaurant's prepaid text add-on, the guest's own checkbox consent, and no STOP.
function smsAllowed(c, restaurant) { return !!(restaurant && restaurant.smsEnabled) && c.smsConsent === true && !c.optedOut && !!c.phone; }
function canText(c, restaurant) { return !SIMULATION_MODE && smsAllowed(c, restaurant); }
// Email is separate from text consent: guests can decline texts and still get email (unsubscribe link in every one).
function canEmail(c) { return !!c.email && !c.emailOptOut; }
// Callers without the restaurant handy only check the guest's side; notifyGuest re-checks the restaurant's text add-on.
function canMessage(c, restaurant) { return (restaurant ? smsAllowed(c, restaurant) : (c.smsConsent === true && !c.optedOut && !!c.phone)) || canEmail(c); }

const SMS_CONSENT_TEXT = (name) => `Yes, text me rewards, reminders and offers from ${name}. Up to 4 msgs/month. Msg & data rates may apply. Reply STOP to cancel, HELP for help. Consent is not a condition of purchase.`;
function recordSmsConsent(customer, restaurant, req) {
  customer.smsConsent = true;
  customer.optedOut = false;
  customer.smsConsentAt = new Date().toISOString();
  customer.smsConsentText = SMS_CONSENT_TEXT(restaurant.restaurantName);
  customer.smsConsentSource = 'checkin_page_checkbox';
  customer.smsConsentIp = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
}

// Guest-facing email wrapper with the legally required unsubscribe link + mailing address (CAN-SPAM).
function guestEmailHtml(restaurant, customer, bodyHtml) {
  ensureDeviceToken(customer);
  const unsub = `${publicBaseUrl()}/unsubscribe/${customer.deviceToken}`;
  const address = process.env.BUSINESS_ADDRESS ? `<br>${escHtml(process.env.BUSINESS_ADDRESS)}` : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1d1640">
    ${restaurant.logoFile ? `<img src="${publicBaseUrl()}${logoUrl(restaurant)}" alt="${escHtml(restaurant.restaurantName)}" style="display:block;max-height:64px;max-width:200px;margin:0 0 10px">` : ''}
    <h2 style="margin:0 0 12px">${escHtml(restaurant.restaurantName)}</h2>
    ${bodyHtml}
    <p style="font-size:11px;color:#8a8175;margin-top:28px;border-top:1px solid #e6dccb;padding-top:10px">
      You're getting this because you joined ${escHtml(restaurant.restaurantName)}'s Tuesday Club.
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
  } else if (canText(customer, restaurant)) {
    channel = 'sms';
    result = await sendSms(customer.phone, sms);
  } else if (canEmail(customer)) {
    channel = 'email';
    result = await sendEmail({
      to: customer.email, subject, fromName: restaurant.restaurantName,
      html: guestEmailHtml(restaurant, customer, html),
    });
  } else if (smsAllowed(customer, restaurant)) {
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
    smsEnabled: !!restaurant.smsEnabled,
    minSpend: restaurant.minSpend || null,
    minSpendBig: null, // one minimum for everything (simple offer)
    bigPrize: VISIT_MILESTONES.length ? { n: VISIT_MILESTONES[0], prize: prizeFor(restaurant, VISIT_MILESTONES[0]) } : null,
    logoUrl: logoUrl(restaurant),
    window: windowInfo(restaurant),
    draw: drawStatusFor(db, restaurant, null),
  });
});

app.post('/api/public/checkin', rateLimit('checkin', 40, 10 * 60 * 1000), async (req, res) => {
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
  // Text consent is optional and separate (carrier + TCPA rules); only counts if this restaurant offers texts.
  const wantsTexts = req.body.smsConsent === true && !!restaurant.smsEnabled;

  // Same phone OR same email at this restaurant = same guest: no new ID, no double reward.
  let customer = db.customers.find(
    (c) => c.restaurantId === restaurantId && (c.phone === phone || (email && c.email === email))
  );
  const now = new Date().toISOString();
  const isNewCustomer = !customer;
  if (customer) {
    customer.name = name || customer.name;
    if (email && !customer.email) customer.email = email;
    if (wantsTexts) recordSmsConsent(customer, restaurant, req);
  } else {
    customer = {
      id: crypto.randomUUID(),
      restaurantId,
      rewardId: nextRewardId(restaurant, db),
      name: name || '',
      phone,
      email,
      smsConsent: false,
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
    if (wantsTexts) recordSmsConsent(customer, restaurant, req);
    db.customers.unshift(customer);
  }
  ensureDeviceToken(customer);
  const scan = processScan(db, restaurant, customer, logVisit(db, customer, visitType, 'form'));
  writeDB(db);

  // Welcome text with their Reward ID the moment a brand-new guest opts in.
  if (isNewCustomer) {
    const offer = restaurant.currentOffer ? `Your reward: ${restaurant.currentOffer}. ` : '';
    await notifyGuest(db, restaurant, customer, 'welcome', {
      sms: `Welcome to ${restaurant.restaurantName}'s Tuesday Club! ${offer}Rewards are good ${windowLabel(restaurant)}. Your member ID is ${customer.rewardId}. Every visit also enters you in the monthly free-meal draw. Reply STOP to opt out.`,
      subject: `Welcome to ${restaurant.restaurantName}'s Tuesday Club! Here's your member ID`,
      html: `<p>Thanks for joining${customer.name ? ', ' + escHtml(customer.name) : ''}!</p>
        ${restaurant.currentOffer ? `<p>On your <b>next visit</b> you get: <b>${escHtml(restaurant.currentOffer)}</b></p>` : ''}
        <p>Your rewards are good <b>${escHtml(windowLabel(restaurant))}</b>. Visit any night to earn them, then scan the tag at your table on a Club Night and show your server the code.</p>
        ${drawOn(restaurant) ? `<p>Every day you check in also enters you in the <b>monthly free-meal draw</b> (meal up to $${drawCap(restaurant)}). <a href="${publicBaseUrl()}/rules">Rules</a></p>` : ''}
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
    progress: progressFor(db, restaurant, customer),
    offer: restaurant.currentOffer,
    restaurantName: restaurant.restaurantName,
    window: windowInfo(restaurant),
  });
});

// Returning guest: the check-in page sends the token saved on their phone, no form needed.
app.post('/api/public/returning', rateLimit('returning', 60, 10 * 60 * 1000), (req, res) => {
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
      progress: progressFor(db, restaurant, here),
      customer: publicCustomer(here),
      status: passStatus(here),
      visitType: here.lastVisitType || '',
      offer: restaurant.currentOffer,
      restaurantName: restaurant.restaurantName,
      window: windowInfo(restaurant),
    });
  }

  // Known guest from another restaurant: offer one-tap join (they still tick consent for THIS place).
  res.json({ member: false, knownGuest: true, name: known.name, phoneHint: maskPhone(known.phone) });
});

// Landing-page booking form -> becomes a New Lead in the CRM pipeline
app.post('/api/public/book', rateLimit('book', 5, 60 * 60 * 1000), (req, res) => {
  // Bots fill the hidden "website" field or submit instantly; pretend it worked so they don't retry.
  const tooFast = Number(req.body.elapsedMs) > 0 && Number(req.body.elapsedMs) < 2500;
  if (req.body.website || tooFast) return res.status(201).json({ ok: true });
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
  notifyBooking(lead, when).catch((e) => console.error('Booking email failed:', e.message));
});

// Landing-page bookings: alert Christopher right away, and confirm to the owner if they left an email.
// The alert address comes from BOOKING_ALERT_EMAIL in Railway, with Christopher's address as the default.
async function notifyBooking(lead, when) {
  const to = process.env.BOOKING_ALERT_EMAIL || 'wint_christopher@yahoo.com';
  const crm = `${publicBaseUrl()}/`;
  const row = (k, v) => `<tr><td style="padding:6px 12px 6px 0;color:#5c5578">${k}</td><td style="padding:6px 0"><b>${escHtml(v || 'not given')}</b></td></tr>`;
  await sendEmail({
    to,
    fromName: 'Tuesday Club',
    subject: `New meeting request: ${lead.restaurantName}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;color:#1d1640">
      <h2 style="margin:0 0 6px">New meeting request</h2>
      <p style="margin:0 0 14px;color:#5c5578">Someone booked from the Tuesday Club landing page.</p>
      <table style="border-collapse:collapse;font-size:15px">
        ${row('Restaurant', lead.restaurantName)}${row('Phone', lead.phone)}${row('Email', lead.email)}${row('Preferred time', when)}
      </table>
      <p style="margin:18px 0"><a href="${crm}" style="background:#d81b6a;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:bold">Open the CRM</a></p>
      <p style="font-size:13px;color:#5c5578">They're in the "New Lead" column. Reply within the hour if you can.</p></div>`,
  });
  if (lead.email) {
    await sendEmail({
      to: lead.email,
      fromName: 'Tuesday Club',
      subject: `We got your request, ${lead.restaurantName}`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;color:#1d1640">
        <h2 style="margin:0 0 10px">Thanks, ${escHtml(lead.restaurantName)}!</h2>
        <p>We got your request to meet${when ? ` on <b>${escHtml(when)}</b>` : ''}. Christopher will confirm the time with you shortly.</p>
        <p>In the meeting, you'll see how a sticker on each table turns first-time guests into regulars, with no app and no tablet for your staff.</p>
        <p style="color:#5c5578">Tuesday Club · Worcester, MA</p></div>`,
    });
  }
}

// Staff redeem: requires the restaurant's staff PIN + the guest's Reward ID.
// A redemption counts as a RETURN visit, so it isn't allowed on the day they signed up,
// and only once per guest per day.
app.post('/api/public/redeem', (req, res) => {
  res.status(410).json({ error: 'The staff redeem page is no longer used. Guests show the screen on their phone instead.' });
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
// Twilio's Advanced Opt-Out also replies to STOP/START/HELP automatically; we keep our records in sync.
// Twilio signs every webhook with your auth token. Requests without a valid signature are ignored,
// so nobody can fake a STOP and switch off a guest's texts.
function validTwilioSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const sig = String(req.headers['x-twilio-signature'] || '');
  if (!token || !sig) return false;
  const url = publicBaseUrl() + (req.originalUrl || req.url);
  const data = Object.keys(req.body || {}).sort().reduce((acc, k) => acc + k + req.body[k], url);
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

app.post('/api/sms/inbound', express.urlencoded({ extended: false }), (req, res) => {
  if (!validTwilioSignature(req)) {
    console.warn('Ignored /api/sms/inbound request without a valid Twilio signature');
    return res.status(403).type('text/xml').send('<Response></Response>');
  }
  const from = normalizePhone(req.body.From);
  const body = (req.body.Body || '').trim().toUpperCase();
  const db = readDB();
  const mine = from ? db.customers.filter((c) => c.phone === from) : [];
  const restaurant = mine.length ? db.leads.find((l) => l.id === mine[0].restaurantId) : null;
  const name = restaurant ? restaurant.restaurantName : 'Tuesday Club';
  const now = new Date().toISOString();
  let reply = '';
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'].includes(body)) {
    mine.forEach((c) => { c.optedOut = true; c.smsConsent = false; c.smsOptOutAt = now; });
    writeDB(db);
  } else if (['START', 'UNSTOP', 'YES'].includes(body)) {
    // Only guests who ticked the box before can rejoin by text.
    mine.filter((c) => c.smsConsentAt).forEach((c) => { c.optedOut = false; c.smsConsent = true; c.smsRejoinedAt = now; });
    writeDB(db);
  } else if (['HELP', 'INFO'].includes(body)) {
    const contact = process.env.SUPPORT_CONTACT || 'reply here';
    reply = `${name} Rewards: For help contact ${contact}. Msg & data rates may apply. Reply STOP to cancel.`;
  }
  res.set('Content-Type', 'text/xml');
  res.send(reply ? `<Response><Message>${escHtml(reply)}</Message></Response>` : '<Response></Response>');
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
      sms: `Still thinking about ${restaurant.restaurantName}? Your offer is waiting: ${restaurant.currentOffer}, good ${windowLabel(restaurant)}. Just scan the QR code at your table. Reply STOP to opt out.`,
      subject: `Your reward at ${restaurant.restaurantName} is waiting`,
      html: `<p>Your reward is still waiting: <b>${escHtml(restaurant.currentOffer)}</b></p><p>Come in <b>${escHtml(windowLabel(restaurant))}</b>, scan the QR code or tap the tag at your table, and show your server the reward code.</p>`,
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
      sms: `Thanks for visiting ${restaurant.restaurantName}! Your reward${restaurant.currentOffer ? ` (${restaurant.currentOffer})` : ''} is good ${windowLabel(restaurant)}: scan the tag at your table.${link ? ` Enjoyed it? A quick Google review helps a lot: ${link}` : ''} Reply STOP to opt out.`,
      subject: `Thanks for visiting ${restaurant.restaurantName}!`,
      html: `<p>${hi} for coming in today!</p>
        <p>Come back <b>${escHtml(windowLabel(restaurant))}</b> and scan the QR code or tap the tag at your table${restaurant.currentOffer ? ` to get <b>${escHtml(restaurant.currentOffer)}</b>` : ''}. Your phone will show a reward code for your server. Every check-in also enters you in the weekly free-meal draw.</p>
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
  const bonusPrizes = valid.filter((x) => x.bonusPrize).length;
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
  const freeMeals = valid.filter((x) => x.freeMeal).length;
  const draws = db.draws.filter((d) => d.restaurantId === lead.id && r.inRange(d.drawnAt));
  const drawEntries = draws.reduce((a, d) => a + (d.entries || 0), 0);
  const savedVisits = db.visits.filter((v) => v.restaurantId === lead.id && v.scanStatus === 'saved' && r.inRange(v.at)).length;
  const stats = { month: r.label, totalMembers: customers.length, newSignups, checkins, returnVisits, returningGuests,
                  avgCheck, estRevenue, messagesSent, reviewAsks, topReasons, firstTimeGuests, regularVisits, bonusPrizes,
                  freeMeals, drawEntries, savedVisits, window: windowLabel(lead) };

  const row = (label, value) => `<tr><td style="padding:8px 0;color:#5c5578">${label}</td><td style="padding:8px 0;text-align:right;font-weight:bold">${value}</td></tr>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1d1640">
    <p style="color:#d81b6a;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin:0">Tuesday Club monthly report</p>
    <h2 style="margin:4px 0 4px">${escHtml(lead.restaurantName)}</h2>
    <p style="margin:0 0 18px;color:#5c5578">${escHtml(r.label)}</p>
    <div style="background:#fff1d6;border-radius:16px;padding:18px;margin-bottom:18px">
      <p style="margin:0;color:#5c5578">Estimated Club Night revenue (${escHtml(windowLabel(lead))})</p>
      <p style="margin:4px 0 0;font-size:34px;font-weight:bold">$${estRevenue.toLocaleString('en-US')}</p>
      <p style="margin:4px 0 0;font-size:12px;color:#5c5578">${returnVisits} Club Night reward visits × $${avgCheck} average check</p>
      ${Number(lead.baselineWeekly) > 0 ? `<p style="margin:10px 0 0;font-size:13px">Before Tuesday Club, your Club Night hours brought in about <b>$${Number(lead.baselineWeekly).toLocaleString('en-US')} a week</b> (your number). This month, club reward visits were worth about <b>$${Math.round(estRevenue / 4.33).toLocaleString('en-US')} a week</b>.</p>` : ''}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      ${row('New members this month', newSignups)}
      ${row('Total club members', customers.length)}
      ${row('Check-ins (scans)', checkins)}
      ${row('Visits that earned a Club Night reward', savedVisits)}
      ${row('Club Night visits (rewards used)', returnVisits)}
      ${row('Different guests who came back', returningGuests)}
      ${row(`${VISIT_MILESTONES.map((n) => `${n}th`).join(' & ')}-visit prizes used`, bonusPrizes)}
      ${drawOn(lead) || drawEntries || freeMeals ? row('Free-meal draw entries', drawEntries) + row('Free meals claimed', freeMeals) : ''}
      ${row('Messages sent to your guests', messagesSent)}
      ${row('Google review requests sent', reviewAsks)}
    </table>
    <p style="margin-top:22px;color:#5c5578;font-size:13px">Questions or want to change your offer? Just reply to this email.<br>— Christopher, Tuesday Club</p>
  </div>`;
  return { stats, html, subject: `${lead.restaurantName}: your Tuesday Club results for ${r.label}`, monthKey: r.key };
}

async function sendOwnerReport(db, lead, which) {
  const report = buildOwnerReport(db, lead, which);
  if (!lead.email) return { status: 'no_email', report };
  ensureOwnerToken(lead);
  const html = report.html + `<p style="font-family:Arial,sans-serif;max-width:560px;margin:16px auto 0"><a href="${ownerUrl(lead)}" style="background:#d81b6a;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:bold">See your live results anytime</a></p>`;
  const result = await sendEmail({ to: lead.email, subject: report.subject, html, fromName: 'Tuesday Club' });
  if (process.env.REPORT_COPY_TO) {
    await sendEmail({ to: process.env.REPORT_COPY_TO, subject: `[copy] ${report.subject}`, html, fromName: 'Tuesday Club' });
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
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owner report preview · Tuesday Club</title><link rel="icon" href="/favicon.svg?v=4" type="image/svg+xml"><link rel="icon" href="/favicon-32.png?v=4" sizes="32x32" type="image/png"><link rel="shortcut icon" href="/favicon.ico?v=4"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=4"><body style="background:#fff6e6;padding:24px">${html}</body>`);
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

// ---- Streak reminders ----
// Thursdays after 11am: guests on a 2+ week streak who haven't been in this week get one nudge.
async function runStreakReminders() {
  if (!STREAK_BADGES.length) return; // streaks are off in the simple offer
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  if (nowLocal.getDay() !== 4 || nowLocal.getHours() < 11) return;
  const db = readDB();
  let sent = 0;
  for (const customer of db.customers) {
    if (!canMessage(customer)) continue;
    const s = streakFor(db, customer);
    if (!s.atRisk || s.weeks < 2 || customer.streakReminderWeek === s.thisWeek) continue;
    const restaurant = db.leads.find((l) => l.id === customer.restaurantId);
    if (!restaurant) continue;
    const next = s.weeks + 1;
    const nextPrize = STREAK_BADGES.includes(next) ? prizeFor(restaurant, `streak${next}`) : '';
    const unlock = nextPrize ? ` Week ${next} unlocks: ${nextPrize}!` : '';
    await notifyGuest(db, restaurant, customer, 'streak_reminder', {
      preferEmail: true,
      sms: `Your ${s.weeks}-week streak at ${restaurant.restaurantName} ends Sunday. Stop in this week to keep it alive.${unlock} Reply STOP to opt out.`,
      subject: `Keep your ${s.weeks}-week streak alive at ${restaurant.restaurantName}`,
      html: `<p style="font-size:40px;font-weight:bold;margin:0">${s.weeks}</p><p style="margin:0 0 12px">week streak</p>
        <p>You've been in ${s.weeks} weeks in a row. Stop by before Sunday to keep your streak alive.${unlock ? `<br><b>${escHtml(unlock.trim())}</b>` : ''}</p>
        <p>Just scan the QR code or tap the tag at your table when you come in.</p>`,
    });
    customer.streakReminderWeek = s.thisWeek;
    sent += 1;
  }
  if (sent) writeDB(db);
}

// ---- Monthly free-meal draw (runs from 9am on the 1st for last month; catches up if the server was down) ----
async function runMonthlyDraws(onlyRestaurantId) {
  const p = localParts(new Date());
  if (!onlyRestaurantId && p.day.endsWith('-01') && p.minutes < 9 * 60) return;
  const lastMk = prevMonth(monthKey(p.day));
  if (lastMk < DRAW_MONTHLY_FROM) return [];
  const db = readDB();
  const done = [];
  for (const r of db.leads) {
    if (onlyRestaurantId ? r.id !== onlyRestaurantId : r.stage !== 'Live Client') continue;
    if (!drawOn(r) || db.draws.some((d) => d.restaurantId === r.id && d.month === lastMk)) continue;
    const entries = monthEntries(db, r.id, lastMk);
    const total = [...entries.values()].reduce((a, b) => a + b, 0);
    const now = new Date().toISOString();
    const draw = { id: crypto.randomUUID(), restaurantId: r.id, month: lastMk, entries: total, players: entries.size,
                   cap: drawCap(r), drawnAt: now, winnerId: null, winnerName: '', claimedAt: null,
                   expiresAt: new Date(Date.now() + BANK_DAYS * 86400000).toISOString() };
    let winner = null;
    if (total) {
      let pick = crypto.randomInt(total);
      for (const [cid, n] of entries) { if (pick < n) { draw.winnerId = cid; break; } pick -= n; }
      winner = db.customers.find((c) => c.id === draw.winnerId) || null;
      if (winner) {
        draw.winnerName = shortName(winner);
        activeBank(winner).push(bankItem('meal', `Free meal up to $${draw.cap}`, { drawId: draw.id, expiresAt: draw.expiresAt }));
      }
    }
    db.draws.unshift(draw);
    done.push({ r, draw, winner });
  }
  if (!done.length) return [];
  writeDB(db);
  for (const { r, draw, winner } of done) {
    const when = windowLabel(r);
    if (winner) {
      await notifyGuest(db, r, winner, 'draw_win', {
        sms: `You won the ${monthName(draw.month)} Tuesday Club free-meal draw at ${r.restaurantName}! Your meal (up to $${draw.cap}) is on us. Come in ${when} within 30 days and scan the tag at your table to claim it. Reply STOP to opt out.`,
        subject: `You won a free meal at ${r.restaurantName}!`,
        html: `<p style="font-size:30px;font-weight:bold;margin:0 0 6px">You won! 🎉</p>
          <p>Your name was drawn in the ${monthName(draw.month)} Tuesday Club free-meal draw at <b>${escHtml(r.restaurantName)}</b>.</p>
          <p style="font-size:18px"><b>Your meal is on us, up to $${draw.cap}.</b></p>
          <p>To claim it, come in <b>${escHtml(when)}</b> within the next 30 days and scan the tag at your table. Your phone will show a <b>FREE MEAL</b> code for your server.</p>`,
      }, { drawId: draw.id });
    }
    if (r.email) {
      await sendEmail({
        to: r.email, fromName: 'Tuesday Club',
        subject: winner ? `${monthName(draw.month)} free-meal winner at ${r.restaurantName}: ${draw.winnerName}` : `No free-meal winner for ${monthName(draw.month)} at ${r.restaurantName}`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1d1640">
          <p style="color:#d81b6a;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin:0">Tuesday Club monthly draw</p>
          <h2 style="margin:4px 0 12px">${escHtml(r.restaurantName)} · ${monthLabel(draw.month)}</h2>
          ${winner ? `<p><b>${escHtml(draw.winnerName)}</b> won a free meal up to <b>$${draw.cap}</b>.</p>
          <p>${draw.entries} ${draw.entries === 1 ? 'entry' : 'entries'} from ${draw.players} ${draw.players === 1 ? 'guest' : 'guests'} in ${monthName(draw.month)}.</p>
          <p>They can claim it ${escHtml(when)} within 30 days. Their phone will show a purple <b>FREE MEAL</b> screen with a code starting with <b>W</b>. Comp their meal up to $${draw.cap}; anything over that, they pay.</p>`
          : `<p>Nobody checked in during ${monthName(draw.month)}, so there was no winner. The next draw is on the 1st of next month.</p>`}
          <p style="color:#5c5578;font-size:13px">— Christopher, Tuesday Club</p></div>`,
      });
    }
  }
  writeDB(db);
  return done.map((d) => d.draw);
}

// CRM: draw history, and a "draw now" button for testing or a missed week
app.get('/api/leads/:id/draws', (req, res) => {
  const db = readDB();
  const list = db.draws.filter((d) => d.restaurantId === req.params.id).slice(0, 12);
  const entries = monthEntries(db, req.params.id, monthKey(localDay(new Date())));
  res.json({ thisMonth: { entries: [...entries.values()].reduce((a, b) => a + b, 0), players: entries.size }, draws: list });
});
app.post('/api/leads/:id/draws/run', async (req, res) => {
  const ran = await runMonthlyDraws(req.params.id);
  if (!ran || !ran.length) return res.status(409).json({ error: "Last month's draw for this restaurant already ran (or the draw is turned off)." });
  res.json(ran[0]);
});

// ---- Member messages the owner picks (checkbox menu on the owner page and in the CRM) ----
// Each pick sends on its own schedule: by email to members who gave one, and by text once texting is on.
// Limits per guest: 1 of these a day and PROMO_MONTHLY_CAP a month (matches the "up to 4 msgs/month" consent).
const PROMO_MONTHLY_CAP = 4;
const PROMO_DEFAULTS = ['sun_prize', 'day_of', 'miss_you'];
const PROMO_TYPES = ['club_night_reminder', 'promo_sun_prize', 'promo_sun_all', 'promo_draw_last', 'promo_winner', 'promo_friend', 'promo_miss_you'];
const PROMO_LIBRARY = [
  { key: 'sun_prize', title: 'Sunday: "Your prize is waiting"', when: 'Sundays at 5pm', who: 'Members with a saved prize or free meal' },
  { key: 'day_of', title: 'Club Night day: "Tonight!"', when: '3 hours before Club Night opens', who: 'Members with something waiting (once a week each)' },
  { key: 'sun_all', title: 'Sunday: "Club Night is this week"', when: 'Sundays at 5pm', who: 'Members with nothing saved yet' },
  { key: 'draw_last', title: 'Last chance for the free-meal draw', when: 'The last Sunday of the month, 5pm', who: 'All members', draw: true },
  { key: 'winner', title: 'Free-meal winner announced', when: 'The 1st, right after the draw', who: 'All members (the winner gets their own message)', draw: true },
  { key: 'friend', title: 'Monday: "Bring a friend"', when: 'Mondays at 11am', who: 'Members who visited in the last 30 days' },
  { key: 'miss_you', title: '"We miss you"', when: 'Sundays at 5pm', who: 'Members not seen in 30+ days (once a month each)' },
];
const PROMO_KEYS = PROMO_LIBRARY.map((x) => x.key);
function cleanPromoPicks(v) {
  const list = Array.isArray(v) ? v : (v == null ? [] : [v]);
  return [...new Set(list.map(String).filter((k) => PROMO_KEYS.includes(k)))];
}
const promoPicks = (r) => (Array.isArray(r.promoPicks) ? r.promoPicks : PROMO_DEFAULTS);
const promoAvailable = (r, item) => !item.draw || drawOn(r);

// The words for each message. sample=true fills in example details for previews.
function promoContent(key, r, { items = [], winnerName = '', drawMonth = '' } = {}) {
  const R = r.restaurantName;
  const when = windowLabel(r);
  const min = r.minSpend ? ` with a $${r.minSpend}+ order` : '';
  const mk = monthKey(localDay(new Date()));
  const month = monthName(mk);
  const draw = drawOn(r);
  const drawLine = draw ? ` Every visit = 1 entry to win a free meal in ${month}.` : '';
  const list = items.length ? items.join(' + ') : 'your prize';
  const STOP = ' Reply STOP to opt out.';
  const cta = '<p>Scan the QR code or tap the tag at your table and show your server the screen.</p>';
  switch (key) {
    case 'sun_prize': return {
      sms: `${R}: your ${list} is waiting! Use it ${when}${min}.${STOP}`,
      subject: `Your ${list} is waiting at ${R}`,
      html: `<p style="font-size:22px;font-weight:bold;margin:0 0 8px">Your prize is waiting!</p>
        <p>Saved for you at <b>${escHtml(R)}</b>: <b>${escHtml(list)}</b>.</p>
        <p>Use it <b>${escHtml(when)}</b>${escHtml(min)}.${escHtml(drawLine)}</p>${cta}` };
    case 'day_of': { const w = redeemWindow(r); return {
      sms: `It's Club Night at ${R} tonight ${fmtClock(w.from)}–${fmtClock(w.to)}! Waiting for you: ${list}. Scan the tag at your table.${STOP}`,
      subject: 'Club Night tonight: your reward is waiting',
      html: `<p style="font-size:22px;font-weight:bold;margin:0 0 8px">It's Club Night tonight!</p>
        <p>Waiting for you at <b>${escHtml(R)}</b>: <b>${escHtml(list)}</b>.</p>${cta}` }; }
    case 'sun_all': return {
      sms: `Club Night at ${R} this week: ${when}. ${draw ? 'Each visit = 1 free-meal draw entry + closer to your next prize.' : 'Every visit gets you closer to your next prize.'}${STOP}`,
      subject: `Club Night this week at ${R}`,
      html: `<p style="font-size:22px;font-weight:bold;margin:0 0 8px">Club Night is this week</p>
        <p><b>${escHtml(R)}</b> · <b>${escHtml(when)}</b></p>
        <p>Every visit gets you closer to your next prize.${escHtml(drawLine)}</p>${cta}` };
    case 'draw_last': return {
      sms: `Last week to enter ${R}'s ${month} free-meal draw (up to $${drawCap(r)})! Each day you check in = 1 entry. Winner picked ${nextDrawLabel(mk)}.${STOP}`,
      subject: `Last week to win a free meal at ${R}`,
      html: `<p style="font-size:22px;font-weight:bold;margin:0 0 8px">Last week to enter!</p>
        <p>The <b>${escHtml(month)}</b> free-meal draw at <b>${escHtml(R)}</b> closes soon. The winner's meal is on us, up to <b>$${drawCap(r)}</b>.</p>
        <p>Each day you check in = 1 entry. Winner picked <b>${escHtml(nextDrawLabel(mk))}</b>. <a href="${publicBaseUrl()}/rules">Rules</a></p>` };
    case 'winner': return {
      sms: `${R}'s ${drawMonth || 'monthly'} free-meal winner: ${winnerName || 'Ana L.'}! The ${month} draw starts now: every check-in = 1 entry.${STOP}`,
      subject: `${drawMonth || 'This month'}'s free-meal winner at ${R}`,
      html: `<p style="font-size:22px;font-weight:bold;margin:0 0 8px">We have a winner!</p>
        <p><b>${escHtml(winnerName || 'Ana L.')}</b> won a free meal at <b>${escHtml(R)}</b> in the ${escHtml(drawMonth || 'monthly')} draw.</p>
        <p>The <b>${escHtml(month)}</b> draw starts now. Every day you check in = 1 entry. <a href="${publicBaseUrl()}/rules">Rules</a></p>` };
    case 'friend': return {
      sms: `Bring a friend to ${R} on Club Night (${when})! They can join the club at the table and start earning too.${STOP}`,
      subject: `Bring a friend to ${R} on Club Night`,
      html: `<p style="font-size:22px;font-weight:bold;margin:0 0 8px">Bring a friend!</p>
        <p>Club Night at <b>${escHtml(R)}</b> is <b>${escHtml(when)}</b>. Your friend can scan the tag at the table, join in seconds and start earning too.</p>` };
    case 'miss_you': return {
      sms: `We miss you at ${R}! Come by ${when}. ${draw ? 'Each visit = 1 entry to win a free meal.' : 'Every visit counts toward your next prize.'}${STOP}`,
      subject: `We miss you at ${R}`,
      html: `<p style="font-size:22px;font-weight:bold;margin:0 0 8px">We miss you!</p>
        <p>Come see us at <b>${escHtml(R)}</b>, <b>${escHtml(when)}</b>. Every visit counts toward your next prize.${escHtml(drawLine)}</p>${cta}` };
    default: return null;
  }
}
function promoSampleItems(r) { return [prizeFor(r, VISIT_MILESTONES[0] || 5)]; }
function promoMenu(r) {
  const picks = promoPicks(r);
  return PROMO_LIBRARY.filter((x) => promoAvailable(r, x)).map((x) => {
    const c = promoContent(x.key, r, { items: promoSampleItems(r), winnerName: 'Ana L.', drawMonth: monthName(prevMonth(monthKey(localDay(new Date())))) });
    return { ...x, on: picks.includes(x.key), sms: c.sms, subject: c.subject };
  });
}

// Who gets each message right now
function savedSomething(db, c, now) {
  const bank = activeBank(c);
  const sinceReward = c.lastRedemptionAt || '';
  const savedVisit = db.visits.some((v) => v.customerId === c.id && v.scanStatus === 'saved' && v.at > sinceReward
    && Date.parse(v.at) > now - 21 * 86400000);
  return { bank, savedVisit };
}
function lastVisitAt(db, c) {
  let last = '';
  db.visits.forEach((v) => { if (v.customerId === c.id && v.at > last) last = v.at; });
  return last || c.optedInAt || '';
}
function promoAudience(db, r, key, now = Date.now()) {
  return db.customers.filter((c) => {
    if (c.restaurantId !== r.id || !(canMessage(c, r) || c.demo)) return false; // demo guests count in previews only
    if (localDay(c.optedInAt) === localDay(new Date(now))) return false; // not on the day they joined
    const s = savedSomething(db, c, now);
    const last = Date.parse(lastVisitAt(db, c)) || 0;
    switch (key) {
      case 'sun_prize': return s.bank.length > 0;
      case 'sun_all': return !s.bank.length && !s.savedVisit && now - last < 30 * 86400000;
      case 'draw_last': case 'winner': return true;
      case 'friend': return now - last < 30 * 86400000;
      case 'miss_you': return now - last >= 30 * 86400000;
      default: return false;
    }
  });
}
function promoCountsThisMonth(db, restaurantId) {
  const mk = monthKey(localDay(new Date()));
  const today = localDay(new Date());
  const month = new Map(); const day = new Set(); const missYou = new Map();
  db.messages.forEach((m) => {
    if (m.restaurantId !== restaurantId || !m.customerId || !PROMO_TYPES.includes(m.type) || !m.sentAt) return;
    const d = localDay(m.sentAt);
    if (monthKey(d) === mk) month.set(m.customerId, (month.get(m.customerId) || 0) + 1);
    if (d === today) day.add(m.customerId);
    if (m.type === 'promo_miss_you') missYou.set(m.customerId, Math.max(missYou.get(m.customerId) || 0, Date.parse(m.sentAt)));
  });
  return { month, day, missYou };
}
const promoRoom = (counts, cid) => !counts.day.has(cid) && (counts.month.get(cid) || 0) < PROMO_MONTHLY_CAP;
function notePromoSent(counts, cid) { counts.day.add(cid); counts.month.set(cid, (counts.month.get(cid) || 0) + 1); }

function daysInMonth(day) { const [y, m] = day.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
// Which messages are due now. Each one has a window, so a restart or short outage still catches up.
function promosDue(db, r, p) {
  const due = [];
  const sundayEve = p.dow === 0 && p.minutes >= 17 * 60 && p.minutes < 21 * 60;
  if (sundayEve) {
    // one Sunday message per guest: the most useful one first
    const dom = Number(p.day.slice(8));
    if (dom > daysInMonth(p.day) - 7) due.push({ key: 'draw_last', occ: `draw_last:${p.day}` });
    due.unshift({ key: 'sun_prize', occ: `sun_prize:${p.day}` });
    due.push({ key: 'miss_you', occ: `miss_you:${p.day}` }, { key: 'sun_all', occ: `sun_all:${p.day}` });
  }
  if (p.dow === 1 && p.minutes >= 11 * 60 && p.minutes < 15 * 60) due.push({ key: 'friend', occ: `friend:${p.day}` });
  if (p.day.endsWith('-01') && p.minutes >= 9 * 60 + 30 && p.minutes < 20 * 60) {
    const d = lastDraw(db, r.id);
    if (d && d.month === prevMonth(monthKey(p.day)) && d.winnerId) due.push({ key: 'winner', occ: `winner:${d.id}`, draw: d });
  }
  return due;
}
async function runPromoMessages() {
  const db = readDB();
  const now = new Date();
  const p = localParts(now);
  let changed = false;
  for (const r of db.leads) {
    if (r.stage !== 'Live Client') continue;
    const picks = promoPicks(r);
    const due = promosDue(db, r, p).filter((d) => picks.includes(d.key) && promoAvailable(r, PROMO_LIBRARY.find((x) => x.key === d.key)));
    if (!due.length) continue;
    r.promoSent = r.promoSent || {};
    const counts = promoCountsThisMonth(db, r.id);
    for (const d of due) {
      if (r.promoSent[d.key] === d.occ) continue;
      r.promoSent[d.key] = d.occ; changed = true;
      for (const c of promoAudience(db, r, d.key, now.getTime())) {
        if (c.demo || !promoRoom(counts, c.id)) continue;
        if (d.key === 'winner' && c.id === d.draw.winnerId) continue;
        if (d.key === 'miss_you' && now.getTime() - (counts.missYou.get(c.id) || 0) < 28 * 86400000) continue;
        const items = activeBank(c).map((b) => b.label);
        const content = promoContent(d.key, r, { items, winnerName: d.draw && d.draw.winnerName, drawMonth: d.draw && monthName(d.draw.month) });
        await notifyGuest(db, r, c, `promo_${d.key}`, { ...content, preferEmail: true });
        notePromoSent(counts, c.id);
      }
    }
  }
  if (changed) writeDB(db);
}

// Owner page box: tick the messages, see the exact words, save
function ownerMessagesBox(db, lead, saved) {
  const base = `/owner/${encodeURIComponent(lead.ownerToken)}`;
  const texting = !!lead.smsEnabled && !SIMULATION_MODE;
  const rows = promoMenu(lead).map((x) => {
    const reach = x.key === 'day_of' ? null : promoAudience(db, lead, x.key).length;
    return `<label style="display:flex;gap:12px;align-items:flex-start;padding:14px 0;border-top:1px solid #ece4f7;cursor:pointer">
      <input type="checkbox" name="picks" value="${x.key}" ${x.on ? 'checked' : ''} style="width:22px;height:22px;margin-top:2px;accent-color:#5b2ee5;flex-shrink:0">
      <span style="flex:1;min-width:0"><b style="font-size:16px">${escHtml(x.title)}</b>
      <span style="display:block;font-size:13px;color:#5c5578;margin:2px 0 8px">${escHtml(x.when)} · ${escHtml(x.who)}${reach == null ? '' : ` · ${reach} right now`}</span>
      <span style="display:block;background:#f4efff;border-radius:14px 14px 14px 4px;padding:10px 12px;font-size:14px;line-height:1.4"><b style="font-size:11px;letter-spacing:1px;color:#5b2ee5">TEXT</b><br>${escHtml(x.sms)}</span>
      <span style="display:block;font-size:13px;color:#5c5578;margin-top:6px"><b>Email subject:</b> ${escHtml(x.subject)}</span></span></label>`;
  }).join('');
  return `<form method="post" action="${base}/messages" id="messages" style="background:#fff;border:1px solid #ece4f7;border-radius:18px;padding:16px 18px;margin:16px 0">
    <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#d81b6a;font-weight:700">Messages to your members</p>
    <p style="margin:4px 0 4px;font-size:20px;font-weight:800">Pick what goes out to bring them back</p>
    <p style="margin:0 0 6px;font-size:14px;color:#5c5578">Ticked messages send by themselves. Each guest gets at most ${PROMO_MONTHLY_CAP} a month and 1 a day. ${texting ? 'Members get them by email, or by text if they agreed to texts.' : 'For now they go by email to members who gave one. Texts start once texting is turned on.'}</p>
    ${saved ? '<p style="margin:8px 0;padding:8px 12px;background:#e6faf5;color:#0b8a74;border-radius:10px;font-weight:700">Saved. Your messages are set.</p>' : ''}
    <input type="hidden" name="sent" value="1">
    ${rows}
    <button style="margin-top:10px;width:100%;padding:13px;border:0;border-radius:999px;background:#5b2ee5;color:#fff;font-weight:800;font-size:16px">Save my messages</button></form>`;
}

// ---- Club Night reminder: on a Club Night, 3 hours before it opens, nudge guests who have something waiting ----
// "Something waiting" = a saved prize or free meal, or a busy-night visit since their last reward. Max once a week each.
async function runClubNightReminders() {
  const db = readDB();
  const now = new Date();
  const p = localParts(now);
  const thisWeek = weekStart(p.day);
  let sent = 0;
  for (const r of db.leads) {
    if (r.stage !== 'Live Client') continue;
    const w = redeemWindow(r);
    if (!w.days.includes(p.dow) || p.minutes < toMin(w.from) - 180 || p.minutes >= toMin(w.to)) continue;
    if (!promoPicks(r).includes('day_of')) continue;
    const counts = promoCountsThisMonth(db, r.id);
    const when = `tonight ${fmtClock(w.from)}–${fmtClock(w.to)}`;
    for (const c of db.customers) {
      if (c.restaurantId !== r.id || c.clubNightReminderWeek === thisWeek || !canMessage(c, r) || !promoRoom(counts, c.id)) continue;
      if (localDay(c.optedInAt) === p.day) continue;
      const bank = activeBank(c);
      const sinceReward = c.lastRedemptionAt || '';
      const savedVisit = db.visits.some((v) => v.customerId === c.id && v.scanStatus === 'saved' && v.at > sinceReward
        && Date.parse(v.at) > now.getTime() - 21 * 86400000);
      if (!bank.length && !savedVisit) continue;
      const items = bank.map((b) => b.label);
      if (savedVisit && r.currentOffer) items.unshift(r.currentOffer);
      const list = items.length ? items.join(' + ') : 'your reward';
      await notifyGuest(db, r, c, 'club_night_reminder', {
        preferEmail: true,
        sms: `It's Club Night at ${r.restaurantName} ${when}! Waiting for you: ${list}. Scan the tag at your table. Reply STOP to opt out.`,
        subject: `Club Night ${when}: your ${items.length > 1 ? 'rewards are' : 'reward is'} waiting`,
        html: `<p style="font-size:22px;font-weight:bold;margin:0 0 8px">It's Club Night ${escHtml(when)}!</p>
          <p>Waiting for you at <b>${escHtml(r.restaurantName)}</b>:</p>
          <ul>${items.length ? items.map((i) => `<li><b>${escHtml(i)}</b></li>`).join('') : '<li><b>Your reward</b></li>'}</ul>
          <p>Scan the QR code or tap the tag at your table and show your server the screen.${r.minSpend ? ` Valid with a $${r.minSpend}+ order.` : ''}</p>`,
      });
      c.clubNightReminderWeek = thisWeek;
      notePromoSent(counts, c.id);
      sent += 1;
    }
  }
  if (sent) writeDB(db);
}

// ---- Saved prizes about to expire: one heads-up 5 days before ----
async function runExpiryWarnings() {
  const db = readDB();
  const soon = Date.now() + 5 * 86400000;
  let sent = 0;
  for (const c of db.customers) {
    const due = (c.bank || []).filter((b) => !b.warned && b.expiresAt && Date.parse(b.expiresAt) <= soon && Date.parse(b.expiresAt) > Date.now());
    if (!due.length) continue;
    const r = db.leads.find((l) => l.id === c.restaurantId);
    if (!r || !canMessage(c, r)) { due.forEach((b) => { b.warned = true; }); sent += 1; continue; }
    const list = due.map((b) => b.label).join(' + ');
    const by = new Date(Math.min(...due.map((b) => Date.parse(b.expiresAt)))).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TIMEZONE });
    await notifyGuest(db, r, c, 'expiry_warning', {
      preferEmail: true,
      sms: `Heads up: your ${list} at ${r.restaurantName} expires ${by}. Use it ${windowLabel(r)}. Reply STOP to opt out.`,
      subject: `Your ${list} at ${r.restaurantName} expires ${by}`,
      html: `<p>Don't miss it: your <b>${escHtml(list)}</b> at <b>${escHtml(r.restaurantName)}</b> expires <b>${escHtml(by)}</b>.</p>
        <p>Come in <b>${escHtml(windowLabel(r))}</b> and scan the tag at your table to use it.</p>`,
    });
    due.forEach((b) => { b.warned = true; });
    sent += 1;
  }
  if (sent) writeDB(db);
}

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
  res.set('Content-Disposition', `attachment; filename="tuesdayclub-backup-${localDay(new Date())}.json"`);
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
      subject: `Tuesday Club backup ${today} (${(db.leads || []).length} restaurants, ${(db.customers || []).length} guests)`,
      html: '<p>Your daily Tuesday Club CRM backup is attached. Keep this email: it can rebuild everything if the server data is ever lost. (The file ends in .txt so the email service accepts it; remove the .txt to restore it.)</p>',
      attachments: [{ filename: `tuesdayclub-backup-${today}.txt`, content: raw.toString("base64") }], // Brevo rejects .json attachments; rename the file to .json to restore
    });
  }
  console.log(`Backup saved: ${file}`);
}

async function runScheduledJobs() {
  for (const job of [runFollowUpCheck, runFirstVisitEmailCheck, runStreakReminders, runReviewRequestCheck, runAutomationCheck, runMonthlyDraws, runPromoMessages, runClubNightReminders, runExpiryWarnings, runMonthlyReports, runDailyBackup]) {
    try { await job(); } catch (err) { console.error(`Scheduled job ${job.name} failed:`, err.message); }
  }
}
setInterval(runScheduledJobs, 15 * 60 * 1000);
runScheduledJobs();

// ---- Custom 404 (must stay after every route) ----
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ---- Demo restaurant for sales pitches (set DEMO_RESTAURANT=1 in Railway) ----
// Creates "Maple Street Diner (Demo)" once, with about 3 weeks of made-up guests and visits, so the guest page,
// owner page and report have something real-looking to show. Demo guests have no email and no texting, so
// nothing is ever sent to them. Delete the restaurant in the CRM and restart to rebuild it with fresh dates.
const DEMO_LOGO_PNG = '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';
function seedDemoRestaurant() {
  if (process.env.DEMO_RESTAURANT !== '1') return;
  const db = readDB();
  if (db.leads.some((l) => l.demo)) return;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const now = Date.now();
  const today = localDay(new Date());
  const dayAgo = (n) => localDay(new Date(now - n * 86400000));
  const lead = {
    id: crypto.randomUUID(), demo: true, restaurantName: 'Maple Street Diner (Demo)', contactName: 'Sample owner', phone: '', email: '',
    slowestNight: 'Tuesday', currentOffer: 'Free fries', googleReviewLink: '', redeemDays: [1, 2, 3], redeemFrom: '17:00', redeemTo: '20:00',
    drawEnabled: false, drawCap: 40, baselineWeekly: 900, ownerPin: '', avgCheck: 24, mocTier: 'casual', mocReward: 6, mocPrize: 12, mocFood: 30,
    prize2: '', prize3: '', prize5: 'Free appetizer', prize10: '', prizestreak2: '', prizestreak4: '', prizestreak8: '',
    minSpend: 15, minSpendBig: null, smsEnabled: false, stage: 'Live Client', liveSince: new Date(now - 24 * 86400000).toISOString(),
    notes: 'Sample restaurant for showing owners. Guests and numbers are made up.', rewardCode: makeRewardCode('Maple Street Diner', db.leads, null),
    rewardCounter: 0, staffPin: newStaffPin(), createdAt: new Date(now - 24 * 86400000).toISOString(), updatedAt: new Date().toISOString(),
  };
  ensureOwnerToken(lead);
  try {
    fs.mkdirSync(LOGO_DIR, { recursive: true });
    lead.logoFile = `${lead.id}.png`; lead.logoVersion = now;
    fs.writeFileSync(path.join(LOGO_DIR, lead.logoFile), Buffer.from(DEMO_LOGO_PNG, 'base64'));
  } catch (e) { lead.logoFile = null; }
  db.leads.push(lead);
  const first = ['Ana', 'Marcus', 'Jen', 'Luis', 'Priya', 'Tom', 'Keisha', 'Dan', 'Sofia', 'Mike', 'Rosa', 'Kevin', 'Nia', 'Chris', 'Emma', 'Jay', 'Tina', 'Omar', 'Liz', 'Sam', 'Gabi', 'Rob', 'Maya', 'Dev'];
  const last = ['Lopez', 'Reed', 'Park', 'Silva', 'Shah', 'Nolan', 'Brown', 'Kelly', 'Costa', 'Ward', 'Diaz', 'Chen', 'Mensah', 'Ortiz'];
  const isClub = (day) => [1, 2, 3].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
  for (let g = 0; g < 78; g += 1) {
    const joinedAgo = 2 + Math.floor(rnd() * 22);
    const c = { id: crypto.randomUUID(), restaurantId: lead.id, rewardId: nextRewardId(lead, db), demo: true,
      name: `${pick(first)} ${pick(last)}`, phone: `+1508555${String(1000 + g)}`, email: '', smsConsent: false,
      optedInAt: '', optedOut: false, redemptionCount: 0, lastRedemptionAt: null, followUpSentAt: 'demo', reviewRequestSentAt: 'demo',
      checkinCount: 0, awarded: [], bank: [], deviceToken: newDeviceToken() };
    const visits = 1 + Math.floor(rnd() * 6);
    const days = new Set([dayAgo(joinedAgo)]);
    // most return visits land on Club Nights: that's what the saved rewards pull guests in for
    for (let k = 1; k < visits; k += 1) {
      let day = dayAgo(Math.floor(rnd() * joinedAgo));
      for (let t = 0; t < 6 && rnd() < 0.75 && !isClub(day); t += 1) day = dayAgo(Math.floor(rnd() * joinedAgo));
      days.add(day);
    }
    [...days].sort().forEach((day, i) => {
      const club = isClub(day) && i > 0;
      const at = zonedToUtc(day, club ? pick(['17:20', '18:05', '18:40', '19:15']) : pick(['12:30', '18:30', '19:45', '20:30'])).toISOString();
      if (Date.parse(at) > now) return;
      c.checkinCount += 1;
      if (i === 0) c.optedInAt = at;
      const status = i === 0 ? 'new' : club ? (c.checkinCount === 5 ? 'bonus' : 'reward') : 'saved';
      const v = { id: crypto.randomUUID(), restaurantId: lead.id, customerId: c.id, day, visitType: '', via: 'form', at,
        code: `${SCAN_LETTERS[status]}-${String(1000 + db.visits.length % 9000).padStart(4, '0')}`, scanStatus: status };
      if (c.checkinCount === 5) { c.awarded.push('v5'); v.prize = 'Free appetizer'; }
      db.visits.unshift(v);
      c.lastCheckinAt = at;
      if (status === 'reward' || status === 'bonus') {
        c.redemptionCount += 1; c.lastRedemptionAt = at;
        db.redemptions.unshift({ id: crypto.randomUUID(), restaurantId: lead.id, rewardIdEntered: c.rewardId, result: 'valid', via: 'scan',
          visitCode: v.code, customerId: c.id, at, ...(status === 'bonus' ? { bonusPrize: 'Free appetizer' } : {}) });
      }
      if (status === 'saved' && c.checkinCount === 5) c.bank.push(bankItem('prize', 'Free appetizer'));
    });
    if (!c.optedInAt) continue;
    db.customers.unshift(c);
    db.messages.unshift({ id: crypto.randomUUID(), restaurantId: lead.id, customerId: c.id, type: 'welcome', channel: 'email', body: '', sentAt: c.optedInAt, status: 'demo' });
  }
  writeDB(db);
  console.log(`Demo restaurant created: ${lead.restaurantName}`);
}
seedDemoRestaurant();

app.listen(PORT, '0.0.0.0', () => {
  const modes = [];
  if (SIMULATION_MODE) modes.push('SMS simulation mode — no Twilio credentials set');
  if (EMAIL_SIMULATION) modes.push('email simulation mode — no email API key set');
  console.log(`Tuesday Club CRM running on port ${PORT}${modes.length ? ` (${modes.join('; ')})` : ''}`);
});
