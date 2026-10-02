document.getElementById('yr').textContent = new Date().getFullYear();

// Live clock on the example phone, like the real guest screen
(function () {
  const el = document.getElementById('hero-clock');
  if (!el) return;
  const tick = () => { el.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }); };
  tick(); setInterval(tick, 1000);
})();

// A little celebration when the page opens, from the example phone
window.addEventListener('load', () => {
  const phone = document.querySelector('.phone');
  if (!phone || !window.celebrate) return;
  const r = phone.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) return;
  setTimeout(() => window.celebrate({ count: 140, origin: { x: (r.left + r.width / 2) / window.innerWidth, y: Math.max(0.1, (r.top + 120) / window.innerHeight) } }), 500);
});

// Show a friendly placeholder until the MP4 is uploaded to public/media/
(function () {
  const v = document.getElementById('vsl');
  const src = v.querySelector('source');
  const missing = () => { v.classList.add('hidden'); document.getElementById('vsl-missing').classList.remove('hidden'); };
  src.addEventListener('error', missing);
  v.addEventListener('error', missing);
  if (v.networkState === 3) missing(); // the error may fire before this script runs
  fetch(src.getAttribute('src'), { method: 'HEAD' }).then((r) => { if (!r.ok) missing(); }).catch(() => {});
})();

document.getElementById('book-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('book-error');
  err.classList.add('hidden');
  const payload = {
    restaurantName: document.getElementById('b-restaurant').value.trim(),
    phone: document.getElementById('b-phone').value.trim(),
    email: document.getElementById('b-email').value.trim(),
    preferredTime: document.getElementById('b-time').value,
  };
  const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
  if (!payload.restaurantName) return fail('Please add your restaurant name.');
  if (!payload.phone && !payload.email) return fail('Please add a phone number or email so we can confirm.');
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/public/book', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    e.target.querySelectorAll('input, button[type="submit"]').forEach((el) => el.closest('div, button').classList.add('hidden'));
    document.getElementById('book-done').classList.remove('hidden');
    if (window.celebrate) window.celebrate({ count: 220, origin: { x: 0.5, y: 0.45 } });
  } catch (ex) {
    fail(ex.message);
    btn.disabled = false; btn.textContent = 'Request my meeting';
  }
});
