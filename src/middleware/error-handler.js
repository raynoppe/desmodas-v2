import { logger } from '../lib/logger.js';

export function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;

  logger.error({
    err,
    method: req.method,
    url: req.url,
    statusCode,
  }, err.message);

  res.status(statusCode).json({
    error: err.message,
    ...(err.details && { details: err.details }),
  });
}
