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

  participantForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    const continueBtn = document.getElementById('continue-btn');
    continueBtn.disabled = true;
    continueBtn.textContent = 'Loading...';

    const formData = {
      firstName: document.getElementById('firstName').value,
      lastName: document.getElementById('lastName').value,
      email: document.getElementById('email').value,
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
        showError(data.error || 'Failed to initiate registration');
        continueBtn.disabled = false;
        continueBtn.textContent = 'Continue to Payment';
        return;
      }

      clientSecret = data.clientSecret;
      paymentIntentId = data.paymentIntentId;

      elements = stripe.elements({ clientSecret });
      const paymentElement = elements.create('payment');
      paymentElement.mount('#payment-element-container');
      paymentElement.on('ready', () => { payBtn.disabled = false; });

      step1.style.display = 'none';
      step2.style.display = 'block';
    } catch (err) {
      showError('An error occurred. Please try again.');
      continueBtn.disabled = false;
      continueBtn.textContent = 'Continue to Payment';
    }
  });

  backBtn.addEventListener('click', function() {
    step2.style.display = 'none';
    step1.style.display = 'block';
    document.getElementById('continue-btn').disabled = false;
    document.getElementById('continue-btn').textContent = 'Continue to Payment';
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
