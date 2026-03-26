import pool from '../../db/postgres.js';
import { logger } from '../../lib/logger.js';
import { typesenseIndexer } from '../search/indexer.js';
import { scrapeScheduler } from '../scheduler/scrape-scheduler.js';
import { imageUploader } from '../images/s3-uploader.js';

export class SiteStatusManager {
  /**
   * Mark a store as closed: update status, remove all products, remove from Typesense.
   */
  async markAsClosed(storeId) {
    // 1. Update store status
    try {
      await pool.query(
        "UPDATE sites SET status = 'Archived', date_updated = $1 WHERE id = $2",
        [new Date().toISOString(), storeId]
      );
    } catch (error) {
      logger.error({ error: error.message, storeId }, 'Failed to close store');
      return;
    }

    // 2. Mark all active products as removed
    try {
      await pool.query(
        `UPDATE products SET status = 'removed', date_updated = $1
         WHERE site_id = $2 AND status IN ('active', 'discontinued', 'draft', 'new', 'updated')`,
        [new Date().toISOString(), storeId]
      );
    } catch (error) {
      logger.error({ error: error.message, storeId }, 'Failed to remove store products');
    }

    // 3. Remove from Typesense
    try {
      await typesenseIndexer.removeStoreProducts(storeId);
    } catch (error) {
      logger.error({ error: error.message, storeId }, 'Failed to remove from Typesense');
    }

    // 4. Remove scheduled scrape jobs
    try {
      await scrapeScheduler.removeSchedule(storeId);
    } catch (error) {
      logger.warn({ error: error.message, storeId }, 'Failed to remove schedule');
    }

    logger.info({ storeId }, 'Store marked as closed');
  }

  /**
   * Permanently delete a store and ALL associated data.
   * This is irreversible — removes products, images, sessions, locations, price history, then the site itself.
   */
  async hardDelete(storeId) {
    const stats = { products: 0, images: 0, sessions: 0, locations: 0, priceHistory: 0 };

    // 1. Get all product IDs for this store (to delete images from S3)
    const { rows: products } = await pool.query(
      'SELECT id FROM products WHERE site_id = $1',
      [storeId]
    );
    stats.products = products.length;

    // 2. Remove from Typesense first
    try {
      await typesenseIndexer.removeStoreProducts(storeId);
    } catch (error) {
      logger.warn({ error: error.message, storeId }, 'Failed to remove from Typesense during hard delete');
    }

    // 3. Remove scheduled jobs
    try {
      await scrapeScheduler.removeSchedule(storeId);
    } catch (error) {
      logger.warn({ error: error.message, storeId }, 'Failed to remove schedule during hard delete');
    }

    // 4. Delete product images from S3 (batch, non-blocking per product)
    for (const product of products) {
      try {
        await imageUploader.deleteProductImages(product.id);
        stats.images++;
      } catch (error) {
        logger.warn({ error: error.message, productId: product.id }, 'Failed to delete product images from S3');
      }
    }

    // 5. Delete from DB in order (respecting FK constraints)
    // Price history
    const priceResult = await pool.query('DELETE FROM product_price_history WHERE site_id = $1', [storeId]);
    stats.priceHistory = priceResult.rowCount || 0;

    // AI training data for this store's products
    if (products.length > 0) {
      const productIds = products.map(p => p.id);
      await pool.query('DELETE FROM ai_training_data WHERE product_id = ANY($1)', [productIds]);
    }

    // Products
    await pool.query('DELETE FROM products WHERE site_id = $1', [storeId]);

    // Scraping sessions (should cascade, but be explicit)
    const sessionResult = await pool.query('DELETE FROM scraping_sessions WHERE site_id = $1', [storeId]);
    stats.sessions = sessionResult.rowCount || 0;

    // Site locations
    const locationResult = await pool.query('DELETE FROM site_locations WHERE site_id = $1', [storeId]);
    stats.locations = locationResult.rowCount || 0;

    // Finally, delete the site record itself
    await pool.query('DELETE FROM sites WHERE id = $1', [storeId]);

    logger.info({ storeId, stats }, 'Store permanently deleted');
    return stats;
  }

  /**
   * Reactivate a closed store (admin action).
   */
  async reactivateStore(storeId) {
    try {
      await pool.query(
        "UPDATE sites SET status = 'draft', date_updated = $1 WHERE id = $2 AND status = 'Archived'",
        [new Date().toISOString(), storeId]
      );
      logger.info({ storeId }, 'Store reactivated for review');
    } catch (error) {
      logger.error({ error: error.message, storeId }, 'Failed to reactivate store');
    }
  }
}

export const siteStatusManager = new SiteStatusManager();
