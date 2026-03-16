// ── State ─────────────────────────────────────────────────
const state = {
  jobId:          null,
  taskId:         null,
  selectedHeight: null,
  selectedAudioFormat: 'mp3',
  selectedImageFormat: 'original',
  outputFormat:   'mp4',
  availableFormats: ['mp4', 'mp3', 'thumbnail'],
  pollTimer:      null,
  busy:           false,
  stopping:       false,
  deliveredFile:  null,
};

const TOOL_DEFINITIONS = [
  {
    format: 'mp4',
    label: 'Video Downloader',
    description: 'Save the full video as MP4 and choose quality.',
    badge: 'MP4',
  },
  {
    format: 'mp3',
    label: 'Video to MP3',
    description: 'Extract clean audio and export as MP3.',
    badge: 'MP3',
  },
  {
    format: 'thumbnail',
    label: 'Thumbnail Downloader',
    description: 'Save the source thumbnail image when available.',
    badge: 'IMG',
  },
];

const ALL_TOOL_FORMATS = TOOL_DEFINITIONS.map((tool) => tool.format);

// ── ETA tracker ───────────────────────────────────────────
const eta = {
  phase:    -1,     // activeIdx of the phase being tracked
  samples:  [],     // [ { pct, ts } ] — rolling speed samples
  lastPct:  0,
  lastTs:   0,
};

function resetEta() {
  eta.phase   = -1;
  eta.samples = [];
  eta.lastPct = 0;
  eta.lastTs  = 0;
}

// Returns a human-readable ETA string, or '' if not enough data yet.
function calcEta(activeIdx, pct) {
  if (pct <= 0 || pct >= 100) { resetEta(); return ''; }

  const now = Date.now();

  // New phase started — reset
  if (activeIdx !== eta.phase) {
    eta.phase   = activeIdx;
    eta.samples = [];
    eta.lastPct = pct;
    eta.lastTs  = now;
    return '';
  }

  const elapsed = (now - eta.lastTs) / 1000; // seconds
  const delta   = pct - eta.lastPct;

  if (elapsed >= 0.4 && delta > 0) {
    eta.samples.push(delta / elapsed);        // % per second
    if (eta.samples.length > 10) eta.samples.shift();
    eta.lastPct = pct;
    eta.lastTs  = now;
  }

  if (eta.samples.length < 2) return '';

  const speed = eta.samples.reduce((a, b) => a + b, 0) / eta.samples.length;
  const secsLeft = (100 - pct) / speed;

  if (secsLeft < 4)  return 'almost done';
  if (secsLeft < 60) return `${Math.round(secsLeft)}s remaining`;
  const m = Math.floor(secsLeft / 60);
  const s = Math.round(secsLeft % 60);
  return `${m}m ${s < 10 ? '0' + s : s}s remaining`;
}

// ── DOM refs ──────────────────────────────────────────────
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const loginOverlay    = $('#login-overlay');
const app             = $('#app');
const loginForm       = $('#login-form');
const loginBtn        = $('#login-btn');
const loginError      = $('#login-error');
const analyzeForm     = $('#analyze-form');
const analyzeBtn      = $('#analyze-btn');
const urlInput        = $('#url-input');
const urlError        = $('#url-error');
const urlHint         = $('#url-hint');
const analyzingNotice = $('#analyzing-notice');
const results         = $('#results');
const folderSection   = $('#folder-section');
const folderTitle     = $('#folder-title');
const folderFileList  = $('#folder-file-list');
const qualityCard     = $('.quality-card');
const formatSectionLabel = $('#format-section-label');
const qualityGrid     = $('#quality-grid');
const qualityNote     = $('#quality-note');
const audioFormatRow  = $('#audio-format-row');
const audioFormatSelect = $('#audio-format-select');
const imageFormatRow  = $('#image-format-row');
const imageFormatSelect = $('#image-format-select');
const outputGrid      = $('#output-grid');
const outputNote      = $('#output-note');
const downloadBtn     = $('#download-btn');
const downloadBtnLabel = $('#download-btn-label');
const downloadHint    = $('#download-hint');
const analyzeBtnLabel = $('#analyze-btn .btn-label');
const stopBtn         = $('#stop-btn');
const progressPanel   = $('#progress-panel');
const progressDetail  = $('#progress-detail');
const progBar         = $('#prog-bar');
const platformsToggle = $('#platforms-toggle');
const supportedPlatforms = $('#supported-platforms');
const platformsStatus = $('#platforms-status');
const platformsList = $('#platforms-list');
const platformsClose = $('#platforms-close');
const downloadResult  = $('#download-result');
const downloadResultTitle = $('#download-result-title');
const downloadResultMeta  = $('#download-result-meta');
const openPreviewBtn      = $('#open-preview-btn');
const saveAgainBtn        = $('#save-again-btn');
const dismissDownloadResultBtn = $('#dismiss-download-result-btn');
const logoutBtn       = $('#logout-btn');

const STEP_COUNT = 3;

let supportedPlatformsCache = null;

// ── Auth ──────────────────────────────────────────────────
async function checkAuth() {
  try {
    const r = await fetch('/api/auth/status', { credentials: 'include' });
    r.ok ? showApp() : showLogin();
  } catch { showLogin(); }
}

async function tryRefresh() {
  try {
    return (await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })).ok;
  } catch { return false; }
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    ...opts,
  });
  if (r.status === 401) {
    if (await tryRefresh()) return api(path, opts);
    showLogin();
    throw new Error('Session expired');
  }
  return r;
}

// ── Layout transitions ────────────────────────────────────
function showLogin() {
  app.classList.add('hidden');
  loginOverlay.classList.remove('hidden');
  setTimeout(() => $('#username')?.focus(), 80);
}
function showApp() {
  loginOverlay.classList.add('hidden');
  app.classList.remove('hidden');
  setTimeout(() => urlInput?.focus(), 80);
}

// ── Button helpers ────────────────────────────────────────
function setLoading(btn, on) {
  btn.disabled = on;
  btn.querySelector('.btn-label')?.classList.toggle('hidden', on);
  btn.querySelector('.btn-spinner')?.classList.toggle('hidden', !on);
}
function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
function hideError(el)       { el.classList.add('hidden'); }

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatQualityLabel(height) {
  return height === 'best' ? 'Best' : `${height}p`;
}

function formatOutputLabel(format) {
  return TOOL_DEFINITIONS.find((tool) => tool.format === format)?.label ?? 'Video Downloader';
}

function getRequestedHeight() {
  return state.outputFormat === 'mp4' ? state.selectedHeight : (state.selectedHeight ?? 'best');
}

function getRequestedFormat() {
  if (state.outputFormat === 'mp3') return state.selectedAudioFormat;
  return state.outputFormat;
}

function updateAnalyzeContext() {
  if (state.outputFormat === 'thumbnail') {
    urlInput.placeholder = 'Paste a video link to fetch its thumbnail image...';
    if (analyzeBtnLabel) analyzeBtnLabel.textContent = 'Fetch Thumbnail';
    if (urlHint) {
      urlHint.textContent = 'Thumbnail Downloader pulls the source preview image when the platform exposes one. Some links may not provide thumbnails.';
    }
    return;
  }

  if (state.outputFormat === 'mp3') {
    urlInput.placeholder = 'Paste a video link to extract audio...';
    if (analyzeBtnLabel) analyzeBtnLabel.textContent = 'Fetch Audio';
    if (urlHint) {
      urlHint.textContent = 'Audio converter extracts best available audio from supported links and lets you export MP3 or M4A.';
    }
    return;
  }

  urlInput.placeholder = 'Paste any video link — YouTube, Instagram, Drive...';
  if (analyzeBtnLabel) analyzeBtnLabel.textContent = 'Fetch Video';
  if (urlHint) {
    urlHint.textContent = 'Video Downloader saves full MP4 files from supported sites. Supports YouTube, Instagram, Facebook, TikTok, Twitter/X, Vimeo, and Google Drive files or folders.';
  }
}

function updateDownloadCallToAction() {
  if (state.outputFormat === 'thumbnail') {
    downloadBtn.disabled = false;
    const chosenFormat = state.selectedImageFormat === 'original'
      ? 'source format'
      : state.selectedImageFormat.toUpperCase();
    downloadBtnLabel.textContent = `Save thumbnail (${chosenFormat})`;
    downloadHint.textContent = 'Choose the image format you want, then save the thumbnail.';
    qualityCard.classList.remove('is-audio-mode');
    audioFormatRow.classList.add('hidden');
    imageFormatRow.classList.remove('hidden');
    qualityGrid.classList.add('hidden');
    if (formatSectionLabel) formatSectionLabel.textContent = 'Select image format';
    qualityNote.textContent = 'Thumbnail Downloader can save the original image or convert it to PNG, JPG, or WEBP before download.';
    outputNote.textContent = 'Thumbnail Downloader saves the preview image exposed by the source platform.';
    return;
  }

  if (state.outputFormat === 'mp3') {
    const chosenFormat = state.selectedAudioFormat.toUpperCase();
    downloadBtn.disabled = false;
    downloadBtnLabel.textContent = `Export ${chosenFormat} audio`;
    downloadHint.textContent = `Extract the best available audio track and save it as ${chosenFormat}.`;
    qualityCard.classList.remove('is-audio-mode');
    audioFormatRow.classList.remove('hidden');
    imageFormatRow.classList.add('hidden');
    qualityGrid.classList.add('hidden');
    if (formatSectionLabel) formatSectionLabel.textContent = 'Select audio format';
    qualityNote.textContent = 'Audio converter mode uses the best available source audio. Choose MP3 or M4A output format.';
    outputNote.textContent = 'Audio converter extracts the best available audio and converts it into the selected output format.';
    return;
  }

  qualityCard.classList.remove('is-audio-mode');
  audioFormatRow.classList.add('hidden');
  imageFormatRow.classList.add('hidden');
  qualityGrid.classList.remove('hidden');
  if (formatSectionLabel) formatSectionLabel.textContent = 'Select quality';
  qualityNote.textContent = 'Video and audio are combined into a single MP4 file.';
  outputNote.textContent = 'Video Downloader saves the full video as MP4 and lets the user pick the best available quality.';

  if (state.selectedHeight) {
    downloadBtn.disabled = false;
    downloadBtnLabel.textContent = `Download ${formatQualityLabel(state.selectedHeight)} MP4`;
    downloadHint.textContent = `Ready to save ${formatQualityLabel(state.selectedHeight)} as a single MP4 file.`;
  } else {
    downloadBtn.disabled = true;
    downloadBtnLabel.textContent = 'Select a quality above';
    downloadHint.textContent = 'Pick a quality to unlock the download action.';
  }
}

function renderOutputOptions(formats = ALL_TOOL_FORMATS) {
  const availableSet = new Set(formats);
  outputGrid.innerHTML = '';
  state.availableFormats = [...availableSet];

  TOOL_DEFINITIONS.forEach((tool) => {
    const isAvailable = availableSet.has(tool.format);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `output-item${isAvailable ? '' : ' unavailable'}`;
    btn.dataset.format = tool.format;
    btn.disabled = !isAvailable;
    btn.setAttribute('aria-disabled', String(!isAvailable));
    btn.innerHTML = `
      <div class="output-item-title-row">
        <strong class="output-item-title">${tool.label}</strong>
        <span class="output-item-tag">${isAvailable ? tool.badge : 'Unavailable'}</span>
      </div>
      <p class="output-item-desc">${tool.description}</p>
    `;

    if (isAvailable) {
      btn.addEventListener('click', () => selectOutputFormat(tool.format, btn));
    }

    outputGrid.appendChild(btn);
  });

  if (!availableSet.has(state.outputFormat)) {
    state.outputFormat = formats[0] ?? 'mp4';
  }

  const activeButton = outputGrid.querySelector(`[data-format="${state.outputFormat}"]`);
  if (activeButton) {
    activeButton.classList.add('selected');
  }

  updateAnalyzeContext();
}

function selectOutputFormat(format, button) {
  state.outputFormat = format;
  outputGrid.querySelectorAll('.output-item').forEach((item) => item.classList.remove('selected'));
  button.classList.add('selected');
  updateAnalyzeContext();
  applyProgressPreset();
  updateDownloadCallToAction();
}

function setStopButtonVisible(visible) {
  stopBtn.classList.toggle('hidden', !visible);
}

function setStepsIdle() {
  document.querySelectorAll('.pstep').forEach((el) => {
    el.classList.remove('active', 'done');
    el.querySelector('.pstep-icon').innerHTML = svgDot();
    const label = el.querySelector('.pstep-label');
    if (label?.dataset.base) label.textContent = label.dataset.base;
  });
}

function applyProgressPreset() {
  const audioLabel = state.selectedAudioFormat?.toUpperCase?.() ?? 'MP3';
  const labels = state.outputFormat === 'thumbnail'
    ? ['Downloading image', 'Preparing image', 'Ready to save']
    : state.outputFormat === 'mp3'
      ? ['Downloading source', 'Preparing audio', `Converting to ${audioLabel}`]
      : ['Downloading video', 'Downloading audio', 'Merging streams'];

  document.querySelectorAll('.pstep-label').forEach((label, index) => {
    label.dataset.base = labels[index] ?? label.textContent;
    label.textContent = label.dataset.base;
  });
}

function clearDeliveredFile() {
  if (state.deliveredFile?.blobUrl) URL.revokeObjectURL(state.deliveredFile.blobUrl);
  state.deliveredFile = null;
}

function hideDownloadResult() {
  downloadResult.classList.add('hidden');
}

function setPlatformsPanelVisible(visible) {
  supportedPlatforms.classList.toggle('hidden', !visible);
  platformsToggle?.setAttribute('aria-expanded', visible ? 'true' : 'false');
}

function renderSupportedPlatforms(platforms) {
  platformsList.innerHTML = '';

  platforms.forEach((platform) => {
    const item = document.createElement('article');
    item.className = 'supported-platform-item';
    item.innerHTML = `
      <h4 class="supported-platform-name">${escapeHtml(platform.name)}</h4>
      <p class="supported-platform-domains">${escapeHtml(platform.domains.join(', '))}</p>
    `;
    platformsList.appendChild(item);
  });

  platformsStatus.textContent = `Showing ${platforms.length} recognized platform families.`;
}

async function ensureSupportedPlatformsLoaded() {
  if (supportedPlatformsCache) {
    renderSupportedPlatforms(supportedPlatformsCache);
    return;
  }

  platformsStatus.textContent = 'Loading supported platforms…';
  platformsList.innerHTML = '';

  const response = await api('/api/video/platforms');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Could not load supported platforms');

  supportedPlatformsCache = data.platforms ?? [];
  renderSupportedPlatforms(supportedPlatformsCache);
}

function showDownloadResult({ title, meta, canPreview = true }) {
  downloadResultTitle.textContent = title;
  downloadResultMeta.textContent = meta;
  openPreviewBtn.disabled = !canPreview;
  saveAgainBtn.disabled = !state.deliveredFile?.blob;
  downloadResult.classList.remove('hidden');
}

function parseFilenameFromDisposition(headerValue, fallbackTitle = 'video') {
  if (!headerValue) return `${fallbackTitle}.mp4`;

  const utfMatch = headerValue.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch) return decodeURIComponent(utfMatch[1]);

  const basicMatch = headerValue.match(/filename="?([^";]+)"?/i);
  if (basicMatch) return basicMatch[1];

  return `${fallbackTitle}.mp4`;
}

function replaceFileExtension(filename, ext) {
  const cleanExt = ext.replace(/^\./, '');
  if (!filename) return `download.${cleanExt}`;
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return `${filename}.${cleanExt}`;
  return `${filename.slice(0, lastDot)}.${cleanExt}`;
}

async function convertImageBlob(blob, targetFormat) {
  const img = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  img.close();

  const mime = targetFormat === 'png'
    ? 'image/png'
    : targetFormat === 'jpg'
      ? 'image/jpeg'
      : 'image/webp';

  return new Promise((resolve, reject) => {
    canvas.toBlob((converted) => {
      if (!converted) {
        reject(new Error('Could not convert thumbnail image'));
        return;
      }
      resolve(converted);
    }, mime, targetFormat === 'jpg' ? 0.92 : undefined);
  });
}

function triggerBrowserDownload(blobUrl, filename) {
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function saveBlobToDisk(blob, filename) {
  const lower = filename.toLowerCase();
  const ext = lower.endsWith('.mp3') ? 'mp3'
    : lower.endsWith('.m4a') ? 'm4a'
    : lower.endsWith('.png') ? 'png'
    : lower.endsWith('.webp') ? 'webp'
    : lower.endsWith('.gif') ? 'gif'
    : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'jpg'
    : 'mp4';
  const mime = ext === 'mp3' ? 'audio/mpeg'
    : ext === 'm4a' ? 'audio/mp4'
    : ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : ext === 'jpg' ? 'image/jpeg'
    : 'video/mp4';
  if ('showSaveFilePicker' in window && window.isSecureContext) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: ext === 'mp3' ? 'MP3 audio'
            : ext === 'm4a' ? 'M4A audio'
            : ext === 'png' || ext === 'webp' || ext === 'gif' || ext === 'jpg' ? 'Image file'
            : 'MP4 video',
          accept: { [mime]: [`.${ext}`] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { mode: 'picker' };
    } catch (err) {
      if (err?.name === 'AbortError') return { mode: 'cancelled' };
      throw err;
    }
  }

  return { mode: 'browser' };
}

async function deliverDownload(taskId, fallbackTitle) {
  const response = await api(`/api/video/serve?taskId=${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: {},
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error ?? 'Could not fetch the completed file');
  }

  const sourceFilename = parseFilenameFromDisposition(
    response.headers.get('Content-Disposition'),
    fallbackTitle ?? 'video'
  );
  const sourceBlob = await response.blob();

  let finalBlob = sourceBlob;
  let finalFilename = sourceFilename;

  if (state.outputFormat === 'thumbnail' && state.selectedImageFormat !== 'original') {
    finalBlob = await convertImageBlob(sourceBlob, state.selectedImageFormat);
    finalFilename = replaceFileExtension(sourceFilename, state.selectedImageFormat);
  }

  const saveResult = await saveBlobToDisk(finalBlob, finalFilename);

  const blobUrl = URL.createObjectURL(finalBlob);
  clearDeliveredFile();
  state.deliveredFile = { blob: finalBlob, blobUrl, filename: finalFilename };

  if (saveResult.mode === 'browser') {
    triggerBrowserDownload(blobUrl, finalFilename);
  }

  return { filename: finalFilename, mode: saveResult.mode };
}

function renderFolderPicker(data) {
  hideDownloadResult();
  folderTitle.textContent = data.title ?? 'Folder contents';
  folderFileList.innerHTML = '';

  (data.files ?? []).forEach((file) => {
    const li = document.createElement('li');
    li.className = 'folder-file-item';
    li.innerHTML = `
      <span class="folder-file-name" title="${escapeHtml(file.title)}">${escapeHtml(file.title)}</span>
      <button class="folder-dl-btn" type="button" data-url="${escapeHtml(file.url)}">Download</button>
    `;
    folderFileList.appendChild(li);
  });

  folderFileList.querySelectorAll('.folder-dl-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      urlInput.value = btn.dataset.url;
      folderSection.classList.add('hidden');
      analyzeForm.requestSubmit();
    });
  });

  folderSection.classList.remove('hidden');
  results.classList.add('hidden');
}

// ── Login ─────────────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.busy) return;
  state.busy = true;
  hideError(loginError);
  setLoading(loginBtn, true);
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#username').value.trim(), password: $('#password').value }),
    });
    const d = await r.json();
    r.ok ? showApp() : showError(loginError, d.error ?? 'Login failed');
  } catch { showError(loginError, 'Network error — try again'); }
  finally  { state.busy = false; setLoading(loginBtn, false); }
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  resetAll();
  showLogin();
});

// ── Analyze ───────────────────────────────────────────────
analyzeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const url = urlInput.value.trim();
  if (!url) return;

  hideError(urlError);
  resetResults();
  state.busy = true;
  setLoading(analyzeBtn, true);
  analyzingNotice.classList.remove('hidden');
  showSkeleton();

  try {
    const r = await api('/api/video/analyze', { method: 'POST', body: JSON.stringify({ url }) });
    const d = await r.json();

    if (!r.ok) {
      removeSkeleton();
      results.classList.add('hidden');
      showError(urlError,
        d.code === 'AUTH_REQUIRED'
          ? 'Google sign-in required — stop the server and run: npm run setup:auth'
          : (d.error ?? 'Could not analyze this file')
      );
      return;
    }

    if (d.type === 'gdrive-folder') {
      removeSkeleton();
      renderFolderPicker(d);
      return;
    }

    state.jobId = d.jobId;
    folderSection.classList.add('hidden');
    renderResults(d);
  } catch (err) {
    removeSkeleton();
    results.classList.add('hidden');
    if (err.message !== 'Session expired') showError(urlError, 'Network error — try again');
  } finally {
    state.busy = false;
    setLoading(analyzeBtn, false);
    analyzingNotice.classList.add('hidden');
  }
});

// ── Skeleton ──────────────────────────────────────────────
function showSkeleton() {
  document.getElementById('skeleton-placeholder')?.remove();
  const clone = document.getElementById('skeleton-tmpl').content.cloneNode(true);
  results.prepend(clone);
  $('#meta-card').classList.add('hidden');
  $('.quality-card').classList.add('hidden');
  $('.download-bar').classList.add('hidden');
  results.classList.remove('hidden');
}
function removeSkeleton() {
  document.getElementById('skeleton-placeholder')?.remove();
  $('#meta-card').classList.remove('hidden');
  $('.quality-card').classList.remove('hidden');
  $('.download-bar').classList.remove('hidden');
}

// ── Render results ────────────────────────────────────────
function renderResults(data) {
  removeSkeleton();
  hideDownloadResult();

  const thumb = $('#meta-thumb');
  if (data.thumbnail) { thumb.src = data.thumbnail; thumb.alt = data.title; thumb.style.display = ''; }
  else                { thumb.style.display = 'none'; }

  $('#meta-platform').textContent = data.platform ?? 'Google Drive';
  $('#meta-title').textContent    = data.title ?? 'Unknown';
  $('#meta-uploader').textContent = data.uploader ? `By ${data.uploader}` : '';

  renderOutputOptions(data.outputFormats ?? ['mp4']);

  qualityGrid.innerHTML = '';
  (data.qualities ?? []).forEach((q) => {
    const btn = document.createElement('button');
    btn.className = 'quality-item';
    btn.type = 'button';
    btn.dataset.height = q.height;
    const heightLabel = q.height === 'best' ? '★ Best' : `${q.height}p`;
    const metaLabel = q.height === 'best'
      ? (q.label ?? 'Best available quality')
      : q.label.replace(/^\d+p\s*/, '').replace(/[()]/g, '').trim();
    btn.innerHTML = `
      <div class="qi-res">${heightLabel}</div>
      <div class="qi-meta">${metaLabel}</div>
      ${q.fps && q.fps > 30 ? `<span class="qi-badge">${q.fps}fps</span>` : ''}
    `;
    btn.addEventListener('click', () => selectQuality(q.height, btn));
    qualityGrid.appendChild(btn);
  });

  applyProgressPreset();
  updateDownloadCallToAction();
  setStopButtonVisible(false);
  progressPanel.classList.add('hidden');
  results.classList.remove('hidden');
}

function selectQuality(height, el) {
  document.querySelectorAll('.quality-item').forEach((i) => i.classList.remove('selected'));
  el.classList.add('selected');
  state.selectedHeight = height;
  updateDownloadCallToAction();
}

// ── Download + progress polling ───────────────────────────
downloadBtn.addEventListener('click', async () => {
  if (state.busy || !state.jobId) return;
  if (state.outputFormat === 'mp4' && !state.selectedHeight) return;
  state.busy = true;
  state.stopping = false;
  setLoading(downloadBtn, true);
  setStopButtonVisible(true);
  stopBtn.disabled = false;
  showProgress('Downloading…');
  downloadHint.textContent = 'Download in progress. You can stop it at any time.';

  try {
    const r = await api('/api/video/start-download', {
      method: 'POST',
      body: JSON.stringify({ jobId: state.jobId, height: getRequestedHeight(), format: getRequestedFormat() }),
    });
    const d = await r.json();

    if (!r.ok) {
      progressPanel.classList.add('hidden');
      showError(urlError,
        d.code === 'JOB_EXPIRED'
          ? 'Session expired — paste the URL and Fetch again'
          : (d.error ?? 'Could not start download')
      );
      state.busy = false;
      setLoading(downloadBtn, false);
      setStopButtonVisible(false);
      updateDownloadCallToAction();
      downloadHint.textContent = 'Pick another quality or try again.';
      return;
    }

    state.taskId = d.taskId;
    startPolling(d.taskId);
  } catch (err) {
    progressPanel.classList.add('hidden');
    state.busy = false;
    setLoading(downloadBtn, false);
    setStopButtonVisible(false);
    updateDownloadCallToAction();
    downloadHint.textContent = 'Download did not start. Check the error and try again.';
    if (err.message !== 'Session expired') showError(urlError, 'Network error — try again');
  }
});

stopBtn.addEventListener('click', async () => {
  if (!state.taskId || state.stopping) return;
  state.stopping = true;
  setLoading(stopBtn, true);
  stopBtn.disabled = true;

  try {
    const r = await api(`/api/video/task/${state.taskId}/cancel`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) {
      stopBtn.disabled = false;
      setLoading(stopBtn, false);
      state.stopping = false;
      showError(urlError, d.error ?? 'Could not stop the download');
      return;
    }

    clearPolling();
    onDownloadCancelled(d.message ?? 'Download stopped');
  } catch (err) {
    stopBtn.disabled = false;
    setLoading(stopBtn, false);
    state.stopping = false;
    if (err.message !== 'Session expired') showError(urlError, 'Could not stop the download');
  }
});

openPreviewBtn.addEventListener('click', () => {
  if (!state.deliveredFile?.blobUrl) return;
  window.open(state.deliveredFile.blobUrl, '_blank', 'noopener,noreferrer');
});

saveAgainBtn.addEventListener('click', async () => {
  if (!state.deliveredFile?.blob || !state.deliveredFile?.filename) return;
  const result = await saveBlobToDisk(state.deliveredFile.blob, state.deliveredFile.filename);
  if (result.mode === 'browser') {
    triggerBrowserDownload(state.deliveredFile.blobUrl, state.deliveredFile.filename);
    showDownloadResult({
      title: 'Saved again using browser download',
      meta: `${state.deliveredFile.filename} was sent to your browser download manager again.`,
    });
    return;
  }
  if (result.mode === 'picker') {
    showDownloadResult({
      title: 'Saved again',
      meta: `${state.deliveredFile.filename} was saved using the file picker.`,
    });
    return;
  }
  if (result.mode === 'cancelled') {
    showDownloadResult({
      title: 'Video still ready to save',
      meta: `${state.deliveredFile.filename} is still available. Use Save again whenever you want, or open the preview first.`,
    });
  }
});

dismissDownloadResultBtn.addEventListener('click', () => {
  hideDownloadResult();
});

platformsToggle?.addEventListener('click', async () => {
  const willOpen = supportedPlatforms.classList.contains('hidden');
  if (!willOpen) {
    setPlatformsPanelVisible(false);
    return;
  }

  setPlatformsPanelVisible(true);
  try {
    await ensureSupportedPlatformsLoaded();
  } catch (err) {
    platformsStatus.textContent = err.message || 'Could not load supported platforms.';
    platformsList.innerHTML = '';
  }
});

platformsClose?.addEventListener('click', () => {
  setPlatformsPanelVisible(false);
});

function startPolling(taskId) {
  clearPolling();
  state.pollTimer = setInterval(() => pollTask(taskId), 500);
  pollTask(taskId); // immediate first check
}

function clearPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function pollTask(taskId) {
  try {
    const r = await api(`/api/video/task/${taskId}`);
    const d = await r.json();

    if (!r.ok) {
      clearPolling();
      onDownloadError(d.error ?? 'Task not found');
      return;
    }

    // Update the step UI
    updateProgressSteps(d.step ?? '', d.progress ?? 0, d.phaseProgress ?? 0);

    if (d.status === 'done') {
      clearPolling();
      await onDownloadReady(taskId, d.title);
    } else if (d.status === 'cancelled') {
      clearPolling();
      onDownloadCancelled(d.error ?? 'Download stopped');
    } else if (d.status === 'error') {
      clearPolling();
      onDownloadError(d.error ?? 'Download failed');
    }
  } catch (err) {
    if (err.message !== 'Session expired') {
      clearPolling();
      onDownloadError('Lost connection to server');
    }
  }
}

async function onDownloadReady(taskId, title) {
  state.taskId = null;
  state.stopping = false;
  updateProgressSteps('Ready', 100, 100);
  setStepDone(); // mark all steps green

  let delivery;
  try {
    delivery = await deliverDownload(taskId, title);
  } catch (err) {
    onDownloadError(err.message || 'Could not save the completed file');
    return;
  }

  if (delivery.mode === 'picker') {
    progressDetail.textContent = '✓ File saved using the save dialog.';
    progressDetail.style.color = 'var(--success)';
    showDownloadResult({
      title: `${state.outputFormat === 'mp3' ? state.selectedAudioFormat.toUpperCase() + ' audio' : state.outputFormat === 'thumbnail' ? 'Thumbnail' : 'Video'} saved successfully`,
      meta: `${delivery.filename} was saved to the location you selected. Use Open preview to inspect it instantly.`,
    });
  } else if (delivery.mode === 'browser') {
    progressDetail.textContent = '✓ File sent to your browser download manager.';
    progressDetail.style.color = 'var(--success)';
    showDownloadResult({
      title: 'Download sent to browser',
      meta: `${delivery.filename} was handed off to the browser. If you did not see it, use Save again for a direct save dialog.`,
    });
  } else {
    progressDetail.textContent = 'Save dialog closed before the file was written.';
    progressDetail.style.color = 'var(--warning)';
    showDownloadResult({
      title: state.outputFormat === 'thumbnail' ? 'Thumbnail ready to save' : 'File ready to save',
      meta: `${delivery.filename} is ready. Use Save again to choose a location, or Open preview to inspect it first.`,
    });
  }

  // Re-enable button for another download
  state.busy = false;
  setLoading(downloadBtn, false);
  setLoading(stopBtn, false);
  stopBtn.disabled = false;
  setStopButtonVisible(false);
  downloadBtn.disabled = false;
  downloadBtnLabel.textContent = state.outputFormat === 'mp3'
    ? `Export ${state.selectedAudioFormat.toUpperCase()} audio again`
    : state.outputFormat === 'thumbnail'
      ? 'Save thumbnail image again'
    : `Download ${formatQualityLabel(state.selectedHeight)} MP4 again`;
  downloadHint.textContent = 'Download finished. Use the popup below to preview or save again.';
}

function onDownloadError(msg) {
  state.taskId = null;
  state.stopping = false;
  progressPanel.classList.add('hidden');
  hideDownloadResult();
  showError(urlError, msg);
  state.busy = false;
  setLoading(downloadBtn, false);
  setLoading(stopBtn, false);
  stopBtn.disabled = false;
  setStopButtonVisible(false);
  updateDownloadCallToAction();
  downloadHint.textContent = 'Download failed. Review the message and try again.';
}

function onDownloadCancelled(msg) {
  state.taskId = null;
  state.stopping = false;
  state.busy = false;
  setLoading(downloadBtn, false);
  setLoading(stopBtn, false);
  stopBtn.disabled = false;
  setStopButtonVisible(false);
  updateDownloadCallToAction();
  setStepsIdle();
  progBar.classList.remove('is-indeterminate');
  progBar.style.width = '0%';
  progressPanel.classList.remove('hidden');
  progressDetail.textContent = msg;
  progressDetail.style.color = 'var(--warning)';
  downloadHint.textContent = 'Download stopped. You can start again whenever you want.';
}

// ── Progress panel helpers ────────────────────────────────
function showProgress(stepText) {
  progressPanel.classList.remove('hidden');
  progressDetail.textContent = '';
  progressDetail.style.color = '';
  progBar.classList.remove('is-indeterminate');
  progBar.style.width = '0%';
  resetEta();
  document.querySelectorAll('.pstep').forEach((el) => {
    el.classList.remove('active', 'done');
    el.querySelector('.pstep-icon').innerHTML = '';
  });
  updateProgressSteps(stepText, 0, 0);
}

// progress      = overall 0–100 (unused for bar now, kept for server compat)
// phaseProgress = 0–100 for the CURRENT step only — bar resets each step
function updateProgressSteps(stepText, progress = 0, phaseProgress = 0) {
  const isMerging = /merging|converting|encoding/i.test(stepText);
  const isReady   = /ready/i.test(stepText);

  // Find which step is current
  let activeIdx = -1;
  if (/downloading audio source|downloading source|downloading video/i.test(stepText)) activeIdx = 0;
  else if (/downloading audio|extracting audio|preparing audio/i.test(stepText)) activeIdx = 1;
  else if (/merging|converting|encoding/i.test(stepText)) activeIdx = 2;
  if (activeIdx === -1 && /downloading/i.test(stepText)) activeIdx = 0;
  if (isReady) activeIdx = STEP_COUNT;

  document.querySelectorAll('.pstep').forEach((el, i) => {
    el.classList.remove('active', 'done');
    const icon  = el.querySelector('.pstep-icon');
    const label = el.querySelector('.pstep-label');
    const baseName = label?.dataset.base ?? label?.textContent ?? '';
    if (!label?.dataset.base) { if (label) label.dataset.base = label.textContent; }

    if (i < activeIdx) {
      el.classList.add('done');
      icon.innerHTML = svgCheck();
      if (label) label.textContent = baseName;
    } else if (i === activeIdx) {
      el.classList.add('active');
      icon.innerHTML = svgSpin();
      if (label) {
        label.textContent = phaseProgress > 0 && phaseProgress < 100
          ? `${baseName} — ${phaseProgress}%`
          : baseName;
      }
    } else {
      icon.innerHTML = svgDot();
      if (label) label.textContent = baseName;
    }
  });

  // ── Progress bar: 0→100% PER STEP, resets on each new step ──
  if (isReady) {
    progBar.classList.remove('is-indeterminate');
    progBar.style.width = '100%';
  } else if (isMerging) {
    // ffmpeg has no byte-level progress → show animated sweep
    progBar.classList.add('is-indeterminate');
    progBar.style.width = '';
  } else {
    progBar.classList.remove('is-indeterminate');
    progBar.style.width = `${Math.max(0, Math.min(100, phaseProgress))}%`;
  }

  // ── Detail line: percentage + ETA ────────────────────────
  if (!isReady && stepText) {
    if (phaseProgress > 0 && phaseProgress < 100) {
      const etaStr = calcEta(activeIdx, phaseProgress);
      progressDetail.textContent = etaStr
        ? `${phaseProgress}% complete · ${etaStr}`
        : `${phaseProgress}% complete`;
    } else {
      progressDetail.textContent = stepText;
    }
  } else {
    progressDetail.textContent = '';
  }
}

function setStepDone() {
  document.querySelectorAll('.pstep').forEach((el) => {
    el.classList.remove('active');
    el.classList.add('done');
    el.querySelector('.pstep-icon').innerHTML = svgCheck();
    const label = el.querySelector('.pstep-label');
    if (label?.dataset.base) label.textContent = label.dataset.base;
  });
  progBar.classList.remove('is-indeterminate');
  progBar.style.width = '100%';
}

// ── Reset ─────────────────────────────────────────────────
function resetResults({ keepSelectedTool = true } = {}) {
  clearPolling();
  resetEta();
  clearDeliveredFile();
  const selectedTool = keepSelectedTool ? state.outputFormat : 'mp4';
  state.jobId = null;
  state.taskId = null;
  state.selectedHeight = null;
  state.selectedAudioFormat = 'mp3';
  if (audioFormatSelect) audioFormatSelect.value = 'mp3';
  state.selectedImageFormat = 'original';
  if (imageFormatSelect) imageFormatSelect.value = 'original';
  state.outputFormat = selectedTool;
  state.availableFormats = [...ALL_TOOL_FORMATS];
  state.stopping = false;
  renderOutputOptions(ALL_TOOL_FORMATS);
  applyProgressPreset();
  results.classList.add('hidden');
  folderSection.classList.add('hidden');
  folderFileList.innerHTML = '';
  progressPanel.classList.add('hidden');
  hideDownloadResult();
  setLoading(stopBtn, false);
  stopBtn.disabled = false;
  setStopButtonVisible(false);
  progBar.style.width = '0%';
  document.getElementById('skeleton-placeholder')?.remove();
}
function resetAll() {
  resetResults({ keepSelectedTool: false });
  urlInput.value = '';
  hideError(urlError);
  analyzingNotice.classList.add('hidden');
}

// ── SVGs ──────────────────────────────────────────────────
function svgCheck() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
}
function svgSpin() {
  return `<span class="inline-spin"></span>`;
}
function svgDot() {
  return `<span class="step-dot"></span>`;
}

// ── Boot ──────────────────────────────────────────────────
renderOutputOptions(ALL_TOOL_FORMATS);
updateAnalyzeContext();
applyProgressPreset();
checkAuth();

audioFormatSelect?.addEventListener('change', () => {
  state.selectedAudioFormat = audioFormatSelect.value;
  updateDownloadCallToAction();
});

imageFormatSelect?.addEventListener('change', () => {
  state.selectedImageFormat = imageFormatSelect.value;
  updateDownloadCallToAction();
});
