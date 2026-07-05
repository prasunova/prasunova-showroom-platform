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

async function init() {
  const widget = document.getElementById('turnstile-widget');
  if (widget && TURNSTILE_SITE_KEY) {
    widget.dataset.sitekey   = TURNSTILE_SITE_KEY;
    widget.dataset.callback  = 'onTurnstileSuccess';
  }

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
  selectedRoom = room; activeSurface = 'floor'; maskImages = {};
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
    if (room.hasMasks) {
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

function renderCanvas() {
  if (!roomPhoto) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(roomPhoto, 0, 0, W, H);
  if (!selectedTile || !maskImages[activeSurface]) return;
  const mc = document.createElement('canvas');
  mc.width = W; mc.height = H;
  mc.getContext('2d').drawImage(maskImages[activeSurface], 0, 0, W, H);
  const maskData = mc.getContext('2d').getImageData(0, 0, W, H);
  const tc = document.createElement('canvas');
  tc.width = 96; tc.height = 96;
  tc.getContext('2d').drawImage(selectedTile._img, 0, 0, 96, 96);
  const oc = document.createElement('canvas');
  oc.width = W; oc.height = H;
  const octx = oc.getContext('2d');
  octx.fillStyle = octx.createPattern(tc, 'repeat');
  octx.fillRect(0, 0, W, H);
  const od = octx.getImageData(0, 0, W, H);
  for (let i = 0; i < maskData.data.length; i += 4) {
    od.data[i+3] = maskData.data[i] > 127 ? 200 : 0;
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
    selectedRoom = null; selectedTile = null; maskImages = {}; roomPhoto = null;
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
  document.getElementById('btn-upload').addEventListener('click', () =>
    document.getElementById('upload-modal').classList.remove('hidden'));
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
