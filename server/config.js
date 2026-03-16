import { config as loadEnv } from 'dotenv';
loadEnv();

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
};

const nodeEnv = process.env.NODE_ENV || 'development';
const authBypass = process.env.AUTH_BYPASS
  ? process.env.AUTH_BYPASS === 'true'
  : nodeEnv === 'development';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv,

  jwt: {
    // In local dev bypass mode, token signing is not required.
    secret: authBypass ? (process.env.JWT_SECRET || 'dev-bypass-secret') : required('JWT_SECRET'),
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
    downloadExpiry: '5m',
  },

  auth: {
    bypass: authBypass,
    username: authBypass ? (process.env.ADMIN_USERNAME || 'admin') : required('ADMIN_USERNAME'),
    passwordHash: authBypass ? (process.env.ADMIN_PASSWORD_HASH || '') : required('ADMIN_PASSWORD_HASH'),
  },

  cors: {
    origins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim()),
  },

  rateLimit: {
    windowMs: 15 * 60 * 1000,
    apiMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    downloadMax: parseInt(process.env.DOWNLOAD_RATE_MAX || '10', 10),
  },
};
