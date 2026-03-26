import pool from '../../db/postgres.js';
import { logger } from '../../lib/logger.js';
import { siteStatusManager } from './site-status.js';

const FAILURE_THRESHOLD = 3;
const CHECK_TIMEOUT_MS = 15000;

// Rate limiting configuration
const CONCURRENCY_LIMIT = 5;        // Max concurrent health checks
const DELAY_BETWEEN_BATCHES_MS = 1000; // 1 second pause between batches
const PER_DOMAIN_DELAY_MS = 2000;    // Min 2 seconds between checks to the same domain

export class SiteHealthChecker {
  constructor() {
    // Track last check time per domain to avoid hammering the same host
    this._domainLastChecked = new Map();
  }

  _getDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  async _waitForDomainRateLimit(domain) {
    const lastChecked = this._domainLastChecked.get(domain);
    if (lastChecked) {
      const elapsed = Date.now() - lastChecked;
      if (elapsed < PER_DOMAIN_DELAY_MS) {
        await new Promise(resolve => setTimeout(resolve, PER_DOMAIN_DELAY_MS - elapsed));
      }
    }
    this._domainLastChecked.set(domain, Date.now());
  }

  async checkSite(storeUrl) {
    const domain = this._getDomain(storeUrl);
    await this._waitForDomainRateLimit(domain);

    try {
      const response = await fetch(storeUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        redirect: 'follow',
      });

      return {
        online: response.ok,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        online: false,
        statusCode: null,
        error: error.message,
      };
    }
  }

  async _processStore(store) {
    const result = await this.checkSite(store.url);

    if (!result.online) {
      await this._handleFailure(store, result);
    } else {
      await this._clearFailures(store.id);
    }
  }

  async _processBatch(batch) {
    await Promise.all(batch.map(store => this._processStore(store)));
  }

  async runHealthChecks() {
    const { rows: stores } = await pool.query(
      `SELECT id, site_name AS store_name, site_url AS url, status
       FROM sites WHERE status = 'published'`
    );

    const storeList = stores || [];
    logger.info({ storeCount: storeList.length }, 'Starting health checks');

    // Clear domain tracking from previous run
    this._domainLastChecked.clear();

    // Process stores in batches with concurrency limit
    for (let i = 0; i < storeList.length; i += CONCURRENCY_LIMIT) {
      const batch = storeList.slice(i, i + CONCURRENCY_LIMIT);
      const batchNum = Math.floor(i / CONCURRENCY_LIMIT) + 1;
      const totalBatches = Math.ceil(storeList.length / CONCURRENCY_LIMIT);

      logger.debug({ batch: batchNum, totalBatches, batchSize: batch.length }, 'Processing health check batch');

      await this._processBatch(batch);

      // Pause between batches (skip after last batch)
      if (i + CONCURRENCY_LIMIT < storeList.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
      }
    }

    logger.info({ storeCount: storeList.length }, 'Health checks completed');
  }

  async _handleFailure(store, result) {
    // Get recent sessions to count consecutive failures
    const { rows: recentJobs } = await pool.query(
      `SELECT status FROM scraping_sessions
       WHERE site_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [store.id, FAILURE_THRESHOLD]
    );

    const consecutiveFailures = recentJobs?.filter(j => j.status === 'failed').length || 0;

    // Record this failure
    await pool.query(
      `INSERT INTO scraping_sessions (site_id, status, session_type, started_at, completed_at, error_summary)
       VALUES ($1, 'failed', 'health_check', $2, $2, $3)`,
      [
        store.id,
        new Date().toISOString(),
        JSON.stringify([{ type: 'health_check', message: result.error || `HTTP ${result.statusCode}` }]),
      ]
    );

    if (consecutiveFailures + 1 >= FAILURE_THRESHOLD) {
      logger.warn({ storeId: store.id, storeName: store.store_name, failures: consecutiveFailures + 1 }, 'Store offline threshold reached, marking as closed');
      await siteStatusManager.markAsClosed(store.id);
    } else {
      logger.info({ storeId: store.id, storeName: store.store_name, failures: consecutiveFailures + 1 }, 'Store health check failed');
    }
  }

  async _clearFailures(storeId) {
    // No action needed - consecutive failure count is derived from recent sessions
  }
}

export const siteHealthChecker = new SiteHealthChecker();
