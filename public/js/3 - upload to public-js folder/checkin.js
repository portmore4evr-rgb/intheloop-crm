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

const SCAN_LOOK = {
  reward: { cls: 's-reward', label: 'REWARD', sub: 'Show this screen to your server' },
  new: { cls: 's-new', label: 'WELCOME!', sub: "You're in! Your reward is ready on your next Club Night visit" },
  used: { cls: 's-used', label: 'USED TODAY', sub: 'Rewards are once per day. See you next time!' },
  bonus: { cls: 's-bonus', label: 'BONUS PRIZE', sub: 'You unlocked a bigger prize! Show this screen to your server' },
  meal: { cls: 's-meal', label: 'FREE MEAL', sub: 'You won the weekly draw! Show this screen to your server' },
  saved: { cls: 's-saved', label: 'SAVED!', sub: "This visit counts. Nothing to give today: your reward is saved for a Club Night" },
};

const BOLT = '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>';
const STAR = '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>';

function renderProgress(p) {
  if (!p) { document.getElementById('progress-card').hidden = true; return; }
  document.getElementById('progress-card').hidden = false;
  document.getElementById('streak-num').textContent = p.streak;
  document.getElementById('streak-weeks').innerHTML = p.lastWeeks.map((w) => `
    <div><span class="l ${w.current ? 'cur' : ''}">${w.label}</span>
      <span class="wk-dot ${w.visited ? 'on' : ''}">${w.visited ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">${BOLT}</svg>` : ''}</span></div>`).join('');
  const msg = document.getElementById('streak-msg');
  if (p.streak === 0) msg.textContent = 'Visit once a week to start a streak. 4 weeks in a row wins a prize.';
  else if (p.atRisk) msg.textContent = `Come in by Sunday to keep your ${p.streak}-week streak alive!`;
  else if (p.streak === 1) msg.textContent = "You're on the board! Come back next week to build your streak.";
  else msg.textContent = `Way to go! ${p.streak} weeks in a row. Keep your streak alive.`;

  const next = document.getElementById('next-prize');
  if (p.next) {
    next.hidden = false;
    document.getElementById('next-remaining').textContent =
      `${p.next.remaining} more ${p.next.remaining === 1 ? 'visit' : 'visits'} until your ${ordinal(p.next.n)}-visit prize:`;
    document.getElementById('next-prize-name').textContent = p.next.prize;
    document.getElementById('next-bar').style.width = `${Math.min(100, Math.round((p.visits / p.next.n) * 100))}%`;
  } else next.hidden = true;

  document.getElementById('badge-grid').innerHTML = p.badges.map((b) => {
    const on = b.earned;
    const outer = on ? (b.kind === 'streak' ? '#1fd1b0' : '#ffc83d') : 'rgba(255,255,255,.10)';
    const inner = on ? (b.kind === 'streak' ? '#0b8a74' : '#ff4d94') : 'rgba(255,255,255,.06)';
    const icon = b.kind === 'streak' ? BOLT : STAR;
    return `<div class="badge ${on ? '' : 'off'}">
      <div class="ring" style="background:${outer}"><div style="background:${inner}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="${on ? '#fff' : 'rgba(255,255,255,.3)'}" aria-hidden="true">${icon}</svg></div></div>
      <b>${b.label}</b>${b.prize ? `<span>${escapeHtml(b.prize)}</span>` : ''}</div>`;
  }).join('');

  // Prizes and free-meal wins waiting for the Club Night window
  const saved = p.saved || [];
  const bank = document.getElementById('bank-box');
  bank.classList.toggle('hidden', !saved.length);
  document.getElementById('bank-list').innerHTML = saved.map((b) => `<li>${b.kind === 'meal' ? '🏆 ' : ''}${escapeHtml(b.label)}<span>until ${new Date(b.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></li>`).join('');

  const d = p.draw;
  const box = document.getElementById('draw-box-2');
  box.classList.toggle('hidden', !d);
  if (d) {
    document.getElementById('draw-title-2').textContent = d.entries
      ? `You have ${d.entries} ${d.entries === 1 ? 'entry' : 'entries'} in this week's free-meal draw`
      : "Check in to enter this week's free-meal draw";
    document.getElementById('draw-text-2').innerHTML = `Winner picked Monday: their meal is free, up to $${d.cap}. ${d.lastWinner ? `Last week: ${escapeHtml(d.lastWinner)} won!` : 'Every day you check in = 1 more entry.'} <a href="/rules">Rules</a>`;
  }
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
  document.getElementById('badge-body').textContent = streak
    ? `That's ${b.label.split('-')[0]} weeks in a row at ${restaurantName}. Keep your streak alive!`
    : `That's ${b.label.split(' ')[0]} visits to ${restaurantName}. Thanks for being a regular!`;
  const prizeBox = document.getElementById('badge-prize');
  if (b.prize) {
    prizeBox.classList.remove('hidden');
    document.getElementById('badge-prize-name').textContent = b.prize;
    document.getElementById('badge-prize-note').textContent = lastScanStatus === 'saved'
      ? `Saved for your next Club Night${win ? `: ${win.label}` : ''}` : 'Show your server the pink screen';
  }
  else prizeBox.classList.add('hidden');
  document.getElementById('badge-close').textContent = badgeQueue.length ? 'Next badge' : 'See my progress';
  modal.classList.remove('hidden');
  if (window.celebrate) window.celebrate({ count: 220, origin: { x: 0.5, y: 0.3 } });
}

let clockTimer = null;
function startClock() {
  const tick = () => {
    const now = new Date();
    document.getElementById('live-clock').textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    document.getElementById('live-date').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
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
  const need = scan.status === 'reward' ? minSpend : (scan.status === 'bonus' || scan.status === 'meal') ? minSpendBig : null;
  let sub = need ? `${look.sub}. Valid ${minText(need)}.` : look.sub;
  if (scan.status === 'saved' && win) sub = `This visit counts! Your reward is saved for ${win.label}.`;
  if (scan.status === 'new' && win) sub = `You're in! Rewards are good ${win.label}.`;
  document.getElementById('scan-sub').textContent = sub;
  document.getElementById('visit-code').textContent = scan.code || '—';
  const offer = `${currentOffer || 'Your reward'}${minSpend ? ` ${minText(minSpend)}` : ''}`;
  document.getElementById('pass-offer-text').textContent =
    scan.status === 'meal' ? `${scan.prize}${minSpendBig ? ` ${minText(minSpendBig)}` : ''}`
      : scan.status === 'bonus' ? `${scan.prize}${minSpendBig ? ` ${minText(minSpendBig)}` : ''}`
      : scan.status === 'reward' ? offer
      : scan.status === 'saved' ? (scan.savedPrize ? `Saved: ${currentOffer || 'your reward'} + ${scan.savedPrize}` : `Saved: ${offer}`)
      : scan.status === 'new' ? `Your reward: ${offer}` : 'Thanks for coming back!';
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
    if (data.logoUrl) {
      const logo = document.getElementById('restaurant-logo');
      logo.alt = `${data.restaurantName} logo`;
      logo.onload = () => logo.classList.remove('hidden');
      logo.src = data.logoUrl;
    }
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
      const name = data.customer.name ? `, ${data.customer.name}` : '';
      showPass(data, `Welcome back${name}!`);
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
    showPass(data, data.isNewCustomer ? "You're in the club" : 'Welcome back!');
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
  const btn = document.getElementById('today-submit');
  saved.classList.add('hidden'); err.classList.add('hidden');
  if (!visitType) { err.textContent = 'Please choose one first.'; err.classList.remove('hidden'); return; }
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/public/returning', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, token: getToken(), visitType }),
    });
    if (!res.ok) throw new Error('save failed');
    saved.classList.remove('hidden');
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = 'Submit'; btn.disabled = false; }, 2500);
  } catch (e) {
    err.textContent = 'Could not save. Please try again.'; err.classList.remove('hidden');
    btn.textContent = 'Submit'; btn.disabled = false;
  }
}

function notMe() {
  clearToken();
  document.getElementById('name-input').value = '';
  document.getElementById('phone-input').value = '';
  document.getElementById('email-input').value = '';
  showStep(1);
}

document.getElementById('today-submit').addEventListener('click', saveTodayVisit);
document.getElementById('badge-close').addEventListener('click', showNextBadge);
document.getElementById('join-btn').addEventListener('click', joinWithSavedInfo);
document.getElementById('not-me').addEventListener('click', notMe);
document.getElementById('join-not-me').addEventListener('click', notMe);

(async () => { if (await loadRestaurant()) await tryReturning(); })();
