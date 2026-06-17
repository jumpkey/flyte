// Flyte site JS — CSP-safe (external file, no inline handlers).
document.addEventListener('click', function (e) {
  const back = e.target.closest('[data-back]');
  if (back) { e.preventDefault(); history.back(); }
});
// Event-card image fallback (D2 / AC-I2 ③): error events don't bubble, so we
// listen in the capture phase. A broken or unreachable event image is removed
// so the gradient + initials fallback shows through — never a broken-image icon.
document.addEventListener('error', function (e) {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.closest('.event-media')) {
    img.remove();
  }
}, true);

// Native <dialog> opener/closer (CSP-safe modals, no Bootstrap JS needed).
document.addEventListener('click', function (e) {
  const opener = e.target.closest('[data-open-dialog]');
  if (opener) {
    const dlg = document.querySelector(opener.getAttribute('data-open-dialog'));
    if (dlg && typeof dlg.showModal === 'function') { e.preventDefault(); dlg.showModal(); }
  }
  const closer = e.target.closest('[data-close-dialog]');
  if (closer) { const dlg = closer.closest('dialog'); if (dlg) { e.preventDefault(); dlg.close(); } }
});

// Admin row click-through: a table row with data-href navigates to it.
document.addEventListener('click', function (e) {
  const row = e.target.closest('.admin-row[data-href]');
  if (row && e.target.tagName !== 'A') { window.location.href = row.getAttribute('data-href'); }
});

// Admin event-form live preview (WF-09): mirror inputs into the storefront card.
(function () {
  const preview = document.getElementById('event-preview');
  if (!preview) return;
  const $ = function (sel) { return preview.querySelector('[data-preview="' + sel + '"]'); };
  const nameEl = document.getElementById('name');
  const feeEl = document.getElementById('feeDollars');
  const dateEl = document.getElementById('eventDate');
  const locEl = document.getElementById('location');
  const imgEl = document.getElementById('imageUrl');
  const fileEl = document.getElementById('imageFile');
  let objectUrl = null; // revoked before each new selection to avoid leaks

  function initials(name) {
    return (name || 'EV').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || 'EV';
  }
  function render() {
    const name = nameEl ? nameEl.value : '';
    $('title').textContent = name || 'Event name';
    $('initials').textContent = initials(name);
    const fee = feeEl ? parseFloat(feeEl.value) : NaN;
    $('price').textContent = '$' + (isNaN(fee) ? '0.00' : fee.toFixed(2));
    if (dateEl && dateEl.value) {
      const d = new Date(dateEl.value);
      if (!isNaN(d.getTime())) {
        const badge = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
        $('badge').textContent = badge;
        $('meta').textContent = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + (locEl && locEl.value ? ' · ' + locEl.value : '');
      }
    } else {
      $('meta').textContent = locEl && locEl.value ? locEl.value : '';
    }
    const img = $('img');
    // Precedence in the live preview mirrors the storefront: a chosen file (D1)
    // wins over the URL, then the styled fallback shows through.
    var file = fileEl && fileEl.files && fileEl.files[0];
    if (file) {
      if (objectUrl) { URL.revokeObjectURL(objectUrl); }
      objectUrl = URL.createObjectURL(file);
      img.src = objectUrl; img.style.display = 'block';
    } else if (imgEl && /^https:\/\//i.test(imgEl.value)) {
      img.src = imgEl.value; img.style.display = 'block';
    } else {
      img.removeAttribute('src'); img.style.display = 'none';
    }
  }
  [nameEl, feeEl, dateEl, locEl, imgEl].forEach(function (el) { if (el) el.addEventListener('input', render); });
  if (fileEl) fileEl.addEventListener('change', render);
  render();
})();

// Refund modal: enable the partial-amount field only when "Partial" is chosen.
document.addEventListener('change', function (e) {
  if (e.target && e.target.name === 'refundType') {
    var amt = document.getElementById('refund-amount');
    if (amt) {
      var partial = e.target.value === 'partial';
      amt.disabled = !partial;
      if (partial) amt.focus();
    }
  }
});

// Double-submit guard for one-shot POST forms (W13): once a form marked
// [data-once] starts submitting, disable its submit button so a second click
// can't fire a duplicate request. Belt-and-suspenders with the server-side
// Stripe idempotency key. We don't preventDefault — the submission proceeds.
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (form && form.matches && form.matches('form[data-once]')) {
    var btn = form.querySelector('button[type="submit"], button:not([type])');
    if (btn) {
      if (btn.dataset.submitting) { e.preventDefault(); return; }
      btn.dataset.submitting = '1';
      if (btn.dataset.busy) btn.textContent = btn.dataset.busy;
      // Disable after the event loop so the button still posts with the form.
      setTimeout(function () { btn.disabled = true; }, 0);
    }
  }
});

// Analytics Events table status filter (#16): CSP-safe, client-side. Delegated
// on document so it survives the HTMX range-swap that re-renders the fragment.
// With JS off, all rows show (checkboxes are checked by default, no JS hides).
document.addEventListener('change', function (e) {
  var box = e.target.closest && e.target.closest('#event-status-filter [data-status-filter]');
  if (!box) return;
  var filter = box.closest('#event-status-filter');
  var table = document.getElementById(filter.getAttribute('data-events-table'));
  if (!table) return;
  var active = {};
  filter.querySelectorAll('[data-status-filter]').forEach(function (cb) {
    if (cb.checked) active[cb.value] = true;
  });
  table.querySelectorAll('tbody tr[data-status]').forEach(function (row) {
    row.style.display = active[row.getAttribute('data-status')] ? '' : 'none';
  });
});

// Bootstrap/HTMX coexistence seam (WK §11.1 rule 5): re-init JS-driven
// widgets inside swapped fragments here if we ever put any there.
document.addEventListener('htmx:afterSwap', function () { /* no-op for now */ });
