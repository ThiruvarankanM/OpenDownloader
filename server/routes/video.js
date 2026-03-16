import { Router } from 'express';
import { z } from 'zod';
import fs from 'fs';
import { requireAuth } from '../middleware/auth.js';
import { apiLimiter, downloadLimiter } from '../middleware/rateLimiter.js';
import {
  analyzeVideo,
  cancelTask,
  downloadThumbnail,
  getJob,
  getSupportedPlatforms,
  createTask,
  getTask,
  deleteTask,
  downloadAndMerge,
  downloadUniversal,
} from '../services/downloader.js';

const router = Router();

const analyzeSchema = z.object({
  url: z.string().url().max(2048),
});

const startSchema = z.object({
  jobId: z.string().uuid(),
  height: z.union([z.coerce.number().int().min(100).max(4320), z.literal('best')]),
  format: z.enum(['mp4', 'mp3', 'm4a', 'thumbnail']).default('mp4'),
});

// Analyze: detect platform, return metadata + jobId
router.post('/analyze', requireAuth, apiLimiter, async (req, res) => {
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'A valid URL is required' });
  }
  try {
    const metadata = await analyzeVideo(parsed.data.url);
    return res.json(metadata);
  } catch (err) {
    if (err.message === 'AUTH_REQUIRED') {
      return res.status(403).json({
        error: 'Google sign-in required.',
        hint: 'Stop the server and run: npm run setup:auth',
        code: 'AUTH_REQUIRED',
      });
    }
    return res.status(422).json({ error: err.message });
  }
});

// Start download: kicks off background download task
router.post('/start-download', requireAuth, downloadLimiter, (req, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  const { jobId, height, format } = parsed.data;
  const job = getJob(jobId);
  if (!job) {
    return res.status(410).json({
      error: 'Session expired -- paste the URL and Fetch again',
      code: 'JOB_EXPIRED',
    });
  }

  const taskId = createTask();

  if (format === 'thumbnail') {
    if (!job.thumbnail) {
      deleteTask(taskId);
      return res.status(404).json({ error: 'Thumbnail is not available for this item' });
    }
    downloadThumbnail({
      taskId,
      imageUrl: job.thumbnail,
      title: `${job.title} thumbnail`,
    }).catch(() => {});
    return res.json({ taskId });
  }

  if (job.type === 'universal') {
    downloadUniversal({
      taskId,
      originalUrl: job.originalUrl,
      height,
      title: job.title,
      format,
    }).catch(() => {});
  } else {
    const fallbackHeight = Object.keys(job.streamsByHeight ?? {})
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0];
    const isAudioMode = format === 'mp3' || format === 'm4a';
    const resolvedHeight = isAudioMode && !job.streamsByHeight[height]
      ? fallbackHeight
      : height;
    const streams = job.streamsByHeight[resolvedHeight];
    if (!streams) {
      deleteTask(taskId);
      return res.status(404).json({ error: `${height}p stream not available` });
    }
    downloadAndMerge({
      taskId,
      videoUrl: streams.videoUrl,
      audioUrl: streams.audioUrl,
      title: job.title,
      format,
    }).catch(() => {});
  }

  return res.json({ taskId });
});

router.get('/platforms', requireAuth, (req, res) => {
  return res.json({ platforms: getSupportedPlatforms() });
});

// Task status: poll for progress
router.get('/task/:taskId', requireAuth, (req, res) => {
  const { taskId } = req.params;
  const task = getTask(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found or expired' });
  }
  return res.json({
    status: task.status,
    step: task.step,
    progress: task.progress ?? 0,
    phaseProgress: task.phaseProgress ?? 0,
    title: task.title,
    error: task.error ?? null,
  });
});

router.post('/task/:taskId/cancel', requireAuth, async (req, res) => {
  const { taskId } = req.params;
  const result = await cancelTask(taskId);
  if (!result.ok) {
    const status = result.code === 'TASK_NOT_FOUND' ? 404 : 409;
    return res.status(status).json({ error: result.message, code: result.code });
  }
  return res.json({ ok: true, message: result.message, code: result.code });
});

// Serve: stream completed merged file to browser
router.get('/serve', requireAuth, (req, res) => {
  const { taskId } = req.query;
  if (!taskId || typeof taskId !== 'string') {
    return res.status(400).json({ error: 'Missing taskId' });
  }

  const task = getTask(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found or expired' });
  if (task.status !== 'done') return res.status(409).json({ error: 'File not ready yet' });
  if (!task.filePath || !fs.existsSync(task.filePath)) {
    return res.status(404).json({ error: 'Output file missing' });
  }

  const fileExtension = task.fileExtension ?? 'mp4';
  const mimeType = task.mimeType
    ?? (fileExtension === 'mp3'
      ? 'audio/mpeg'
      : fileExtension === 'm4a'
        ? 'audio/mp4'
        : 'video/mp4');
  const filename = `${(task.title ?? 'video').replace(/"/g, '\\"')}.${fileExtension}`;

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  const stream = fs.createReadStream(task.filePath);

  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  res.on('finish', () => {
    try { fs.unlinkSync(task.filePath); } catch {}
    deleteTask(taskId);
  });

  stream.pipe(res);
});

export { router as videoRouter };
