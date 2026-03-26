import { logger } from '../lib/logger.js';
import { delay } from '../lib/utils.js';
import config from '../config/index.js';

import { scrapingEngine } from './scraping/engine.js';
import { detectPlatform } from '../config/platforms.js';
import { extractProductData } from './scraping/product-extractor.js';
import { extractProductUrls } from './scraping/page-navigator.js';
import { autoScroll, clickLoadMore } from './scraping/scroll-handler.js';
import { categorizeProduct } from './ai/categorizer.js';
import { mapColourToBase } from './ai/colour-mapper.js';
import { siteHealthChecker } from './monitoring/health-checker.js';

/**
 * Dry-run scrape that extracts product data without writing to DB, S3, or Typesense.
 * Streams progress via SSE callback.
 */
export async function runTestScrape(store, productLimit, send, isAborted) {
  send('log', { message: `Starting test scrape for ${store.store_name}` });
  send('log', { message: `URL: ${store.url}` });
  send('log', { message: `Product limit: ${productLimit}` });

  // 1. Health check
  send('log', { message: 'Running health check...' });
  const health = await siteHealthChecker.checkSite(store.url);
  if (!health.online) {
    send('error', { message: `Site is offline: ${health.error || `HTTP ${health.statusCode}`}` });
    return;
  }
  send('log', { message: `Health check passed (HTTP ${health.statusCode})` });

  if (isAborted()) return;

  // 2. Discover product URLs
  send('log', { message: 'Discovering product URLs...' });
  const productUrls = await discoverProductUrls(store, send);

  if (productUrls.length === 0) {
    send('error', { message: 'No product URLs found on this site' });
    return;
  }

  send('log', { message: `Found ${productUrls.length} product URLs` });
  send('stats', { discovered: productUrls.length, limit: productLimit });

  if (isAborted()) return;

  // 3. Extract products (limited)
  const urlsToScrape = productUrls.slice(0, productLimit);
  send('log', { message: `Extracting data from ${urlsToScrape.length} products...` });

  const products = [];
  for (let i = 0; i < urlsToScrape.length; i++) {
    if (isAborted()) {
      send('log', { message: 'Test scrape aborted' });
      return;
    }

    const url = urlsToScrape[i];
    send('log', { message: `[${i + 1}/${urlsToScrape.length}] Extracting: ${url}` });

    try {
      const product = await extractProduct(url, store);
      if (product) {
        products.push(product);
        send('product', product);
        send('log', { message: `  → ${product.product_name} (${product.price ? `${product.currency || ''} ${(product.price / 100).toFixed(2)}` : 'no price'})` });
      } else {
        send('log', { message: `  → No extractable data` });
      }
    } catch (error) {
      send('log', { message: `  → Error: ${error.message}` });
    }

    send('stats', {
      discovered: productUrls.length,
      extracted: products.length,
      progress: i + 1,
      total: urlsToScrape.length,
    });

    // Rate limiting between requests
    if (i < urlsToScrape.length - 1) {
      await delay(config.REQUEST_DELAY_MS);
    }
  }

  send('log', { message: `Test scrape complete: ${products.length}/${urlsToScrape.length} products extracted` });
  send('results', { products, total_discovered: productUrls.length });
}

async function discoverProductUrls(store, send) {
  try {
    const result = await scrapingEngine.runOnPage(store.url, {}, async ({ page }) => {
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

      const homepageProducts = await extractProductUrls(page, store.url);
      return { categoryLinks, homepageProducts };
    });

    if (result?.error) {
      send('log', { message: `Discovery error: ${result.error}` });
      return [];
    }

    const allProductUrls = new Set(result.homepageProducts || []);
    const categoryLinks = (result.categoryLinks || []).slice(0, 10); // Fewer categories for test

    send('log', { message: `Found ${categoryLinks.length} category pages, crawling...` });

    for (const categoryUrl of categoryLinks) {
      try {
        const catResult = await scrapingEngine.runOnPage(categoryUrl, {}, async ({ page }) => {
          await clickLoadMore(page);
          await autoScroll(page);
          return extractProductUrls(page, categoryUrl);
        });

        if (catResult && !catResult.error) {
          const before = allProductUrls.size;
          catResult.forEach(url => allProductUrls.add(url));
          const added = allProductUrls.size - before;
          if (added > 0) {
            send('log', { message: `  ${categoryUrl.split('/').pop()}: +${added} products` });
          }
        }
      } catch (error) {
        logger.debug({ categoryUrl, error: error.message }, 'Failed to scrape category');
      }

      await delay(config.REQUEST_DELAY_MS);
    }

    return [...allProductUrls];
  } catch (error) {
    send('log', { message: `Discovery failed: ${error.message}` });
    return [];
  }
}

async function extractProduct(productUrl, store) {
  const result = await scrapingEngine.runOnPage(productUrl, {}, async ({ page }) => {
    return extractProductData(page, productUrl);
  });

  if (!result || result.error || !result.product_name) {
    return null;
  }

  // AI categorization (still useful to preview)
  let category = null;
  try {
    category = await categorizeProduct(
      result.product_name,
      result.product_description,
      `Store: ${store.store_name}, URL: ${store.url}`
    );
  } catch (error) {
    logger.debug({ error: error.message }, 'Categorization failed in test scrape');
  }

  // Colour mapping
  let colourBase = null;
  if (result.product_colour) {
    try {
      colourBase = await mapColourToBase(result.product_colour);
    } catch {}
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
    primary_image: result.primary_image,
    additional_images: result.additional_images || [],
    source_url: productUrl,
    category_name: category?.category_slug?.replace(/-/g, ' ') || null,
    category_slug: category?.category_slug || null,
  };
}
