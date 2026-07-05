import { API_BASE } from '../config.js';

document.getElementById('btn-send-reset').addEventListener('click', async () => {
  const email = document.getElementById('fp-email').value.trim().toLowerCase();
  const errEl = document.getElementById('fp-error');
  errEl.textContent = '';
  if (!email) { errEl.textContent = 'Email is required.'; return; }

  const res  = await fetch(`${API_BASE}/api/tile/auth/forgot-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();
  if (data.ok) {
    document.getElementById('step1').style.display = 'none';
    document.getElementById('step2').style.display = 'block';
  } else errEl.textContent = data.error || 'Failed.';
});

document.getElementById('btn-reset').addEventListener('click', async () => {
  const email       = document.getElementById('fp-email').value.trim().toLowerCase();
  const otp         = document.getElementById('reset-otp').value.trim();
  const newPassword = document.getElementById('new-password').value;
  const errEl       = document.getElementById('reset-error');
  errEl.textContent = '';

  if (!otp || !newPassword) { errEl.textContent = 'Code and new password required.'; return; }

  const res  = await fetch(`${API_BASE}/api/tile/auth/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, otp, newPassword }),
  });
  const data = await res.json();
  if (data.ok) { alert('Password reset! Please login.'); location.href = 'index.html'; }
  else errEl.textContent = data.error || 'Reset failed.';
});
