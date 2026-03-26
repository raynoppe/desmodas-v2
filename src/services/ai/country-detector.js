import { claudeClient } from './claude-client.js';
import { trainingDataset } from './training-dataset.js';
import { logger } from '../../lib/logger.js';

const COUNTRY_PROMPT = `Analyze this ecommerce website content and determine:
1. The country of origin (where the brand is based)
2. Which countries they ship to
3. The base currency

Respond with ONLY a JSON object:
{
  "country_of_origin": "Country Name",
  "ships_to_countries": ["Country1", "Country2"],
  "site_currency": "GBP|EUR|USD|etc"
}

Use full country names for country_of_origin and ships_to_countries.
Use ISO 4217 currency codes for site_currency.
If ships_to information is unclear, check for "worldwide" shipping mentions.
If you cannot determine something, use null.`;

const TLD_COUNTRY_MAP = {
  '.co.uk': { country: 'United Kingdom', currency: 'GBP' },
  '.uk': { country: 'United Kingdom', currency: 'GBP' },
  '.fr': { country: 'France', currency: 'EUR' },
  '.de': { country: 'Germany', currency: 'EUR' },
  '.it': { country: 'Italy', currency: 'EUR' },
  '.es': { country: 'Spain', currency: 'EUR' },
  '.nl': { country: 'Netherlands', currency: 'EUR' },
  '.se': { country: 'Sweden', currency: 'SEK' },
  '.dk': { country: 'Denmark', currency: 'DKK' },
  '.no': { country: 'Norway', currency: 'NOK' },
  '.au': { country: 'Australia', currency: 'AUD' },
  '.ca': { country: 'Canada', currency: 'CAD' },
  '.jp': { country: 'Japan', currency: 'JPY' },
  '.com': null, // Ambiguous
};

const LANG_COUNTRY_MAP = {
  'en-gb': { country: 'United Kingdom', currency: 'GBP' },
  'en-us': { country: 'United States', currency: 'USD' },
  'fr': { country: 'France', currency: 'EUR' },
  'de': { country: 'Germany', currency: 'EUR' },
  'it': { country: 'Italy', currency: 'EUR' },
  'es': { country: 'Spain', currency: 'EUR' },
  'nl': { country: 'Netherlands', currency: 'EUR' },
  'sv': { country: 'Sweden', currency: 'SEK' },
  'da': { country: 'Denmark', currency: 'DKK' },
  'ja': { country: 'Japan', currency: 'JPY' },
};

/**
 * Detect country of origin, shipping countries, and currency.
 * Uses TLD/language hints first, then AI for deeper analysis.
 */
export async function detectCountryAndCurrency(storeUrl, metadata) {
  const hints = getHints(storeUrl, metadata);

  // If we have enough from hints, use them
  if (hints.country && hints.currency && !metadata.shippingContent) {
    return {
      country_of_origin: hints.country,
      ships_to_countries: hints.shipsTo || ['Worldwide'],
      site_currency: hints.currency,
    };
  }

  // Use AI for deeper analysis
  const content = [
    `URL: ${storeUrl}`,
    metadata.detectedLanguage ? `Language: ${metadata.detectedLanguage}` : '',
    metadata.detectedCurrency ? `Detected currency symbol: ${metadata.detectedCurrency}` : '',
    metadata.shippingContent ? `Shipping page:\n${String(metadata.shippingContent).slice(0, 5000)}` : '',
    metadata.contactContent ? `Contact page:\n${String(metadata.contactContent).slice(0, 3000)}` : '',
    metadata.aboutContent ? `About page:\n${String(metadata.aboutContent).slice(0, 3000)}` : '',
  ].filter(Boolean).join('\n\n');

  try {
    const result = await claudeClient.analyzeJson(content, COUNTRY_PROMPT);

    await trainingDataset.save('country_detection', { storeUrl }, result);

    return {
      country_of_origin: result.country_of_origin || hints.country,
      ships_to_countries: result.ships_to_countries || hints.shipsTo || [],
      site_currency: result.site_currency || hints.currency || 'GBP',
    };
  } catch (error) {
    logger.warn({ error: error.message, storeUrl }, 'AI country detection failed');

    return {
      country_of_origin: hints.country || null,
      ships_to_countries: hints.shipsTo || [],
      site_currency: hints.currency || metadata.detectedCurrency || 'GBP',
    };
  }
}

function getHints(url, metadata) {
  const hints = { country: null, currency: null, shipsTo: null };

  // Check TLD
  const urlLower = url.toLowerCase();
  for (const [tld, info] of Object.entries(TLD_COUNTRY_MAP)) {
    if (info && urlLower.includes(tld)) {
      hints.country = info.country;
      hints.currency = info.currency;
      break;
    }
  }

  // Check language
  if (metadata.detectedLanguage) {
    const langLower = metadata.detectedLanguage.toLowerCase();
    const langInfo = LANG_COUNTRY_MAP[langLower];
    if (langInfo) {
      hints.country = hints.country || langInfo.country;
      hints.currency = hints.currency || langInfo.currency;
    }
  }

  // Check detected currency from price elements
  if (metadata.detectedCurrency) {
    hints.currency = hints.currency || metadata.detectedCurrency;
  }

  return hints;
}
