import { logger } from '../../lib/logger.js';
import { priceToCents } from '../../lib/utils.js';
import { PLATFORMS, detectPlatform } from '../../config/platforms.js';

/**
 * Extract product data from a single product page.
 * Tries structured data (JSON-LD, meta tags) first, then platform-specific selectors.
 */
export async function extractProductData(page, url) {
  const html = await page.content();
  const platform = detectPlatform(html, url);
  logger.debug({ url, platform, htmlLength: html.length }, 'Starting product extraction');

  // Try JSON-LD structured data first (most reliable)
  const jsonLd = await extractJsonLd(page);
  if (jsonLd) {
    logger.debug({ url, source: 'json-ld', name: jsonLd.product_name }, 'Extracted product from structured data');
    return normalizeProduct(jsonLd, url);
  }
  logger.debug({ url }, 'No JSON-LD product data found');

  // Try platform-specific selectors
  if (platform !== 'unknown' && PLATFORMS[platform]) {
    const platformData = await extractWithSelectors(page, PLATFORMS[platform].productSelectors, url);
    if (platformData?.product_name) {
      logger.debug({ url, source: platform, name: platformData.product_name }, 'Extracted product from platform selectors');
      return normalizeProduct(platformData, url);
    }
    logger.debug({ url, platform }, 'Platform selectors found no product name');
  }

  // Try meta tags as fallback
  const metaData = await extractMetaTags(page);
  if (metaData?.product_name) {
    logger.debug({ url, source: 'meta-tags', name: metaData.product_name }, 'Extracted product from meta tags');
    return normalizeProduct(metaData, url);
  }
  logger.debug({ url }, 'No meta tag product data found');

  // Generic fallback
  const generic = await extractGeneric(page);
  logger.debug({ url, source: 'generic', name: generic?.product_name }, 'Extracted product from generic selectors');
  return normalizeProduct(generic, url);
}

/**
 * Detect product gender from URL path, breadcrumbs, and page content.
 * Returns 'Female', 'Male', or null (for unisex/unknown).
 */
const FEMALE_PATTERNS = /\b(women|woman|womens|women's|ladies|lady|female|her|girls?)\b/i;
const MALE_PATTERNS = /\b(men|mans|mens|men's|gentlemen|male|his|boys?)\b/i;
// Avoid false positives from words containing "men" like "garment", "moment", "element", etc.
const MALE_URL_PATTERNS = /\/(men|mens|male|boys|gentlemen)(\/|$|\?)/i;
const FEMALE_URL_PATTERNS = /\/(women|womens|ladies|female|girls)(\/|$|\?)/i;

function detectGenderFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (FEMALE_URL_PATTERNS.test(path)) return 'female';
    if (MALE_URL_PATTERNS.test(path)) return 'male';
  } catch {}
  return null;
}

function detectGenderFromText(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const femaleMatch = FEMALE_PATTERNS.test(lower);
  const maleMatch = MALE_PATTERNS.test(lower);
  // Only return if unambiguous (one gender, not both)
  if (femaleMatch && !maleMatch) return 'female';
  if (maleMatch && !femaleMatch) return 'male';
  return null;
}

async function extractJsonLd(page) {
  return page.evaluate(() => {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const product = data['@type'] === 'Product' ? data
          : Array.isArray(data['@graph'])
            ? data['@graph'].find(item => item['@type'] === 'Product')
            : null;

        if (product) {
          const offer = product.offers?.[0] || product.offers || {};
          const images = Array.isArray(product.image)
            ? product.image
            : product.image ? [product.image] : [];

          // Extract gender from Schema.org audience
          const audience = product.audience || product.targetAudience;
          const suggestedGender = audience?.suggestedGender
            || audience?.audienceType
            || (typeof audience === 'string' ? audience : null);

          return {
            product_name: product.name,
            product_description: product.description,
            price_raw: offer.price || offer.lowPrice,
            currency: offer.priceCurrency,
            product_colour: product.color,
            composition: product.material,
            primary_image: images[0],
            additional_images: images.slice(1),
            sizes: Array.isArray(product.size) ? product.size : product.size ? [product.size] : [],
            brand: product.brand?.name || product.brand,
            sku: product.sku,
            gender_hint: suggestedGender || null,
          };
        }
      } catch {}
    }
    return null;
  });
}

async function extractMetaTags(page) {
  return page.evaluate(() => {
    const get = (name) =>
      document.querySelector(`meta[property="${name}"]`)?.content
      || document.querySelector(`meta[name="${name}"]`)?.content;

    let name = get('og:title') || get('twitter:title');
    // Fall back to document title but strip site name suffixes
    if (!name && document.title) {
      name = document.title.split('|')[0].split(' - ')[0].split(' \u2013 ')[0].trim();
    }
    const price = get('product:price:amount') || get('og:price:amount');
    const currency = get('product:price:currency') || get('og:price:currency');
    const image = get('og:image') || get('twitter:image');
    const description = get('og:description') || get('twitter:description')
      || document.querySelector('meta[name="description"]')?.content;

    if (!name) return null;
    return {
      product_name: name,
      product_description: description,
      price_raw: price,
      currency,
      primary_image: image,
      additional_images: [],
    };
  });
}

async function extractWithSelectors(page, selectors, url) {
  const baseUrl = (() => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch { return null; }
  })();

  return page.evaluate(({ selectors: sels, baseUrl: base }) => {
    const getText = (selector) => {
      for (const sel of selector.split(',')) {
        const el = document.querySelector(sel.trim());
        if (el) return el.innerText?.trim();
      }
      return null;
    };

    const getImages = (selector) => {
      const imgs = [];
      for (const sel of selector.split(',')) {
        document.querySelectorAll(sel.trim()).forEach(img => {
          let src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
          if (src) {
            if (src.startsWith('//')) src = 'https:' + src;
            else if (src.startsWith('/') && base) src = base + src;
            imgs.push(src);
          }
        });
      }
      return imgs;
    };

    const getOptions = (selector) => {
      const options = [];
      for (const sel of selector.split(',')) {
        document.querySelectorAll(sel.trim()).forEach(el => {
          const text = el.innerText?.trim() || el.getAttribute('data-value') || el.value;
          if (text && text !== 'Select' && text !== '--') options.push(text);
        });
      }
      return options;
    };

    const images = sels.images ? getImages(sels.images) : [];

    return {
      product_name: sels.name ? getText(sels.name) : null,
      product_description: sels.description ? getText(sels.description) : null,
      price_raw: sels.price ? getText(sels.price) : null,
      primary_image: images[0] || null,
      additional_images: images.slice(1),
      product_colour: sels.colour ? (getOptions(sels.colour)[0] || null) : null,
      sizes: sels.sizes ? getOptions(sels.sizes) : [],
    };
  }, { selectors, baseUrl });
}

async function extractGeneric(page) {
  return page.evaluate(() => {
    // Try h1 first, then h2 (Hydrogen stores use h2 for product names)
    let name = document.querySelector('h1')?.innerText?.trim();
    if (!name) {
      const h2s = document.querySelectorAll('h2');
      for (const h2 of h2s) {
        const text = h2.innerText?.trim();
        if (text && text.length > 2 && text.length < 200
          && !text.toLowerCase().includes('cookie')
          && !text.toLowerCase().includes('newsletter')
          && !text.toLowerCase().includes('subscribe')
          && !text.toLowerCase().includes('shop')) {
          name = text;
          break;
        }
      }
    }
    // Fall back to page title (strip site name suffix)
    if (!name) {
      const title = document.title;
      if (title) {
        name = title.split('|')[0].split(' - ')[0].split(' \u2013 ')[0].trim();
      }
    }

    const priceEl = document.querySelector('[class*="price"], [data-price]');
    const descEl = document.querySelector(
      '[class*="description"], [data-description], .product-description'
    );
    const description = descEl?.innerText?.trim()
      || document.querySelector('meta[name="description"]')?.content;

    const images = [];
    document.querySelectorAll('.product img, [class*="product"] img, [class*="gallery"] img').forEach(img => {
      const src = img.src || img.getAttribute('data-src');
      if (src) images.push(src);
    });
    // Fallback: Shopify CDN images (for Hydrogen stores)
    if (images.length === 0) {
      document.querySelectorAll('img[src*="cdn.shopify.com/s/files"]').forEach(img => {
        const src = img.src;
        if (src && !src.includes('logo') && !src.includes('icon')) images.push(src);
      });
    }

    return {
      product_name: name,
      product_description: description,
      price_raw: priceEl?.innerText?.trim(),
      primary_image: images[0] || null,
      additional_images: images.slice(1),
    };
  });
}

function cleanShopifyImageUrl(url) {
  if (!url || !url.includes('cdn.shopify.com')) return url;
  try {
    const parsed = new URL(url);
    // Remove Shopify resize params to get full-size image
    parsed.searchParams.delete('width');
    parsed.searchParams.delete('height');
    parsed.searchParams.delete('crop');
    return parsed.toString();
  } catch {
    return url;
  }
}

function normalizeGenderHint(hint) {
  if (!hint) return null;
  const lower = String(hint).toLowerCase().trim();
  if (['female', 'women', 'woman', 'ladies'].includes(lower)) return 'female';
  if (['male', 'men', 'man', 'gentlemen'].includes(lower)) return 'male';
  return null;
}

function normalizeProduct(raw, sourceUrl) {
  const priceResult = raw.price_raw ? priceToCents(String(raw.price_raw), raw.currency) : { cents: 0, currency: raw.currency || 'GBP' };

  // Detect gender: JSON-LD audience > URL path > product name/description breadcrumbs
  const gender = normalizeGenderHint(raw.gender_hint)
    || detectGenderFromUrl(sourceUrl)
    || detectGenderFromText(raw.product_name)
    || detectGenderFromText(raw.breadcrumb)
    || null;

  return {
    product_name: raw.product_name || null,
    product_description: raw.product_description || null,
    price: typeof priceResult === 'object' ? priceResult.cents : priceResult,
    currency: (typeof priceResult === 'object' ? priceResult.currency : raw.currency) || 'GBP',
    product_colour: raw.product_colour || null,
    sizes_available: raw.sizes || [],
    composition: raw.composition || null,
    dimensions: raw.dimensions || null,
    primary_image: cleanShopifyImageUrl(raw.primary_image) || null,
    additional_images: (raw.additional_images || []).map(cleanShopifyImageUrl),
    source_url: sourceUrl,
    brand: raw.brand || null,
    gender: gender,
  };
}
