import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const requireAuth = (req, res, next) => {
  if (config.auth.bypass) {
    req.user = { sub: 'local-dev', type: 'bypass' };
    return next();
  }

  const token = req.cookies?.accessToken;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    if (payload.type !== 'access') throw new Error('Invalid token type');
    req.user = payload;
    next();
  } catch {
    res.clearCookie('accessToken');
    return res.status(401).json({ error: 'Session expired' });
  }
};
