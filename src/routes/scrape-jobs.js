import { Router } from 'express';
import pool from '../db/postgres.js';
import { stopAllJobs, getRunningJobs, stopJob, retryJob } from '../services/scheduler/job-runner.js';

const router = Router();

// Get currently running jobs (must be before /:id)
router.get('/running', async (req, res, next) => {
  try {
    const jobs = getRunningJobs();
    res.json({ running: jobs, count: jobs.length });
  } catch (error) { next(error); }
});

// Stop all scrape jobs (running + queued + scheduled) (must be before /:id)
router.post('/stop-all', async (req, res, next) => {
  try {
    const results = await stopAllJobs();

    // Also mark any DB sessions still 'running' or 'queued' as failed
    const { rowCount } = await pool.query(
      `UPDATE scraping_sessions SET status = 'failed', completed_at = NOW(),
       error_summary = $1
       WHERE status IN ('running', 'queued')`,
      [JSON.stringify([{ type: 'abort', message: 'Scrape was stopped by admin' }])]
    );

    res.json({
      message: 'All scrape jobs stopped',
      ...results,
      sessionsMarkedFailed: rowCount,
    });
  } catch (error) { next(error); }
});

// Stop a single running job by session ID
router.post('/:id/stop', async (req, res, next) => {
  try {
    const sessionId = req.params.id;

    // Find the BullMQ job ID for this session
    const running = getRunningJobs();
    // The session ID won't match BullMQ job ID directly.
    // Look up the store from the session, then find the running job for that store.
    const { rows: [session] } = await pool.query(
      'SELECT site_id FROM scraping_sessions WHERE id = $1',
      [sessionId]
    );

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Try to find a running BullMQ job for this store
    const runningJob = running.find(j => j.storeId === session.site_id);
    if (runningJob) {
      stopJob(runningJob.jobId);
    }

    // Also mark this specific session as failed in DB
    await pool.query(
      `UPDATE scraping_sessions SET status = 'failed', completed_at = NOW(),
       error_summary = $1
       WHERE id = $2 AND status IN ('running', 'queued')`,
      [JSON.stringify([{ type: 'abort', message: 'Scrape was stopped by admin' }]), sessionId]
    );

    res.json({ message: 'Job stopped', sessionId, bullmqStopped: !!runningJob });
  } catch (error) { next(error); }
});

// Retry a failed/completed job by session ID
router.post('/:id/retry', async (req, res, next) => {
  try {
    const sessionId = req.params.id;

    const { rows: [session] } = await pool.query(
      'SELECT site_id, status FROM scraping_sessions WHERE id = $1',
      [sessionId]
    );

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'running') {
      return res.status(400).json({ error: 'Job is already running' });
    }

    const newJobId = await retryJob(session.site_id);
    res.json({ message: 'Job queued for retry', sessionId, storeId: session.site_id, bullmqJobId: newJobId });
  } catch (error) { next(error); }
});

// List scrape jobs
router.get('/', async (req, res, next) => {
  try {
    const { store_id, status, limit = 50, offset = 0 } = req.query;

    const conditions = [];
    const values = [];
    let idx = 1;

    if (store_id) { conditions.push(`ss.site_id = $${idx++}`); values.push(store_id); }
    if (status) { conditions.push(`ss.status = $${idx++}`); values.push(status); }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM scraping_sessions ss ${whereClause}`,
      values
    );

    // Data with store join
    values.push(Number(limit), Number(offset));
    const { rows: data } = await pool.query(
      `SELECT ss.*,
        ss.site_id AS store_id,
        ss.products_discovered AS products_found,
        ss.products_new AS products_added,
        ss.products_updated,
        ss.products_discontinued AS products_removed,
        ss.error_summary AS errors,
        ss.started_at AS created_at,
        s.site_name AS store_name,
        s.site_url AS url
       FROM scraping_sessions ss
       JOIN sites s ON s.id = ss.site_id
       ${whereClause}
       ORDER BY ss.started_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      values
    );

    res.json({ data, total: parseInt(count) });
  } catch (error) { next(error); }
});

// Get job by ID
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ss.*,
        ss.site_id AS store_id,
        ss.products_discovered AS products_found,
        ss.products_new AS products_added,
        ss.products_updated,
        ss.products_discontinued AS products_removed,
        ss.error_summary AS errors,
        ss.started_at AS created_at,
        s.site_name AS store_name,
        s.site_url AS url
       FROM scraping_sessions ss
       JOIN sites s ON s.id = ss.site_id
       WHERE ss.id = $1`,
      [req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Job not found' });
    res.json(rows[0]);
  } catch (error) { next(error); }
});

export default router;
