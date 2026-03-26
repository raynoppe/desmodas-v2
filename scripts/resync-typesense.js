#!/usr/bin/env node

/**
 * Re-sync published store products from Postgres → Typesense.
 *
 * Usage:
 *   node scripts/resync-typesense.js              # Sync all published stores
 *   node scripts/resync-typesense.js <store_id>   # Sync a specific store
 *
 * Run from the scraper directory: cd /path/to/scraper && node scripts/resync-typesense.js
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import pg from 'pg';
import Typesense from 'typesense';
import fs from 'fs';

dotenv.config({ path: resolve(process.cwd(), '.env'), override: true });

const COLLECTION = 'desmodas_products';

// Postgres connection
const cert = process.env.DB_CERT?.replace(/\\n/g, '\n');
const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '25060'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: cert ? { ca: cert } : undefined,
});

// Typesense client
const tsClient = new Typesense.Client({
  nodes: [{
    host: process.env.TYPESENSE_HOST,
    port: parseInt(process.env.TYPESENSE_PORT || '443'),
    protocol: process.env.TYPESENSE_PROTOCOL || 'https',
  }],
  apiKey: process.env.TYPESENSE_API_KEY,
  connectionTimeoutSeconds: 30,
});

function mapProductToDoc(product, store) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: String(product.id),
    product_name: product.product_title || '',
    product_description: product.product_description || '',
    product_colour: product.product_colour || '',
    colour_base: product.colour_base || '',
    gender: product.product_gender || '',
    age_group: '',
    price: Math.round(parseFloat(product.product_price || 0) * 100),
    currency: product.product_currency || 'GBP',
    on_sale: product.on_sale || false,
    sizes_available: product.product_variations || [],
    composition: product.composition || '',
    category_name: product.category_name || '',
    category_slug: product.category_slug || '',
    store_id: store.id,
    store_name: store.site_name || '',
    primary_image_url: product.product_image || '',
    thumbnail_url: product.product_thumbnail || product.product_image || '',
    source_url: product.source_url || product.product_url || '',
    status: product.status || 'draft',
    country_of_origin: store.origin_country || '',
    date_added: product.date_created
      ? Math.floor(new Date(product.date_created).getTime() / 1000)
      : now,
    date_modified: product.date_updated
      ? Math.floor(new Date(product.date_updated).getTime() / 1000)
      : now,
  };
}

async function syncStore(store) {
  const { rows: products } = await pool.query(
    `SELECT p.*, c.category_name, c.slug AS category_slug
     FROM products p
     LEFT JOIN categories c ON c.id = p.scraper_category_id
     WHERE p.site_id = $1 AND p.status NOT IN ('removed', 'Archived')`,
    [store.id]
  );

  if (!products.length) {
    console.log(`  ${store.site_name}: 0 products in DB, skipping`);
    return { store: store.site_name, indexed: 0, failed: 0 };
  }

  // Check how many are already in Typesense
  let existingCount = 0;
  try {
    const existing = await tsClient.collections(COLLECTION).documents().search({
      q: '*', query_by: 'product_name', filter_by: `store_id:${store.id}`, per_page: 0,
    });
    existingCount = existing.found || 0;
  } catch { /* collection might not exist */ }

  console.log(`  ${store.site_name}: ${products.length} in DB, ${existingCount} in Typesense`);

  if (existingCount === products.length) {
    console.log(`  Already in sync, skipping`);
    return { store: store.site_name, indexed: 0, failed: 0, skipped: true };
  }

  // Batch upsert using JSONL import for performance
  const docs = products.map(p => mapProductToDoc(p, store));
  const jsonlLines = docs.map(d => JSON.stringify(d)).join('\n');

  let indexed = 0;
  let failed = 0;

  try {
    const results = await tsClient
      .collections(COLLECTION)
      .documents()
      .import(jsonlLines, { action: 'upsert' });

    // Results is a string of JSONL responses
    const lines = typeof results === 'string' ? results.split('\n') : results;
    for (const line of lines) {
      const result = typeof line === 'string' ? JSON.parse(line) : line;
      if (result.success) {
        indexed++;
      } else {
        failed++;
        if (failed <= 3) {
          console.log(`    Failed: ${result.error} (doc: ${result.document?.slice(0, 80)}...)`);
        }
      }
    }
  } catch (error) {
    console.error(`  Batch import error: ${error.message}`);
    // Fall back to individual upserts
    for (const doc of docs) {
      try {
        await tsClient.collections(COLLECTION).documents().upsert(doc);
        indexed++;
      } catch (err) {
        failed++;
        if (failed <= 3) {
          console.error(`    Failed ${doc.id}: ${err.message}`);
        }
      }
    }
  }

  console.log(`  Indexed: ${indexed}, Failed: ${failed}`);
  return { store: store.site_name, indexed, failed };
}

async function main() {
  const storeIdArg = process.argv[2];

  console.log('Typesense Re-sync');
  console.log('=================\n');

  // Verify Typesense collection exists
  try {
    const info = await tsClient.collections(COLLECTION).retrieve();
    console.log(`Collection: ${COLLECTION} (${info.num_documents} docs)\n`);
  } catch (error) {
    console.error(`Collection "${COLLECTION}" not found. Create it first.`);
    process.exit(1);
  }

  // Get stores to sync
  let storeQuery = `SELECT id, site_name, origin_country FROM sites WHERE status = 'published'`;
  const values = [];
  if (storeIdArg) {
    storeQuery += ` AND (id::text = $1 OR site_handle = $1)`;
    values.push(storeIdArg);
  }
  storeQuery += ` ORDER BY site_name`;

  const { rows: stores } = await pool.query(storeQuery, values);

  if (!stores.length) {
    console.log('No published stores found.');
    process.exit(0);
  }

  console.log(`Syncing ${stores.length} store(s)...\n`);

  const results = [];
  for (const store of stores) {
    const result = await syncStore(store);
    results.push(result);
  }

  // Summary
  console.log('\n--- Summary ---');
  const totalIndexed = results.reduce((sum, r) => sum + r.indexed, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  console.log(`Stores: ${stores.length}`);
  console.log(`Indexed: ${totalIndexed}`);
  console.log(`Failed: ${totalFailed}`);

  // Final count
  const info = await tsClient.collections(COLLECTION).retrieve();
  console.log(`Total in Typesense: ${info.num_documents}`);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
