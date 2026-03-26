import { claudeClient } from './claude-client.js';
import { trainingDataset } from './training-dataset.js';
import pool from '../../db/postgres.js';
import { logger } from '../../lib/logger.js';

const CATEGORIZATION_PROMPT = `You are a product categorizer for a multi-vertical search engine covering fashion, interior design, and lifestyle products.

Given a product name, description, and store context, assign it to the most appropriate category and determine the target gender.

You must respond with ONLY a JSON object in this exact format:
{
  "category_slug": "the-category-slug",
  "search_engine": "fashion|interior_design|lifestyle",
  "gender": "female|male|null",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}

Gender rules:
- "female" for women's/ladies' products
- "male" for men's/gentlemen's products
- null for unisex, gender-neutral, or non-gendered products (e.g. homeware, gifts, stationery)
- Look at product name, description, sizing cues, and store context for gender signals

Available search engines:
- fashion: clothing, shoes, accessories, jewelry, bags, watches
- interior_design: furniture, lighting, decor, textiles, kitchenware, home accessories
- lifestyle: beauty, wellness, food, stationery, tech accessories, gifts

For the category_slug, use lowercase with hyphens. Examples:
Fashion: dresses, tops, trousers, jeans, skirts, coats, knitwear, shoes, boots, sandals, bags, jewelry, watches, accessories, swimwear, activewear, lingerie
Interior Design: sofas, chairs, tables, beds, storage, lighting, rugs, curtains, cushions, vases, candles, mirrors, wall-art, tableware, kitchenware
Lifestyle: skincare, makeup, fragrance, haircare, wellness, stationery, tech-accessories, gifts`;

export async function categorizeProduct(productName, productDescription, storeContext = '') {
  const content = [
    `Product name: ${productName}`,
    productDescription ? `Description: ${productDescription}` : '',
    storeContext ? `Store context: ${storeContext}` : '',
  ].filter(Boolean).join('\n');

  try {
    const result = await claudeClient.analyzeJson(content, CATEGORIZATION_PROMPT);

    // Save to training dataset
    await trainingDataset.save('categorization', { productName, productDescription, storeContext }, result);

    // Find or create the category
    const categoryId = await findOrCreateCategory(result.category_slug, result.search_engine);

    return {
      category_id: categoryId,
      category_slug: result.category_slug,
      search_engine: result.search_engine,
      confidence: result.confidence,
      gender: result.gender || null,
    };
  } catch (error) {
    logger.error({ error: error.message, productName }, 'Failed to categorize product');
    return null;
  }
}

async function findOrCreateCategory(slug, searchEngine) {
  // Try to find existing category by slug
  const { rows: [existing] } = await pool.query(
    'SELECT id FROM categories WHERE slug = $1',
    [slug]
  );

  if (existing) return existing.id;

  // Create new category (integer ID auto-incremented)
  const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const area = searchEngine === 'fashion' ? 'Fashion'
    : searchEngine === 'interior_design' ? 'Interior'
    : 'Lifestyle';

  try {
    const { rows: [created] } = await pool.query(
      `INSERT INTO categories (category_name, slug, search_engine, indent, area, is_active)
       VALUES ($1, $2, $3, 0, $4, true)
       ON CONFLICT (slug) DO UPDATE SET category_name = $1
       RETURNING id`,
      [name, slug, searchEngine, area]
    );

    logger.info({ slug, searchEngine, id: created.id }, 'Created new category');
    return created.id;
  } catch (error) {
    logger.error({ error: error.message, slug }, 'Failed to create category');
    return null;
  }
}
