import pool from '../../db/postgres.js';
import { logger } from '../../lib/logger.js';

const SIMILARITY_THRESHOLD = 0.85;

export class Deduplicator {
  /**
   * Check if a product is a duplicate within the same store.
   * Uses exact URL match first, then fuzzy title matching.
   */
  async isDuplicate(storeId, product) {
    // 1. Exact URL match (check both source_url and product_url columns)
    const { rows } = await pool.query(
      'SELECT id FROM products WHERE site_id = $1 AND (source_url = $2 OR product_url = $2) LIMIT 1',
      [storeId, product.source_url]
    );

    if (rows.length > 0) return true;

    // 2. Fuzzy title match using pg_trgm similarity
    if (product.product_name) {
      const { rows: similarProducts } = await pool.query(
        'SELECT * FROM find_similar_products($1, $2, $3)',
        [storeId, product.product_name, SIMILARITY_THRESHOLD]
      );

      if (similarProducts?.length > 0) {
        logger.debug({
          name: product.product_name,
          similarTo: similarProducts[0].product_title,
          similarity: similarProducts[0].similarity,
        }, 'Found similar product');
        return true;
      }
    }

    return false;
  }
}

export const deduplicator = new Deduplicator();
