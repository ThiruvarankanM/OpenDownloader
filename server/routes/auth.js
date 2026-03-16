import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const COOKIE = {
  httpOnly: true,
  secure: config.nodeEnv === 'production',
  sameSite: 'strict',
  path: '/',
};

const loginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(128),
});

router.post('/login', authLimiter, async (req, res) => {
  if (config.auth.bypass) {
    return res.json({ ok: true, bypass: true, user: 'local-dev' });
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const { username, password } = parsed.data;

  // Both checks run regardless to prevent timing-based username enumeration
  const usernameValid = username === config.auth.username;
  const passwordValid = await bcrypt.compare(password, config.auth.passwordHash);

  if (!usernameValid || !passwordValid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const accessToken = jwt.sign(
    { sub: username, type: 'access' },
    config.jwt.secret,
    { expiresIn: config.jwt.accessExpiry }
  );
  const refreshToken = jwt.sign(
    { sub: username, type: 'refresh' },
    config.jwt.secret,
    { expiresIn: config.jwt.refreshExpiry }
  );

  res.cookie('accessToken', accessToken, { ...COOKIE, maxAge: 15 * 60 * 1000 });
  res.cookie('refreshToken', refreshToken, {
    ...COOKIE,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/auth/refresh',
  });

  return res.json({ ok: true });
});

router.post('/refresh', (req, res) => {
  if (config.auth.bypass) {
    return res.json({ ok: true, bypass: true });
  }

  const token = req.cookies?.refreshToken;
  if (!token) return res.status(401).json({ error: 'No refresh token' });

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    if (payload.type !== 'refresh') throw new Error('Invalid token type');

    const accessToken = jwt.sign(
      { sub: payload.sub, type: 'access' },
      config.jwt.secret,
      { expiresIn: config.jwt.accessExpiry }
    );

    res.cookie('accessToken', accessToken, { ...COOKIE, maxAge: 15 * 60 * 1000 });
    return res.json({ ok: true });
  } catch {
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
});

router.post('/logout', requireAuth, (req, res) => {
  res.clearCookie('accessToken', COOKIE);
  res.clearCookie('refreshToken', { ...COOKIE, path: '/api/auth/refresh' });
  return res.json({ ok: true, bypass: config.auth.bypass || false });
});

router.get('/status', requireAuth, (req, res) => {
  return res.json({ ok: true, user: req.user.sub });
});

export { router as authRouter };
