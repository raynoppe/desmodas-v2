import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import config from '../../config/index.js';
import { logger } from '../../lib/logger.js';

let connection;
let scrapeQueue;
let healthQueue;
let scrapeWorker;
let healthWorker;

// Abort controllers for running pipelines, keyed by BullMQ job ID
const runningJobs = new Map();

// Default job options: retry up to 2 times with exponential backoff
export const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 60_000, // 1 min, then 2 min, then 4 min
  },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 200 },
};

export function getConnection() {
  if (!connection) {
    connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return connection;
}

export function getScrapeQueue() {
  if (!scrapeQueue) {
    scrapeQueue = new Queue('scrape-jobs', { connection: getConnection() });
  }
  return scrapeQueue;
}

export function getHealthQueue() {
  if (!healthQueue) {
    healthQueue = new Queue('health-checks', { connection: getConnection() });
  }
  return healthQueue;
}

/**
 * Initialize the scrape worker that processes store scrape jobs.
 * @param {Function} processFn - The pipeline function to call for each store
 */
export function initScrapeWorker(processFn) {
  scrapeWorker = new Worker('scrape-jobs', async (job) => {
    const { storeId, sessionId, productLimit } = job.data;
    logger.info({ storeId, jobId: job.id, sessionId, attempt: job.attemptsMade + 1, productLimit: productLimit || 'unlimited' }, 'Starting scrape job');

    // Create an AbortController so this job can be cancelled
    const abortController = new AbortController();
    runningJobs.set(job.id, { storeId, abortController, startedAt: Date.now() });

    try {
      const result = await processFn(storeId, job.id, { productLimit, sessionId, signal: abortController.signal });
      logger.info({ storeId, jobId: job.id, result }, 'Scrape job completed');
      return result;
    } catch (error) {
      if (abortController.signal.aborted) {
        logger.warn({ storeId, jobId: job.id }, 'Scrape job was aborted');
        // Don't retry aborted jobs
        throw new Error('Job aborted');
      }
      logger.error({ storeId, jobId: job.id, error: error.message, attempt: job.attemptsMade + 1 }, 'Scrape job failed');
      throw error;
    } finally {
      runningJobs.delete(job.id);
    }
  }, {
    connection: getConnection(),
    concurrency: config.MAX_CONCURRENT_SCRAPES,
    limiter: {
      max: 5,
      duration: 60000, // max 5 jobs started per minute
    },
  });

  scrapeWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, error: err.message }, 'Scrape worker: job failed');
  });

  scrapeWorker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Scrape worker: job completed');
  });

  return scrapeWorker;
}

/**
 * Stop all running and queued scrape jobs.
 * - Aborts currently running pipelines via AbortController
 * - Drains the queue (removes all waiting jobs)
 * - Removes all repeatable (scheduled) jobs
 */
export async function stopAllJobs() {
  const queue = getScrapeQueue();
  const results = { aborted: 0, drained: 0, repeatableRemoved: 0 };

  // 1. Abort all currently running pipelines
  for (const [jobId, { storeId, abortController }] of runningJobs) {
    logger.info({ jobId, storeId }, 'Aborting running job');
    abortController.abort();
    results.aborted++;
  }

  // 2. Drain the queue (remove all waiting/delayed jobs)
  try {
    const waiting = await queue.getWaiting();
    const delayed = await queue.getDelayed();
    for (const job of [...waiting, ...delayed]) {
      await job.remove();
      results.drained++;
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Error draining queue');
  }

  // 3. Remove all repeatable (scheduled) jobs
  try {
    const repeatableJobs = await queue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await queue.removeRepeatableByKey(job.key);
      results.repeatableRemoved++;
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Error removing repeatable jobs');
  }

  logger.warn(results, 'All scrape jobs stopped');
  return results;
}

/**
 * Get info about currently running jobs.
 */
export function getRunningJobs() {
  return Array.from(runningJobs.entries()).map(([jobId, { storeId, startedAt }]) => ({
    jobId,
    storeId,
    startedAt: new Date(startedAt).toISOString(),
    runningFor: Math.round((Date.now() - startedAt) / 1000),
  }));
}

/**
 * Stop a single running job by BullMQ job ID.
 */
export function stopJob(jobId) {
  const entry = runningJobs.get(jobId);
  if (!entry) return false;
  logger.info({ jobId, storeId: entry.storeId }, 'Aborting single job');
  entry.abortController.abort();
  return true;
}

/**
 * Retry a failed job by creating a new job with the same store data.
 */
export async function retryJob(storeId, options = {}) {
  const queue = getScrapeQueue();
  const job = await queue.add(
    `retry-scrape-${storeId}`,
    { storeId, productLimit: options.productLimit || null },
    { ...DEFAULT_JOB_OPTS, priority: 1 }
  );
  logger.info({ storeId, jobId: job.id }, 'Retrying scrape job');
  return job.id;
}

/**
 * Initialize the health check worker.
 * @param {Function} processFn - The health check function
 */
export function initHealthWorker(processFn) {
  healthWorker = new Worker('health-checks', async (job) => {
    await processFn();
  }, {
    connection: getConnection(),
    concurrency: 1,
  });

  return healthWorker;
}

export async function shutdown() {
  await scrapeWorker?.close();
  await healthWorker?.close();
  await scrapeQueue?.close();
  await healthQueue?.close();
  await connection?.quit();
}
