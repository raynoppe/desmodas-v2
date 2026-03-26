/**
 * One-time migration: Set all sites to source='scraper' and
 * convert 'approved' status to 'published'.
 *
 * Run with: node src/db/migrate-all-to-scraper.js
 */
import 'dotenv/config';
import pool from './postgres.js';

async function migrate() {
  console.log('Starting migration...\n');

  // 1. Check current state
  const { rows: before } = await pool.query(
    `SELECT source, status, COUNT(*)::int as count
     FROM sites GROUP BY source, status ORDER BY source, status`
  );
  console.log('Current state:');
  console.table(before);

  // 2. Update all sites to source='scraper'
  const { rowCount: sourceUpdated } = await pool.query(
    `UPDATE sites SET source = 'scraper', date_updated = NOW()
     WHERE source != 'scraper' OR source IS NULL`
  );
  console.log(`\nUpdated ${sourceUpdated} sites to source='scraper'`);

  // 3. Convert 'approved' status to 'published'
  const { rowCount: statusUpdated } = await pool.query(
    `UPDATE sites SET status = 'published', date_updated = NOW()
     WHERE status = 'approved'`
  );
  console.log(`Updated ${statusUpdated} sites from 'approved' to 'published'`);

  // 4. Verify
  const { rows: after } = await pool.query(
    `SELECT source, status, COUNT(*)::int as count
     FROM sites GROUP BY source, status ORDER BY source, status`
  );
  console.log('\nAfter migration:');
  console.table(after);

  await pool.end();
  console.log('\nDone!');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
