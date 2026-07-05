import { API_BASE } from '../config.js';

const POLL_INTERVAL_MS = 30_000;
const TIMEOUT_MS       = 20 * 60 * 1000;

let pollTimer = null, timeoutTimer = null, elapsedTimer = null;
let elapsedSeconds = 0, currentHash = null, uploadStartTime = null;
let turnstileToken = null;

window.onTurnstileSuccess = (token) => { turnstileToken = token; };

const fileInput      = document.getElementById('file-input');
const fileDropZone   = document.getElementById('file-drop-zone');
const categorySelect = document.getElementById('category-select');
const btnProcess     = document.getElementById('btn-process');
const btnRetry       = document.getElementById('btn-retry');
const step1          = document.getElementById('upload-step-1');
const step2          = document.getElementById('upload-step-2');
const step3          = document.getElementById('upload-step-3');
const processingMsg  = document.getElementById('processing-msg');
const elapsedLabel   = document.getElementById('elapsed-label');
const errorTitle     = document.getElementById('error-title');
const errorMsg       = document.getElementById('error-msg');

const slug = new URLSearchParams(location.search).get('shop') || '';

let selectedFile = null;

fileInput.addEventListener('change', e => { if (e.target.files[0]) setFile(e.target.files[0]); });
fileDropZone.addEventListener('click', () => fileInput.click());
fileDropZone.addEventListener('dragover', e => { e.preventDefault(); fileDropZone.classList.add('drag-over'); });
fileDropZone.addEventListener('dragleave', () => fileDropZone.classList.remove('drag-over'));
fileDropZone.addEventListener('drop', e => {
  e.preventDefault(); fileDropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) setFile(f);
});

function setFile(file) {
  if (file.size > 20 * 1024 * 1024) { showError('File too large', 'Choose an image under 20MB.'); return; }
  selectedFile = file;
  fileDropZone.classList.add('has-file');
  fileDropZone.querySelector('span').textContent = `✓  ${file.name}`;
  btnProcess.disabled = false;
}

async function hashFile(file) {
  const buf = await file.arrayBuffer();
  const h   = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0,8);
}

async function checkReady(hash) {
  try {
    const res  = await fetch(`${API_BASE}/api/tile/poll/${hash}?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' });
    const data = await res.json();
    return (data.ok && data.ready) ? data : null;
  } catch { return null; }
}

btnProcess.addEventListener('click', async () => {
  if (!selectedFile || !slug) return;
  if (!turnstileToken) {
    showError('Verification required', 'Please wait for the security check to complete.');
    return;
  }
  btnProcess.disabled = true;
  processingMsg.textContent = 'Computing fingerprint…';

  const hash     = await hashFile(selectedFile);
  const category = categorySelect.value;
  currentHash    = hash;

  const cached = await checkReady(hash);
  if (cached) { handleMasksReady(hash, cached); return; }

  goToStep(2); startElapsedTimer(); uploadStartTime = Date.now();

  try {
    processingMsg.textContent = 'Uploading photo…';
    const imageBase64 = await fileToBase64(selectedFile);
    const res = await fetch(`${API_BASE}/api/tile/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, hash, category, slug, turnstileToken }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Upload error ${res.status}`);
    }
    processingMsg.textContent = 'AI segmentation queued. Checking every 30s…';
  } catch (e) {
    showError('Upload Failed', e.message); return;
  }

  pollTimer = setInterval(async () => {
    const ready = await checkReady(hash);
    if (ready) { clearInterval(pollTimer); stopElapsedTimer(); clearTimeout(timeoutTimer); handleMasksReady(hash, ready); return; }
    const elapsed = Math.floor((Date.now() - uploadStartTime) / 60000);
    processingMsg.textContent = `SAM 3 analysing your room (${elapsed} min elapsed)…`;
  }, POLL_INTERVAL_MS);

  timeoutTimer = setTimeout(() => {
    clearInterval(pollTimer); stopElapsedTimer();
    showError('Still Processing…', 'AI is taking longer than expected. Bookmark this page and check back.');
    btnRetry.textContent = 'Check Again';
    btnRetry.onclick = () => { goToStep(2); startElapsedTimer(); uploadStartTime = Date.now(); pollTimer = setInterval(async () => {
      const ready = await checkReady(hash);
      if (ready) { clearInterval(pollTimer); stopElapsedTimer(); handleMasksReady(hash, ready); }
    }, POLL_INTERVAL_MS); };
  }, TIMEOUT_MS);
});

function handleMasksReady(hash, readyData) {
  document.getElementById('upload-modal').classList.add('hidden');
  const surfaces = readyData.surfaces || ['floor'];
  const masks    = {};
  surfaces.forEach(s => { if (readyData.maskUrls?.[s]) masks[s] = readyData.maskUrls[s]; });
  const userRoom = {
    id: `user_${hash}`, name: 'Your Room', category: categorySelect.value,
    surfaces, photo: readyData.photoUrl || '', masks, hasMasks: true,
  };
  if (selectedFile) {
    userRoom._localPhotoURL = URL.createObjectURL(selectedFile);
    userRoom.photo          = userRoom._localPhotoURL;
  }
  if (window.SS_openRoom) {
    window.SS_openRoom(userRoom);
    if (window.SS_showToast) window.SS_showToast('Your room is ready! Pick a tile to preview.');
  }
}

function startElapsedTimer() {
  elapsedSeconds = 0; updateElapsed();
  elapsedTimer = setInterval(() => { elapsedSeconds++; updateElapsed(); }, 1000);
}
function stopElapsedTimer() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; } }
function updateElapsed() {
  const m = String(Math.floor(elapsedSeconds/60)), s = String(elapsedSeconds%60).padStart(2,'0');
  elapsedLabel.textContent = `Elapsed: ${m}:${s}`;
}
function goToStep(n) {
  [step1,step2,step3].forEach((el,i) => {
    el.classList.toggle('active', i+1===n); el.classList.toggle('hidden', i+1!==n);
  });
}
function showError(title, msg) {
  goToStep(3);
  errorTitle.textContent = title; errorMsg.textContent = msg;
  btnRetry.textContent = 'Try Another Photo'; btnRetry.onclick = resetUpload;
}
function resetUpload() {
  selectedFile = null; currentHash = null; turnstileToken = null;
  fileDropZone.classList.remove('has-file','drag-over');
  fileDropZone.querySelector('span').textContent = 'Drop a photo here or click to browse';
  btnProcess.disabled = true; fileInput.value = '';
  if (pollTimer) clearInterval(pollTimer);
  stopElapsedTimer(); clearTimeout(timeoutTimer);
  goToStep(1);
}
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
btnRetry.addEventListener('click', resetUpload);
