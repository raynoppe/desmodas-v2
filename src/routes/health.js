import { Router } from 'express';

const router = Router();
const startedAt = Date.now();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

export default router;
