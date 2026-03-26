import pool from '../../db/postgres.js';
import { centsToDollars, dollarsToCents } from '../../db/column-maps.js';
import { logger } from '../../lib/logger.js';
import { priceTracker } from './price-tracker.js';
import { deduplicator } from './deduplicator.js';

const GRACE_PERIOD_DAYS = 7;

export class CatalogManager {
  /**
   * Process scraped products for a store: insert new, update existing,
   * mark missing as discontinued, and track price changes.
   */
  async processScrapingResults(storeId, scrapedProducts, jobId) {
    const stats = { found: 0, added: 0, updated: 0, removed: 0 };
    stats.found = scrapedProducts.length;

    // Get existing active products for this store
    const { rows: existingProducts } = await pool.query(
      `SELECT id, source_url, product_url, product_title AS product_name,
              product_price, product_currency AS currency,
              COALESCE(on_sale, false) AS on_sale, status
       FROM products
       WHERE site_id = $1 AND status IN ('active', 'discontinued', 'draft', 'new', 'updated')`,
      [storeId]
    );

    const existingByUrl = new Map();
    for (const product of existingProducts || []) {
      // Key by source_url if available, fall back to product_url
      const key = product.source_url || product.product_url;
      if (key) {
        existingByUrl.set(key, {
          ...product,
          price: dollarsToCents(product.product_price),
        });
      }
    }

    const seenUrls = new Set();

    // Process each scraped product
    for (const scraped of scrapedProducts) {
      if (!scraped.source_url || !scraped.product_name) continue;

      seenUrls.add(scraped.source_url);
      const existing = existingByUrl.get(scraped.source_url);

      if (existing) {
        // Update existing product
        const changed = await this._updateProduct(existing, scraped);
        if (changed) stats.updated++;
      } else {
        // Check for duplicates before inserting
        const isDuplicate = await deduplicator.isDuplicate(storeId, scraped);
        if (isDuplicate) {
          logger.debug({ name: scraped.product_name }, 'Skipping duplicate product');
          continue;
        }

        // Insert new product
        const inserted = await this._insertProduct(storeId, scraped);
        if (inserted) stats.added++;
      }
    }

    // Mark missing products as discontinued
    const missingProducts = (existingProducts || []).filter(
      p => (p.status === 'active' || p.status === 'draft' || p.status === 'new' || p.status === 'updated')
        && !seenUrls.has(p.source_url || p.product_url)
    );

    for (const missing of missingProducts) {
      await this._markDiscontinued(missing.id);
    }

    // Clean up products past grace period
    stats.removed = await this._cleanupDiscontinued(storeId);

    // Update job stats
    if (jobId) {
      await pool.query(
        `UPDATE scraping_sessions SET
          products_discovered = $1, products_new = $2,
          products_updated = $3, products_discontinued = $4
         WHERE id = $5`,
        [stats.found, stats.added, stats.updated, stats.removed, jobId]
      );
    }

    logger.info({ storeId, ...stats }, 'Processed scraping results');
    return stats;
  }

  async _insertProduct(storeId, scraped) {
    const productId = crypto.randomUUID();
    try {
      const { rows } = await pool.query(
        `INSERT INTO products (
          id, site_id, product_title, product_description, colour_base, product_colour,
          product_variations, composition, dimensions, product_gender, age_group,
          product_price, product_currency, on_sale,
          product_image, product_thumbnail, product_images,
          product_url, source_url, scraper_category_id, search_engine,
          status, source, date_created, date_updated
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
        RETURNING id`,
        [
          productId, storeId, scraped.product_name, scraped.product_description,
          scraped.colour_base, scraped.product_colour,
          JSON.stringify(scraped.sizes_available || []),
          scraped.composition,
          scraped.dimensions ? JSON.stringify(scraped.dimensions) : null,
          scraped.gender || null, scraped.age_group || null,
          centsToDollars(scraped.price || 0), scraped.currency || 'GBP',
          scraped.on_sale || false,
          scraped.primary_image_url, scraped.thumbnail_url,
          JSON.stringify(scraped.additional_images || []),
          scraped.source_url, scraped.source_url,
          scraped.category_id || null, scraped.search_engine || null,
          'draft', 'scraper',
          new Date().toISOString(), new Date().toISOString(),
        ]
      );

      const data = rows[0];

      // Record initial price
      await priceTracker.recordPrice(data.id, scraped.price || 0, scraped.currency || 'GBP', false);

      logger.debug({ id: data.id, name: scraped.product_name }, 'Inserted new product');
      return data;
    } catch (error) {
      // Handle unique constraint violation gracefully
      if (error.code === '23505') {
        logger.debug({ sourceUrl: scraped.source_url }, 'Product already exists (concurrent insert)');
        return null;
      }
      logger.error({ error: error.message, name: scraped.product_name }, 'Failed to insert product');
      return null;
    }
  }

  async _updateProduct(existing, scraped) {
    const updates = {};
    let changed = false;

    // Column mapping: scraper field → DO column
    const fieldMap = {
      product_name: 'product_title',
      product_description: 'product_description',
      colour_base: 'colour_base',
      product_colour: 'product_colour',
      composition: 'composition',
      primary_image_url: 'product_image',
      thumbnail_url: 'product_thumbnail',
      category_id: 'scraper_category_id',
      gender: 'product_gender',
      age_group: 'age_group',
    };

    for (const [scraperKey, doColumn] of Object.entries(fieldMap)) {
      if (scraped[scraperKey] != null && scraped[scraperKey] !== existing[scraperKey]) {
        updates[doColumn] = scraped[scraperKey];
        changed = true;
      }
    }

    // JSON fields
    if (scraped.sizes_available && JSON.stringify(scraped.sizes_available) !== JSON.stringify(existing.sizes_available)) {
      updates.product_variations = JSON.stringify(scraped.sizes_available);
      changed = true;
    }
    if (scraped.additional_images && JSON.stringify(scraped.additional_images) !== JSON.stringify(existing.additional_images)) {
      updates.product_images = JSON.stringify(scraped.additional_images);
      changed = true;
    }

    // Check price change (scraped.price is in cents, existing.price was converted to cents)
    const priceChanged = await priceTracker.detectChange(
      existing.id, scraped.price, scraped.currency || 'GBP'
    );
    if (priceChanged) {
      updates.product_price = centsToDollars(scraped.price);
      updates.product_currency = scraped.currency || 'GBP';
      updates.on_sale = scraped.price < existing.price;
      changed = true;
    }

    // If product was discontinued, reactivate it
    if (existing.status === 'discontinued') {
      updates.status = 'active';
      changed = true;
    }

    if (changed) {
      const setClauses = [];
      const values = [];
      let idx = 1;

      for (const [col, val] of Object.entries(updates)) {
        setClauses.push(`${col} = $${idx++}`);
        values.push(val);
      }
      setClauses.push(`date_updated = $${idx++}`);
      values.push(new Date().toISOString());
      values.push(existing.id);

      try {
        await pool.query(
          `UPDATE products SET ${setClauses.join(', ')} WHERE id = $${idx}`,
          values
        );
      } catch (error) {
        logger.error({ error: error.message, id: existing.id }, 'Failed to update product');
        return false;
      }
    }

    return changed;
  }

  async _markDiscontinued(productId) {
    await pool.query(
      `UPDATE products SET status = 'discontinued', date_updated = $1
       WHERE id = $2 AND status IN ('active', 'draft', 'new', 'updated')`,
      [new Date().toISOString(), productId]
    );
  }

  async _cleanupDiscontinued(storeId) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - GRACE_PERIOD_DAYS);

    const { rows } = await pool.query(
      `UPDATE products SET status = 'removed', date_updated = $1
       WHERE site_id = $2 AND status = 'discontinued' AND date_updated < $3
       RETURNING id`,
      [new Date().toISOString(), storeId, cutoff.toISOString()]
    );

    return rows?.length || 0;
  }
}

export const catalogManager = new CatalogManager();
