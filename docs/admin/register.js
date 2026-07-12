import { API_BASE } from '../config.js';

const TOKEN_KEY = 'showroom_admin_token';

document.getElementById('slug').addEventListener('input', e => {
  const val = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
  e.target.value = val;
  document.getElementById('slug-preview').textContent = val || '...';
});

document.getElementById('btn-send-otp').addEventListener('click', async () => {
  const email    = document.getElementById('reg-email').value.trim().toLowerCase();
  const shopName = document.getElementById('shop-name').value.trim();
  const slug     = document.getElementById('slug').value.trim();
  const errEl    = document.getElementById('reg-error');
  errEl.textContent = '';

  if (!email || !shopName || !slug) { errEl.textContent = 'All fields are required.'; return; }

  const consent = document.getElementById('consent-check').checked;
  if (!consent) { errEl.textContent = 'Please accept the Privacy Policy and Terms.'; return; }

  const res  = await fetch(`${API_BASE}/api/tile/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, shopName, slug, consent }),
  });
  const data = await res.json();
  if (data.ok) {
    document.getElementById('step1').style.display = 'none';
    document.getElementById('step2').style.display = 'block';
  } else {
    errEl.textContent = data.error || 'Registration failed.';
  }
});

document.getElementById('btn-verify').addEventListener('click', async () => {
  const email    = document.getElementById('reg-email').value.trim().toLowerCase();
  const otp      = document.getElementById('otp-input').value.trim();
  const password = document.getElementById('reg-password').value;
  const errEl    = document.getElementById('otp-error');
  errEl.textContent = '';

  if (!otp || !password) { errEl.textContent = 'OTP and password required.'; return; }

  const res  = await fetch(`${API_BASE}/api/tile/auth/verify-otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, otp, password }),
  });
  const data = await res.json();
  if (data.ok) {
    localStorage.setItem(TOKEN_KEY, data.token);
    location.href = 'index.html';
  } else {
    errEl.textContent = data.error || 'Verification failed.';
  }
});
