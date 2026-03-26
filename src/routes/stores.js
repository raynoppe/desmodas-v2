import { Router } from 'express';
import pool from '../db/postgres.js';
import { mapSiteToStore, STORE_STATUS_MAP, daysToInterval } from '../db/column-maps.js';
import { scrapeScheduler } from '../services/scheduler/scrape-scheduler.js';
import { siteStatusManager } from '../services/monitoring/site-status.js';
import { ValidationError } from '../lib/errors.js';

const router = Router();

// List stores (only scraper-managed)
router.get('/', async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    const conditions = [];
    const values = [];
    let idx = 1;

    if (status) {
      const mappedStatus = STORE_STATUS_MAP[status] || status;
      conditions.push(`s.status = $${idx++}`);
      values.push(mappedStatus);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count query
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM sites s ${whereClause}`,
      values
    );

    // Data query with locations
    values.push(Number(limit), Number(offset));
    const { rows: data } = await pool.query(
      `SELECT s.*,
        COALESCE(json_agg(sl.*) FILTER (WHERE sl.id IS NOT NULL), '[]') AS store_locations
       FROM sites s
       LEFT JOIN site_locations sl ON sl.site_id = s.id
       ${whereClause}
       GROUP BY s.id
       ORDER BY s.date_created DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      values
    );

    res.json({ data: data.map(mapSiteToStore), total: parseInt(count) });
  } catch (error) { next(error); }
});

// Get store by ID
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
        COALESCE(json_agg(sl.*) FILTER (WHERE sl.id IS NOT NULL), '[]') AS store_locations
       FROM sites s
       LEFT JOIN site_locations sl ON sl.site_id = s.id
       WHERE s.id = $1
       GROUP BY s.id`,
      [req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
    res.json(mapSiteToStore(rows[0]));
  } catch (error) { next(error); }
});

// Add store
router.post('/', async (req, res, next) => {
  try {
    const { store_name, url, scrape_frequency = 7, description, email, tel } = req.body;
    if (!store_name || !url) throw new ValidationError('store_name and url are required');

    const storeId = crypto.randomUUID();
    const domain = new URL(url).hostname.replace(/^www\./, '');
    const handle = store_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const now = new Date().toISOString();

    const { rows } = await pool.query(
      `INSERT INTO sites (id, site_name, site_url, site_handle, domain, source,
        scrape_frequency, site_description, email, tel,
        status, date_created, date_updated)
       VALUES ($1, $2, $3, $4, $5, 'scraper', $6::interval, $7, $8, $9, 'draft', $10, $10)
       RETURNING *`,
      [storeId, store_name, url, handle, domain,
        daysToInterval(scrape_frequency), description || null, email || null, tel || null,
        now]
    );

    if (!rows[0]) throw new Error('Failed to insert store');
    const data = mapSiteToStore(rows[0]);

    // Don't auto-scrape — user should test scrape first, then publish when ready
    res.status(201).json(data);
  } catch (error) {
    if (error.code === '23505') {
      return next(new ValidationError('Store URL already exists'));
    }
    next(error);
  }
});

// Update store
router.patch('/:id', async (req, res, next) => {
  try {
    // Map allowed scraper field names to DO column names
    const fieldMap = {
      store_name: 'site_name',
      description: 'site_description',
      url: 'site_url',
      email: 'email',
      tel: 'tel',
      address_street: 'address_street',
      address_city: 'address_city',
      address_state: 'address_state',
      address_postcode: 'address_postcode',
      address_country: 'address_country',
      status: 'status',
      scrape_frequency: 'scrape_frequency',
      is_ethical: 'is_ethical',
      ethical_score: 'ethical_score',
    };

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [scraperKey, doColumn] of Object.entries(fieldMap)) {
      if (req.body[scraperKey] !== undefined) {
        if (scraperKey === 'status') {
          setClauses.push(`${doColumn} = $${idx++}`);
          values.push(STORE_STATUS_MAP[req.body[scraperKey]] || req.body[scraperKey]);
        } else if (scraperKey === 'scrape_frequency') {
          setClauses.push(`${doColumn} = $${idx++}::interval`);
          values.push(daysToInterval(req.body[scraperKey]));
        } else if (scraperKey === 'ethical_score') {
          setClauses.push(`${doColumn} = $${idx++}`);
          values.push(JSON.stringify(req.body[scraperKey]));
        } else {
          setClauses.push(`${doColumn} = $${idx++}`);
          values.push(req.body[scraperKey]);
        }
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push(`date_updated = $${idx++}`);
    values.push(new Date().toISOString());
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE sites SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (!rows[0]) return res.status(404).json({ error: 'Store not found' });

    // Update schedule if frequency changed
    if (req.body.scrape_frequency) {
      await scrapeScheduler.updateSchedule(req.params.id, req.body.scrape_frequency);
    }

    res.json(mapSiteToStore(rows[0]));
  } catch (error) { next(error); }
});

// Close store (soft delete)
router.delete('/:id', async (req, res, next) => {
  try {
    await siteStatusManager.markAsClosed(req.params.id);
    res.json({ message: 'Store closed and products removed' });
  } catch (error) { next(error); }
});

// Permanently delete store and all data
router.delete('/:id/permanent', async (req, res, next) => {
  try {
    const stats = await siteStatusManager.hardDelete(req.params.id);
    res.json({ message: 'Store permanently deleted', stats });
  } catch (error) { next(error); }
});

// Trigger immediate scrape
router.post('/:id/scrape', async (req, res, next) => {
  try {
    const { product_limit } = req.body || {};
    const jobId = await scrapeScheduler.triggerImmediateScrape(req.params.id, { productLimit: product_limit ? Number(product_limit) : null });
    res.json({ job_id: jobId, message: 'Scrape job queued' });
  } catch (error) {
    if (error.code === 'DUPLICATE_SCRAPE') {
      return res.status(409).json({ error: error.message });
    }
    next(error);
  }
});

// Get site info — extract and save store metadata (description, country, ethics, locations)
router.post('/:id/get-info', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM sites WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Store not found' });

    const store = mapSiteToStore(rows[0]);

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const { runInfoScrape } = await import('../services/info-pipeline.js');
    const result = await runInfoScrape(store, send);

    send('done', { message: 'Site info extraction complete', result });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      res.end();
    } else {
      next(error);
    }
  }
});

// Test scrape — dry run that returns extracted data via SSE without saving to DB
router.post('/:id/test-scrape', async (req, res, next) => {
  try {
    const { product_limit = 5 } = req.body || {};
    const limit = Math.min(Math.max(1, Number(product_limit) || 5), 50);

    // Get store details
    const { rows } = await pool.query('SELECT * FROM sites WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Store not found' });

    const store = mapSiteToStore(rows[0]);

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Handle client disconnect
    let aborted = false;
    req.on('close', () => { aborted = true; });

    const { runTestScrape } = await import('../services/test-pipeline.js');
    await runTestScrape(store, limit, send, () => aborted);

    send('done', { message: 'Test scrape complete' });
    res.end();
  } catch (error) {
    // If headers already sent (SSE started), send error event
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      res.end();
    } else {
      next(error);
    }
  }
});

// Schedule recurring scrape for a store (called when status → published)
router.post('/:id/schedule', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, scrape_frequency FROM sites WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Store not found' });

    const { intervalToDays } = await import('../db/column-maps.js');
    const freqDays = intervalToDays(rows[0].scrape_frequency) || 7;
    await scrapeScheduler.updateSchedule(req.params.id, freqDays);

    // Also trigger an immediate first scrape
    const jobId = await scrapeScheduler.triggerImmediateScrape(req.params.id);

    res.json({ message: 'Store scheduled', frequency_days: freqDays, job_id: jobId });
  } catch (error) { next(error); }
});

// Remove recurring scrape schedule (called when status changes away from published)
router.post('/:id/unschedule', async (req, res, next) => {
  try {
    await scrapeScheduler.removeSchedule(req.params.id);
    res.json({ message: 'Store unscheduled' });
  } catch (error) { next(error); }
});

export default router;
