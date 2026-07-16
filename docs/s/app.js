import { API_BASE, TURNSTILE_SITE_KEY } from '../config.js';

const slug = new URLSearchParams(location.search).get('shop') || '';
if (!slug) {
  document.body.innerHTML = '<p style="padding:40px;font-size:18px">No shop specified. Use ?shop=yourshop in the URL.</p>';
  throw new Error('no slug');
}

let ROOMS = [], TILES = [], selectedRoom = null, selectedTile = null;
let activeSurface = 'floor', maskImages = {}, roomPhoto = null;
let roomFilter = 'all', tileFilter = 'all';

const canvas = document.getElementById('tile-canvas');
const ctx    = canvas.getContext('2d');

const FILTER_MAP = {
  kitchen:  ['kitchen'],
  bathroom: ['bathroom','toilet','shower'],
  living:   ['living_room','bedroom','dining'],
  outdoor:  ['balcony','terrace','entrance','driveway'],
};

function renderTurnstile() {
  const widget = document.getElementById('turnstile-widget');
  if (!widget || !TURNSTILE_SITE_KEY) return;
  // Explicit rendering: Turnstile's implicit (class-based) auto-render only
  // scans the DOM once when its own script loads, which races app.js — if
  // this widget isn't in the DOM with the class yet at that instant, it's
  // never picked up. Polling for window.turnstile sidesteps that entirely.
  if (!window.turnstile) { setTimeout(renderTurnstile, 100); return; }
  window.SS_turnstileWidgetId = window.turnstile.render(widget, {
    sitekey:  TURNSTILE_SITE_KEY,
    callback: (token) => { if (window.onTurnstileSuccess) window.onTurnstileSuccess(token); },
  });
}

async function init() {
  renderTurnstile();

  try {
    const res     = await fetch(`${API_BASE}/api/tile/catalog/${slug}`);
    const catalog = await res.json();
    if (!catalog.ok) {
      document.body.innerHTML = `<p style="padding:40px">Shop not found.</p>`;
      return;
    }
    document.title = `${catalog.shopName} — Digital Showroom`;
    const shopInitials = catalog.shopName.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const nameEl   = document.querySelector('#logo-shop-name') || document.querySelector('.logo-name');
    const badgeEl  = document.getElementById('logo-badge') || document.querySelector('.logo-mg');
    if (nameEl)  nameEl.textContent  = catalog.shopName;
    if (badgeEl) badgeEl.textContent = shopInitials;
    ROOMS = catalog.rooms;
    TILES = catalog.tiles;
  } catch (e) {
    console.error('Failed to load catalog', e);
    return;
  }
  renderRoomGallery();
  renderTileSidebar();
  restoreFromURL();
  bindEvents();
}

function renderRoomGallery() {
  const grid  = document.getElementById('room-grid');
  grid.innerHTML = '';
  const rooms = ROOMS.filter(r => roomFilter === 'all' || (FILTER_MAP[roomFilter]||[]).includes(r.category));
  if (!rooms.length) {
    grid.innerHTML = '<p style="color:var(--muted);padding:24px;grid-column:1/-1">No rooms yet.</p>';
    return;
  }
  rooms.forEach(room => {
    const card = document.createElement('div');
    card.className = 'room-card';
    card.dataset.id = room.id;
    card.innerHTML =
      `<img src="${room.photo}" alt="${room.name}" loading="lazy" crossorigin="anonymous" onerror="this.style.display='none'" />` +
      `<div class="room-card-info"><div class="room-card-name">${room.name}</div>` +
      `<div class="room-card-cat">${room.category.replace(/_/g,' ')} · ${(room.surfaces||['floor']).join(' + ')}</div></div>`;
    card.addEventListener('click', () => openRoom(room));
    grid.appendChild(card);
  });
}

async function openRoom(room) {
  selectedRoom = room; activeSurface = 'floor'; maskImages = {}; surfaceCache = null;
  document.getElementById('view-gallery').className = 'view-hidden';
  document.getElementById('view-room').className    = 'view-active';
  document.getElementById('room-name-label').textContent = room.name;
  document.querySelector('[data-surface="wall"]').disabled = true;
  showCanvasLoading(true);
  try {
    roomPhoto = await loadImage(room.photo);
    const maxW = Math.min(roomPhoto.width, 1200);
    const scale = maxW / roomPhoto.width;
    canvas.width = roomPhoto.width * scale;
    canvas.height = roomPhoto.height * scale;
    if (room.masks) {
      // User-uploaded room: signed mask URLs already provided by the poll response.
      if (room.masks.floor) { maskImages.floor = await loadImage(room.masks.floor); }
      if (room.masks.wall)  { maskImages.wall  = await loadImage(room.masks.wall);  }
      document.querySelector('[data-surface="wall"]').disabled = !room.masks.wall;
    } else if (room.hasMasks) {
      // Catalog room: fetch masks from the backend by room id.
      const res  = await fetch(`${API_BASE}/api/tile/room-masks/${room.id}`);
      const data = await res.json();
      if (data.ok && data.maskUrls) {
        if (data.maskUrls.floor) { maskImages.floor = await loadImage(data.maskUrls.floor); }
        if (data.maskUrls.wall)  { maskImages.wall  = await loadImage(data.maskUrls.wall);  }
        document.querySelector('[data-surface="wall"]').disabled = !data.maskUrls.wall;
      }
    }
  } catch(e) { console.error('Failed to load room', e); }
  showCanvasLoading(false);
  renderCanvas();
  updateURL();
}

const TILE_OPACITY = 200;              // out of 255, as before
const SHADE_MIN = 0.55, SHADE_MAX = 1.45;

// Depends only on the room + surface, not on the tile, so it survives tile clicks.
let surfaceCache = null;

// Separable box blur over a single-channel array, edges clamped.
// ctx.filter = 'blur()' would do this in one line but is still not Baseline and
// silently no-ops on some older Android browsers, so this stays in plain JS.
function blurChannel(src, W, H, radius) {
  const span = radius * 2 + 1;
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  const clampX = x => x < 0 ? 0 : (x > W - 1 ? W - 1 : x);
  const clampY = y => y < 0 ? 0 : (y > H - 1 ? H - 1 : y);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += src[row + clampX(x)];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = sum / span;
      sum -= src[row + clampX(x - radius)];
      sum += src[row + clampX(x + radius + 1)];
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[clampY(y) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = sum / span;
      sum -= tmp[clampY(y - radius) * W + x];
      sum += tmp[clampY(y + radius + 1) * W + x];
    }
  }
  return out;
}

// Solves the 8-DOF projective transform taking the four src points to the four
// dst points. Canvas 2D's own setTransform is affine only, so it cannot do this.
function solveHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  // Gaussian elimination with partial pivoting on the 8x8 system.
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-10) return null;           // singular / degenerate
    const tA = A[col]; A[col] = A[piv]; A[piv] = tA;
    const tb = b[col]; b[col] = b[piv]; b[piv] = tb;
    const d = A[col][col];
    for (let c2 = col; c2 < 8; c2++) A[col][c2] /= d;
    b[col] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c2 = col; c2 < 8; c2++) A[r][c2] -= f * A[col][c2];
      b[r] -= f * b[col];
    }
  }
  const Hm = new Float64Array(9);
  for (let i = 0; i < 8; i++) Hm[i] = b[i];
  Hm[8] = 1;
  return Hm;
}

function applyHomography(Hm, x, y) {
  const w = Hm[6] * x + Hm[7] * y + Hm[8];
  if (Math.abs(w) < 1e-12) return [0, 0];
  return [(Hm[0] * x + Hm[1] * y + Hm[2]) / w, (Hm[3] * x + Hm[4] * y + Hm[5]) / w];
}

// Feathered mask + per-pixel shading factors for the active surface.
function buildSurfaceCache(W, H) {
  const roomData = ctx.getImageData(0, 0, W, H).data;

  const mc = document.createElement('canvas');
  mc.width = W; mc.height = H;
  const mctx = mc.getContext('2d');
  mctx.drawImage(maskImages[activeSurface], 0, 0, W, H);
  const maskData = mctx.getImageData(0, 0, W, H).data;

  const px = W * H;
  const hard = new Float32Array(px);
  const lum  = new Float32Array(px);
  let lumSum = 0, lumCount = 0;
  for (let p = 0; p < px; p++) {
    const i = p * 4;
    const inside = maskData[i] > 127 ? 1 : 0;
    hard[p] = inside;
    const l = 0.299 * roomData[i] + 0.587 * roomData[i+1] + 0.114 * roomData[i+2];
    lum[p] = l;
    if (inside) { lumSum += l; lumCount++; }
  }
  const meanLum = lumCount ? lumSum / lumCount : 128;

  const radius = Math.max(1, Math.round(Math.min(W, H) / 300));
  const soft = blurChannel(hard, W, H, radius);

  // Relative shading only: dividing by the surface's own mean luminance keeps the
  // tile's true brightness and transfers just the room's shadows and highlights.
  const shade = new Float32Array(px);
  for (let p = 0; p < px; p++) {
    const s = meanLum > 1 ? lum[p] / meanLum : 1;
    shade[p] = s < SHADE_MIN ? SHADE_MIN : (s > SHADE_MAX ? SHADE_MAX : s);
  }
  return { surface: activeSurface, W, H, soft, shade };
}

function renderCanvas() {
  if (!roomPhoto) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(roomPhoto, 0, 0, W, H);
  if (!selectedTile || !maskImages[activeSurface]) return;

  if (!surfaceCache || surfaceCache.surface !== activeSurface ||
      surfaceCache.W !== W || surfaceCache.H !== H) {
    surfaceCache = buildSurfaceCache(W, H);
  }
  const { soft, shade } = surfaceCache;

  const tc = document.createElement('canvas');
  tc.width = 96; tc.height = 96;
  tc.getContext('2d').drawImage(selectedTile._img, 0, 0, 96, 96);
  const oc = document.createElement('canvas');
  oc.width = W; oc.height = H;
  const octx = oc.getContext('2d');
  octx.fillStyle = octx.createPattern(tc, 'repeat');
  octx.fillRect(0, 0, W, H);
  const od = octx.getImageData(0, 0, W, H);
  for (let p = 0, px = W * H; p < px; p++) {
    const a = soft[p];
    const i = p * 4;
    if (a <= 0.002) { od.data[i+3] = 0; continue; }
    const s = shade[p];
    od.data[i]   *= s;
    od.data[i+1] *= s;
    od.data[i+2] *= s;
    od.data[i+3] = a * TILE_OPACITY;
  }
  octx.putImageData(od, 0, 0);
  ctx.drawImage(oc, 0, 0);
}

function renderTileSidebar() {
  const grid  = document.getElementById('tile-grid');
  grid.innerHTML = '';
  const tiles = TILES.filter(t => tileFilter === 'all' || t.category === tileFilter);
  if (!tiles.length) {
    grid.innerHTML = '<p style="color:var(--muted);padding:16px;font-size:13px">No tiles in this category.</p>';
    return;
  }
  tiles.forEach(tile => {
    const card = document.createElement('div');
    card.className = 'tile-card';
    card.dataset.id = tile.id;
    card.innerHTML =
      `<img class="tile-thumb" src="${tile.file}" alt="${tile.name}" crossorigin="anonymous" onerror="this.style.display='none'" />` +
      `<div class="tile-info"><div class="tile-name">${tile.name}</div>` +
      `<div class="tile-finish">${tile.finish||tile.category}</div>` +
      `<div class="tile-price">₹${tile.price_per_sqft}/sqft</div></div>`;
    card.addEventListener('click', () => selectTile(tile, card));
    grid.appendChild(card);
  });
}

async function selectTile(tile, cardEl) {
  document.querySelectorAll('.tile-card').forEach(c => c.classList.remove('selected'));
  cardEl.classList.add('selected');
  selectedTile = tile;
  if (!tile._img) {
    try { tile._img = await loadImage(tile.file); } catch { tile._img = null; }
  }
  renderCanvas();
  updateURL();
}

function setSurface(surface) {
  activeSurface = surface;
  document.querySelectorAll('.surface-btn').forEach(b => b.classList.toggle('active', b.dataset.surface === surface));
  renderCanvas();
}

function showCanvasLoading(show) {
  document.getElementById('canvas-loading').classList.toggle('hidden', !show);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function downloadResult() {
  const link = document.createElement('a');
  link.download = `${slug}-${selectedRoom?.id||'room'}-${selectedTile?.id||'tile'}.jpg`;
  link.href = canvas.toDataURL('image/jpeg', 0.92);
  link.click();
}

function updateURL() {
  const p = new URLSearchParams();
  p.set('shop', slug);
  if (selectedRoom) p.set('room', selectedRoom.id);
  if (selectedTile) p.set('tile', selectedTile.id);
  if (activeSurface !== 'floor') p.set('surface', activeSurface);
  history.replaceState(null, '', '?' + p.toString());
}

function restoreFromURL() {
  const p      = new URLSearchParams(location.search);
  const roomId = p.get('room');
  const tileId = p.get('tile');
  const surf   = p.get('surface') || 'floor';
  if (roomId) {
    const room = ROOMS.find(r => r.id === roomId);
    if (room) openRoom(room).then(() => {
      setSurface(surf);
      if (tileId) {
        const tile = TILES.find(t => t.id === tileId);
        const card = document.querySelector(`.tile-card[data-id="${tileId}"]`);
        if (tile && card) selectTile(tile, card);
      }
    });
  }
}

function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function bindEvents() {
  document.getElementById('room-filter').addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    roomFilter = btn.dataset.filter;
    renderRoomGallery();
  });
  document.getElementById('btn-back').addEventListener('click', () => {
    document.getElementById('view-room').className    = 'view-hidden';
    document.getElementById('view-gallery').className = 'view-active';
    selectedRoom = null; selectedTile = null; maskImages = {}; roomPhoto = null; surfaceCache = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    history.replaceState(null, '', '?shop=' + slug);
  });
  document.getElementById('surface-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.surface-btn');
    if (!btn || btn.disabled) return;
    setSurface(btn.dataset.surface);
  });
  document.getElementById('tile-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    tileFilter = btn.dataset.cat;
    renderTileSidebar();
  });
  document.getElementById('btn-catalog').addEventListener('click', () => {
    document.getElementById('view-room').className    = 'view-hidden';
    document.getElementById('view-gallery').className = 'view-active';
  });
  document.getElementById('btn-upload').addEventListener('click', () => {
    if (window.SS_resetUpload) window.SS_resetUpload();
    document.getElementById('upload-modal').classList.remove('hidden');
  });
  document.getElementById('btn-download').addEventListener('click', downloadResult);
  document.getElementById('btn-share').addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).then(() => showToast('Link copied!'));
  });
  document.getElementById('modal-close').addEventListener('click', () =>
    document.getElementById('upload-modal').classList.add('hidden'));
  document.getElementById('upload-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('upload-modal'))
      document.getElementById('upload-modal').classList.add('hidden');
  });
  window.SS_openRoom  = openRoom;
  window.SS_showToast = showToast;
}

init();
