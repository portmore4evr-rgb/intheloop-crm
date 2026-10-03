let STAGES = [];
let LEADS = [];
let currentTab = 'pipeline';
const PRIZE_KEYS = ['3', '5', '10', 'streak2', 'streak4', 'streak8'];

const stageColors = {
  0: 'border-hair',
  1: 'border-hair',
  2: 'border-hair',
  3: 'border-amber/60',
  4: 'border-teal/60',
};
// Colored pill for each stage name (same green/orange as the landing page)
const stageHeads = ['bg-hair text-ink', 'bg-[#fbe3d2] text-amberdeep', 'bg-[#fbe3d2] text-amberdeep', 'bg-amber text-white', 'bg-teal text-white'];

async function init() {
  STAGES = await fetch('/api/stages').then((r) => r.json());
  populateStageSelect();
  await refreshLeads();
  bindEvents();
  renderCurrentTab();
}

async function refreshLeads() {
  LEADS = await fetch('/api/leads').then((r) => r.json());
}

function populateStageSelect() {
  const sel = document.getElementById('f-stage');
  sel.innerHTML = STAGES.map((s) => `<option value="${s}">${s}</option>`).join('');
}

function bindEvents() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('btn-add-lead').addEventListener('click', () => openModal());
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });

  document.getElementById('lead-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveLead();
  });

  document.getElementById('btn-delete').addEventListener('click', async () => {
    const id = document.getElementById('f-id').value;
    if (!id) return;
    if (!confirm('Delete this restaurant record? This cannot be undone.')) return;
    await fetch(`/api/leads/${id}`, { method: 'DELETE' });
    closeModal();
    await refreshLeads();
    renderCurrentTab();
  });

  document.getElementById('btn-copy-checkin').addEventListener('click', () => {
    const link = document.getElementById('checkin-link-display').textContent;
    navigator.clipboard.writeText(link).catch(() => {});
    const btn = document.getElementById('btn-copy-checkin');
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = original), 1500);
  });

  document.getElementById('btn-add-customer').addEventListener('click', addCustomer);
  document.getElementById('btn-send-promo').addEventListener('click', sendPromotion);
  document.getElementById('btn-add-automation').addEventListener('click', addAutomation);
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('tab-active', active);
    btn.classList.toggle('tab-inactive', !active);
  });
  ['pipeline', 'restaurants', 'analytics'].forEach((t) => {
    document.getElementById('view-' + t).classList.toggle('hidden', t !== tab);
  });
  renderCurrentTab();
}

function renderCurrentTab() {
  if (currentTab === 'pipeline') renderPipeline();
  if (currentTab === 'restaurants') renderRestaurants();
  if (currentTab === 'analytics') renderAnalytics();
}

function renderPipeline() {
  const board = document.getElementById('pipeline-board');
  board.innerHTML = STAGES.map((stage, i) => {
    const items = LEADS.filter((l) => l.stage === stage);
    return `
      <div class="stage-col card p-3 border-2 ${stageColors[i] === 'border-hair' ? 'border-transparent' : stageColors[i]} flex flex-col min-h-[200px]" data-stage="${escapeHtml(stage)}">
        <p class="stage-head ${stageHeads[i] || 'bg-hair text-ink'} font-mono text-[11px] uppercase tracking-wider mb-3 flex items-center justify-between gap-2">
          <span>${stage}</span><span>${items.length}</span>
        </p>
        <div class="space-y-2 flex-1">
          ${items.map((l) => leadCard(l, i)).join('') || '<p class="text-inkmute text-xs text-center py-6">Drop a lead here</p>'}
        </div>
      </div>
    `;
  }).join('');
  board.querySelectorAll('[data-open]').forEach(enableDrag);
}

function leadCard(lead, stageIdx) {
  const isLive = stageIdx === STAGES.length - 1;
  return `
    <div class="lead-card bg-bg border border-transparent rounded-2xl p-3 hover:border-amber transition" data-open="${lead.id}" title="Drag to another stage, or click to open">
      <p class="text-sm font-semibold mb-1">${escapeHtml(lead.restaurantName)}</p>
      <p class="text-xs text-inkmute">${escapeHtml(lead.contactName || 'No contact yet')}</p>
      ${isLive ? '<span class="font-mono text-[10px] uppercase tracking-wider text-teal block mt-2">● Active Client</span>' : ''}
    </div>
  `;
}

// ---- Drag a lead card to another stage (mouse: just drag; touch: press and hold, then drag) ----
let drag = null;

function enableDrag(card) {
  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { card, id: card.dataset.open, x: e.clientX, y: e.clientY, active: false, pointerId: e.pointerId,
             touch: e.pointerType === 'touch', holdTimer: null };
    if (drag.touch) drag.holdTimer = setTimeout(() => { if (drag && !drag.active) startDrag(drag.x, drag.y); }, 300);
  });
}

function startDrag(x, y) {
  drag.active = true;
  const r = drag.card.getBoundingClientRect();
  const ghost = drag.card.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.style.width = r.width + 'px';
  ghost.style.left = r.left + 'px';
  ghost.style.top = r.top + 'px';
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  drag.offX = x - r.left;
  drag.offY = y - r.top;
  drag.card.classList.add('drag-source');
  document.body.classList.add('dragging');
}

function columnAt(x, y) {
  if (drag && drag.ghost) drag.ghost.style.display = 'none';
  const el = document.elementFromPoint(x, y);
  if (drag && drag.ghost) drag.ghost.style.display = '';
  return el ? el.closest('.stage-col') : null;
}

document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
  if (!drag.active) {
    if (drag.touch) { if (moved > 8) { clearTimeout(drag.holdTimer); drag = null; } return; } // a swipe = scroll the page
    if (moved < 6) return;
    startDrag(drag.x, drag.y);
  }
  drag.ghost.style.left = (e.clientX - drag.offX) + 'px';
  drag.ghost.style.top = (e.clientY - drag.offY) + 'px';
  const col = columnAt(e.clientX, e.clientY);
  document.querySelectorAll('.stage-col').forEach((c) => c.classList.toggle('drop-target', c === col));
});

// Stop the page from scrolling while a touch drag is happening
document.addEventListener('touchmove', (e) => { if (drag && drag.active) e.preventDefault(); }, { passive: false });

async function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  clearTimeout(d.holdTimer);
  if (!d.active) {
    if (!cancelled) openModal(d.id); // a plain click/tap opens the lead
    return;
  }
  const col = cancelled ? null : columnAt(e.clientX, e.clientY);
  d.ghost.remove();
  d.card.classList.remove('drag-source');
  document.body.classList.remove('dragging');
  document.querySelectorAll('.stage-col').forEach((c) => c.classList.remove('drop-target'));
  const lead = LEADS.find((l) => l.id === d.id);
  const newStage = col && col.dataset.stage;
  if (!lead || !newStage || newStage === lead.stage) return;

  const oldStage = lead.stage;
  lead.stage = newStage; // move it on screen right away
  renderPipeline();
  try {
    const res = await fetch(`/api/leads/${d.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: newStage }),
    });
    if (!res.ok) throw new Error('save failed');
    await refreshLeads();
  } catch (err) {
    lead.stage = oldStage;
    alertBar(`Couldn't move ${lead.restaurantName}. Check your connection and try again.`);
  }
  renderCurrentTab();
}
document.addEventListener('pointerup', (e) => endDrag(e, false));
document.addEventListener('pointercancel', (e) => endDrag(e, true));

function alertBar(msg) {
  let bar = document.getElementById('drag-error');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'drag-error';
    bar.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 bg-ink text-bg text-sm px-4 py-2 rounded-full z-50';
    document.body.appendChild(bar);
  }
  bar.textContent = msg;
  bar.hidden = false;
  setTimeout(() => { bar.hidden = true; }, 4000);
}

function renderRestaurants() {
  const tbody = document.getElementById('restaurants-tbody');
  const empty = document.getElementById('restaurants-empty');
  if (LEADS.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = LEADS.map((l) => `
    <tr class="hover:bg-panel2 cursor-pointer transition" data-open="${l.id}">
      <td class="px-5 py-3">${escapeHtml(l.restaurantName)}</td>
      <td class="px-5 py-3 text-inkmute">${escapeHtml(l.contactName || '—')}</td>
      <td class="px-5 py-3 text-inkmute">${escapeHtml(l.slowestNight || '—')}</td>
      <td class="px-5 py-3 text-inkmute">${escapeHtml(l.currentOffer || '—')}</td>
      <td class="px-5 py-3"><span class="font-mono text-xs px-2 py-1 rounded-full ${l.stage === 'Live Client' ? 'bg-tealight text-teal' : 'bg-hair text-inkmute'}">${l.stage}</span></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => openModal(el.dataset.open));
  });
}

async function renderAnalytics() {
  const a = await fetch('/api/analytics').then((r) => r.json());
  document.getElementById('kpi-total').textContent = a.total;
  document.getElementById('kpi-live').textContent = a.liveClients;
  document.getElementById('kpi-conversion').textContent = a.conversionRate + '%';
  document.getElementById('kpi-deals').textContent = a.dealsClosedThisMonth;
  document.getElementById('kpi-customers').textContent = a.totalCustomers;
  document.getElementById('kpi-redemptions').textContent = a.totalRedemptions;

  const maxCount = Math.max(1, ...Object.values(a.byStage));
  const funnel = document.getElementById('funnel-bars');
  funnel.innerHTML = STAGES.map((stage) => {
    const count = a.byStage[stage] || 0;
    const pct = Math.round((count / maxCount) * 100);
    return `
      <div>
        <div class="flex justify-between text-sm mb-1"><span>${stage}</span><span class="font-mono">${count}</span></div>
        <div class="h-3 rounded-full bg-hair overflow-hidden"><div class="h-full bg-teal" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join('');

  const recentEl = document.getElementById('recent-activity');
  recentEl.innerHTML = a.recent.length
    ? a.recent.map((r) => `
        <div class="flex justify-between items-center bg-bg border border-hair rounded-2xl px-3 py-2.5 text-sm">
          <span>${escapeHtml(r.restaurantName)}</span>
          <span class="font-mono text-[11px] text-inkmute">${r.stage}</span>
        </div>
      `).join('')
    : '<p class="text-inkmute text-sm text-center py-6">No activity yet.</p>';
}

function openModal(id) {
  const form = document.getElementById('lead-form');
  form.reset();
  const deleteBtn = document.getElementById('btn-delete');
  const customersSection = document.getElementById('customers-section');

  if (id) {
    const lead = LEADS.find((l) => l.id === id);
    document.getElementById('modal-title').textContent = lead.restaurantName;
    document.getElementById('f-id').value = lead.id;
    document.getElementById('f-restaurantName').value = lead.restaurantName || '';
    document.getElementById('f-contactName').value = lead.contactName || '';
    document.getElementById('f-phone').value = lead.phone || '';
    document.getElementById('f-email').value = lead.email || '';
    document.getElementById('f-slowestNight').value = lead.slowestNight || '';
    document.getElementById('f-stage').value = lead.stage;
    document.getElementById('f-currentOffer').value = lead.currentOffer || '';
    document.getElementById('f-googleReviewLink').value = lead.googleReviewLink || '';
    document.getElementById('f-smsEnabled').checked = !!lead.smsEnabled;
    PRIZE_KEYS.forEach((k) => { document.getElementById(`f-prize${k}`).value = lead[`prize${k}`] || ''; });
    document.getElementById('f-notes').value = lead.notes || '';
    document.getElementById('f-staffPin').value = lead.staffPin || '';
    document.getElementById('redeem-link-display').textContent = `${window.location.origin}/redeem/${lead.id}`;
    document.getElementById('staff-pin-display').textContent = lead.staffPin || '—';
    document.getElementById('reward-code-display').textContent = (lead.rewardCode || '') + '-';
    deleteBtn.classList.remove('hidden');

    const liveSinceEl = document.getElementById('live-since-display');
    if (lead.liveSince) {
      liveSinceEl.textContent = `● Live client since ${new Date(lead.liveSince).toLocaleDateString()}`;
      liveSinceEl.classList.remove('hidden');
    } else {
      liveSinceEl.classList.add('hidden');
    }

    customersSection.classList.remove('hidden');
    const checkinUrl = `${window.location.origin}/checkin/${lead.id}`;
    document.getElementById('checkin-link-display').textContent = checkinUrl;
    document.getElementById('checkin-qr').src =
      `https://api.qrserver.com/v1/create-qr-code/?size=140x140&color=201e1d&bgcolor=f9f4ed&data=${encodeURIComponent(checkinUrl)}`;
    renderOwnerTools(lead);
    loadCustomers(lead.id);
    loadPromotions(lead.id);
    loadAutomations(lead.id);
  } else {
    document.getElementById('modal-title').textContent = 'Add Lead';
    document.getElementById('f-id').value = '';
    document.getElementById('f-stage').value = STAGES[0];
    deleteBtn.classList.add('hidden');
    document.getElementById('live-since-display').classList.add('hidden');
    customersSection.classList.add('hidden');
  }

  document.getElementById('modal-backdrop').classList.remove('hidden');
}

async function loadCustomers(restaurantId) {
  const customers = await fetch(`/api/leads/${restaurantId}/customers`).then((r) => r.json());
  document.getElementById('customers-count').textContent = `(${customers.length})`;
  const list = document.getElementById('customers-list');
  list.innerHTML = customers.length
    ? customers.map((c) => `
        <div class="bg-bg border border-hair rounded-2xl px-3 py-2 flex items-center justify-between text-sm">
          <div>
            <span class="font-code text-xs text-amberdeep mr-2">${escapeHtml(c.rewardId || '—')}</span>
            <span>${escapeHtml(c.name || 'No name')}</span>
            <span class="text-inkmute font-mono text-xs ml-2">${escapeHtml(c.phone)}</span>
            ${c.email ? `<span class="text-inkmute text-xs ml-2">${escapeHtml(c.email)}</span>` : ''}
            ${c.optedOut ? '<span class="text-xs text-brick ml-2">opted out</span>' : ''}
            ${c.firstVisitLabel ? `<div class="text-inkmute text-xs mt-0.5">Joined as: ${escapeHtml(c.firstVisitLabel)}${c.lastVisitLabel && c.lastVisitLabel !== c.firstVisitLabel ? ` · Last visit: ${escapeHtml(c.lastVisitLabel)}` : ''}</div>` : ''}
          </div>
          <span class="font-mono text-[11px] text-teal text-right">${c.checkinCount || 0} check-in${(c.checkinCount || 0) === 1 ? '' : 's'}<br>${c.redemptionCount || 0} reward${(c.redemptionCount || 0) === 1 ? '' : 's'} used</span>
        </div>
      `).join('')
    : '<p class="text-inkmute text-sm text-center py-4">No customers yet — share the check-in link above.</p>';
}

async function addCustomer() {
  const id = document.getElementById('f-id').value;
  if (!id) return;
  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  if (!phone) return;
  const res = await fetch(`/api/leads/${id}/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phone }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Could not add customer');
    return;
  }
  document.getElementById('cust-name').value = '';
  document.getElementById('cust-phone').value = '';
  loadCustomers(id);
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
}

async function saveLead() {
  const id = document.getElementById('f-id').value;
  const payload = {
    restaurantName: document.getElementById('f-restaurantName').value,
    contactName: document.getElementById('f-contactName').value,
    phone: document.getElementById('f-phone').value,
    email: document.getElementById('f-email').value,
    slowestNight: document.getElementById('f-slowestNight').value,
    stage: document.getElementById('f-stage').value,
    currentOffer: document.getElementById('f-currentOffer').value,
    googleReviewLink: document.getElementById('f-googleReviewLink').value,
    smsEnabled: document.getElementById('f-smsEnabled').checked,
    ...Object.fromEntries(PRIZE_KEYS.map((k) => [`prize${k}`, document.getElementById(`f-prize${k}`).value.trim()])),
    notes: document.getElementById('f-notes').value,
  };
  const pin = document.getElementById('f-staffPin').value.trim();
  if (/^\d{4}$/.test(pin)) payload.staffPin = pin;

  if (id) {
    await fetch(`/api/leads/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } else {
    await fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  closeModal();
  await refreshLeads();
  renderCurrentTab();
}

async function loadPromotions(restaurantId) {
  const promos = await fetch(`/api/leads/${restaurantId}/promotions`).then((r) => r.json());
  const list = document.getElementById('promotions-list');
  list.innerHTML = promos.length
    ? promos.map((p) => `
        <div class="bg-bg border border-hair rounded-2xl px-3 py-2 text-sm">
          <p class="mb-1">${escapeHtml(p.message)}</p>
          <p class="font-mono text-[11px] text-inkmute">Sent to ${p.recipientCount} (${p.audience}) · ${new Date(p.sentAt).toLocaleString()}</p>
        </div>
      `).join('')
    : '<p class="text-inkmute text-sm text-center py-4">No promotions sent yet.</p>';
}

async function sendPromotion() {
  const id = document.getElementById('f-id').value;
  if (!id) return;
  const message = document.getElementById('promo-message').value.trim();
  const audience = document.getElementById('promo-audience').value;
  if (!message) return;

  const btn = document.getElementById('btn-send-promo');
  const original = btn.textContent;
  btn.textContent = 'Sending…';
  btn.disabled = true;

  const res = await fetch(`/api/leads/${id}/promotions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, audience }),
  }).then((r) => r.json());

  btn.textContent = original;
  btn.disabled = false;
  document.getElementById('promo-message').value = '';

  const status = document.getElementById('promo-status');
  status.textContent = res.simulated
    ? `Simulated send to ${res.promotion.recipientCount} customer(s) — connect Twilio to send for real.`
    : `Sent to ${res.promotion.recipientCount} customer(s).`;
  status.classList.remove('hidden');
  setTimeout(() => status.classList.add('hidden'), 4000);

  loadPromotions(id);
}

async function loadAutomations(restaurantId) {
  const automations = await fetch(`/api/leads/${restaurantId}/automations`).then((r) => r.json());
  const list = document.getElementById('automations-list');
  list.innerHTML = automations.length
    ? automations.map((a) => `
        <div class="bg-bg border border-hair rounded-2xl px-3 py-2 flex items-center justify-between text-sm">
          <div>
            <p class="mb-0.5">${escapeHtml(a.message)}</p>
            <p class="font-mono text-[11px] text-amberdeep">Every ${a.dayOfWeek} · ${a.audience}</p>
          </div>
          <button data-remove-auto="${a.id}" class="text-brick text-xs hover:underline">Remove</button>
        </div>
      `).join('')
    : '<p class="text-inkmute text-sm text-center py-3">No automated promotions yet.</p>';

  list.querySelectorAll('[data-remove-auto]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/leads/${restaurantId}/automations/${btn.dataset.removeAuto}`, { method: 'DELETE' });
      loadAutomations(restaurantId);
    });
  });
}

async function addAutomation() {
  const id = document.getElementById('f-id').value;
  if (!id) return;
  const message = document.getElementById('auto-message').value.trim();
  const dayOfWeek = document.getElementById('auto-day').value;
  const audience = document.getElementById('auto-audience').value;
  if (!message) return;

  await fetch(`/api/leads/${id}/automations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, dayOfWeek, audience }),
  });
  document.getElementById('auto-message').value = '';
  loadAutomations(id);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();


// ---- Owner report, average check, and backup (injected into the restaurant panel) ----
function renderOwnerTools(lead) {
  const section = document.getElementById('customers-section');
  let box = document.getElementById('owner-tools');
  if (!box) {
    box = document.createElement('div');
    box.id = 'owner-tools';
    box.className = 'mb-6';
    section.insertBefore(box, section.firstChild);
  }
  box.innerHTML = `
    <h3 class="font-display font-800 text-xl mb-1">Owner Report</h3>
    <p class="text-inkmute text-sm mb-3">Emailed automatically on the 1st of each month to Onboarding and Live Client restaurants.
      It goes to the owner email above${lead.email ? ` (<span class="font-mono text-xs">${escapeHtml(lead.email)}</span>)` : ' (add one first)'}.</p>
    <div class="flex flex-wrap items-center gap-2 mb-2">
      <label class="text-sm text-inkmute">Average check $</label>
      <input id="avg-check" type="number" min="1" step="1" value="${Number(lead.avgCheck) > 0 ? Number(lead.avgCheck) : ''}" placeholder="25"
        class="w-24 bg-bg border border-hair rounded px-3 py-1.5 text-sm focus:outline-none focus:border-teal">
      <button id="btn-save-avg" class="border border-teal text-teal rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-teal hover:text-bg transition">Save</button>
    </div>
    <div class="flex flex-wrap gap-2 mb-2">
      <a href="/api/leads/${lead.id}/report" target="_blank" class="border border-teal text-teal rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-teal hover:text-bg transition">Preview this month</a>
      <a href="/api/leads/${lead.id}/report?period=last" target="_blank" class="border border-hair text-inkmute rounded-lg px-3 py-1.5 text-sm hover:border-teal transition">Preview last month</a>
      <button id="btn-send-report" class="bg-teal text-bg rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-amber transition">Email report to owner now</button>
      <a href="/api/backup" class="border border-hair text-inkmute rounded-lg px-3 py-1.5 text-sm hover:border-teal transition">Download full backup</a>
    </div>
    <p id="owner-tools-status" class="text-xs text-teal hidden"></p>`;

  const status = (msg) => { const el = document.getElementById('owner-tools-status'); el.textContent = msg; el.classList.remove('hidden'); };
  document.getElementById('btn-save-avg').addEventListener('click', async () => {
    const v = Number(document.getElementById('avg-check').value);
    if (!(v > 0)) return status('Enter the average check in dollars, e.g. 25.');
    await fetch(`/api/leads/${lead.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avgCheck: v }) });
    lead.avgCheck = v;
    status(`Saved: reports now use $${v} per return visit.`);
  });
  document.getElementById('btn-send-report').addEventListener('click', async () => {
    const res = await fetch(`/api/leads/${lead.id}/report/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return status(data.error || 'Could not send the report.');
    status(data.simulated
      ? `Report built (${data.stats.returnVisits} return visits, ~$${data.stats.estRevenue}). Email is in simulation mode until an email API key is added in Railway.`
      : `Report emailed to ${data.to}.`);
  });
}
