document.getElementById('yr').textContent = new Date().getFullYear();

// Live clock on the example phone, like the real guest screen
(function () {
  const el = document.getElementById('hero-clock');
  if (!el) return;
  const tick = () => { el.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }); };
  tick(); setInterval(tick, 1000);
})();

// Slide tour (replaces the video): autoplay, arrows, dots, swipe, pause
(function () {
  const deck = document.getElementById('deck');
  if (!deck) return;
  const slides = [...deck.querySelectorAll('.slide')];
  const dots = document.getElementById('deck-dots');
  const playBtn = document.getElementById('deck-play');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = 0, timer = null, playing = !reduce;
  slides.forEach((s, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Go to slide ${n + 1}`);
    b.addEventListener('click', () => { go(n); stop(); });
    dots.appendChild(b);
  });
  function go(n) {
    i = (n + slides.length) % slides.length;
    slides.forEach((s, k) => {
      const on = k === i;
      s.classList.toggle('on', on);
      s.setAttribute('aria-hidden', on ? 'false' : 'true');
      if ('inert' in s) s.inert = !on;
    });
    [...dots.children].forEach((d, k) => d.setAttribute('aria-current', k === i ? 'true' : 'false'));
  }
  const PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
  const PAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  function start() { clearInterval(timer); timer = setInterval(() => go(i + 1), 6500); playing = true; playBtn.innerHTML = PAUSE; playBtn.setAttribute('aria-label', 'Pause the tour'); }
  function stop() { clearInterval(timer); playing = false; playBtn.innerHTML = PLAY; playBtn.setAttribute('aria-label', 'Play the tour'); }
  document.getElementById('deck-prev').addEventListener('click', () => { go(i - 1); stop(); });
  document.getElementById('deck-next').addEventListener('click', () => { go(i + 1); stop(); });
  playBtn.addEventListener('click', () => (playing ? stop() : start()));
  deck.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { go(i - 1); stop(); }
    if (e.key === 'ArrowRight') { go(i + 1); stop(); }
  });
  let x0 = null;
  deck.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  deck.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 40) { go(dx < 0 ? i + 1 : i - 1); stop(); }
  });
  // Only run while the tour is on screen
  if ('IntersectionObserver' in window && !reduce) {
    let seen = false;
    new IntersectionObserver((es) => es.forEach((en) => {
      if (en.isIntersecting && !seen) { seen = true; start(); }
    }), { threshold: 0.4 }).observe(deck);
  }
  go(0);
  if (reduce) stop(); else { playBtn.innerHTML = PAUSE; }
})();

const formShownAt = Date.now(); // spam check: real people take more than a couple of seconds
document.getElementById('book-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('book-error');
  err.classList.add('hidden');
  const payload = {
    restaurantName: document.getElementById('b-restaurant').value.trim(),
    phone: document.getElementById('b-phone').value.trim(),
    email: document.getElementById('b-email').value.trim(),
    preferredTime: document.getElementById('b-time').value,
    website: (document.getElementById('b-website') || {}).value || '',
    elapsedMs: Date.now() - formShownAt,
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
