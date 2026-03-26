import { Router } from 'express';
import pool from '../db/postgres.js';
import { ValidationError } from '../lib/errors.js';

const router = Router();

// List categories (tree)
router.get('/', async (req, res, next) => {
  try {
    const { search_engine } = req.query;

    let query = 'SELECT * FROM categories WHERE is_active = true';
    const values = [];

    if (search_engine) {
      query += ' AND search_engine = $1';
      values.push(search_engine);
    }

    query += ' ORDER BY category_name';

    const { rows } = await pool.query(query, values);

    // Map to scraper field names and build tree structure
    const mapped = (rows || []).map(cat => ({
      ...cat,
      name: cat.category_name,
    }));

    const tree = buildTree(mapped);
    res.json(tree);
  } catch (error) { next(error); }
});

// Create category
router.post('/', async (req, res, next) => {
  try {
    const { name, slug, search_engine = 'fashion', parent_category_id, description } = req.body;
    if (!name || !slug) throw new ValidationError('name and slug are required');

    const area = search_engine === 'fashion' ? 'Fashion'
      : search_engine === 'interior_design' ? 'Interior'
      : 'Lifestyle';

    const { rows } = await pool.query(
      `INSERT INTO categories (category_name, slug, search_engine, parent_category_id, description, area, indent, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, 0, true)
       RETURNING *`,
      [name, slug, search_engine, parent_category_id || null, description || null, area]
    );

    if (!rows[0]) throw new Error('Failed to create category');
    res.status(201).json({ ...rows[0], name: rows[0].category_name });
  } catch (error) {
    if (error.code === '23505') {
      return next(new ValidationError('Category slug already exists'));
    }
    next(error);
  }
});

// Update category
router.patch('/:id', async (req, res, next) => {
  try {
    const fieldMap = {
      name: 'category_name',
      slug: 'slug',
      search_engine: 'search_engine',
      parent_category_id: 'parent_category_id',
      description: 'description',
      is_active: 'is_active',
    };

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [scraperKey, doColumn] of Object.entries(fieldMap)) {
      if (req.body[scraperKey] !== undefined) {
        setClauses.push(`${doColumn} = $${idx++}`);
        values.push(req.body[scraperKey]);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE categories SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (!rows[0]) return res.status(404).json({ error: 'Category not found' });
    res.json({ ...rows[0], name: rows[0].category_name });
  } catch (error) { next(error); }
});

function buildTree(categories) {
  const map = new Map();
  const roots = [];

  for (const cat of categories) {
    map.set(cat.id, { ...cat, children: [] });
  }

  for (const cat of categories) {
    const node = map.get(cat.id);
    if (cat.parent_category_id && map.has(cat.parent_category_id)) {
      map.get(cat.parent_category_id).children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export default router;
