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
const QUAD_MIN_COVERAGE = 0.80;        // below this the fit is untrustworthy -> flat tiling
const SS = 2;                          // 2x2 supersampling; far-field tiles alias badly without it

// How many times a tile IMAGE repeats across the visible floor.
// The tile images are photos of already-laid floors, not single tile faces: the
// wooden image is ~12 plank rows, the subway image ~50 tiles with grout baked in.
// So the DB `sizes` field ("3x6 in") describes one tile inside the photo and
// cannot be converted to a scale — nothing records how many tiles a photo shows.
// These are per-category starting points read off the actual images, assuming
// roughly 12 ft of visible floor; the Tile size slider is the real answer for
// owner-uploaded tiles, whose scale we can never know.
const DEFAULT_REPEATS = {
  wooden:    1.5,   // image is ~8 ft of planks
  ceramic:   5,     // image is ~2.5 ft of subway/azulejo
  marble:    3,     // image reads as a ~4 ft slab face
  granite:   3,
  vitrified: 3,
  anti_skid: 3,
};
const FALLBACK_REPEATS = 3;
const SCALE_MIN = 0.25, SCALE_MAX = 4;  // slider multiplies the default by this range

let tileScale = 1;                      // 1 = category default; driven by the slider

function defaultRepeats(tile) {
  // Guard with a ternary, not `tile &&`: that yields null for a null tile, which
  // slips past an `undefined` check and would zero out the repeat count.
  const d = tile ? DEFAULT_REPEATS[tile.category] : undefined;
  return typeof d === 'number' && d > 0 ? d : FALLBACK_REPEATS;
}

// Slider 0..100 -> multiplier SCALE_MIN..SCALE_MAX, geometric so 50 lands on 1.0
// and each end feels like an equal step rather than one end being squashed.
function sliderToScale(v) {
  const t = v / 100;
  return SCALE_MIN * Math.pow(SCALE_MAX / SCALE_MIN, t);
}
function scaleToSlider(s) {
  return 100 * Math.log(s / SCALE_MIN) / Math.log(SCALE_MAX / SCALE_MIN);
}

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

// A real floor viewed from standing height projects to a trapezoid, so fit one
// line down the mask's left edge and one down its right edge. This recovers the
// floor plane from the SAM3 mask we already have — no manual corner picking, and
// it works for visitor-uploaded rooms too. Measured against the 8 catalogue
// masks this scores 0.907-0.992 IoU against the real mask.
function fitFloorQuad(alpha, W, H) {
  const rows = [];
  let maxCount = 0;
  for (let y = 0; y < H; y++) {
    let xmin = -1, xmax = -1, count = 0;
    const base = y * W;
    for (let x = 0; x < W; x++) {
      if (alpha[base + x] > 0.5) { if (xmin < 0) xmin = x; xmax = x; count++; }
    }
    if (count > 0) { rows.push({ y: y, xmin: xmin, xmax: xmax, count: count }); if (count > maxCount) maxCount = count; }
  }
  if (rows.length < 8) return null;
  // Drop sliver rows: far-field noise and stray specks skew the edge fit.
  const solid = rows.filter(function (r) { return r.count > maxCount * 0.15; });
  if (solid.length < 8) return null;

  const fitLine = function (pts) {
    const n = pts.length;
    let sy = 0, sx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const y = pts[i][0], x = pts[i][1];
      sy += y; sx += x; syy += y * y; sxy += x * y;
    }
    const den = n * syy - sy * sy;
    if (Math.abs(den) < 1e-9) return null;
    const mm = (n * sxy - sy * sx) / den;
    return { m: mm, b: (sx - mm * sy) / n };
  };
  const L = fitLine(solid.map(function (r) { return [r.y, r.xmin]; }));
  const R = fitLine(solid.map(function (r) { return [r.y, r.xmax]; }));
  if (!L || !R) return null;

  const yTop = solid[0].y, yBot = solid[solid.length - 1].y;
  if (yBot - yTop < 8) return null;
  const at = function (l, y) { return l.m * y + l.b; };
  const quad = [
    [at(L, yTop), yTop], [at(R, yTop), yTop],
    [at(R, yBot), yBot], [at(L, yBot), yBot],
  ];
  if (at(R, yTop) - at(L, yTop) < 4 || at(R, yBot) - at(L, yBot) < 4) return null;

  // How much of the mask actually lands inside the fitted quad.
  let inside = 0, total = 0;
  for (let i = 0; i < solid.length; i++) {
    const r = solid[i];
    const lx = at(L, r.y), rx = at(R, r.y);
    const base = r.y * W;
    for (let x = 0; x < W; x++) {
      if (alpha[base + x] > 0.5) { total++; if (x >= lx - 1 && x <= rx + 1) inside++; }
    }
  }
  return { quad: quad, coverage: total ? inside / total : 0 };
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
  // Only the floor is a ground plane; the trapezoid model does not describe walls.
  let Hm = null, quadCoverage = 0;
  if (activeSurface === 'floor') {
    const fit = fitFloorQuad(hard, W, H);
    if (fit && fit.coverage >= QUAD_MIN_COVERAGE) {
      quadCoverage = fit.coverage;
      // Map image -> tile plane directly, which is the direction the pixel loop needs.
      Hm = solveHomography(fit.quad, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
  }

  return { surface: activeSurface, W, H, soft, shade, hom: Hm, quadCoverage };
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
  const soft = surfaceCache.soft, shade = surfaceCache.shade, hom = surfaceCache.hom;
  // Larger tileScale means physically bigger tiles, so the image repeats fewer times.
  const repeats = defaultRepeats(selectedTile) / tileScale;

  const TS = 128;
  const tc = document.createElement('canvas');
  tc.width = TS; tc.height = TS;
  tc.getContext('2d').drawImage(selectedTile._img, 0, 0, TS, TS);
  const tex = tc.getContext('2d').getImageData(0, 0, TS, TS).data;

  const oc = document.createElement('canvas');
  oc.width = W; oc.height = H;
  const octx = oc.getContext('2d');
  let od;

  if (!hom) {
    // No trustworthy floor plane (walls, or a mask we couldn't fit): tile flat,
    // but still honour the size slider so the control does something everywhere.
    const step = Math.max(8, Math.round(W / repeats));
    const fc = document.createElement('canvas');
    fc.width = step; fc.height = step;
    fc.getContext('2d').drawImage(selectedTile._img, 0, 0, step, step);
    octx.fillStyle = octx.createPattern(fc, 'repeat');
    octx.fillRect(0, 0, W, H);
    od = octx.getImageData(0, 0, W, H);
  } else {
    od = octx.createImageData(W, H);
  }

  // Bilinear sample of the tile texture at wrapped tile-plane coords.
  function sample(u, v, out) {
    const fx = (u - Math.floor(u)) * TS - 0.5, fy = (v - Math.floor(v)) * TS - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const dx = fx - x0, dy = fy - y0;
    const xa = ((x0 % TS) + TS) % TS, xb = (((x0 + 1) % TS) + TS) % TS;
    const ya = ((y0 % TS) + TS) % TS, yb = (((y0 + 1) % TS) + TS) % TS;
    const i00 = (ya * TS + xa) * 4, i10 = (ya * TS + xb) * 4;
    const i01 = (yb * TS + xa) * 4, i11 = (yb * TS + xb) * 4;
    const w00 = (1 - dx) * (1 - dy), w10 = dx * (1 - dy);
    const w01 = (1 - dx) * dy, w11 = dx * dy;
    for (let c = 0; c < 3; c++) {
      out[c] += tex[i00 + c] * w00 + tex[i10 + c] * w10 + tex[i01 + c] * w01 + tex[i11 + c] * w11;
    }
  }

  const acc = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4;
      const a = soft[p];
      if (a <= 0.002) { od.data[i + 3] = 0; continue; }
      const s = shade[p];
      if (hom) {
        acc[0] = acc[1] = acc[2] = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const uv = applyHomography(hom, x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
            sample(uv[0] * repeats, uv[1] * repeats, acc);
          }
        }
        const n = SS * SS;
        od.data[i]     = acc[0] / n * s;
        od.data[i + 1] = acc[1] / n * s;
        od.data[i + 2] = acc[2] / n * s;
      } else {
        od.data[i]     *= s;
        od.data[i + 1] *= s;
        od.data[i + 2] *= s;
      }
      od.data[i + 3] = a * TILE_OPACITY;
    }
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
  // Tile size: re-render only. Scale never touches the mask or shading, so the
  // surface cache stays valid and dragging stays cheap.
  document.getElementById('tile-scale').addEventListener('input', e => {
    tileScale = sliderToScale(+e.target.value);
    renderCanvas();
  });
  document.getElementById('scale-reset').addEventListener('click', () => {
    tileScale = 1;
    document.getElementById('tile-scale').value = scaleToSlider(1);
    renderCanvas();
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
