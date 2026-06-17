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

// Bootstrap/HTMX coexistence seam (WK §11.1 rule 5): re-init JS-driven
// widgets inside swapped fragments here if we ever put any there.
document.addEventListener('htmx:afterSwap', function () { /* no-op for now */ });
