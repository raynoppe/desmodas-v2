import { logger } from '../../lib/logger.js';

const PAGINATION_SELECTORS = [
  '.pagination a.next, .pagination .next a',
  'a[rel="next"], link[rel="next"]',
  '.pagination-item--next a',
  'a:has-text("Next")',
  'a:has-text(">")',
  '[aria-label="Next page"]',
  '.pages-items a.next',
];

const PRODUCT_LINK_PATTERNS = [
  'a[href*="/products/"]',
  'a[href*="/product/"]',
  'a[href*="/p/"]',
  '.product-card a',
  '.product-item a',
  '.product a.product-link',
  '[class*="product"] a[href]',
  '.grid__item a[href*="/products"]',
  '.collection-products a[href]',
];

export async function extractProductUrls(page, baseUrl) {
  const urls = await page.evaluate((patterns) => {
    const links = new Set();
    for (const pattern of patterns) {
      try {
        document.querySelectorAll(pattern).forEach(a => {
          const href = a.href;
          if (href && !href.includes('#') && !href.includes('javascript:')) {
            links.add(href);
          }
        });
      } catch {}
    }
    return [...links];
  }, PRODUCT_LINK_PATTERNS);

  // Filter to same domain only
  const domain = new URL(baseUrl).hostname;
  const filtered = urls.filter(url => {
    try {
      return new URL(url).hostname === domain;
    } catch {
      return false;
    }
  });

  logger.debug({ count: filtered.length }, 'Extracted product URLs');
  return [...new Set(filtered)];
}

export async function getNextPageUrl(page) {
  for (const sel of PAGINATION_SELECTORS) {
    try {
      const link = await page.locator(sel).first();
      if (await link.isVisible({ timeout: 500 })) {
        const href = await link.getAttribute('href');
        if (href) {
          return href.startsWith('http') ? href : new URL(href, page.url()).href;
        }
      }
    } catch {}
  }
  return null;
}

export async function collectAllProductUrls(engine, startUrl, options = {}) {
  const { maxPages = 20 } = options;
  const allUrls = new Set();
  let currentUrl = startUrl;
  let pageNum = 0;

  while (currentUrl && pageNum < maxPages) {
    pageNum++;
    logger.info({ page: pageNum, url: currentUrl }, 'Navigating category page');

    const result = await engine.runOnPage(currentUrl, options, async ({ page }) => {
      const urls = await extractProductUrls(page, currentUrl);
      const nextPage = await getNextPageUrl(page);
      return { urls, nextPage };
    });

    if (result?.error) {
      logger.warn({ error: result.error, url: currentUrl }, 'Failed to scrape category page');
      break;
    }

    if (result?.urls) {
      result.urls.forEach(u => allUrls.add(u));
    }

    currentUrl = result?.nextPage || null;
  }

  logger.info({ totalUrls: allUrls.size, pages: pageNum }, 'Collected all product URLs');
  return [...allUrls];
}
