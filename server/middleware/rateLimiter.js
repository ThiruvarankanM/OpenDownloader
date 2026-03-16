import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

const limiterDefaults = {
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: config.rateLimit.windowMs,
};

export const apiLimiter = rateLimit({
  ...limiterDefaults,
  max: config.rateLimit.apiMax,
  message: { error: 'Too many requests, please try again later' },
});

export const downloadLimiter = rateLimit({
  ...limiterDefaults,
  max: config.rateLimit.downloadMax,
  message: { error: 'Download limit reached, please try again in 15 minutes' },
});

export const authLimiter = rateLimit({
  ...limiterDefaults,
  max: 10,
  message: { error: 'Too many login attempts, please try again later' },
});
