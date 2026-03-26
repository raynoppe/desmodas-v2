import express from 'express';
import config from './config/index.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { apiKeyAuth } from './middleware/auth.js';
import pool from './db/postgres.js';

// Routes
import healthRoutes from './routes/health.js';
import storesRoutes from './routes/stores.js';
import productsRoutes from './routes/products.js';
import scrapeJobsRoutes from './routes/scrape-jobs.js';
import categoriesRoutes from './routes/categories.js';

// Services
import { initScrapeWorker, initHealthWorker, shutdown } from './services/scheduler/job-runner.js';
import { scrapeScheduler } from './services/scheduler/scrape-scheduler.js';
import { runStorePipeline } from './services/pipeline.js';
import { siteHealthChecker } from './services/monitoring/health-checker.js';
import { typesenseIndexer } from './services/search/indexer.js';

const app = express();
app.use(express.json());

// Public routes
app.use('/health', healthRoutes);

// Protected API routes
app.use('/api', apiKeyAuth);
app.use('/api/stores', storesRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/scrape-jobs', scrapeJobsRoutes);
app.use('/api/categories', categoriesRoutes);

app.use(errorHandler);

// Initialize services
async function start() {
  // Clean up stale 'running' sessions from previous crash/restart
  try {
    const { rowCount } = await pool.query(
      `UPDATE scraping_sessions SET status = 'failed', completed_at = NOW(),
       error_summary = $1
       WHERE status IN ('running', 'queued')`,
      [JSON.stringify([{ type: 'crash_recovery', message: 'Session was still running when scraper restarted — marked as failed' }])]
    );
    if (rowCount > 0) {
      logger.warn({ count: rowCount }, 'Cleaned up stale running sessions from previous crash');
    }
  } catch (error) {
    logger.warn({ error: error.message }, 'Failed to clean up stale sessions');
  }

  try {
    // Ensure Typesense collection exists
    await typesenseIndexer.ensureCollection();
    logger.info('Typesense collection ready');
  } catch (error) {
    logger.warn({ error: error.message }, 'Typesense init failed (will retry on first use)');
  }

  // Initialize BullMQ workers
  initScrapeWorker(runStorePipeline);
  initHealthWorker(() => siteHealthChecker.runHealthChecks());
  logger.info('BullMQ workers initialized');

  // Schedule existing stores
  try {
    await scrapeScheduler.scheduleAllStores();
  } catch (error) {
    logger.warn({ error: error.message }, 'Failed to schedule stores (Redis may not be available)');
  }

  // Start HTTP server
  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Desmodas scraper service started');
  });
}

// Graceful shutdown
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Shutting down gracefully');
  await shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

start().catch(error => {
  logger.fatal({ error: error.message }, 'Failed to start service');
  process.exit(1);
});

export default app;
