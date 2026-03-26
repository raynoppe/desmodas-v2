import { Router } from 'express';
import pool from '../db/postgres.js';
import { dollarsToCents } from '../db/column-maps.js';
import { priceTracker } from '../services/catalog/price-tracker.js';

const router = Router();

// List products
router.get('/', async (req, res, next) => {
  try {
    const { store_id, status = 'active', category_id, limit = 50, offset = 0 } = req.query;

    const conditions = [];
    const values = [];
    let idx = 1;

    if (store_id) { conditions.push(`p.site_id = $${idx++}`); values.push(store_id); }
    if (status) { conditions.push(`p.status = $${idx++}`); values.push(status); }
    if (category_id) { conditions.push(`p.scraper_category_id = $${idx++}`); values.push(category_id); }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM products p ${whereClause}`,
      values
    );

    // Data with category join
    values.push(Number(limit), Number(offset));
    const { rows: data } = await pool.query(
      `SELECT p.*,
        p.product_title AS product_name,
        p.product_price AS price,
        p.product_currency AS currency,
        p.product_image AS primary_image_url,
        p.product_thumbnail AS thumbnail_url,
        p.site_id AS store_id,
        c.category_name AS category_name,
        c.slug AS category_slug,
        c.search_engine AS category_search_engine
       FROM products p
       LEFT JOIN categories c ON c.id = p.scraper_category_id
       ${whereClause}
       ORDER BY p.date_updated DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      values
    );

    res.json({ data, total: parseInt(count) });
  } catch (error) { next(error); }
});

// Get product by ID with price history
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
        p.product_title AS product_name,
        p.product_price AS price,
        p.product_currency AS currency,
        p.product_image AS primary_image_url,
        p.product_thumbnail AS thumbnail_url,
        p.site_id AS store_id,
        c.category_name AS category_name,
        c.slug AS category_slug,
        c.search_engine AS category_search_engine,
        s.site_name AS store_name,
        s.site_url AS store_url
       FROM products p
       LEFT JOIN categories c ON c.id = p.scraper_category_id
       LEFT JOIN sites s ON s.id = p.site_id
       WHERE p.id = $1`,
      [req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });

    const priceHistory = await priceTracker.getHistory(req.params.id);
    res.json({ ...rows[0], price_history: priceHistory });
  } catch (error) { next(error); }
});

// Update product (admin fields)
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['is_highlight', 'is_promoted', 'promotion_start', 'promotion_end', 'category_id'];
    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const doColumn = key === 'category_id' ? 'scraper_category_id' : key;
        setClauses.push(`${doColumn} = $${idx++}`);
        values.push(req.body[key]);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push(`date_updated = $${idx++}`);
    values.push(new Date().toISOString());
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE products SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (error) { next(error); }
});

export default router;
