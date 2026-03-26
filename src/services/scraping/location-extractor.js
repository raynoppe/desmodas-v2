import { logger } from '../../lib/logger.js';
import { scrapingEngine } from './engine.js';

const STORE_LOCATOR_PATTERNS = [
  'a[href*="/store-locator"]',
  'a[href*="/stores"]',
  'a[href*="/our-stores"]',
  'a[href*="/locations"]',
  'a[href*="/find-a-store"]',
  'a[href*="/boutiques"]',
  'a[href*="/pages/stores"]',
  'a[href*="/pages/stockists"]',
  'a:has-text("Store Locator")',
  'a:has-text("Our Stores")',
  'a:has-text("Find a Store")',
  'a:has-text("Stockists")',
  'a:has-text("Boutiques")',
];

/**
 * Detect and extract physical store locations.
 * Returns raw location data for AI processing.
 */
export async function extractStoreLocations(storeUrl, options = {}) {
  // First find the store locator page
  const locatorUrl = await findStoreLocatorPage(storeUrl, options);
  if (!locatorUrl) {
    logger.debug({ url: storeUrl }, 'No store locator page found');
    return [];
  }

  logger.info({ url: locatorUrl }, 'Found store locator page');

  // Extract location data from the store locator page
  const result = await scrapingEngine.runOnPage(locatorUrl, options, async ({ page }) => {
    // Check for JSON-LD location data first
    const jsonLdLocations = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      const locations = [];
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent);
          const items = Array.isArray(data) ? data
            : data['@graph'] ? data['@graph']
            : [data];

          for (const item of items) {
            if (item['@type'] === 'Store' || item['@type'] === 'LocalBusiness' || item['@type'] === 'Place') {
              locations.push({
                name: item.name,
                address_street: item.address?.streetAddress,
                address_city: item.address?.addressLocality,
                address_state: item.address?.addressRegion,
                address_postcode: item.address?.postalCode,
                address_country: item.address?.addressCountry,
                contact_phone: item.telephone,
                contact_email: item.email,
                latitude: item.geo?.latitude,
                longitude: item.geo?.longitude,
                opening_hours: item.openingHours,
              });
            }
          }
        } catch {}
      }
      return locations;
    });

    if (jsonLdLocations.length > 0) {
      return jsonLdLocations;
    }

    // Fallback: extract page content for AI analysis
    const pageContent = await page.evaluate(() => {
      const main = document.querySelector('main, [role="main"], .main-content, body');
      return main ? main.innerText : document.body.innerText;
    });

    return { rawContent: pageContent, pageUrl: locatorUrl };
  });

  if (result?.error) {
    logger.warn({ error: result.error }, 'Failed to extract store locations');
    return [];
  }

  // If we got structured locations, return them
  if (Array.isArray(result)) {
    logger.info({ count: result.length }, 'Extracted store locations from structured data');
    return result;
  }

  // Otherwise return raw content for AI processing
  return result;
}

async function findStoreLocatorPage(storeUrl, options) {
  const result = await scrapingEngine.runOnPage(storeUrl, options, async ({ page }) => {
    return page.evaluate((patterns) => {
      for (const pattern of patterns) {
        try {
          const el = document.querySelector(pattern);
          if (el?.href) return el.href;
        } catch {}
      }

      // Also check footer links
      const footer = document.querySelector('footer');
      if (footer) {
        const footerLinks = footer.querySelectorAll('a[href]');
        for (const link of footerLinks) {
          const href = link.href.toLowerCase();
          const text = link.innerText.toLowerCase();
          if (href.includes('store') || href.includes('location') || href.includes('boutique') ||
              text.includes('store') || text.includes('location') || text.includes('boutique')) {
            return link.href;
          }
        }
      }

      return null;
    }, STORE_LOCATOR_PATTERNS);
  });

  if (result?.error) return null;
  return result;
}
