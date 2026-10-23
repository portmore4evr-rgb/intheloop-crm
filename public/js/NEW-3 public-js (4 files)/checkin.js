const restaurantId = window.location.pathname.split('/checkin/')[1];
const TOKEN_KEY = 'itl_guest_token'; // kept from the old name so saved phones still work
let currentOffer = '';
let minSpend = null, minSpendBig = null; // minimum order to redeem, set per restaurant in the CRM
const minText = (n) => (n ? `with a $${n}+ order` : '');
let restaurantName = '';
let win = null;      // Club Night window from the server: { label, openNow, opensAt, closesAt }
let drawInfo = null; // weekly free-meal draw: { cap, lastWinner }

// ---- saved-on-this-phone token (so guests only fill the form once) ----
function getToken() {
  try { const t = localStorage.getItem(TOKEN_KEY); if (t) return t; } catch (e) {}
  const m = document.cookie.match(/(?:^|; )itl_guest=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
function saveToken(t) {
  if (!t) return;
  try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
  document.cookie = `itl_guest=${encodeURIComponent(t)}; max-age=${60 * 60 * 24 * 400}; path=/; SameSite=Lax; Secure`;
}
function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  document.cookie = 'itl_guest=; max-age=0; path=/';
}

function showStep(n) {
  document.querySelectorAll('.step').forEach((s) => s.classList.remove('active'));
  document.getElementById('step-' + n).classList.add('active');
}

// Must match SMS_CONSENT_TEXT in server.js word for word (it's what gets stored as proof of consent).
function consentText() {
  return `Yes, text me rewards, reminders and offers from ${restaurantName}. Up to 4 msgs/month. Msg & data rates may apply. Reply STOP to cancel, HELP for help. Consent is not a condition of purchase.`;
}

// One big word + one short line per screen color. The live clock, date and daily code stop screenshots.
const SCAN_LOOK = {
  reward: { cls: 's-reward', label: 'REWARD', sub: 'Show your server' },
  bonus: { cls: 's-bonus', label: 'PRIZE!', sub: 'Show your server' },
  meal: { cls: 's-meal', label: 'FREE MEAL!', sub: 'Show your server' },
  saved: { cls: 's-saved', label: 'SAVED', sub: 'Nothing to redeem today' },
  new: { cls: 's-new', label: "YOU'RE IN!", sub: 'Nothing to redeem today' },
  used: { cls: 's-used', label: 'USED TODAY', sub: 'See you next time' },
};

const BOLT = '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>';
const STAR = '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>';

function shortDate(iso) { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

function renderProgress(p) {
  if (!p) return;
  const saved = p.saved || [];

  // You won the draw (until claimed)
  const meal = saved.find((b) => b.kind === 'meal');
  document.getElementById('win-banner').classList.toggle('hidden', !meal || lastScanStatus === 'meal');
  if (meal) document.getElementById('win-text').textContent = `${win ? win.label : 'Club Night'} · by ${shortDate(meal.expiresAt)}`;

  // Draw
  const d = p.draw;
  document.getElementById('draw-line').textContent = d ? "You're in this week's free-meal draw" : 'Free-meal draw is off';
  document.getElementById('draw-sub').innerHTML = d
    ? `${d.entries} ${d.entries === 1 ? 'entry' : 'entries'} · winner picked Monday · <a href="/rules">rules</a>` : '';

  // Saved for Club Night (prizes only; the meal has its own banner)
  const prizes = saved.filter((b) => b.kind !== 'meal');
  document.getElementById('bank-row').classList.toggle('hidden', !prizes.length);
  document.getElementById('bank-list').textContent = prizes.map((b) => b.label).join(' + ') + (prizes.length ? ` · until ${shortDate(prizes[0].expiresAt)}` : '');

  // Next prize: dots instead of numbers
  const nextRow = document.getElementById('next-row');
  if (p.next) {
    nextRow.classList.remove('hidden');
    document.getElementById('next-line').textContent = `${p.next.remaining} more ${p.next.remaining === 1 ? 'visit' : 'visits'}: ${p.next.prize}`;
    const prev = [0, 2, 3, 5, 10].filter((n) => n < p.next.n).pop() || 0;
    const steps = Math.max(1, p.next.n - prev);
    const done = Math.max(0, Math.min(steps, p.visits - prev));
    document.getElementById('next-dots').innerHTML = Array.from({ length: steps }, (_, i) => `<i class="${i < done ? 'on' : ''}"></i>`).join('');
  } else nextRow.classList.add('hidden');

  // Streak: only when there is one
  const sr = document.getElementById('streak-row');
  sr.classList.toggle('hidden', !p.streak);
  if (p.streak) {
    document.getElementById('streak-line').textContent = `${p.streak}-week streak`;
    document.getElementById('streak-sub').textContent = p.atRisk ? 'Come in by Sunday to keep it' : 'Keep it going';
  }

  // Badges (inside "My badges & details")
  document.getElementById('badge-grid').innerHTML = p.badges.map((b) => {
    const on = b.earned;
    const outer = on ? (b.kind === 'streak' ? '#1fd1b0' : '#ffc83d') : '#ece4f7';
    const inner = on ? (b.kind === 'streak' ? '#0b8a74' : '#ff4d94') : '#f6f1ff';
    const icon = b.kind === 'streak' ? BOLT : STAR;
    return `<div class="badge ${on ? '' : 'off'}">
      <div class="ring" style="background:${outer}"><div style="background:${inner}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="${on ? '#fff' : '#c9c2e6'}" aria-hidden="true">${icon}</svg></div></div>
      <b>${b.label}</b>${b.prize ? `<span>${escapeHtml(b.prize)}</span>` : ''}</div>`;
  }).join('');
}

function ordinal(n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`; }
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; }

let badgeQueue = [];
let lastScanStatus = '';
function showNextBadge() {
  const modal = document.getElementById('badge-modal');
  const b = badgeQueue.shift();
  if (!b) { modal.classList.add('hidden'); return; }
  const streak = b.kind === 'streak';
  document.getElementById('badge-hex-outer').style.background = streak ? '#1fd1b0' : '#ffc83d';
  document.getElementById('badge-hex-inner').style.background = streak ? '#0b8a74' : '#ff4d94';
  document.getElementById('badge-icon').innerHTML = streak ? BOLT : STAR;
  document.getElementById('badge-title').textContent = b.label;
  document.getElementById('badge-body').textContent = streak ? 'Weeks in a row. Nice!' : 'Thanks for coming back!';
  const prizeBox = document.getElementById('badge-prize');
  if (b.prize) {
    prizeBox.classList.remove('hidden');
    document.getElementById('badge-prize-name').textContent = b.prize;
    document.getElementById('badge-prize-note').textContent = lastScanStatus === 'saved'
      ? `Saved for Club Night${win ? ` · ${win.label}` : ''}` : 'Show your server';
  }
  else prizeBox.classList.add('hidden');
  document.getElementById('badge-close').textContent = badgeQueue.length ? 'Next' : 'Got it';
  modal.classList.remove('hidden');
  if (window.celebrate) window.celebrate({ count: 220, origin: { x: 0.5, y: 0.3 } });
}

let clockTimer = null;
function startClock() {
  const tick = () => {
    const now = new Date();
    document.getElementById('live-clock').textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    document.getElementById('live-date').textContent = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };
  tick();
  if (!clockTimer) clockTimer = setInterval(tick, 1000);
}

function showPass(data, heading) {
  currentOffer = data.offer || currentOffer;
  if (data.window) { win = data.window; renderWindow(); }
  const c = data.customer || {};
  const scan = data.scan || {};
  lastScanStatus = scan.status || '';
  const look = SCAN_LOOK[scan.status] || SCAN_LOOK.new;
  document.getElementById('scan-card').className = `pass pop-in ${look.cls}`;
  document.getElementById('pass-heading').textContent = heading;
  document.getElementById('scan-label').textContent = look.label;
  document.getElementById('scan-sub').textContent = look.sub;
  document.getElementById('visit-code').textContent = scan.code || '—';
  document.querySelectorAll('.legend span').forEach((el) => el.classList.toggle('on', el.dataset.k === scan.status));
  const reward = currentOffer || 'Your reward';
  const when = win ? `Use on Club Night · ${win.label}` : 'Use on Club Night';
  const what = {
    reward, bonus: scan.prize, meal: scan.prize,
    saved: scan.savedPrize ? `${reward} + ${scan.savedPrize}` : reward,
    new: reward, used: 'Already redeemed today',
  }[scan.status] || reward;
  document.getElementById('pass-offer-text').textContent = what;
  const need = scan.status === 'reward' ? minSpend : (scan.status === 'bonus' || scan.status === 'meal') ? minSpendBig : null;
  const minEl = document.getElementById('pass-min');
  const minLine = need ? `With a $${need}+ order` : (scan.status === 'saved' || scan.status === 'new') ? when : '';
  minEl.textContent = minLine;
  minEl.classList.toggle('hidden', !minLine);
  document.getElementById('reward-id').textContent = c.rewardId || '—';
  document.getElementById('visit-number').textContent =
    `${c.memberNumber ? `Member #${c.memberNumber} · ` : ''}Visit #${c.visitNumber || 1}`;
  if (data.visitType) document.getElementById('today-visit').value = data.visitType;
  startClock();
  renderProgress(data.progress);
  showStep(2);
  badgeQueue = (scan.newBadges || []).slice();
  if (badgeQueue.length) setTimeout(showNextBadge, 600);
  else if (window.celebrate && (scan.status === 'reward' || scan.status === 'bonus' || scan.status === 'meal' || (scan.status === 'new' && data.isNewCustomer))) {
    setTimeout(() => window.celebrate({ count: scan.status === 'meal' ? 320 : scan.status === 'new' ? 120 : 180 }), 300);
  }
}

// ---- Club Night window banner with a live countdown ----
let windowTimer = null;
function untilText(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h ${mm}m` : h ? `${h}h ${mm}m` : `${mm}m`;
}
function renderWindow() {
  if (!win) return;
  const box = document.getElementById('window-box');
  box.classList.remove('hidden');
  document.getElementById('window-label').textContent = win.label;
  const tick = () => {
    const now = Date.now();
    const closes = win.closesAt ? Date.parse(win.closesAt) : 0;
    const opens = win.opensAt ? Date.parse(win.opensAt) : 0;
    const open = closes && now < closes;
    box.classList.toggle('open', !!open);
    document.getElementById('window-cap').textContent = open ? 'Rewards are on right now' : 'Rewards unlock on Club Nights';
    document.getElementById('window-count').textContent = open ? `Open now · ends in ${untilText(closes - now)}`
      : opens && opens > now ? `Next one starts in ${untilText(opens - now)}` : '';
  };
  tick();
  if (!windowTimer) windowTimer = setInterval(tick, 30000);
}

function renderDrawTeaser() {
  const box = document.getElementById('draw-box');
  if (!drawInfo) return;
  box.classList.remove('hidden');
  document.getElementById('draw-title').textContent = `Win your whole meal free (up to $${drawInfo.cap})`;
  document.getElementById('draw-text').innerHTML = `Every check-in is an entry in this week's draw. Winner picked every Monday.${drawInfo.lastWinner ? ` Last week: ${escapeHtml(drawInfo.lastWinner)} won!` : ''} <a href="/rules">Rules</a>`;
}

async function loadRestaurant() {
  try {
    const res = await fetch(`/api/public/restaurant/${restaurantId}`);
    if (!res.ok) throw new Error('not found');
    const data = await res.json();
    restaurantName = data.restaurantName;
    document.getElementById('restaurant-name').textContent = data.restaurantName;
    // The restaurant's own logo (or its initials) on the header and on the prize screen
    const initials = String(data.restaurantName || '').split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
    [['restaurant-logo', 'logo-initials'], ['pass-logo', 'pass-initials']].forEach(([imgId, initId]) => {
      const img = document.getElementById(imgId);
      const init = document.getElementById(initId);
      init.textContent = initials;
      if (!data.logoUrl) return;
      img.alt = `${data.restaurantName} logo`;
      img.onload = () => { img.classList.remove('hidden'); init.classList.add('hidden'); };
      img.src = data.logoUrl;
    });
    document.getElementById('consent-text').textContent = consentText();
    document.getElementById('join-consent-text').textContent = consentText();
    // The text checkbox only shows when this restaurant has the text add-on; email works either way.
    if (data.smsEnabled) {
      document.getElementById('consent-wrap').classList.remove('hidden');
      document.getElementById('join-consent-wrap').classList.remove('hidden');
    }
    win = data.window || null; renderWindow();
    drawInfo = data.draw || null; renderDrawTeaser();
    minSpend = data.minSpend || null;
    minSpendBig = data.minSpendBig || data.minSpend || null;
    document.getElementById('offer-text').textContent = data.currentOffer
      ? `${data.currentOffer}${minSpend ? ` ${minText(minSpend)}` : ''}` : 'Ask your server about today\'s deal!';
    if (win) document.getElementById('offer-note').textContent = `Earn it on any visit, then use it ${win.label}. Bigger prizes at 2, 3, 5 and 10 visits.`;
    currentOffer = data.currentOffer || '';
  } catch (e) {
    document.getElementById('restaurant-name').textContent = 'Restaurant not found';
    document.getElementById('offer-text').textContent = 'This check-in link looks invalid.';
    return false;
  }
  return true;
}

// Scanned before? Skip the form.
async function tryReturning() {
  const token = getToken();
  if (!token) return;
  try {
    const res = await fetch('/api/public/returning', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, token }),
    });
    if (!res.ok) { if (res.status === 404) clearToken(); return; }
    const data = await res.json();
    if (data.member) {
      const name = data.customer.name ? ` ${String(data.customer.name).trim().split(/\s+/)[0]}` : '';
      showPass(data, `Hi${name}!`);
    } else if (data.knownGuest) {
      document.getElementById('join-heading').textContent = data.name ? `Hi ${data.name}!` : 'Hi there!';
      document.getElementById('join-sub').textContent =
        `Join ${restaurantName}'s Tuesday Club with your saved info${data.phoneHint ? ` (${data.phoneHint})` : ''}. No typing needed.`;
      showStep(3);
    }
  } catch (e) { /* stay on the form */ }
}

async function checkIn() {
  const visitType = document.getElementById('visit-input').value;
  const name = document.getElementById('name-input').value.trim();
  const phone = document.getElementById('phone-input').value.trim();
  const email = document.getElementById('email-input').value.trim();
  const smsConsent = document.getElementById('consent-input').checked;
  const errorEl = document.getElementById('checkin-error');
  errorEl.classList.add('hidden');

  const fail = (msg) => { errorEl.textContent = msg; errorEl.classList.remove('hidden'); };
  if (!visitType) return fail('Please pick whether this is your first time here.');
  if (!phone) return fail('Please enter your phone number.');

  try {
    const res = await fetch('/api/public/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, name, phone, email, smsConsent, visitType }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return fail(data.error || 'Something went wrong — please try again.');
    saveToken(data.token);
    data.visitType = visitType;
    showPass(data, data.isNewCustomer ? 'Welcome!' : 'Welcome back!');
  } catch (e) {
    fail('Something went wrong — please try again.');
  }
}

async function joinWithSavedInfo() {
  const visitType = document.getElementById('join-visit').value;
  const smsConsent = document.getElementById('join-consent').checked;
  const errorEl = document.getElementById('join-error');
  errorEl.classList.add('hidden');
  const fail = (msg) => { errorEl.textContent = msg; errorEl.classList.remove('hidden'); };
  if (!visitType) return fail('Please pick whether this is your first time here.');
  try {
    const res = await fetch('/api/public/checkin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, token: getToken(), smsConsent, visitType }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return fail(data.error || 'Something went wrong — please try again.');
    saveToken(data.token);
    data.visitType = visitType;
    showPass(data, "You're in the club");
  } catch (e) {
    fail('Something went wrong — please try again.');
  }
}

async function saveTodayVisit() {
  const visitType = document.getElementById('today-visit').value;
  const saved = document.getElementById('today-saved');
  const err = document.getElementById('today-error');
  saved.classList.add('hidden'); err.classList.add('hidden');
  if (!visitType) return;
  try {
    const res = await fetch('/api/public/returning', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, token: getToken(), visitType }),
    });
    if (!res.ok) throw new Error('save failed');
    saved.classList.remove('hidden');
  } catch (e) {
    err.textContent = 'Could not save. Please try again.'; err.classList.remove('hidden');
  }
}

function notMe() {
  clearToken();
  document.getElementById('name-input').value = '';
  document.getElementById('phone-input').value = '';
  document.getElementById('email-input').value = '';
  showStep(1);
}

document.getElementById('today-visit').addEventListener('change', saveTodayVisit);
document.getElementById('badge-close').addEventListener('click', showNextBadge);
document.getElementById('join-btn').addEventListener('click', joinWithSavedInfo);
document.getElementById('not-me').addEventListener('click', notMe);
document.getElementById('join-not-me').addEventListener('click', notMe);

(async () => { if (await loadRestaurant()) await tryReturning(); })();
