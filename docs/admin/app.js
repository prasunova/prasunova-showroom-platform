import { API_BASE } from '../config.js';

const TOKEN_KEY = 'showroom_admin_token';

function getToken()    { return localStorage.getItem(TOKEN_KEY); }
function setToken(t)   { localStorage.setItem(TOKEN_KEY, t); }
function clearToken()  { localStorage.removeItem(TOKEN_KEY); }
function authHeaders() { return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` }; }

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

async function loadDashboard() {
  const [profRes, tilesRes] = await Promise.all([
    fetch(`${API_BASE}/api/tile/admin/profile`, { headers: authHeaders() }),
    fetch(`${API_BASE}/api/tile/admin/tiles`,   { headers: authHeaders() }),
  ]);
  if (!profRes.ok) { clearToken(); location.reload(); return; }
  const prof  = await profRes.json();
  const tiles = await tilesRes.json();

  document.getElementById('login-section').style.display  = 'none';
  document.getElementById('admin-section').style.display  = 'block';
  document.getElementById('admin-shop-name').textContent  = prof.shopName;
  document.getElementById('edit-shop-name').value = prof.shopName;
  document.getElementById('admin-email').textContent      = prof.email;
  document.getElementById('admin-plan').textContent       = prof.plan === 'free' ? 'Free plan' : 'Pro plan';
  document.getElementById('admin-slug').textContent       = `showroom.prasunova.com/s/?shop=${prof.slug}`;
  document.getElementById('tiles-count').textContent      = `(${(tiles.tiles||[]).length})`;

  renderTiles(tiles.tiles || []);
}

function renderTiles(tiles) {
  const grid = document.getElementById('tile-admin-grid');
  grid.innerHTML = '';
  if (!tiles.length) {
    grid.innerHTML = '<p style="color:var(--muted);font-size:14px">No tiles yet. Add your first tile above.</p>';
    return;
  }
  tiles.forEach(tile => {
    const card = document.createElement('div');
    card.className = 'tile-admin-card';
    card.innerHTML =
      `<img src="${tile.file}" alt="${tile.name}" onerror="this.style.display='none'" />` +
      `<div class="tile-admin-info">` +
      `<strong>${tile.name}</strong>` +
      `<span>${tile.category}${tile.finish ? ' · ' + tile.finish : ''}</span><br/>` +
      `<span>₹${tile.price_per_sqft}/sqft</span><br/>` +
      `<button class="btn-delete" data-id="${tile.id}">Delete</button>` +
      `</div>`;
    card.querySelector('.btn-delete').addEventListener('click', () => deleteTile(tile.id, card));
    grid.appendChild(card);
  });
}

async function deleteTile(id, card) {
  if (!confirm('Delete this tile?')) return;
  const res = await fetch(`${API_BASE}/api/tile/admin/tile/${id}`, {
    method: 'DELETE', headers: authHeaders(),
  });
  if (res.ok) { card.remove(); showToast('Tile deleted.'); }
  else showToast('Delete failed.');
}

document.getElementById('btn-login').addEventListener('click', async () => {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Email and password required.'; return; }

  const res  = await fetch(`${API_BASE}/api/tile/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (data.ok) {
    setToken(data.token);
    if (data.reconsentRequired) {
      if (confirm('Our Privacy Policy has been updated. Click OK to accept the new version and continue.')) {
        await fetch(`${API_BASE}/api/tile/auth/reconsent`, { method: 'POST', headers: authHeaders() });
      }
    }
    await loadDashboard();
  } else errEl.textContent = data.error || 'Login failed.';
});

document.getElementById('btn-logout').addEventListener('click', () => { clearToken(); location.reload(); });

document.getElementById('btn-upload-tile').addEventListener('click', async () => {
  const name     = document.getElementById('tile-name').value.trim();
  const category = document.getElementById('tile-category').value;
  const finish   = document.getElementById('tile-finish').value.trim();
  const price    = parseFloat(document.getElementById('tile-price').value) || 0;
  const fileEl   = document.getElementById('tile-image');
  const errEl    = document.getElementById('upload-error');
  errEl.textContent = '';

  if (!name || !fileEl.files[0]) { errEl.textContent = 'Name and image are required.'; return; }

  const reader = new FileReader();
  reader.onload = async () => {
    const imageBase64 = reader.result.split(',')[1];
    const res = await fetch(`${API_BASE}/api/tile/admin/tile`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ name, category, finish: finish || null, price_per_sqft: price, imageBase64 }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Tile uploaded!');
      document.getElementById('tile-name').value   = '';
      document.getElementById('tile-finish').value = '';
      document.getElementById('tile-image').value  = '';
      await loadDashboard();
    } else errEl.textContent = data.error || 'Upload failed.';
  };
  reader.readAsDataURL(fileEl.files[0]);
});

document.getElementById('btn-save-shop-name').addEventListener('click', async () => {
  const shopName = document.getElementById('edit-shop-name').value.trim();
  if (!shopName) { showToast('Shop name cannot be empty.'); return; }
  const res = await fetch(`${API_BASE}/api/tile/admin/profile`, {
    method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ shopName }),
  });
  const data = await res.json();
  if (data.ok) { document.getElementById('admin-shop-name').textContent = data.shopName; showToast('Shop name updated.'); }
  else showToast(data.error || 'Update failed.');
});

document.getElementById('btn-export-data').addEventListener('click', async () => {
  const res = await fetch(`${API_BASE}/api/tile/admin/account/export`, { headers: authHeaders() });
  if (!res.ok) { showToast('Export failed.'); return; }
  const data = await res.json();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'my-showroom-data.json';
  a.click();
  showToast('Data downloaded.');
});

document.getElementById('btn-delete-account').addEventListener('click', async () => {
  const password = prompt('This soft-deletes your account (permanent after 30 days). Enter your password to confirm:');
  if (!password) return;
  const res = await fetch(`${API_BASE}/api/tile/admin/account/delete`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (data.ok) { alert(data.message); clearToken(); location.reload(); }
  else showToast(data.error || 'Deletion failed.');
});

if (getToken()) loadDashboard();
