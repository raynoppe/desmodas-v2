/**
 * Centralized column name + value mappings between the scraper's internal
 * naming conventions and the existing DigitalOcean Postgres schema.
 */

// Status mapping: scraper internal → DO Postgres
export const STORE_STATUS_MAP = {
  new: 'draft',
  active: 'published',
  closed: 'Archived',
  review: 'draft',
};

// Reverse status mapping: DO Postgres → scraper internal
export const STORE_STATUS_REVERSE = {
  draft: 'new',
  published: 'active',
  approved: 'active',
  Archived: 'closed',
  Errors: 'closed',
  new: 'new',
};

/**
 * Convert price from integer cents to decimal string.
 * e.g. 1999 → '19.99'
 */
export function centsToDollars(cents) {
  if (cents == null) return '0.00';
  return (Number(cents) / 100).toFixed(2);
}

/**
 * Convert price from decimal (number or string) to integer cents.
 * e.g. '19.99' → 1999, 19.99 → 1999
 */
export function dollarsToCents(dollars) {
  if (dollars == null) return 0;
  return Math.round(parseFloat(dollars) * 100);
}

/**
 * Convert integer days to Postgres interval string.
 * e.g. 7 → '7 days'
 */
export function daysToInterval(days) {
  return `${days} days`;
}

/**
 * Convert Postgres interval to integer days.
 * Handles: '7 days', { days: 7 }, 7 (passthrough)
 */
export function intervalToDays(interval) {
  if (typeof interval === 'number') return interval;
  if (typeof interval === 'string') {
    const match = interval.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 7;
  }
  // pg interval object: { days: 7, hours: 0, ... }
  if (interval && typeof interval === 'object' && interval.days != null) {
    return interval.days;
  }
  return 7;
}

/**
 * Map a row from the `sites` table to the scraper's internal store format.
 * This lets downstream scraper code use its own field names (store_name, url, etc.)
 * while the DB uses site_name, site_url, etc.
 */
export function mapSiteToStore(row) {
  if (!row) return null;
  return {
    ...row,
    // Map DO column names to scraper internal names
    store_name: row.site_name,
    description: row.site_description,
    url: row.site_url,
    country_of_origin: row.origin_country,
    scrape_frequency: intervalToDays(row.scrape_frequency),
    status: STORE_STATUS_REVERSE[row.status] || row.status,
    date_added: row.date_created,
    date_modified: row.date_updated,
  };
}

/**
 * Map a row from the `products` table to the scraper's internal product format.
 */
export function mapProductRow(row) {
  if (!row) return null;
  return {
    ...row,
    product_name: row.product_title,
    price: dollarsToCents(row.product_price),
    currency: row.product_currency,
    primary_image_url: row.product_image,
    thumbnail_url: row.product_thumbnail,
    additional_images: row.product_images,
    sizes_available: row.product_variations,
    source_url: row.source_url || row.product_url,
    store_id: row.site_id,
    gender: row.product_gender,
    category_id: row.scraper_category_id,
  };
}
