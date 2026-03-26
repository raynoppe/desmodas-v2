import { logger } from '../lib/logger.js';
import pool from '../db/postgres.js';
import { extractStoreMetadata } from './scraping/store-extractor.js';
import { extractStoreLocations } from './scraping/location-extractor.js';
import { detectCountryAndCurrency } from './ai/country-detector.js';
import { analyzeEthics } from './ai/ethical-analyzer.js';
import { siteHealthChecker } from './monitoring/health-checker.js';

/**
 * Extract and save store metadata (description, contact, country, currency, ethics, locations).
 * Streams progress via SSE callback. Saves results to DB.
 */
export async function runInfoScrape(store, send) {
  const result = {
    description: null,
    email: null,
    tel: null,
    country: null,
    currency: null,
    is_ethical: false,
    ethical_score: null,
    locations: 0,
  };

  send('log', { message: `Getting site info for ${store.store_name}` });
  send('log', { message: `URL: ${store.url}` });

  // 1. Health check
  send('log', { message: 'Running health check...' });
  const health = await siteHealthChecker.checkSite(store.url);
  if (!health.online) {
    send('error', { message: `Site is offline: ${health.error || `HTTP ${health.statusCode}`}` });
    return result;
  }
  send('log', { message: `Health check passed (HTTP ${health.statusCode})` });

  // 2. Extract metadata from homepage + about/contact/shipping pages
  send('log', { message: 'Extracting site metadata (homepage, about, contact, shipping pages)...' });
  let metadata;
  try {
    metadata = await extractStoreMetadata(store.url);
    send('log', { message: `Description: ${metadata.description ? 'found' : 'not found'}` });
    send('log', { message: `Email: ${metadata.email || 'not found'}` });
    send('log', { message: `Phone: ${metadata.tel || 'not found'}` });
    send('log', { message: `Currency detected: ${metadata.detectedCurrency || 'not found'}` });
    send('log', { message: `Language: ${metadata.detectedLanguage || 'not found'}` });
    send('log', { message: `Social links: ${metadata.socialLinks?.length || 0} found` });
    result.description = metadata.description;
    result.email = metadata.email;
    result.tel = metadata.tel;
  } catch (error) {
    send('log', { message: `Metadata extraction failed: ${error.message}` });
    return result;
  }

  // 3. AI country detection
  send('log', { message: 'Detecting country and currency (AI)...' });
  let countryData = { country_of_origin: null, ships_to_countries: null, site_currency: null };
  try {
    countryData = await detectCountryAndCurrency(store.url, metadata);
    send('log', { message: `Country: ${countryData.country_of_origin || 'unknown'}` });
    send('log', { message: `Currency: ${countryData.site_currency || 'unknown'}` });
    send('log', { message: `Ships to: ${countryData.ships_to_countries?.join(', ') || 'unknown'}` });
    result.country = countryData.country_of_origin;
    result.currency = countryData.site_currency;
  } catch (error) {
    send('log', { message: `Country detection failed: ${error.message}` });
  }

  // 4. AI ethical analysis
  send('log', { message: 'Analyzing ethical practices (AI)...' });
  let ethicsData = { is_ethical: false, ethical_score: null };
  try {
    ethicsData = await analyzeEthics(metadata.aboutContent, metadata.description, store.url);
    send('log', { message: `Ethical: ${ethicsData.is_ethical ? 'Yes' : 'No'}` });
    if (ethicsData.ethical_score) {
      send('log', { message: `Ethical score: ${JSON.stringify(ethicsData.ethical_score)}` });
    }
    result.is_ethical = ethicsData.is_ethical;
    result.ethical_score = ethicsData.ethical_score;
  } catch (error) {
    send('log', { message: `Ethical analysis failed: ${error.message}` });
  }

  // 5. Save to database
  send('log', { message: 'Saving to database...' });
  try {
    const setClauses = [];
    const values = [];
    let idx = 1;

    if (metadata.description) {
      setClauses.push(`site_description = $${idx++}`);
      values.push(metadata.description);
    }
    if (metadata.email) {
      setClauses.push(`email = $${idx++}`);
      values.push(metadata.email);
    }
    if (metadata.tel) {
      setClauses.push(`tel = $${idx++}`);
      values.push(metadata.tel);
    }

    // Country — FK to 'list' table using ISO codes
    if (countryData.country_of_origin) {
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
        send('log', { message: `Country code: ${countryCode}` });
      }
    }

    if (countryData.ships_to_countries?.length) {
      setClauses.push(`ships_to_countries = $${idx++}`);
      values.push(JSON.stringify(countryData.ships_to_countries));
    }
    if (countryData.site_currency) {
      setClauses.push(`site_currency = $${idx++}`);
      values.push(countryData.site_currency);
    }

    setClauses.push(`is_ethical = $${idx++}`);
    values.push(ethicsData.is_ethical);

    if (ethicsData.ethical_score) {
      setClauses.push(`ethical_score = $${idx++}`);
      values.push(JSON.stringify(ethicsData.ethical_score));
    }

    setClauses.push(`date_updated = $${idx++}`);
    values.push(new Date().toISOString());
    values.push(store.id);

    if (setClauses.length > 0) {
      await pool.query(
        `UPDATE sites SET ${setClauses.join(', ')} WHERE id = $${idx}`,
        values
      );
      send('log', { message: `Updated ${setClauses.length} fields on site record` });
    }
  } catch (error) {
    send('log', { message: `Database update failed: ${error.message}` });
  }

  // 6. Extract and save locations
  send('log', { message: 'Looking for store locations...' });
  try {
    const locations = await extractStoreLocations(store.url);
    if (Array.isArray(locations) && locations.length > 0) {
      // Clear old locations first
      await pool.query('DELETE FROM site_locations WHERE site_id = $1', [store.id]);

      for (const loc of locations) {
        const address = [loc.address_street, loc.address_city, loc.address_postcode, loc.address_country]
          .filter(Boolean).join(', ');
        await pool.query(
          `INSERT INTO site_locations (address, site_id, latitude, longitude, opening_hours)
           VALUES ($1, $2, $3, $4, $5)`,
          [address, store.id, loc.latitude?.toString() || null, loc.longitude?.toString() || null, loc.opening_hours || null]
        );
      }
      result.locations = locations.length;
      send('log', { message: `Found and saved ${locations.length} store locations` });
    } else {
      send('log', { message: 'No store locations found' });
    }
  } catch (error) {
    send('log', { message: `Location extraction failed: ${error.message}` });
  }

  send('log', { message: 'Site info extraction complete' });
  return result;
}
