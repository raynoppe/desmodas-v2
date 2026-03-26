import pool from '../db/postgres.js';
import { mapSiteToStore, centsToDollars, intervalToDays } from '../db/column-maps.js';
import { logger } from '../lib/logger.js';
import { delay } from '../lib/utils.js';
import config from '../config/index.js';

// Scraping
import { scrapingEngine } from './scraping/engine.js';
import { detectPlatform } from '../config/platforms.js';
import { extractProductData } from './scraping/product-extractor.js';
import { extractStoreMetadata } from './scraping/store-extractor.js';
import { extractStoreLocations } from './scraping/location-extractor.js';
import { extractProductUrls } from './scraping/page-navigator.js';
import { autoScroll, clickLoadMore } from './scraping/scroll-handler.js';

// AI
import { categorizeProduct } from './ai/categorizer.js';
import { mapColourToBase } from './ai/colour-mapper.js';
import { analyzeEthics } from './ai/ethical-analyzer.js';
import { detectCountryAndCurrency } from './ai/country-detector.js';

// Images
import { imageProcessor } from './images/processor.js';
import { imageUploader } from './images/s3-uploader.js';

// Catalog
import { catalogManager } from './catalog/manager.js';

// Search
import { typesenseIndexer } from './search/indexer.js';

// Monitoring
import { siteHealthChecker } from './monitoring/health-checker.js';

/**
 * Full end-to-end scrape pipeline for a single store.
 */
export async function runStorePipeline(storeId, bullmqJobId, options = {}) {
  const { productLimit, signal, sessionId: existingSessionId } = options;

  function checkAborted() {
    if (signal?.aborted) {
      throw new Error('Scrape aborted');
    }
  }

  // 1. Create or reuse a scraping_sessions record (atomic — prevents duplicates)
  let jobId;
  if (existingSessionId) {
    // Reuse the 'queued' session created when the job was triggered
    await pool.query(
      `UPDATE scraping_sessions SET status = 'running', started_at = NOW()
       WHERE id = $1`,
      [existingSessionId]
    );
    jobId = existingSessionId;
  } else {
    // Atomically insert only if no running/queued session exists for this store
    const { rows } = await pool.query(
      `INSERT INTO scraping_sessions (site_id, status, session_type, started_at)
       SELECT $1, 'running', 'scheduled', $2
       WHERE NOT EXISTS (
         SELECT 1 FROM scraping_sessions
         WHERE site_id = $1 AND status IN ('running', 'queued')
       )
       RETURNING id`,
      [storeId, new Date().toISOString()]
    );
    if (!rows[0]) {
      logger.warn({ storeId }, 'Skipping — store already has an active scrape');
      return { skipped: true, reason: 'duplicate' };
    }
    jobId = rows[0].id;
  }

  const errors = [];

  // Helper to update session progress in DB
  async function updateProgress(updates) {
    if (!jobId) return;
    const setClauses = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
      if (key === 'session_summary') {
        setClauses.push(`${key} = $${idx++}`);
        values.push(JSON.stringify(val));
      } else {
        setClauses.push(`${key} = $${idx++}`);
        values.push(val);
      }
    }
    if (setClauses.length === 0) return;
    values.push(jobId);
    await pool.query(
      `UPDATE scraping_sessions SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      values
    ).catch(err => logger.warn({ error: err.message }, 'Failed to update progress'));
  }

  try {
    // 2. Get store details
    await updateProgress({ session_summary: { stage: 'loading_store' } });
    const { rows: storeRows } = await pool.query(
      'SELECT * FROM sites WHERE id = $1',
      [storeId]
    );
    const store = mapSiteToStore(storeRows[0]);

    if (!store) {
      throw new Error(`Store not found: ${storeId}`);
    }

    // Only scrape sites that are published
    if (storeRows[0].status !== 'published') {
      logger.warn({ storeId, storeName: store.store_name, status: storeRows[0].status }, 'Skipping scrape — site is not published');
      errors.push({ type: 'status', message: `Site status is '${storeRows[0].status}', must be 'published' to scrape` });
      await completePipeline(jobId, storeId, errors, 'failed');
      return { success: false, errors };
    }

    logger.info({ storeId, storeName: store.store_name, url: store.url }, 'Starting pipeline');

    // 3. Health check
    await updateProgress({ session_summary: { stage: 'health_check', store_name: store.store_name } });
    const health = await siteHealthChecker.checkSite(store.url);
    if (!health.online) {
      errors.push({ type: 'health_check', message: `Site offline: ${health.error || health.statusCode}` });
      await completePipeline(jobId, storeId, errors, 'failed');
      return { success: false, errors };
    }

    // 4. Store metadata (first scrape or periodic refresh)
    const isFirstScrape = !store.country_of_origin || !store.site_currency;
    if (isFirstScrape) {
      await updateProgress({ session_summary: { stage: 'metadata_extraction', store_name: store.store_name } });
      await scrapeStoreMetadata(store, errors);
    }

    checkAborted();

    // 5. Discover product URLs
    await updateProgress({ session_summary: { stage: 'discovering_products', store_name: store.store_name } });
    const productUrls = await discoverProducts(store, errors);
    if (productUrls.length === 0) {
      errors.push({ type: 'discovery', message: 'No product URLs found' });
      await completePipeline(jobId, storeId, errors, 'failed');
      return { success: false, errors };
    }

    // Apply product limit if set (for test scrapes)
    const urlsToScrape = productLimit ? productUrls.slice(0, productLimit) : productUrls;

    logger.info({
      discovered: productUrls.length,
      scraping: urlsToScrape.length,
      storeId,
      ...(productLimit ? { productLimit } : {}),
    }, productLimit ? `Discovered ${productUrls.length} product URLs, limiting to ${urlsToScrape.length}` : 'Discovered product URLs');

    // Update discovered count
    await updateProgress({
      products_discovered: productUrls.length,
      session_summary: { stage: 'extracting_products', store_name: store.store_name, total_to_scrape: urlsToScrape.length },
    });

    checkAborted();

    // 6. Extract, process, and enrich each product
    const processedProducts = [];
    let failedCount = 0;
    for (let i = 0; i < urlsToScrape.length; i++) {
      checkAborted();
      try {
        const product = await scrapeAndEnrichProduct(urlsToScrape[i], store);
        if (product) {
          processedProducts.push(product);
          logger.debug({ url: urlsToScrape[i], name: product.product_name, index: i }, 'Product extracted');
        } else {
          failedCount++;
          logger.warn({ url: urlsToScrape[i], index: i }, 'Product extraction returned null');
        }
      } catch (error) {
        failedCount++;
        logger.error({ url: urlsToScrape[i], index: i, error: error.message }, 'Product extraction threw error');
        errors.push({ type: 'product', url: urlsToScrape[i], message: error.message });
      }

      // Update progress every 5 products or on last one
      if ((i + 1) % 5 === 0 || i === urlsToScrape.length - 1) {
        await updateProgress({
          products_discovered: productUrls.length,
          products_failed: failedCount,
          session_summary: {
            stage: 'extracting_products',
            store_name: store.store_name,
            progress: i + 1,
            total_to_scrape: urlsToScrape.length,
            extracted: processedProducts.length,
          },
        });
      }

      // Rate limiting
      if (i < urlsToScrape.length - 1) {
        await delay(config.REQUEST_DELAY_MS);
      }
    }

    logger.info({ processed: processedProducts.length, total: urlsToScrape.length, discovered: productUrls.length }, 'Product extraction complete');

    // 7. Catalog management (insert/update/discontinue)
    await updateProgress({ session_summary: { stage: 'catalog_update', store_name: store.store_name } });
    const stats = await catalogManager.processScrapingResults(storeId, processedProducts, jobId);

    // Update with catalog stats
    await updateProgress({
      products_new: stats?.inserted || 0,
      products_updated: stats?.updated || 0,
      products_discontinued: stats?.discontinued || 0,
      products_failed: failedCount,
    });

    // 8. Sync to Typesense
    await updateProgress({ session_summary: { stage: 'typesense_sync', store_name: store.store_name } });
    await syncToTypesense(storeId, store);

    // 9. Complete
    await completePipeline(jobId, storeId, errors, 'completed', {
      products_discovered: productUrls.length,
      products_new: stats?.inserted || 0,
      products_updated: stats?.updated || 0,
      products_discontinued: stats?.discontinued || 0,
      products_failed: failedCount,
    });

    logger.info({ storeId, stats, errorCount: errors.length }, 'Pipeline completed');
    return { success: true, stats, errors };

  } catch (error) {
    const wasAborted = signal?.aborted || error.message === 'Scrape aborted';
    if (wasAborted) {
      logger.warn({ storeId }, 'Pipeline aborted');
      errors.push({ type: 'abort', message: 'Scrape was stopped by admin' });
      await completePipeline(jobId, storeId, errors, 'failed');
      return { success: false, aborted: true, errors };
    }
    logger.error({ storeId, error: error.message }, 'Pipeline failed');
    errors.push({ type: 'pipeline', message: error.message });
    await completePipeline(jobId, storeId, errors, 'failed');
    return { success: false, errors };
  }
}

async function scrapeStoreMetadata(store, errors) {
  try {
    logger.info({ storeId: store.id }, 'Extracting store metadata');

    const metadata = await extractStoreMetadata(store.url);
    const countryData = await detectCountryAndCurrency(store.url, metadata);
    const ethicsData = await analyzeEthics(metadata.aboutContent, metadata.description, store.url);

    // Build dynamic UPDATE for sites table
    const setClauses = [];
    const values = [];
    let idx = 1;

    if (metadata.description) { setClauses.push(`site_description = $${idx++}`); values.push(metadata.description); }
    if (metadata.email) { setClauses.push(`email = $${idx++}`); values.push(metadata.email); }
    if (metadata.tel) { setClauses.push(`tel = $${idx++}`); values.push(metadata.tel); }
    if (countryData.country_of_origin) {
      // origin_country has FK to 'list' table with ISO 3166-1 alpha-2 codes
      // The AI detector may return a full country name, so look up the code
      let countryCode = countryData.country_of_origin;
      if (countryCode.length > 2) {
        const { rows: countryRows } = await pool.query(
          `SELECT id FROM list WHERE type = 'country' AND LOWER(value) = LOWER($1) LIMIT 1`,
          [countryCode]
        );
        countryCode = countryRows[0]?.id || null;
      }
      if (countryCode) {
        setClauses.push(`origin_country = $${idx++}`);
        values.push(countryCode);
      }
    }
    if (countryData.ships_to_countries?.length) { setClauses.push(`ships_to_countries = $${idx++}`); values.push(JSON.stringify(countryData.ships_to_countries)); }
    if (countryData.site_currency) { setClauses.push(`site_currency = $${idx++}`); values.push(countryData.site_currency); }
    setClauses.push(`is_ethical = $${idx++}`); values.push(ethicsData.is_ethical);
    if (ethicsData.ethical_score) { setClauses.push(`ethical_score = $${idx++}`); values.push(JSON.stringify(ethicsData.ethical_score)); }
    setClauses.push(`date_updated = $${idx++}`); values.push(new Date().toISOString());
    values.push(store.id);

    if (setClauses.length > 0) {
      await pool.query(
        `UPDATE sites SET ${setClauses.join(', ')} WHERE id = $${idx}`,
        values
      );
    }

    // Extract store locations
    const locations = await extractStoreLocations(store.url);
    if (Array.isArray(locations) && locations.length > 0) {
      for (const loc of locations) {
        const address = [loc.address_street, loc.address_city, loc.address_postcode, loc.address_country]
          .filter(Boolean).join(', ');
        await pool.query(
          `INSERT INTO site_locations (address, site_id, latitude, longitude, opening_hours)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            address,
            store.id,
            loc.latitude?.toString() || null,
            loc.longitude?.toString() || null,
            loc.opening_hours || null,
          ]
        );
      }
    }

    logger.info({ storeId: store.id, country: countryData.country_of_origin }, 'Store metadata updated');
  } catch (error) {
    errors.push({ type: 'metadata', message: error.message });
    logger.warn({ storeId: store.id, error: error.message }, 'Store metadata extraction failed');
  }
}

async function discoverProducts(store, errors) {
  try {
    // Get category/collection pages from the store
    const result = await scrapingEngine.runOnPage(store.url, {}, async ({ page }) => {
      // Find collection/category links
      const categoryLinks = await page.evaluate(() => {
        const links = new Set();
        const patterns = [
          'a[href*="/collections/"]', 'a[href*="/categories/"]',
          'a[href*="/category/"]', 'a[href*="/shop/"]',
          'a[href*="/product-category/"]',
          'nav a[href]', '.main-menu a[href]', '.site-nav a[href]',
        ];

        const currentHost = window.location.hostname;
        for (const pattern of patterns) {
          document.querySelectorAll(pattern).forEach(a => {
            const href = a.href;
            try {
              const linkHost = new URL(href).hostname;
              if (href && linkHost === currentHost
                && !href.includes('#') && !href.includes('javascript:')
                && !href.includes('/cart') && !href.includes('/account')
                && !href.includes('/search') && !href.includes('/blog')
                && !href.includes('/pages/')) {
                links.add(href);
              }
            } catch {}
          });
        }
        return [...links];
      });

      // Also get product URLs directly from homepage
      const homepageProducts = await extractProductUrls(page, store.url);

      return { categoryLinks, homepageProducts };
    });

    if (result?.error) {
      errors.push({ type: 'discovery', message: result.error });
      return [];
    }

    const allProductUrls = new Set(result.homepageProducts || []);

    // Scrape each category page for more product URLs
    const categoryLinks = (result.categoryLinks || []).slice(0, 20); // Limit category pages
    for (const categoryUrl of categoryLinks) {
      try {
        const catResult = await scrapingEngine.runOnPage(categoryUrl, {}, async ({ page }) => {
          await clickLoadMore(page);
          await autoScroll(page);
          return extractProductUrls(page, categoryUrl);
        });

        if (catResult && !catResult.error) {
          catResult.forEach(url => allProductUrls.add(url));
        }
      } catch (error) {
        logger.debug({ categoryUrl, error: error.message }, 'Failed to scrape category');
      }

      await delay(config.REQUEST_DELAY_MS);
    }

    return [...allProductUrls];
  } catch (error) {
    errors.push({ type: 'discovery', message: error.message });
    return [];
  }
}

async function scrapeAndEnrichProduct(productUrl, store) {
  const result = await scrapingEngine.runOnPage(productUrl, {}, async ({ page }) => {
    return extractProductData(page, productUrl);
  });

  if (!result || result.error || !result.product_name) {
    logger.debug({
      url: productUrl,
      hasResult: !!result,
      error: result?.error,
      hasName: !!result?.product_name,
    }, 'Skipping product - no extractable data');
    return null;
  }

  // AI categorization
  const category = await categorizeProduct(
    result.product_name,
    result.product_description,
    `Store: ${store.store_name}, URL: ${store.url}`
  );

  // Colour mapping
  const colourBase = result.product_colour
    ? await mapColourToBase(result.product_colour)
    : null;

  // Image processing
  let imageUrls = { primaryUrl: null, thumbnailUrl: null, additionalUrls: [] };
  if (result.primary_image) {
    const images = await imageProcessor.downloadAndProcess(result.primary_image);
    if (images) {
      // Use a temp ID for upload path; will be updated after DB insert
      const tempId = crypto.randomUUID();
      imageUrls = await imageUploader.uploadProductImages(tempId, {
        primary: images.primary,
        thumbnail: images.thumbnail,
      });
    }
  }

  return {
    product_name: result.product_name,
    product_description: result.product_description,
    colour_base: colourBase,
    product_colour: result.product_colour,
    sizes_available: result.sizes_available,
    composition: result.composition,
    dimensions: result.dimensions,
    price: result.price,
    currency: result.currency,
    on_sale: false,
    primary_image_url: imageUrls.primaryUrl,
    thumbnail_url: imageUrls.thumbnailUrl,
    additional_images: imageUrls.additionalUrls,
    source_url: productUrl,
    category_id: category?.category_id || null,
    category_name: category?.category_slug?.replace(/-/g, ' ') || null,
    category_slug: category?.category_slug || null,
    search_engine: category?.search_engine || null,
    // Gender: prefer extractor detection (URL/JSON-LD), fall back to AI categorizer
    gender: result.gender || category?.gender || null,
  };
}

async function syncToTypesense(storeId, store) {
  try {
    await typesenseIndexer.ensureCollection();

    const { rows: products } = await pool.query(
      `SELECT p.*, c.category_name, c.slug AS category_slug, c.search_engine
       FROM products p
       LEFT JOIN categories c ON c.id = p.scraper_category_id
       WHERE p.site_id = $1 AND p.status NOT IN ('removed', 'Archived')`,
      [storeId]
    );

    if (!products?.length) return;

    const enriched = products.map(p => ({
      ...p,
      // Map to scraper internal names for Typesense indexer
      product_name: p.product_title,
      price: Math.round(parseFloat(p.product_price || 0) * 100),
      currency: p.product_currency,
      primary_image_url: p.product_image,
      thumbnail_url: p.product_thumbnail,
      store_id: p.site_id,
      source_url: p.source_url || p.product_url,
      category_name: p.category_name,
      category_slug: p.category_slug,
      search_engine: p.search_engine,
      gender: p.product_gender || '',
      sustainable: p.sustainable || 'no',
      date_modified: p.updated_at || p.created_at || new Date(),
    }));

    await typesenseIndexer.upsertBatch(enriched, store);

    // Remove discontinued/removed products from Typesense
    const { rows: removedProducts } = await pool.query(
      'SELECT id FROM products WHERE site_id = $1 AND status IN ($2, $3)',
      [storeId, 'discontinued', 'removed']
    );

    for (const product of removedProducts || []) {
      await typesenseIndexer.removeProduct(product.id);
    }

    logger.info({ storeId, indexed: products.length }, 'Typesense sync complete');
  } catch (error) {
    logger.error({ storeId, error: error.message }, 'Typesense sync failed');
  }
}

async function completePipeline(jobId, storeId, errors, status, finalStats = {}) {
  if (!jobId) return;

  const { rows: [storeFreq] } = await pool.query(
    'SELECT scrape_frequency FROM sites WHERE id = $1',
    [storeId]
  );

  const freqDays = intervalToDays(storeFreq?.scrape_frequency);
  const nextRun = new Date();
  nextRun.setDate(nextRun.getDate() + freqDays);

  const setClauses = [
    'status = $1',
    'completed_at = $2',
    'error_summary = $3',
    'next_run_at = $4',
    'session_summary = $5',
  ];
  const values = [
    status,
    new Date().toISOString(),
    JSON.stringify(errors.length > 0 ? errors : []),
    nextRun.toISOString(),
    JSON.stringify({ stage: status === 'completed' ? 'done' : 'failed' }),
  ];
  let idx = 6;

  // Include final stats if provided
  if (finalStats.products_discovered != null) { setClauses.push(`products_discovered = $${idx++}`); values.push(finalStats.products_discovered); }
  if (finalStats.products_new != null) { setClauses.push(`products_new = $${idx++}`); values.push(finalStats.products_new); }
  if (finalStats.products_updated != null) { setClauses.push(`products_updated = $${idx++}`); values.push(finalStats.products_updated); }
  if (finalStats.products_discontinued != null) { setClauses.push(`products_discontinued = $${idx++}`); values.push(finalStats.products_discontinued); }
  if (finalStats.products_failed != null) { setClauses.push(`products_failed = $${idx++}`); values.push(finalStats.products_failed); }

  values.push(jobId);
  await pool.query(
    `UPDATE scraping_sessions SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    values
  );
}
