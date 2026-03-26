import { logger } from '../../lib/logger.js';
import { scrapingEngine } from './engine.js';

const ABOUT_LINK_PATTERNS = [
  'a[href*="/about"]',
  'a[href*="/pages/about"]',
  'a:has-text("About")',
  'a:has-text("About Us")',
];

const CONTACT_LINK_PATTERNS = [
  'a[href*="/contact"]',
  'a[href*="/pages/contact"]',
  'a:has-text("Contact")',
  'a:has-text("Contact Us")',
];

const SHIPPING_LINK_PATTERNS = [
  'a[href*="/shipping"]',
  'a[href*="/delivery"]',
  'a[href*="/pages/shipping"]',
  'a[href*="/pages/delivery"]',
  'a:has-text("Shipping")',
  'a:has-text("Delivery")',
];

/**
 * Extract store metadata from the site's homepage and key pages.
 * Returns raw data that will be further analyzed by AI services.
 */
export async function extractStoreMetadata(storeUrl, options = {}) {
  const metadata = {
    description: null,
    email: null,
    tel: null,
    address: null,
    aboutContent: null,
    contactContent: null,
    shippingContent: null,
    socialLinks: [],
    detectedCurrency: null,
    detectedLanguage: null,
  };

  // Extract from homepage
  const homeResult = await scrapingEngine.runOnPage(storeUrl, options, async ({ page }) => {
    return page.evaluate(() => {
      const getMeta = (name) =>
        document.querySelector(`meta[property="${name}"]`)?.content
        || document.querySelector(`meta[name="${name}"]`)?.content;

      // Find email links
      const emailLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
      const email = emailLinks[0]?.href?.replace('mailto:', '')?.split('?')[0];

      // Find phone links
      const telLinks = Array.from(document.querySelectorAll('a[href^="tel:"]'));
      const tel = telLinks[0]?.href?.replace('tel:', '');

      // Find social links
      const socialPatterns = ['instagram.com', 'facebook.com', 'twitter.com', 'tiktok.com', 'pinterest.com', 'linkedin.com'];
      const socialLinks = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        if (socialPatterns.some(p => href.includes(p))) {
          socialLinks.push(href);
        }
      });

      // Detect currency from price elements
      const priceEl = document.querySelector('[class*="price"], .money, [data-price]');
      const priceText = priceEl?.innerText || '';
      let currency = null;
      if (priceText.includes('\u00A3')) currency = 'GBP';
      else if (priceText.includes('\u20AC')) currency = 'EUR';
      else if (priceText.includes('$')) currency = 'USD';

      // Detect language
      const lang = document.documentElement.lang || null;

      // Find about/contact/shipping page links
      const findLink = (patterns) => {
        for (const pat of patterns) {
          try {
            const el = document.querySelector(pat);
            if (el?.href) return el.href;
          } catch {}
        }
        return null;
      };

      return {
        description: getMeta('og:description') || getMeta('description'),
        email,
        tel,
        socialLinks,
        currency,
        lang,
        aboutUrl: findLink(['a[href*="/about"]', 'a[href*="/pages/about"]']),
        contactUrl: findLink(['a[href*="/contact"]', 'a[href*="/pages/contact"]']),
        shippingUrl: findLink(['a[href*="/shipping"]', 'a[href*="/delivery"]', 'a[href*="/pages/shipping"]']),
      };
    });
  });

  if (homeResult && !homeResult.error) {
    metadata.description = homeResult.description;
    metadata.email = homeResult.email;
    metadata.tel = homeResult.tel;
    metadata.socialLinks = homeResult.socialLinks || [];
    metadata.detectedCurrency = homeResult.currency;
    metadata.detectedLanguage = homeResult.lang;

    // Fetch about page content
    if (homeResult.aboutUrl) {
      const aboutResult = await scrapingEngine.fetchPage(homeResult.aboutUrl, options);
      if (aboutResult && !aboutResult.error) {
        metadata.aboutContent = aboutResult.content;
      }
    }

    // Fetch contact page content
    if (homeResult.contactUrl) {
      const contactResult = await scrapingEngine.fetchPage(homeResult.contactUrl, options);
      if (contactResult && !contactResult.error) {
        metadata.contactContent = contactResult.content;
      }
    }

    // Fetch shipping page content
    if (homeResult.shippingUrl) {
      const shippingResult = await scrapingEngine.fetchPage(homeResult.shippingUrl, options);
      if (shippingResult && !shippingResult.error) {
        metadata.shippingContent = shippingResult.content;
      }
    }
  }

  logger.info({ url: storeUrl, hasEmail: !!metadata.email, hasCurrency: !!metadata.detectedCurrency }, 'Extracted store metadata');
  return metadata;
}
