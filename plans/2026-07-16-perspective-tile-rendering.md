# Perspective-Correct Tile Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tiles recede into the floor with true perspective instead of being a flat, uniform-size repeating pattern pasted over the photo.

**Architecture:** Fit a trapezoid to the SAM3 floor mask we already load, solve a homography that maps image pixels back to a flat "tile plane", and for each masked pixel sample the tile texture at its plane coordinate. Tiles then shrink toward the back automatically because the homography does the foreshortening. This reuses the existing per-pixel loop in `renderCanvas()` that already does masking and shading, so perspective costs one matrix multiply per pixel and no new dependency.

**Tech Stack:** Vanilla Canvas 2D, plain ES5-compatible JS, no build step, no WebGL, no libraries. Static GitHub Pages.

## Global Constraints

- **No new dependencies.** No `perspective.js`, no npm, no bundler. The site is static files served by GitHub Pages.
- **No `ctx.filter`.** Not Baseline; silently no-ops on older Android browsers, which are most of our visitor traffic.
- **No new precompute.** Must work on the existing floor masks for all 24 rooms and on visitor-uploaded rooms, with no SAM3 re-run and no backend change.
- **Never write plans, notes, or scratch files under `docs/`.** That directory is the live GitHub Pages root and anything in it is published publicly.
- **Must degrade safely.** If the quad fit is poor, fall back to the current flat tiling rather than render garbage.
- **Preserve existing behaviour:** feathered mask edges and room luminance shading (shipped in `6c795a3`) must survive unchanged.
- Deploy branch is `main`; Pages serves `docs/`. Push to both `origin` (PrasuNova, live) and `supraa-testing` (mirror).

## Verification approach

This repo has no test framework and no build step — it is static files. Verification is done the way the shipped box-blur was verified: standalone Node scripts in the scratchpad that import the real functions out of `docs/s/app.js` and assert numeric properties, plus a browser harness for visual checks. Scratchpad path:

`C:\Users\sunil\AppData\Local\Temp\claude\W--PrasuNova-Tile-visualization\6fce53df-07e0-4068-92af-182a23faca0f\scratchpad`

Real production floor masks for 8 rooms are already downloaded to `scratchpad/masks/*.png`, and `scratchpad/pngdec.mjs` decodes them (Node zlib, no PIL/sharp).

## File Structure

- `docs/s/app.js` — the only production file that changes. All new code is added to it as plain functions. It is currently ~330 lines and cohesive (one page's logic); splitting it would mean adding `<script>` tags or module wiring for no benefit, so new functions go here alongside `blurChannel` / `buildSurfaceCache`.
  - `solveHomography(src, dst)` — pure math, no DOM.
  - `applyHomography(H, x, y)` — pure math, no DOM.
  - `fitFloorQuad(maskAlpha, W, H)` — pure math, no DOM.
  - `buildSurfaceCache(W, H)` — extended to also compute and cache the homography.
  - `renderCanvas()` — pixel loop extended to sample through the homography.
- `plans/2026-07-16-perspective-tile-rendering.md` — this file. Not under `docs/`, so not published.

---

### Task 1: Homography solver

**Files:**
- Modify: `docs/s/app.js` (add two functions above `buildSurfaceCache`)
- Test: `scratchpad/test-homography.mjs` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `solveHomography(src, dst)` → `Float64Array(9)` or `null`. `src`/`dst` are each an array of 4 `[x, y]` points in corresponding order. Returns the 3×3 matrix (row-major, `H[8]` normalised to 1) mapping `src` → `dst`. Returns `null` if the system is singular (degenerate quad).
  - `applyHomography(H, x, y)` → `[u, v]`. Applies `H` to a point and divides through by w.

- [ ] **Step 1: Write the failing test**

Create `scratchpad/test-homography.mjs`:

```js
import fs from 'fs';
const src = fs.readFileSync('W:/PrasuNova/Tile visualization/mansi-granite-visualizer/docs/s/app.js','utf8').replace(/\r\n/g,'\n');
function grab(name) {
  const m = src.match(new RegExp('function ' + name + '[\\s\\S]*?\\n}\\n'));
  if (!m) throw new Error('could not find ' + name + ' in app.js');
  return m[0];
}
const solveHomography = eval('(' + grab('solveHomography') + ')');
const applyHomography = eval('(' + grab('applyHomography') + ')');

let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) fails++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// identity: unit square -> unit square
const unit = [[0,0],[1,0],[1,1],[0,1]];
const I = solveHomography(unit, unit);
ok('identity maps (0.3,0.7) to itself', (() => {
  const [u,v] = applyHomography(I, 0.3, 0.7); return near(u,0.3) && near(v,0.7);
})());

// the four corners must map exactly onto the destination corners
const quad = [[120,715],[901,715],[1066,1023],[-43,1023]];   // real balcony_02 fit
const H = solveHomography(quad, unit);
ok('quad corners map to unit-square corners', unit.every((want, i) => {
  const [u,v] = applyHomography(H, quad[i][0], quad[i][1]);
  return near(u, want[0], 1e-6) && near(v, want[1], 1e-6);
}));

// round trip: plane -> image -> plane
const Hinv = solveHomography(unit, quad);
ok('round trip plane->image->plane is stable', (() => {
  for (const [u0,v0] of [[0.1,0.2],[0.5,0.5],[0.9,0.85]]) {
    const [x,y] = applyHomography(Hinv, u0, v0);
    const [u1,v1] = applyHomography(H, x, y);
    if (!near(u1,u0,1e-6) || !near(v1,v0,1e-6)) return false;
  }
  return true;
})());

// perspective is real: equal steps in v must NOT be equal steps in image y
ok('foreshortening present (far rows compress)', (() => {
  const a = applyHomography(Hinv, 0.5, 0.1)[1];
  const b = applyHomography(Hinv, 0.5, 0.5)[1];
  const c = applyHomography(Hinv, 0.5, 0.9)[1];
  return (b - a) < (c - b) * 0.999;   // near band must span more pixels than far band
})());

// degenerate input must return null, not NaN
ok('degenerate quad returns null', solveHomography([[0,0],[0,0],[0,0],[0,0]], unit) === null);

console.log(fails ? '\n' + fails + ' FAILURES' : '\nALL PASS');
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd <scratchpad> && node test-homography.mjs`
Expected: FAIL — `Error: could not find solveHomography in app.js`

- [ ] **Step 3: Implement the minimal code to make the test pass**

In `docs/s/app.js`, immediately above `// Feathered mask + per-pixel shading factors`, add:

```js
// Solves the 8-DOF projective transform taking the four src points to the four
// dst points. Canvas 2D's own setTransform is affine only, so it cannot do this.
function solveHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
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
  const H = new Float64Array(9);
  for (let i = 0; i < 8; i++) H[i] = b[i];
  H[8] = 1;
  return H;
}

function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  if (Math.abs(w) < 1e-12) return [0, 0];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `cd <scratchpad> && node test-homography.mjs`
Expected: all 5 PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add docs/s/app.js
git commit -m "feat: add homography solver for perspective tile mapping"
```

---

### Task 2: Fit the floor quad from the mask

**Files:**
- Modify: `docs/s/app.js` (add `fitFloorQuad` above `buildSurfaceCache`)
- Test: `scratchpad/test-quadfit.mjs` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `fitFloorQuad(alpha, W, H)` → `{ quad, coverage }` or `null`.
  - `alpha` is a `Float32Array(W*H)`, 1 inside the surface and 0 outside (this is exactly the `hard` array already built in `buildSurfaceCache`).
  - `quad` is `[[x,y] ×4]` ordered top-left, top-right, bottom-right, bottom-left — i.e. far edge first, near edge last.
  - `coverage` is the fraction of mask pixels that fall inside the fitted quad (0–1). Callers use it to decide whether to trust the fit.
  - Returns `null` when the mask is too small or too thin to fit.

Rationale, already validated against 8 real production masks (mean IoU 0.946, worst 0.907): a real floor photographed from standing height projects to a trapezoid, so fitting one line to the leftmost mask pixel per row and one to the rightmost recovers the floor plane without any manual corner-clicking.

- [ ] **Step 1: Write the failing test**

Create `scratchpad/test-quadfit.mjs`:

```js
import fs from 'fs';
import { decodePNG, toMask } from './pngdec.mjs';
const src = fs.readFileSync('W:/PrasuNova/Tile visualization/mansi-granite-visualizer/docs/s/app.js','utf8').replace(/\r\n/g,'\n');
const m = src.match(/function fitFloorQuad[\s\S]*?\n}\n/);
if (!m) throw new Error('could not find fitFloorQuad in app.js');
const fitFloorQuad = eval('(' + m[0] + ')');

let fails = 0;
const ok = (n, c) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n); if (!c) fails++; };

// A synthetic trapezoid must be recovered almost exactly.
const W = 400, H = 300, a = new Float32Array(W * H);
const xAt = (y, x0, x1) => x0 + (x1 - x0) * (y - 100) / 199;
for (let y = 100; y < 300; y++)
  for (let x = Math.ceil(xAt(y, 150, 20)); x <= Math.floor(xAt(y, 250, 380)); x++)
    if (x >= 0 && x < W) a[y * W + x] = 1;
const fit = fitFloorQuad(a, W, H);
ok('fits a synthetic trapezoid', !!fit);
ok('coverage above 0.95 on clean trapezoid', fit && fit.coverage > 0.95);
ok('recovers far-left corner within 4px', fit && Math.abs(fit.quad[0][0] - 150) < 4);
ok('recovers near-right corner within 4px', fit && Math.abs(fit.quad[2][0] - 380) < 4);
ok('quad ordered far edge first', fit && fit.quad[0][1] < fit.quad[3][1]);

// Empty and near-empty masks must not throw.
ok('empty mask returns null', fitFloorQuad(new Float32Array(W * H), W, H) === null);

// Every real production mask must fit with good coverage.
for (const f of fs.readdirSync('masks').filter(f => f.endsWith('.png')).sort()) {
  const png = decodePNG('masks/' + f);
  const bin = toMask(png);
  const al = new Float32Array(png.W * png.H);
  for (let i = 0; i < bin.length; i++) al[i] = bin[i];
  const r = fitFloorQuad(al, png.W, png.H);
  ok(f.padEnd(22) + ' coverage ' + (r ? r.coverage.toFixed(3) : 'null'), !!r && r.coverage > 0.85);
}
console.log(fails ? '\n' + fails + ' FAILURES' : '\nALL PASS');
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd <scratchpad> && node test-quadfit.mjs`
Expected: FAIL — `Error: could not find fitFloorQuad in app.js`

- [ ] **Step 3: Implement the minimal code to make the test pass**

In `docs/s/app.js`, above `buildSurfaceCache`, add:

```js
// A real floor viewed from standing height projects to a trapezoid, so fit one
// line down the mask's left edge and one down its right edge. This recovers the
// floor plane from the SAM3 mask we already have — no manual corner picking, and
// it works for visitor-uploaded rooms too.
function fitFloorQuad(alpha, W, H) {
  const rows = [];
  let maxCount = 0;
  for (let y = 0; y < H; y++) {
    let xmin = -1, xmax = -1, count = 0;
    const base = y * W;
    for (let x = 0; x < W; x++) {
      if (alpha[base + x] > 0.5) { if (xmin < 0) xmin = x; xmax = x; count++; }
    }
    if (count > 0) { rows.push({ y, xmin, xmax, count }); if (count > maxCount) maxCount = count; }
  }
  if (rows.length < 8) return null;
  // Drop sliver rows: far-field noise and stray specks skew the edge fit.
  const solid = rows.filter(r => r.count > maxCount * 0.15);
  if (solid.length < 8) return null;

  const fitLine = pts => {
    const n = pts.length;
    let sy = 0, sx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const [y, x] = pts[i]; sy += y; sx += x; syy += y * y; sxy += x * y; }
    const den = n * syy - sy * sy;
    if (Math.abs(den) < 1e-9) return null;
    const mm = (n * sxy - sy * sx) / den;
    return { m: mm, b: (sx - mm * sy) / n };
  };
  const L = fitLine(solid.map(r => [r.y, r.xmin]));
  const R = fitLine(solid.map(r => [r.y, r.xmax]));
  if (!L || !R) return null;

  const yTop = solid[0].y, yBot = solid[solid.length - 1].y;
  if (yBot - yTop < 8) return null;
  const at = (l, y) => l.m * y + l.b;
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
  return { quad, coverage: total ? inside / total : 0 };
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `cd <scratchpad> && node test-quadfit.mjs`
Expected: all PASS — synthetic trapezoid recovered, empty mask returns null, and all 8 real masks report coverage > 0.85.

- [ ] **Step 5: Commit**

```bash
git add docs/s/app.js
git commit -m "feat: derive floor quad from the SAM3 mask by trapezoid fit"
```

---

### Task 3: Sample tiles through the homography

**Files:**
- Modify: `docs/s/app.js` — `buildSurfaceCache()` and `renderCanvas()`
- Test: `scratchpad/test-perspective.mjs` (new)

**Interfaces:**
- Consumes: `solveHomography(src, dst)`, `applyHomography(H, x, y)`, `fitFloorQuad(alpha, W, H)` from Tasks 1–2.
- Produces: `surfaceCache` gains two fields — `hom` (`Float64Array(9)` mapping image → tile plane, or `null` when tiling should stay flat) and `quadCoverage` (number).

**Naming warning:** the field MUST be called `hom`, not `H`. The cache object already carries `H` as the canvas height via shorthand (`{ surface, W, H, soft, shade }`), and a second `H:` key would silently overwrite the height, breaking the `surfaceCache.H !== H` freshness check so the blur rebuilds on every tile click.

Design notes:
- Tiles repeat uniformly in **plane** space. Because the homography maps image → plane, uniform repeats in the plane come out foreshortened in the image for free.
- `FLOOR_TILES_ACROSS = 6` assumes the visible floor is about 12 ft wide with 2 ft tiles. The visible floor is assumed square, so `v` uses the same repeat count and tiles stay square. Real-world calibration is item #4 and is deliberately out of scope.
- Walls keep flat tiling: the trapezoid model is a floor model, so only `activeSurface === 'floor'` gets a homography.
- If `fitFloorQuad` returns `null` or coverage < 0.80, `H` stays `null` and rendering falls back to the existing flat pattern.
- Sampling is 2×2 supersampled and bilinear, because tiles compress toward the far edge and point-sampling there aliases into noise.

- [ ] **Step 1: Write the failing test**

Create `scratchpad/test-perspective.mjs`:

```js
import fs from 'fs';
const src = fs.readFileSync('W:/PrasuNova/Tile visualization/mansi-granite-visualizer/docs/s/app.js','utf8').replace(/\r\n/g,'\n');
let fails = 0;
const ok = (n, c) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n); if (!c) fails++; };

ok('FLOOR_TILES_ACROSS constant defined', /const FLOOR_TILES_ACROSS\s*=/.test(src));
ok('QUAD_MIN_COVERAGE constant defined', /const QUAD_MIN_COVERAGE\s*=/.test(src));
ok('buildSurfaceCache fits the quad', /fitFloorQuad\(/.test(src));
ok('homography only built for floor', /activeSurface === 'floor'/.test(src));
ok('cache carries hom (not H, which would clobber height)', /hom:\s*Hm/.test(src.match(/return \{ surface[\s\S]*?\};/)[0]));
ok('renderCanvas samples via applyHomography', /applyHomography\(/.test(src.match(/function renderCanvas[\s\S]*?\n}\n/)[0]));
ok('flat-tiling fallback retained', /if \(!hom\)/.test(src));
ok('supersampling present', /SS\b/.test(src));

// The shipped feathering and shading must still be wired in.
ok('feathering still applied', /blurChannel\(/.test(src));
ok('shading still applied', /shade\[/.test(src));
console.log(fails ? '\n' + fails + ' FAILURES' : '\nALL PASS');
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd <scratchpad> && node test-perspective.mjs`
Expected: FAIL — `FLOOR_TILES_ACROSS constant defined` and most others fail.

- [ ] **Step 3: Add the constants**

In `docs/s/app.js`, next to `const TILE_OPACITY = 200;`, add:

```js
const FLOOR_TILES_ACROSS = 6;      // ~12 ft of visible floor at 2 ft per tile
const QUAD_MIN_COVERAGE = 0.80;    // below this, the fit is untrustworthy -> flat tiling
const SS = 2;                      // 2x2 supersampling; far-field tiles alias badly without it
```

- [ ] **Step 4: Build the homography inside `buildSurfaceCache`**

In `docs/s/app.js`, inside `buildSurfaceCache`, immediately before the `return { surface: activeSurface, W, H, soft, shade };` line, insert:

```js
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
```

and change the return line to:

```js
  return { surface: activeSurface, W, H, soft, shade, hom: Hm, quadCoverage };
```

- [ ] **Step 5: Sample through the homography in `renderCanvas`**

In `docs/s/app.js`, replace the whole body of `renderCanvas` after the cache lookup. Replace:

```js
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
```

with:

```js
  const { soft, shade, hom } = surfaceCache;

  const TS = 128;
  const tc = document.createElement('canvas');
  tc.width = TS; tc.height = TS;
  tc.getContext('2d').drawImage(selectedTile._img, 0, 0, TS, TS);
  const tex = tc.getContext('2d').getImageData(0, 0, TS, TS).data;

  const oc = document.createElement('canvas');
  oc.width = W; oc.height = H;
  const octx = oc.getContext('2d');
  const od = octx.createImageData(W, H);

  if (!hom) {
    // Fallback: no trustworthy floor plane, tile flat like before.
    octx.fillStyle = octx.createPattern(tc, 'repeat');
    octx.fillRect(0, 0, W, H);
    const flat = octx.getImageData(0, 0, W, H);
    od.data.set(flat.data);
  }

  // Bilinear sample of the tile texture at wrapped plane coords.
  function sample(u, v, out) {
    let fx = (u - Math.floor(u)) * TS - 0.5, fy = (v - Math.floor(v)) * TS - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const dx = fx - x0, dy = fy - y0;
    const xa = ((x0 % TS) + TS) % TS, xb = ((x0 + 1) % TS + TS) % TS;
    const ya = ((y0 % TS) + TS) % TS, yb = ((y0 + 1) % TS + TS) % TS;
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
      if (hom) {
        acc[0] = acc[1] = acc[2] = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
            const uv = applyHomography(hom, px, py);
            sample(uv[0] * FLOOR_TILES_ACROSS, uv[1] * FLOOR_TILES_ACROSS, acc);
          }
        }
        const n = SS * SS, s = shade[p];
        od.data[i]     = acc[0] / n * s;
        od.data[i + 1] = acc[1] / n * s;
        od.data[i + 2] = acc[2] / n * s;
      } else {
        const s = shade[p];
        od.data[i]     *= s;
        od.data[i + 1] *= s;
        od.data[i + 2] *= s;
      }
      od.data[i + 3] = a * TILE_OPACITY;
    }
  }
  octx.putImageData(od, 0, 0);
  ctx.drawImage(oc, 0, 0);
```

- [ ] **Step 6: Run the test and make sure it passes**

Run: `cd <scratchpad> && node test-perspective.mjs`
Expected: all 10 PASS.

Then re-run the earlier suites to prove nothing regressed:

Run: `node test-homography.mjs && node test-quadfit.mjs && node --check "W:/PrasuNova/Tile visualization/mansi-granite-visualizer/docs/s/app.js"`
Expected: ALL PASS from both, and no syntax error.

- [ ] **Step 7: Commit**

```bash
git add docs/s/app.js
git commit -m "feat: perspective-correct tile sampling via floor homography"
```

---

### Task 4: Visual verification and deploy

**Files:**
- Modify: `scratchpad/rendertest/index.html` (existing before/after harness)
- Modify: `REVERT-TRACKER.md`

**Interfaces:**
- Consumes: the finished `renderCanvas()` from Task 3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Point the harness at the current app.js and open it**

```bash
cd <scratchpad>/rendertest
cp "W:/PrasuNova/Tile visualization/mansi-granite-visualizer/docs/s/app.js" app.js.txt
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8777/index.html
```

Expected: `200`. Open http://localhost:8777 and hard-refresh.

- [ ] **Step 2: Check it by eye**

Expected: on the right pane the tile grid converges toward the back of the room — tiles nearest the camera are visibly larger than tiles at the far wall — while the left pane stays uniformly sized. Feathered edges and room shading must still be present.

If the floor looks like it is sliding uphill, or tiles are wildly stretched, the quad order is wrong; re-check that `fitFloorQuad` returns far edge first.

- [ ] **Step 3: Record the revert point**

Update the `## Render pipeline` section of `REVERT-TRACKER.md` to name the new perspective commit and keep `6c795a3` documented as the previous known-good.

- [ ] **Step 4: Deploy to both remotes**

```bash
cd "W:/PrasuNova/Tile visualization/mansi-granite-visualizer"
git push origin main
git push supraa-testing main
```

- [ ] **Step 5: Verify live**

```bash
curl -s "https://showroom.prasunova.com/s/app.js" | grep -c applyHomography
```

Expected: non-zero. Then check https://showroom.prasunova.com/s/?shop=demo on a real room.

---

## Out of scope (deliberately)

- **Grout lines and real-world tile scale (#4).** The homography gives every pixel a plane coordinate, which is exactly what grout and true scale need — so this plan makes #4 cheap — but #4 needs a pixels-per-foot calibration that nothing in the pipeline establishes yet. Not attempted here.
- **Wall perspective.** The trapezoid model describes a ground plane. Walls keep flat tiling.
- **Manual corner adjustment UI.** The spike showed the automatic fit scores 0.907–0.992 IoU on real masks, so there is nothing for a human to fix yet. Revisit only if real rooms prove worse than the catalogue.
