import { chromium } from 'playwright';
import { spawn, execFile as _execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(_execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '..', '..', '.browser-data', 'profile');

// ── Google DASH itag → pixel height ──────────────────────
const ITAG_HEIGHT = {
  137: 1080, 299: 1080, 248: 1080,
  136: 720,  298: 720,  247: 720,
  135: 480,  244: 480,
  134: 360,  243: 360,
  133: 240,  242: 240,
  160: 144,  278: 144,
  22: 720,   18: 360,
};
const AUDIO_PRIORITY = { 140: 1, 141: 2, 139: 3, 171: 4, 251: 5, 250: 6, 249: 7 };

// ── Job store (stream URLs from analyze step) ─────────────
const jobs = new Map();
const JOB_TTL = 12 * 60 * 1000;

function saveJob(data) {
  const id = randomUUID();
  jobs.set(id, { ...data, expiresAt: Date.now() + JOB_TTL });
  for (const [k, v] of jobs) if (v.expiresAt < Date.now()) jobs.delete(k);
  return id;
}

export function getJob(jobId) {
  const j = jobs.get(jobId);
  if (!j || j.expiresAt < Date.now()) { jobs.delete(jobId); return null; }
  return j;
}

// ── Task store (download progress tracking) ───────────────
const tasks = new Map();
const taskRuntimes = new Map();
const TASK_TTL = 60 * 60 * 1000; // 1 hour

export function createTask() {
  const id = randomUUID();
  tasks.set(id, {
    status: 'pending',   // pending | running | done | error | cancelled
    step: 'Starting…',
    progress: 0,
    title: null,
    filePath: null,
    fileExtension: 'mp4',
    mimeType: 'video/mp4',
    error: null,
    expiresAt: Date.now() + TASK_TTL,
  });
  return id;
}

export function getTask(taskId) {
  const t = tasks.get(taskId);
  if (!t || t.expiresAt < Date.now()) {
    tasks.delete(taskId);
    taskRuntimes.delete(taskId);
    return null;
  }
  return t;
}

function setTask(taskId, patch) {
  const t = tasks.get(taskId);
  if (t) tasks.set(taskId, { ...t, ...patch });
}

export function deleteTask(taskId) {
  tasks.delete(taskId);
  taskRuntimes.delete(taskId);
}

function ensureTaskRuntime(taskId) {
  let runtime = taskRuntimes.get(taskId);
  if (!runtime) {
    runtime = {
      processes: new Set(),
      cleanupPaths: new Set(),
      controllers: new Set(),
      page: null,
      cancelled: false,
    };
    taskRuntimes.set(taskId, runtime);
  }
  return runtime;
}

function isTaskCancelled(taskId) {
  return Boolean(taskRuntimes.get(taskId)?.cancelled);
}

function registerTaskCleanupPath(taskId, filePath) {
  if (!filePath) return;
  ensureTaskRuntime(taskId).cleanupPaths.add(filePath);
}

function unregisterTaskCleanupPath(taskId, filePath) {
  taskRuntimes.get(taskId)?.cleanupPaths.delete(filePath);
}

function registerTaskProcess(taskId, proc) {
  if (!proc) return;
  const runtime = ensureTaskRuntime(taskId);
  runtime.processes.add(proc);
  const onExit = () => {
    runtime.processes.delete(proc);
    proc.off('close', onExit);
    proc.off('exit', onExit);
  };
  proc.on('close', onExit);
  proc.on('exit', onExit);
}

function registerTaskPage(taskId, page) {
  const runtime = ensureTaskRuntime(taskId);
  runtime.page = page;
}

function registerTaskController(taskId, controller) {
  if (!controller) return;
  ensureTaskRuntime(taskId).controllers.add(controller);
}

function unregisterTaskController(taskId, controller) {
  taskRuntimes.get(taskId)?.controllers.delete(controller);
}

function clearTaskRuntime(taskId) {
  taskRuntimes.delete(taskId);
}

function createCancellationError() {
  const error = new Error('Download stopped by user');
  error.code = 'TASK_CANCELLED';
  return error;
}

function completeTask(taskId, filePath, { fileExtension = 'mp4', mimeType = 'video/mp4' } = {}) {
  setTask(taskId, {
    status: 'done',
    step: 'Ready',
    filePath,
    fileExtension,
    mimeType,
    progress: 100,
  });
}

function getImageExtension(contentType = '', imageUrl = '') {
  const normalized = contentType.toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';

  const pathname = (() => {
    try { return new URL(imageUrl).pathname.toLowerCase(); } catch { return ''; }
  })();
  if (pathname.endsWith('.png')) return 'png';
  if (pathname.endsWith('.webp')) return 'webp';
  if (pathname.endsWith('.gif')) return 'gif';
  return 'jpg';
}

function getImageMimeType(extension) {
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  return 'image/jpeg';
}

export async function cancelTask(taskId) {
  const task = tasks.get(taskId);
  const runtime = taskRuntimes.get(taskId);

  if (!task) return { ok: false, code: 'TASK_NOT_FOUND', message: 'Task not found or expired' };
  if (task.status === 'done') return { ok: false, code: 'TASK_COMPLETED', message: 'Download already completed' };
  if (task.status === 'cancelled') return { ok: true, code: 'TASK_ALREADY_CANCELLED', message: 'Download already stopped' };

  if (runtime) {
    runtime.cancelled = true;
    const page = runtime.page;
    runtime.page = null;
    if (page) {
      try { await page.close(); } catch {}
    }
    for (const proc of runtime.processes) {
      try { proc.kill('SIGTERM'); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const proc of runtime.processes) {
      try { proc.kill('SIGKILL'); } catch {}
    }
    for (const controller of runtime.controllers) {
      try { controller.abort(); } catch {}
    }
    for (const filePath of runtime.cleanupPaths) {
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }
  }

  setTask(taskId, {
    status: 'cancelled',
    step: 'Stopped',
    error: 'Download stopped by user',
    phaseProgress: 0,
  });

  return { ok: true, code: 'TASK_CANCELLED', message: 'Download stopped' };
}

// ── Helpers ───────────────────────────────────────────────
function parseItag(url) {
  const m = url.match(/[?&]itag=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function isAudioUrl(url) {
  return url.includes('mime=audio') || url.includes('mime%3Daudio');
}

function stripRange(url) {
  return url.split('&range=')[0];
}

function getClen(url) {
  const m = url.match(/[?&]clen=(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// ── Platform detection ───────────────────────────────────
const PLATFORM_NAMES = {
  'youtube.com': 'YouTube',    'youtu.be': 'YouTube',
  'instagram.com': 'Instagram',
  'facebook.com': 'Facebook',  'fb.watch': 'Facebook',  'fb.com': 'Facebook',
  'twitter.com': 'Twitter / X','x.com': 'Twitter / X',
  'tiktok.com': 'TikTok',
  'vimeo.com': 'Vimeo',
  'twitch.tv': 'Twitch',
  'reddit.com': 'Reddit',
  'dailymotion.com': 'Dailymotion',
  'pinterest.com': 'Pinterest',
  'linkedin.com': 'LinkedIn',
  'bilibili.com': 'Bilibili',
  'nicovideo.jp': 'Niconico',
  'rumble.com': 'Rumble',
  'odysee.com': 'Odysee',
  'peertube.social': 'PeerTube',
};

export function getSupportedPlatforms() {
  const grouped = new Map();

  for (const [domain, name] of Object.entries(PLATFORM_NAMES)) {
    if (!grouped.has(name)) grouped.set(name, new Set());
    grouped.get(name).add(domain);
  }

  grouped.set('Google Drive', new Set(['drive.google.com/file/d/...', 'drive.google.com/drive/folders/...']));

  return Array.from(grouped.entries())
    .map(([name, domains]) => ({
      name,
      domains: Array.from(domains).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Returns: 'gdrive-file' | 'gdrive-folder' | 'universal'
export function detectPlatform(rawUrl) {
  let p;
  try { p = new URL(rawUrl); } catch { throw new Error('Invalid URL — please check the link and try again'); }
  const h = p.hostname.replace(/^www\./, '').toLowerCase();
  if (h === 'drive.google.com' || h === 'docs.google.com') {
    if (p.pathname.includes('/file/d/') || p.searchParams.get('id')) return 'gdrive-file';
    if (p.pathname.includes('/drive/folders/') || p.pathname.includes('/folders/')) return 'gdrive-folder';
    throw new Error('Unsupported Google Drive link. Paste a file link (/file/d/…) or a folder link (/drive/folders/…).');
  }
  return 'universal';
}

function getPlatformName(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    for (const [domain, name] of Object.entries(PLATFORM_NAMES)) {
      if (h === domain || h.endsWith('.' + domain)) return name;
    }
  } catch {}
  return 'Video';
}

// ── Shared browser context ────────────────────────────────
// One Chrome window is reused across analyze → download.
// It auto-closes after JOB_TTL if no download is started.
let sharedCtx    = null;
let ctxAutoClose = null;

async function launchBrowser() {
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: 'chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--autoplay-policy=no-user-gesture-required',
      ],
      viewport: { width: 1280, height: 720 },
    });
  } catch (err) {
    if (err.message?.toLowerCase().includes('chrome')) {
      throw new Error('Google Chrome not found. Install Chrome and run: npm run setup:auth');
    }
    throw err;
  }
}

async function getContext() {
  if (sharedCtx) {
    try { await sharedCtx.pages(); return sharedCtx; } catch { sharedCtx = null; }
  }
  sharedCtx = await launchBrowser();
  return sharedCtx;
}

function scheduleContextClose(ms) {
  if (ctxAutoClose) clearTimeout(ctxAutoClose);
  ctxAutoClose = setTimeout(closeSharedContext, ms);
}

async function closeSharedContext() {
  if (ctxAutoClose) { clearTimeout(ctxAutoClose); ctxAutoClose = null; }
  if (sharedCtx) {
    try { await sharedCtx.close(); } catch {}
    sharedCtx = null;
  }
}

// ── Step 1: Analyze ───────────────────────────────────────
export async function analyzeGDriveVideo(rawUrl) {
  // Reuse the shared browser window — no second Chrome launch needed for download
  const context = await getContext();
  const page    = await context.newPage();
  try {
    const videoStreams = new Map();
    const audioStreams = new Map();

    page.on('request', (req) => {
      const u = req.url();
      if (!u.includes('videoplayback') && !u.includes('googlevideo.com')) return;
      const itag = parseItag(u);
      if (!itag) return;
      const clean = stripRange(u);
      if (isAudioUrl(u)) { if (!audioStreams.has(itag)) audioStreams.set(itag, clean); }
      else               { if (!videoStreams.has(itag)) videoStreams.set(itag, clean); }
    });

    await page.goto(rawUrl, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForTimeout(2500);

    const pageUrl = page.url();
    if (pageUrl.includes('accounts.google.com') || pageUrl.includes('/signin') || pageUrl.includes('/ServiceLogin')) {
      throw new Error('AUTH_REQUIRED');
    }

    const html = await page.content();
    if (html.includes('Access denied') || html.includes('You need permission')) {
      throw new Error('Access denied — you do not have permission to view this file.');
    }

    // Phase 1: force preload
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) { v.preload = 'auto'; v.load(); }
    }).catch(() => {});
    await page.waitForTimeout(5000);

    // Phase 2: trigger play if still nothing
    if (videoStreams.size === 0) {
      await page.evaluate(async () => {
        const v = document.querySelector('video');
        if (!v) return;
        v.muted = true; v.volume = 0;
        try { await v.play(); } catch { v.click(); }
      }).catch(() => {});

      for (let w = 0; videoStreams.size === 0 && w < 30_000; w += 2000) {
        await page.waitForTimeout(2000);
        if (w === 10_000 || w === 20_000) {
          await page.evaluate(async () => {
            const v = document.querySelector('video');
            if (v) { v.currentTime = 0; try { await v.play(); } catch {} }
          }).catch(() => {});
        }
      }
    }

    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) { v.pause(); v.src = ''; v.load(); }
    }).catch(() => {});

    if (videoStreams.size === 0) {
      throw new Error(
        'No video streams detected. Make sure the file is a video and you have access. ' +
        'If first time, run: npm run setup:auth'
      );
    }

    const title = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:title"]');
      return (og?.getAttribute('content') ?? document.title).replace(' - Google Drive', '').trim();
    }).catch(() => 'video');

    const thumbnail = await page.evaluate(() => {
      return document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null;
    }).catch(() => null);

    // Best audio
    let bestAudioUrl = null, bestPriority = Infinity;
    for (const [itag, url] of audioStreams) {
      const p = AUDIO_PRIORITY[itag] ?? 99;
      if (p < bestPriority) { bestPriority = p; bestAudioUrl = url; }
    }

    // Build quality list
    const streamsByHeight = {};
    const seen = new Set();
    const qualities = [];

    for (const [itag, videoUrl] of videoStreams) {
      const height = ITAG_HEIGHT[itag] ?? itag;
      if (seen.has(height)) continue;
      seen.add(height);
      const knownH = ITAG_HEIGHT[itag];
      const label = knownH
        ? knownH >= 2160 ? `${knownH}p (4K)`
          : knownH >= 1080 ? `${knownH}p (Full HD)`
          : knownH >= 720  ? `${knownH}p (HD)`
          : knownH >= 480  ? `${knownH}p (SD)`
          : `${knownH}p`
        : `Stream ${itag}`;
      qualities.push({ height, label, fps: null });
      streamsByHeight[height] = { videoUrl, audioUrl: bestAudioUrl };
    }

    qualities.sort((a, b) => b.height - a.height);

    // Strip .mp4 extension from title (prevents double extension on download)
    const safeTitle = title
      .replace(/\.mp4$/i, '')
      .replace(/[/\\?%*:|"<>]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 120);

    const outputFormats = ['mp4', 'mp3', ...(thumbnail ? ['thumbnail'] : [])];
    const jobId = saveJob({ title: safeTitle, thumbnail, streamsByHeight, availableFormats: outputFormats });

    // Keep browser alive for the upcoming download; auto-close if user never downloads
    scheduleContextClose(JOB_TTL);

    return {
      title: safeTitle,
      thumbnail,
      platform: 'Google Drive',
      duration: null,
      uploader: null,
      qualities,
      outputFormats,
      jobId,
    };
  } catch (err) {
    // On error close the browser fully so next attempt starts fresh
    await closeSharedContext();
    throw err;
  } finally {
    // Always close just this tab — the browser window stays open
    await page.close().catch(() => {});
  }
}

// ── Step 2a: Download a single stream through the browser ─
// This is the ONLY reliable way — uses the browser's Google session cookies.
// Identical mechanism to the CLI's downloadStream function.
// phaseStart / phaseEnd: overall progress range (0-100) this phase occupies.
async function downloadViaPage(page, rawUrl, outputPath, { taskId, phaseStart = 0, phaseEnd = 100 } = {}) {
  const url = rawUrl.split('&range=')[0];
  const totalBytes = getClen(rawUrl);
  let bytesWritten = 0;

  if (taskId && isTaskCancelled(taskId)) throw createCancellationError();

  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  // Navigate to a Google domain so credentials are sent with the stream fetch
  await page.goto('https://drive.google.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(400);

  const fnName = `__dl_${Date.now()}`;
  await page.exposeFunction(fnName, (b64) => {
    if (taskId && isTaskCancelled(taskId)) throw createCancellationError();
    const chunk = Buffer.from(b64, 'base64');
    fs.appendFileSync(outputPath, chunk);
    if (taskId && totalBytes > 0) {
      bytesWritten += chunk.length;
      const phasePct = Math.min(bytesWritten / totalBytes, 1);
      const phaseProgress = Math.round(phasePct * 100);
      const overall = Math.round(phaseStart + phasePct * (phaseEnd - phaseStart));
      setTask(taskId, { progress: overall, phaseProgress });
    }
  });

  const result = await page.evaluate(async ({ url, fn }) => {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return { error: `HTTP ${resp.status}: ${resp.statusText}` };

      const reader = resp.body.getReader();
      const CHUNK = 2 * 1024 * 1024; // 2 MB chunks
      let buf = [], size = 0, total = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (value) { buf.push(value); size += value.length; }

        if (size >= CHUNK || done) {
          if (size > 0) {
            const merged = new Uint8Array(size);
            let pos = 0;
            for (const c of buf) { merged.set(c, pos); pos += c.length; }

            // Encode to base64 in 16 KB slices to avoid call-stack overflow
            let bin = '';
            for (let i = 0; i < merged.length; i += 16384) {
              bin += String.fromCharCode.apply(null, merged.subarray(i, Math.min(i + 16384, merged.length)));
            }
            await window[fn](btoa(bin));
            total += size; buf = []; size = 0;
          }
        }
        if (done) return { ok: true, total };
      }
    } catch (e) { return { error: e.message }; }
  }, { url, fn: fnName });

  if (result?.error) throw new Error(`Stream download failed: ${result.error}`);
}

// ── Step 2b: Background task — download + merge ───────────
export async function downloadAndMerge({ taskId, videoUrl, audioUrl, title, format = 'mp4' }) {
  const isAudioFormat = format === 'mp3' || format === 'm4a';
  const outputExt = isAudioFormat ? format : 'mp4';
  const outputMime = format === 'mp3'
    ? 'audio/mpeg'
    : format === 'm4a'
      ? 'audio/mp4'
      : 'video/mp4';
  const tmp     = os.tmpdir();
  const vPath   = path.join(tmp, `loadr_${taskId}_v.mp4`);
  const aPath   = audioUrl ? path.join(tmp, `loadr_${taskId}_a.m4a`) : null;
  const outPath = path.join(tmp, `loadr_${taskId}.${outputExt}`);
  [vPath, aPath, outPath].filter(Boolean).forEach((filePath) => registerTaskCleanupPath(taskId, filePath));

  // Browser is already open from the analyze step — skip the launch wait
  setTask(taskId, {
    title,
    status: 'running',
    step: isAudioFormat ? 'Downloading audio source…' : 'Downloading video stream…',
    progress: 0,
    phaseProgress: 0,
    fileExtension: outputExt,
    mimeType: outputMime,
  });

  // Progress allocation: video 0→55, audio 55→90, ffmpeg 90→100
  const HAS_AUDIO = Boolean(audioUrl && aPath);
  const VIDEO_END = HAS_AUDIO ? 55 : 90;
  const AUDIO_END = 90;

  try {
    // ── Browser download (reuses the context from analyze — no new window) ──
    const context = await getContext();
    const page    = await context.newPage();
    registerTaskPage(taskId, page);
    try {
      if (isAudioFormat) {
        const sourceUrl = audioUrl ?? videoUrl;
        const sourcePath = audioUrl && aPath ? aPath : vPath;
        await downloadViaPage(page, sourceUrl, sourcePath, { taskId, phaseStart: 0, phaseEnd: AUDIO_END });
      } else {
        await downloadViaPage(page, videoUrl, vPath, { taskId, phaseStart: 0, phaseEnd: VIDEO_END });

        if (audioUrl && aPath) {
          if (isTaskCancelled(taskId)) throw createCancellationError();
          setTask(taskId, { step: 'Downloading audio stream…', progress: VIDEO_END, phaseProgress: 0 });
          await downloadViaPage(page, audioUrl, aPath, { taskId, phaseStart: VIDEO_END, phaseEnd: AUDIO_END });
        }
      }
    } finally {
      registerTaskPage(taskId, null);
      await page.close().catch(() => {});
      await closeSharedContext(); // done with browser — close it now
    }

    // ── Merge ─────────────────────────────────────────────────
    if (isTaskCancelled(taskId)) throw createCancellationError();
    setTask(taskId, {
      step: format === 'mp3' ? 'Converting to MP3…' : format === 'm4a' ? 'Converting to M4A…' : 'Merging streams…',
      progress: AUDIO_END,
      phaseProgress: 0,
    });

    await new Promise((resolve, reject) => {
      const ffmpegArgs = isAudioFormat
        ? [
            '-hide_banner', '-loglevel', 'error',
            '-i', audioUrl && aPath ? aPath : vPath,
            '-vn',
            ...(format === 'mp3'
              ? ['-c:a', 'libmp3lame', '-b:a', '192k']
              : ['-c:a', 'aac', '-b:a', '192k']),
            outPath, '-y',
          ]
        : (() => {
            const inputs = aPath ? ['-i', vPath, '-i', aPath] : ['-i', vPath];
            const maps   = aPath ? ['-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0'];
            return [
              '-hide_banner', '-loglevel', 'error',
              ...inputs, ...maps,
              '-c', 'copy',
              outPath, '-y',
            ];
          })();

      const proc = spawn('ffmpeg', ffmpegArgs);
      registerTaskProcess(taskId, proc);

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('error', (err) =>
        reject(err.code === 'ENOENT' ? new Error('ffmpeg not found — run: brew install ffmpeg') : err)
      );
      proc.on('close', (code) => {
        if (isTaskCancelled(taskId)) reject(createCancellationError());
        else if (code !== 0) reject(new Error(stderr.split('\n').filter(Boolean).pop() ?? 'ffmpeg merge failed'));
        else resolve();
      });
    });

    // Delete the raw source streams; keep only the merged file
    [vPath, aPath].filter(Boolean).forEach((p) => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
      unregisterTaskCleanupPath(taskId, p);
    });

    completeTask(taskId, outPath, {
      fileExtension: outputExt,
      mimeType: outputMime,
    });
    unregisterTaskCleanupPath(taskId, outPath);
    clearTaskRuntime(taskId);

  } catch (err) {
    if (isTaskCancelled(taskId) && err.code !== 'TASK_CANCELLED') {
      err = createCancellationError();
    }
    // Clean up any partial files
    [vPath, aPath, outPath].filter(Boolean).forEach((p) => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    });
    if (err.code === 'TASK_CANCELLED') {
      setTask(taskId, { status: 'cancelled', step: 'Stopped', error: 'Download stopped by user', progress: 0, phaseProgress: 0 });
    } else {
      setTask(taskId, { status: 'error', step: 'Failed', error: err.message });
    }
    clearTaskRuntime(taskId);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── yt-dlp: Universal downloader (YouTube, Instagram, Facebook, TikTok, …) ───
// ─────────────────────────────────────────────────────────────────────────────

function ytdlpBin() {
  // prefer locally-installed binary (node_modules/.bin), fall back to PATH
  const local = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'yt-dlp');
  return fs.existsSync(local) ? local : 'yt-dlp';
}

// Run yt-dlp and return parsed JSON output
async function ytdlp(args) {
  const bin = ytdlpBin();
  try {
    const { stdout } = await execFileAsync(bin, args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString();
    if (msg.includes('not found') || err.code === 'ENOENT') {
      throw new Error('yt-dlp is not installed. Run: npm run setup:ytdlp or pip install yt-dlp');
    }
    // Surface yt-dlp's own error message
    const lines = msg.split('\n').map(l => l.trim()).filter(Boolean);
    const last = lines.reverse().find(l => l.startsWith('ERROR:') || l.includes('Error')) ?? lines[0];
    throw new Error(last ?? 'yt-dlp failed');
  }
}

// Analyze any URL using yt-dlp --dump-json
export async function analyzeUniversal(rawUrl) {
  const platform = getPlatformName(rawUrl);

  let raw;
  try {
    raw = await ytdlp(['--dump-single-json', '--no-playlist', rawUrl]);
  } catch (err) {
    throw err;
  }

  let info;
  try { info = JSON.parse(raw); }
  catch { throw new Error('Failed to parse video metadata'); }

  // Build quality list from formats
  const seen = new Set();
  const qualityMap = {};

  (info.formats ?? []).forEach((f) => {
    if (!f.height || !f.vcodec || f.vcodec === 'none') return;
    const h = f.height;
    if (!qualityMap[h]) qualityMap[h] = { height: h, fps: f.fps ?? null, formats: [] };
    qualityMap[h].formats.push(f);
  });

  // Also include combined (progressive) formats that have both video + audio
  (info.formats ?? []).forEach((f) => {
    if (!f.height || f.vcodec === 'none' || f.acodec === 'none') return;
    const h = f.height;
    if (!qualityMap[h]) qualityMap[h] = { height: h, fps: f.fps ?? null, formats: [] };
    if (!qualityMap[h].formats.find(x => x.format_id === f.format_id)) {
      qualityMap[h].formats.push(f);
    }
  });

  if (Object.keys(qualityMap).length === 0) {
    // fallback — just expose a single "best" option
    qualityMap['best'] = { height: 'best', fps: null, formats: [] };
  }

  const qualities = Object.values(qualityMap).map((q) => {
    const h = q.height;
    const label = h === 'best' ? 'Best available'
      : h >= 2160 ? `${h}p (4K)`
      : h >= 1080 ? `${h}p (Full HD)`
      : h >= 720  ? `${h}p (HD)`
      : h >= 480  ? `${h}p (SD)`
      : `${h}p`;
    return { height: h, label, fps: q.fps };
  });

  // Sort descending, 'best' at top
  qualities.sort((a, b) => {
    if (a.height === 'best') return -1;
    if (b.height === 'best') return 1;
    return b.height - a.height;
  });

  const safeTitle = (info.title ?? 'video')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);

  const outputFormats = ['mp4', 'mp3', ...(info.thumbnail ? ['thumbnail'] : [])];

  const jobId = saveJob({
    type: 'universal',
    title: safeTitle,
    originalUrl: rawUrl,
    thumbnail: info.thumbnail ?? null,
    duration: info.duration ?? null,
    uploader: info.uploader ?? info.channel ?? null,
    availableFormats: outputFormats,
    streamsByHeight: qualities.reduce((acc, q) => { acc[q.height] = { height: q.height }; return acc; }, {}),
  });

  return {
    title: safeTitle,
    thumbnail: info.thumbnail ?? null,
    platform,
    duration: info.duration ?? null,
    uploader: info.uploader ?? info.channel ?? null,
    qualities,
    outputFormats,
    jobId,
  };
}

// yt-dlp download task
export async function downloadUniversal({ taskId, originalUrl, height, title, format = 'mp4' }) {
  const isAudioFormat = format === 'mp3' || format === 'm4a';
  const outputExt = isAudioFormat ? format : 'mp4';
  const outputMime = format === 'mp3'
    ? 'audio/mpeg'
    : format === 'm4a'
      ? 'audio/mp4'
      : 'video/mp4';
  const tmp     = os.tmpdir();
  const outBase = path.join(tmp, `loadr_${taskId}`);
  const outPath = `${outBase}.${outputExt}`;
  registerTaskCleanupPath(taskId, outPath);

  setTask(taskId, {
    title,
    status: 'running',
    step: isAudioFormat ? 'Downloading audio source…' : 'Downloading…',
    progress: 0,
    phaseProgress: 0,
    fileExtension: outputExt,
    mimeType: outputMime,
  });

  const bin = ytdlpBin();

  const formatArg = height === 'best'
    ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'
    : `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;

  await new Promise((resolve, reject) => {
    const procArgs = isAudioFormat
      ? [
          '--no-playlist',
          '-f', 'bestaudio/best',
          '-x',
          '--audio-format', format,
          '--audio-quality', '0',
          '--no-part',
          '--newline',
          '-o', `${outBase}.%(ext)s`,
          originalUrl,
        ]
      : [
          '--no-playlist',
          '-f', formatArg,
          '--merge-output-format', 'mp4',
          '--no-part',
          '--newline',
          '-o', outPath,
          originalUrl,
        ];

    const proc = spawn(bin, procArgs);
    registerTaskProcess(taskId, proc);

    let lastLine = '';
    const progressRe = /\[download\]\s+([\d.]+)%/;

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        lastLine = line.trim();
        const m = progressRe.exec(line);
        if (m) {
          const pct = Math.round(parseFloat(m[1]));
          const step = format === 'mp3'
            ? 'Downloading audio source…'
            : format === 'm4a'
              ? 'Downloading audio source…'
            : (line.includes('audio') ? 'Downloading audio…' : 'Downloading video…');
          setTask(taskId, { step, progress: pct, phaseProgress: pct });
        } else if (line.includes('[Merger]') || line.includes('Merging')) {
          setTask(taskId, { step: 'Merging streams…', progress: 90, phaseProgress: 0 });
        } else if (format === 'mp3' && (line.includes('[ExtractAudio]') || /Destination: .*\.mp3/i.test(line))) {
          setTask(taskId, { step: 'Converting to MP3…', progress: 90, phaseProgress: 0 });
        } else if (format === 'm4a' && (line.includes('[ExtractAudio]') || /Destination: .*\.m4a/i.test(line))) {
          setTask(taskId, { step: 'Converting to M4A…', progress: 90, phaseProgress: 0 });
        }
      }
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('error', (err) =>
      reject(err.code === 'ENOENT' ? new Error('yt-dlp not found — run: pip install yt-dlp') : err)
    );

    proc.on('close', (code) => {
      if (isTaskCancelled(taskId)) {
        reject(createCancellationError());
      } else if (code !== 0) {
        const errMsg = stderr.split('\n').filter(Boolean).reverse().find(l => l.includes('ERROR:')) ?? lastLine ?? 'yt-dlp failed';
        reject(new Error(errMsg));
      } else {
        resolve();
      }
    });
  }).catch((err) => {
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    if (err.code === 'TASK_CANCELLED') {
      setTask(taskId, { status: 'cancelled', step: 'Stopped', error: 'Download stopped by user', progress: 0, phaseProgress: 0 });
    } else {
      setTask(taskId, { status: 'error', step: 'Failed', error: err.message });
    }
    clearTaskRuntime(taskId);
    throw err;
  });

  if (!fs.existsSync(outPath)) {
    setTask(taskId, { status: 'error', step: 'Failed', error: 'Output file not found after download' });
    throw new Error('Output file not found after download');
  }

  completeTask(taskId, outPath, {
    fileExtension: outputExt,
    mimeType: outputMime,
  });
  unregisterTaskCleanupPath(taskId, outPath);
  clearTaskRuntime(taskId);
}

export async function downloadThumbnail({ taskId, imageUrl, title }) {
  if (!imageUrl) throw new Error('Thumbnail is not available for this item');

  const controller = new AbortController();
  registerTaskController(taskId, controller);

  setTask(taskId, {
    title,
    status: 'running',
    step: 'Downloading thumbnail…',
    progress: 15,
    phaseProgress: 15,
    fileExtension: 'jpg',
    mimeType: 'image/jpeg',
  });

  let outPath = null;

  try {
    const response = await fetch(imageUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'LOADR/1.0',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });

    if (!response.ok) throw new Error(`Thumbnail request failed with HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    const fileExtension = getImageExtension(contentType, imageUrl);
    const mimeType = getImageMimeType(fileExtension);
    outPath = path.join(os.tmpdir(), `loadr_${taskId}.${fileExtension}`);
    registerTaskCleanupPath(taskId, outPath);

    setTask(taskId, {
      step: 'Preparing image…',
      progress: 80,
      phaseProgress: 80,
      fileExtension,
      mimeType,
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    if (isTaskCancelled(taskId)) throw createCancellationError();
    fs.writeFileSync(outPath, buffer);

    completeTask(taskId, outPath, { fileExtension, mimeType });
    unregisterTaskCleanupPath(taskId, outPath);
    clearTaskRuntime(taskId);
  } catch (err) {
    if (isTaskCancelled(taskId) && err.code !== 'TASK_CANCELLED') err = createCancellationError();
    if (outPath) {
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    }
    if (err.code === 'TASK_CANCELLED') {
      setTask(taskId, { status: 'cancelled', step: 'Stopped', error: 'Download stopped by user', progress: 0, phaseProgress: 0 });
    } else {
      setTask(taskId, { status: 'error', step: 'Failed', error: err.message });
    }
    clearTaskRuntime(taskId);
    throw err;
  } finally {
    unregisterTaskController(taskId, controller);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── GDrive folder: list all video files ──────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeGDriveFolder(rawUrl) {
  const context = await getContext();
  const page    = await context.newPage();

  try {
    await page.goto(rawUrl, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(2000);

    const pageUrl = page.url();
    if (pageUrl.includes('accounts.google.com') || pageUrl.includes('/ServiceLogin')) {
      throw new Error('AUTH_REQUIRED');
    }

    // Collect all file links inside the folder
    const files = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Drive grid/list items with file links
      document.querySelectorAll('[data-tooltip], [data-target], [data-id]').forEach((el) => {
        const link = el.closest('a[href]') ?? el.querySelector('a[href]');
        if (!link) return;
        const href = link.href ?? '';
        const fileMatch = href.match(/\/file\/d\/([^/?#]+)/);
        if (!fileMatch) return;
        const id = fileMatch[1];
        if (seen.has(id)) return;
        seen.add(id);
        const name = el.getAttribute('data-tooltip') ?? el.getAttribute('aria-label') ?? link.textContent?.trim() ?? id;
        results.push({ id, name: name.trim(), url: `https://drive.google.com/file/d/${id}/view` });
      });

      // Fallback: scrape all /file/d/ links
      if (results.length === 0) {
        document.querySelectorAll('a[href]').forEach((a) => {
          const m = a.href.match(/\/file\/d\/([^/?#]+)/);
          if (!m) return;
          const id = m[1];
          if (seen.has(id)) return;
          seen.add(id);
          results.push({ id, name: a.textContent?.trim() || id, url: `https://drive.google.com/file/d/${id}/view` });
        });
      }

      return results;
    });

    const title = await page.title().catch(() => 'Google Drive Folder');

    if (files.length === 0) {
      throw new Error('No downloadable files found in this folder. The folder may be empty or requires Google sign-in.');
    }

    const jobId = saveJob({ type: 'gdrive-folder', title, files });
    scheduleContextClose(JOB_TTL);

    return { type: 'gdrive-folder', title, files, jobId };
  } catch (err) {
    if (err.message === 'AUTH_REQUIRED') throw err;
    await closeSharedContext();
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Top-level dispatcher ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeVideo(rawUrl) {
  const kind = detectPlatform(rawUrl);
  if (kind === 'gdrive-folder') return analyzeGDriveFolder(rawUrl);
  if (kind === 'gdrive-file')   return analyzeGDriveVideo(rawUrl);
  return analyzeUniversal(rawUrl);
}
