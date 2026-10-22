(function() {
  const stripeKey = document.querySelector('[data-stripe-key]')?.getAttribute('data-stripe-key');
  if (!stripeKey) { console.warn('No Stripe publishable key found'); return; }

  const stripe = Stripe(stripeKey);
  let elements;
  let clientSecret;
  let paymentIntentId;
  let activeCheckoutParticipant = null;

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

    // Going Back must not create a second PI or lose the only in-memory
    // capability to finish the existing checkout. The server deliberately
    // will not disclose a client secret based on an email address alone.
    if (clientSecret && activeCheckoutParticipant) {
      const sameParticipant = ['firstName', 'lastName', 'email', 'phone'].every((key) =>
        (formData[key] || '').trim().toLowerCase() === (activeCheckoutParticipant[key] || '').trim().toLowerCase()
      );
      if (!sameParticipant) {
        showFormError('This checkout is already bound to the participant details you submitted. Return to the original details to continue, or finish this checkout before starting another.');
        continueBtn.disabled = false;
        continueBtn.textContent = continueLabel;
        return;
      }
      step1.style.display = 'none';
      step2.style.display = 'block';
      continueBtn.disabled = false;
      continueBtn.textContent = continueLabel;
      return;
    }

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
          already_registered: 'A checkout or registration already exists for this email. Return to the checkout page you already opened; a new checkout cannot be started until this attempt is resolved.',
          payment_setup_failed: 'Payment is temporarily unavailable. Please try again in a moment.',
          event_closed: 'This event is no longer accepting registrations.',
          event_full: 'This event just filled up. Join the waitlist instead.',
        }[data.error] || 'We could not start your registration. Please try again.';
        showFormError(friendly);
        continueBtn.disabled = false;
        continueBtn.textContent = continueLabel;
        return;
      }
      if (data.redirectUrl) {
        window.location.assign(data.redirectUrl);
        return;
      }
      clearFormError();

      clientSecret = data.clientSecret;
      paymentIntentId = data.paymentIntentId;
      activeCheckoutParticipant = {
        firstName: formData.firstName,
        lastName: formData.lastName,
        email: formData.email,
        phone: formData.phone,
      };

      elements = stripe.elements({ clientSecret });
      // Belt-and-suspenders with the card-only PaymentIntent: no wallets/Link UI,
      // so a guest checkout never surfaces a prior session's saved payment method.
      const paymentElement = elements.create('payment', { wallets: { applePay: 'never', googlePay: 'never' } });
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
      const result = await confirmResp.json();
      if (result.redirectUrl) {
        window.location.assign(result.redirectUrl);
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
