// Flyte site JS — CSP-safe (external file, no inline handlers).
document.addEventListener('click', function (e) {
  const back = e.target.closest('[data-back]');
  if (back) { e.preventDefault(); history.back(); }
});
// Bootstrap/HTMX coexistence seam (WK §11.1 rule 5): re-init JS-driven
// widgets inside swapped fragments here if we ever put any there.
document.addEventListener('htmx:afterSwap', function () { /* no-op for now */ });
