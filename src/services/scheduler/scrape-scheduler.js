import { getScrapeQueue, getHealthQueue, DEFAULT_JOB_OPTS } from './job-runner.js';
import pool from '../../db/postgres.js';
import { intervalToDays } from '../../db/column-maps.js';
import { logger } from '../../lib/logger.js';

export class ScrapeScheduler {
  async scheduleAllStores() {
    // Get published stores with their last successful scrape time
    const { rows: stores } = await pool.query(
      `SELECT s.id, s.site_name AS store_name, s.scrape_frequency,
              (SELECT MAX(ss.completed_at) FROM scraping_sessions ss
               WHERE ss.site_id = s.id AND ss.status = 'completed') AS last_completed
       FROM sites s WHERE s.status = 'published'`
    );

    const queue = getScrapeQueue();

    // Remove ALL stale repeatable jobs from Redis before scheduling
    const repeatableJobs = await queue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await queue.removeRepeatableByKey(job.key);
    }
    if (repeatableJobs.length > 0) {
      logger.info({ removed: repeatableJobs.length }, 'Cleared stale repeatable jobs from Redis');
    }

    // Also drain any waiting jobs from a previous run
    await queue.drain();

    let scheduled = 0;
    let skipped = 0;

    for (const store of stores || []) {
      const freqDays = intervalToDays(store.scrape_frequency) || 7;
      const freqMs = freqDays * 24 * 60 * 60 * 1000;

      // If last successful scrape is within the frequency window, skip
      if (store.last_completed) {
        const elapsed = Date.now() - new Date(store.last_completed).getTime();
        if (elapsed < freqMs) {
          const nextDue = new Date(new Date(store.last_completed).getTime() + freqMs);
          logger.debug({ storeId: store.id, storeName: store.store_name, nextDue: nextDue.toISOString() },
            'Store scraped recently — skipping until next due');
          skipped++;
          continue;
        }
      }

      // Store is due for a scrape — add a one-off job (not repeatable)
      // This avoids BullMQ repeatable jobs firing immediately on every restart
      await queue.add(
        `scheduled-scrape-${store.id}`,
        { storeId: store.id },
        { ...DEFAULT_JOB_OPTS }
      );

      logger.debug({ storeId: store.id, frequencyDays: freqDays, lastCompleted: store.last_completed || 'never' },
        'Queued store for scrape');
      scheduled++;
    }

    // Schedule health checks every 6 hours
    const healthQueue = getHealthQueue();
    await healthQueue.add(
      'health-check',
      {},
      {
        repeat: { every: 6 * 60 * 60 * 1000 },
        jobId: 'recurring-health-check',
      }
    );

    logger.info({ total: stores?.length || 0, scheduled, skipped }, 'Store scheduling complete');
  }

  async triggerImmediateScrape(storeId, options = {}) {
    // Check for existing running or queued session for this store
    const { rows: existing } = await pool.query(
      `SELECT id, status FROM scraping_sessions
       WHERE site_id = $1 AND status IN ('running', 'queued')
       LIMIT 1`,
      [storeId]
    );
    if (existing.length > 0) {
      const err = new Error(`Store already has a ${existing[0].status} scrape (session ${existing[0].id})`);
      err.code = 'DUPLICATE_SCRAPE';
      throw err;
    }

    // Create a 'queued' session so it's immediately visible in the admin UI
    const { rows } = await pool.query(
      `INSERT INTO scraping_sessions (site_id, status, session_type, started_at)
       VALUES ($1, 'queued', 'manual', NOW())
       RETURNING id`,
      [storeId]
    );
    const sessionId = rows[0]?.id;

    const queue = getScrapeQueue();
    const job = await queue.add(
      `manual-scrape-${storeId}`,
      { storeId, sessionId, productLimit: options.productLimit || null },
      { ...DEFAULT_JOB_OPTS, priority: 1 }
    );
    logger.info({ storeId, jobId: job.id, sessionId, productLimit: options.productLimit || 'unlimited' }, 'Triggered immediate scrape');
    return job.id;
  }

  async updateSchedule(storeId, newFrequency) {
    const queue = getScrapeQueue();

    // Remove existing repeatable job
    const repeatableJobs = await queue.getRepeatableJobs();
    const existing = repeatableJobs.find(j => j.id === `recurring-${storeId}`);
    if (existing) {
      await queue.removeRepeatableByKey(existing.key);
    }

    // Create new repeatable job
    const repeatMs = newFrequency * 24 * 60 * 60 * 1000;
    await queue.add(
      `scrape-${storeId}`,
      { storeId },
      {
        ...DEFAULT_JOB_OPTS,
        repeat: { every: repeatMs },
        jobId: `recurring-${storeId}`,
      }
    );

    logger.info({ storeId, frequencyDays: newFrequency }, 'Updated scrape schedule');
  }

  async removeSchedule(storeId) {
    const queue = getScrapeQueue();
    const repeatableJobs = await queue.getRepeatableJobs();
    const existing = repeatableJobs.find(j => j.id === `recurring-${storeId}`);
    if (existing) {
      await queue.removeRepeatableByKey(existing.key);
      logger.info({ storeId }, 'Removed scrape schedule');
    }
  }
}

export const scrapeScheduler = new ScrapeScheduler();
