import pool from '../../db/postgres.js';
import { centsToDollars, dollarsToCents } from '../../db/column-maps.js';
import { logger } from '../../lib/logger.js';

export class PriceTracker {
  /**
   * Detect if a product's price has changed.
   * Returns true if there's a change, false otherwise.
   */
  async detectChange(productId, newPriceCents, newCurrency) {
    const { rows: [product] } = await pool.query(
      'SELECT product_price, product_currency FROM products WHERE id = $1',
      [productId]
    );

    if (!product) return false;

    const currentPriceCents = dollarsToCents(product.product_price);
    const changed = currentPriceCents !== newPriceCents || product.product_currency !== newCurrency;

    if (changed) {
      await this.recordPrice(productId, newPriceCents, newCurrency, newPriceCents < currentPriceCents);
      logger.info({
        productId,
        oldPrice: currentPriceCents,
        newPrice: newPriceCents,
        currency: newCurrency,
      }, 'Price change detected');
    }

    return changed;
  }

  /**
   * Record a price entry in the history tables.
   */
  async recordPrice(productId, priceCents, currency, onSale = false) {
    const priceDecimal = centsToDollars(priceCents);

    try {
      // Get current price and metadata for the richer product_price_history table
      const { rows: [current] } = await pool.query(
        'SELECT product_price, site_id, product_url FROM products WHERE id = $1',
        [productId]
      );

      const oldPrice = current?.product_price ? parseFloat(current.product_price) : null;
      const newPrice = parseFloat(priceDecimal);
      const priceChange = oldPrice != null ? (newPrice - oldPrice).toFixed(2) : null;
      const changePercentage = oldPrice && oldPrice > 0
        ? ((parseFloat(priceChange) / oldPrice) * 100).toFixed(2)
        : null;

      // Insert into rich product_price_history
      await pool.query(
        `INSERT INTO product_price_history
          (product_id, site_id, product_url, product_title, old_price, new_price,
           price_change, change_percentage, currency, price_source)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, 'scraping')`,
        [
          productId, current?.site_id, current?.product_url,
          oldPrice, newPrice, priceChange, changePercentage, currency,
        ]
      );

      // Also insert into simple product_prices for backward compatibility
      await pool.query(
        'INSERT INTO product_prices (id, product_id, new_price) VALUES (gen_random_uuid(), $1, $2)',
        [productId, newPrice]
      );
    } catch (error) {
      logger.warn({ error: error.message, productId }, 'Failed to record price history');
    }
  }

  /**
   * Get price history for a product.
   */
  async getHistory(productId, limit = 50) {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM product_price_history WHERE product_id = $1 ORDER BY recorded_at DESC LIMIT $2',
        [productId, limit]
      );
      return rows;
    } catch (error) {
      logger.error({ error: error.message, productId }, 'Failed to get price history');
      return [];
    }
  }
}

export const priceTracker = new PriceTracker();
