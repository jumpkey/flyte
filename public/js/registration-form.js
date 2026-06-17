(function() {
  const stripeKey = document.querySelector('[data-stripe-key]')?.getAttribute('data-stripe-key');
  if (!stripeKey) { console.warn('No Stripe publishable key found'); return; }

  const stripe = Stripe(stripeKey);
  let elements;
  let clientSecret;
  let paymentIntentId;

  const step1 = document.getElementById('registration-step-1');
  const step2 = document.getElementById('registration-step-2');
  const loadingDiv = document.getElementById('registration-loading');
  const errorDiv = document.getElementById('payment-error');
  const payBtn = document.getElementById('pay-btn');
  const backBtn = document.getElementById('back-btn');
  const participantForm = document.getElementById('participant-form');
  // Server-rendered "Pay $X.XX" label, captured so resets keep the amount.
  const payBtnLabel = payBtn.textContent;
  const continueLabel = document.getElementById('continue-btn').textContent;

  const formError = document.getElementById('form-error');
  const emailConfirmEl = document.getElementById('emailConfirm');
  const emailMismatchEl = document.getElementById('email-mismatch');
  function showFormError(msg) { if (formError) { formError.textContent = msg; formError.style.display = 'block'; } }
  function clearFormError() { if (formError) { formError.style.display = 'none'; } }

  participantForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    clearFormError();

    // Guest double-entry: emails must match before we touch the network (D1).
    if (emailConfirmEl) {
      const a = document.getElementById('email').value.trim().toLowerCase();
      const b = emailConfirmEl.value.trim().toLowerCase();
      if (a !== b) {
        if (emailMismatchEl) emailMismatchEl.style.display = 'block';
        emailConfirmEl.focus();
        return;
      }
      if (emailMismatchEl) emailMismatchEl.style.display = 'none';
    }

    const continueBtn = document.getElementById('continue-btn');
    continueBtn.disabled = true;
    continueBtn.textContent = 'Loading...';

    const formData = {
      firstName: document.getElementById('firstName').value,
      lastName: document.getElementById('lastName').value,
      email: document.getElementById('email').value,
      emailConfirm: emailConfirmEl ? emailConfirmEl.value : undefined,
      phone: document.getElementById('phone').value || undefined,
    };

    try {
      const resp = await fetch(window.location.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('[name="_csrf"]').value },
        body: JSON.stringify(formData),
      });
      const data = await resp.json();

      if (!resp.ok) {
        var friendly = {
          email_mismatch: 'The email addresses do not match.',
          already_registered: "You're already registered for this event — check your email for the confirmation.",
          payment_setup_failed: 'Payment is temporarily unavailable. Please try again in a moment.',
        }[data.error] || 'We could not start your registration. Please try again.';
        showFormError(friendly);
        continueBtn.disabled = false;
        continueBtn.textContent = continueLabel;
        return;
      }
      clearFormError();

      clientSecret = data.clientSecret;
      paymentIntentId = data.paymentIntentId;

      elements = stripe.elements({ clientSecret });
      const paymentElement = elements.create('payment');
      paymentElement.mount('#payment-element-container');
      paymentElement.on('ready', () => { payBtn.disabled = false; });

      step1.style.display = 'none';
      step2.style.display = 'block';
    } catch (err) {
      showFormError('An error occurred. Please try again.');
      continueBtn.disabled = false;
      continueBtn.textContent = continueLabel;
    }
  });

  backBtn.addEventListener('click', function() {
    step2.style.display = 'none';
    step1.style.display = 'block';
    document.getElementById('continue-btn').disabled = false;
    document.getElementById('continue-btn').textContent = continueLabel;
  });

  payBtn.addEventListener('click', async function() {
    payBtn.disabled = true;
    payBtn.textContent = 'Processing...';
    errorDiv.style.display = 'none';

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {},
      redirect: 'if_required',
    });

    if (error) {
      showError(error.message || 'Payment failed');
      payBtn.disabled = false;
      payBtn.textContent = payBtnLabel;
      return;
    }

    step2.style.display = 'none';
    loadingDiv.style.display = 'block';

    try {
      const confirmResp = await fetch('/registration/confirm/' + paymentIntentId, {
        method: 'POST',
        headers: { 'X-CSRF-Token': document.querySelector('[name="_csrf"]').value },
      });

      if (confirmResp.redirected) {
        window.location.href = confirmResp.url;
      } else if (confirmResp.ok) {
        // Controller returns redirects (302) for success/waitlist and renders
        // HTML views for pending/error states. fetch follows redirects
        // transparently, so a 200 here means we received a rendered page.
        window.location.reload();
      } else {
        const status = confirmResp.status;
        showError(status >= 500
          ? 'Something went wrong finalizing your registration. Please contact support.'
          : 'Payment confirmation failed. Please contact support if you were charged.');
        loadingDiv.style.display = 'none';
        step2.style.display = 'block';
        payBtn.disabled = false;
        payBtn.textContent = payBtnLabel;
      }
    } catch (err) {
      showError('Failed to confirm registration. Please contact support.');
      loadingDiv.style.display = 'none';
      step2.style.display = 'block';
      payBtn.disabled = false;
      payBtn.textContent = payBtnLabel;
    }
  });

  function showError(msg) {
    errorDiv.textContent = msg;
    errorDiv.style.display = 'block';
  }
})();
