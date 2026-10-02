const restaurantId = window.location.pathname.split('/checkin/')[1];
const TOKEN_KEY = 'itl_guest_token';
let currentOffer = '';
let restaurantName = '';

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

function consentText() {
  return `Yes, text or email me my Reward ID and occasional offers from ${restaurantName}. Msg frequency varies. Msg & data rates may apply. Reply STOP or unsubscribe anytime.`;
}

const SCAN_LOOK = {
  reward: { cls: 'bg-okgreen', label: 'REWARD', sub: 'Show this screen to your server' },
  new: { cls: 'bg-scan-new', label: 'WELCOME!', sub: 'New member. Your reward starts on your next visit' },
  used: { cls: 'bg-scan-used', label: 'USED TODAY', sub: 'Rewards are once per day. See you next time!' },
  bonus: { cls: 'bg-scan-bonus', label: 'BONUS PRIZE', sub: 'You unlocked a bigger prize! Show this screen to your server' },
};

const BOLT = '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>';
const STAR = '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>';

function renderProgress(p) {
  if (!p) { document.getElementById('progress-card').hidden = true; return; }
  document.getElementById('progress-card').hidden = false;
  document.getElementById('streak-num').textContent = p.streak;
  const weeks = document.getElementById('streak-weeks');
  weeks.innerHTML = p.lastWeeks.map((w) => `
    <div class="flex flex-col items-center gap-1.5">
      <span class="text-[10px] ${w.current ? 'text-[#f2c14e] font-semibold' : 'text-[#a99f8f]'}">${w.label}</span>
      <span class="wk-dot" style="background:${w.visited ? '#c67139' : 'rgba(249,244,237,.12)'}">
        ${w.visited ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="#f9f4ed" aria-hidden="true">${BOLT}</svg>` : ''}
      </span>
    </div>`).join('');
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
    const outer = on ? (b.kind === 'streak' ? '#8fa36a' : '#f2c14e') : 'rgba(249,244,237,.14)';
    const inner = on ? (b.kind === 'streak' ? '#56633f' : '#c67139') : 'rgba(249,244,237,.08)';
    const icon = b.kind === 'streak' ? BOLT : STAR;
    return `<div class="flex flex-col items-center gap-1.5">
      <div class="hex w-14 h-16 flex items-center justify-center" style="background:${outer}">
        <div class="hex w-11 h-12 flex items-center justify-center" style="background:${inner}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="${on ? '#f9f4ed' : 'rgba(249,244,237,.35)'}" aria-hidden="true">${icon}</svg>
        </div>
      </div>
      <span class="text-xs font-semibold ${on ? '' : 'text-[#a99f8f]'}">${b.label}</span>
      ${b.prize ? `<span class="text-[10px] leading-tight ${on ? 'text-[#f2c14e]' : 'text-[#a99f8f]'}">${escapeHtml(b.prize)}</span>` : ''}
    </div>`;
  }).join('');
}

function ordinal(n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`; }
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; }

let badgeQueue = [];
function showNextBadge() {
  const modal = document.getElementById('badge-modal');
  const b = badgeQueue.shift();
  if (!b) { modal.classList.add('hidden'); return; }
  const streak = b.kind === 'streak';
  document.getElementById('badge-hex-outer').style.background = streak ? '#8fa36a' : '#f2c14e';
  document.getElementById('badge-hex-inner').style.background = streak ? '#56633f' : '#c67139';
  document.getElementById('badge-icon').innerHTML = streak ? BOLT : STAR;
  document.getElementById('badge-title').textContent = b.label;
  document.getElementById('badge-body').textContent = streak
    ? `That's ${b.label.split('-')[0]} weeks in a row at ${restaurantName}. Keep your streak alive!`
    : `You've visited ${restaurantName} ${b.label}. Thanks for being a regular!`;
  const prizeBox = document.getElementById('badge-prize');
  if (b.prize) { prizeBox.classList.remove('hidden'); document.getElementById('badge-prize-name').textContent = b.prize; }
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
  const c = data.customer || {};
  const scan = data.scan || {};
  const look = SCAN_LOOK[scan.status] || SCAN_LOOK.new;
  document.getElementById('scan-card').className = `rounded-[32px] p-7 pop-in text-center text-paper2 ${look.cls}`;
  document.getElementById('pass-heading').textContent = heading;
  document.getElementById('scan-label').textContent = look.label;
  document.getElementById('scan-sub').textContent = look.sub;
  document.getElementById('visit-code').textContent = scan.code || '—';
  document.getElementById('pass-offer-text').textContent =
    scan.status === 'bonus' ? scan.prize
      : scan.status === 'reward' ? (currentOffer || 'Your reward')
      : scan.status === 'new' ? `Next time: ${currentOffer || 'your reward'}` : 'Thanks for coming back!';
  document.getElementById('reward-id').textContent = c.rewardId || '—';
  document.getElementById('visit-number').textContent =
    `${c.memberNumber ? `Member #${c.memberNumber} · ` : ''}Visit #${c.visitNumber || 1}`;
  if (data.visitType) document.getElementById('today-visit').value = data.visitType;
  startClock();
  renderProgress(data.progress);
  showStep(2);
  badgeQueue = (scan.newBadges || []).slice();
  if (badgeQueue.length) setTimeout(showNextBadge, 600);
  else if (window.celebrate && (scan.status === 'reward' || scan.status === 'bonus' || (scan.status === 'new' && data.isNewCustomer))) {
    setTimeout(() => window.celebrate({ count: scan.status === 'new' ? 120 : 180 }), 300);
  }
}

async function loadRestaurant() {
  try {
    const res = await fetch(`/api/public/restaurant/${restaurantId}`);
    if (!res.ok) throw new Error('not found');
    const data = await res.json();
    restaurantName = data.restaurantName;
    document.getElementById('restaurant-name').textContent = data.restaurantName;
    document.getElementById('consent-text').textContent = consentText();
    document.getElementById('join-consent-text').textContent = consentText();
    document.getElementById('offer-text').textContent = data.currentOffer || 'Ask your server about today\'s deal!';
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
        `Join ${restaurantName}'s loop with your saved info${data.phoneHint ? ` (${data.phoneHint})` : ''}. No typing needed.`;
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
  if (!smsConsent) return fail('Please tick the box so we can text you your Reward ID.');

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
    showPass(data, data.isNewCustomer ? "You're In The Loop" : 'Welcome back — here is your Reward ID');
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
  if (!smsConsent) return fail('Please tick the box so we can text you your Reward ID.');
  try {
    const res = await fetch('/api/public/checkin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, token: getToken(), smsConsent, visitType }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return fail(data.error || 'Something went wrong — please try again.');
    saveToken(data.token);
    data.visitType = visitType;
    showPass(data, "You're In The Loop");
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
