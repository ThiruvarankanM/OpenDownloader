import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { applySecurityMiddleware } from './middleware/security.js';
import { authRouter } from './routes/auth.js';
import { videoRouter } from './routes/video.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

applySecurityMiddleware(app);
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRouter);
app.use('/api/video', videoRouter);

// SPA fallback — must come after API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Centralised error handler
app.use((err, req, res, _next) => {
  console.error(err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(config.port, () => {
  console.log(`OpenDownloader running on http://localhost:${config.port} [${config.nodeEnv}]`);
});
