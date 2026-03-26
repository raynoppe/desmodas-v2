import config from '../config/index.js';

export function apiKeyAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  if (token !== config.ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}
