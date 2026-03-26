#!/usr/bin/env node

/**
 * Backfill product_gender for existing products using URL path heuristics
 * and product name/category analysis.
 *
 * Usage:
 *   node scripts/backfill-gender.js              # All scraper products
 *   node scripts/backfill-gender.js <store_id>   # Specific store
 *   node scripts/backfill-gender.js --dry-run     # Preview changes
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import pg from 'pg';
import Typesense from 'typesense';

dotenv.config({ path: resolve(process.cwd(), '.env'), override: true });

const COLLECTION = 'desmodas_products';
const dryRun = process.argv.includes('--dry-run');
const storeIdArg = process.argv.find(a => a !== '--dry-run' && a !== process.argv[0] && a !== process.argv[1]);

// Postgres
const cert = process.env.DB_CERT?.replace(/\\n/g, '\n');
const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '25060'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: cert ? { ca: cert } : undefined,
});

// Typesense
const tsClient = new Typesense.Client({
  nodes: [{
    host: process.env.TYPESENSE_HOST,
    port: parseInt(process.env.TYPESENSE_PORT || '443'),
    protocol: process.env.TYPESENSE_PROTOCOL || 'https',
  }],
  apiKey: process.env.TYPESENSE_API_KEY,
  connectionTimeoutSeconds: 30,
});

// Gender detection patterns (same as product-extractor.js)
const FEMALE_URL_PATTERNS = /\/(women|womens|ladies|female|girls)(\/|$|\?)/i;
const MALE_URL_PATTERNS = /\/(men|mens|male|boys|gentlemen)(\/|$|\?)/i;
const FEMALE_TEXT = /\b(women|woman|womens|women's|ladies|lady|female|her)\b/i;
const MALE_TEXT = /\b(men|mans|mens|men's|gentlemen|male|his)\b/i;

// Category-based gender hints (strongly gendered categories)
const FEMALE_CATEGORIES = ['dresses', 'skirts', 'lingerie', 'bras', 'swimwear-women', 'maternity'];
const MALE_CATEGORIES = ['suits-men', 'ties', 'cufflinks'];

function detectGender(product) {
  const url = product.source_url || product.product_url || '';
  const name = product.product_title || '';
  const category = product.category_slug || '';

  // 1. URL path (most reliable)
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (FEMALE_URL_PATTERNS.test(path)) return 'female';
    if (MALE_URL_PATTERNS.test(path)) return 'male';
  } catch {}

  // 2. Product name
  const femName = FEMALE_TEXT.test(name);
  const maleName = MALE_TEXT.test(name);
  if (femName && !maleName) return 'female';
  if (maleName && !femName) return 'male';

  // 3. Category slug
  if (FEMALE_CATEGORIES.includes(category)) return 'female';
  if (MALE_CATEGORIES.includes(category)) return 'male';

  return null;
}

async function main() {
  console.log(`Gender Backfill ${dryRun ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(40) + '\n');

  // Get products with null gender
  let query = `
    SELECT p.id, p.product_title, p.source_url, p.product_url, p.site_id,
           c.slug AS category_slug
    FROM products p
    LEFT JOIN categories c ON c.id = p.scraper_category_id
    WHERE p.product_gender IS NULL AND p.source = 'scraper'
  `;
  const values = [];
  if (storeIdArg) {
    query += ` AND p.site_id::text = $1`;
    values.push(storeIdArg);
  }

  const { rows: products } = await pool.query(query, values);
  console.log(`Found ${products.length} products with null gender\n`);

  let updated = 0;
  let female = 0;
  let male = 0;
  let unknown = 0;
  const tsUpdates = [];

  for (const product of products) {
    const gender = detectGender(product);

    if (gender) {
      if (gender === 'female') female++;
      else male++;

      if (!dryRun) {
        await pool.query(
          'UPDATE products SET product_gender = $1, date_updated = NOW() WHERE id = $2',
          [gender, product.id]
        );
        tsUpdates.push({ id: String(product.id), gender });
      }
      updated++;
    } else {
      unknown++;
    }
  }

  console.log(`Results:`);
  console.log(`  Female: ${female}`);
  console.log(`  Male:   ${male}`);
  console.log(`  Unknown (left null): ${unknown}`);
  console.log(`  Total updated: ${updated}`);

  // Update Typesense
  if (!dryRun && tsUpdates.length > 0) {
    console.log(`\nUpdating Typesense...`);
    let tsSuccess = 0;
    let tsFailed = 0;

    for (const update of tsUpdates) {
      try {
        await tsClient.collections(COLLECTION).documents(update.id).update({ gender: update.gender });
        tsSuccess++;
      } catch (err) {
        tsFailed++;
        if (tsFailed <= 3) {
          console.error(`  TS update failed for ${update.id}: ${err.message}`);
        }
      }
    }
    console.log(`  Typesense: ${tsSuccess} updated, ${tsFailed} failed`);
  }

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
