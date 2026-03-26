# Desmodas Scraper - Claude Context

> This file provides context for Claude Code when working in this project.

## What This Project Is

A standalone Node.js ecommerce product scraping service for the Desmodas product search engines. It autonomously discovers, extracts, and enriches product data from fashion/lifestyle retail stores, then stores everything in a shared DigitalOcean Managed Postgres database and indexes in Typesense for natural language search.

The scraper shares its database with the main `desmodas-next` Next.js app (one level up at `../desmodas-next`). Both apps read/write the same `sites`, `products`, `categories` tables. The scraper only manages stores where `source = 'scraper'`, leaving the ~973 existing stores (from Shopify/Awin feeds) untouched.

## Tech Stack

- **Runtime:** Node.js (ESM modules, `"type": "module"`)
- **HTTP:** Express.js on port 4000
- **Scraping:** Crawlee + Playwright (headless Chromium)
- **Database:** DigitalOcean Managed Postgres via raw `pg` pool (database: `livingsexy`)
- **Image Storage:** DigitalOcean Spaces (S3-compatible) — bucket: `livingsexy`, region: `ams3`
- **Search:** Typesense with `ts/all-MiniLM-L12-v2` embeddings for semantic search
- **AI:** Anthropic Claude API (`claude-sonnet-4-5-20250929`) for categorization, colour mapping, ethical analysis, country detection
- **Jobs:** BullMQ + Redis for persistent job scheduling
- **Images:** Sharp (1600px primary + 400px thumbnail, JPEG quality 80)
- **Logging:** Pino (structured JSON logs)

## Architecture

```
src/
  index.js                    # Express app + BullMQ worker startup
  config/
    index.js                  # Env var loading (dotenv with override: true)
    colours.js                # 16 base colours + ~150 colour name mappings
    platforms.js              # Platform detection (Hydrogen, Shopify, WooCommerce, Magento, BigCommerce, Squarespace)
  db/
    postgres.js               # pg Pool connection to DO Managed Postgres (SSL with cert)
    column-maps.js            # Scraper↔DB column name mappings, price/status/interval conversions
  lib/
    logger.js                 # Pino logger
    errors.js                 # ValidationError, NotFoundError, etc.
    utils.js                  # priceToCents(), delay(), randomUserAgent(), sanitizeHtml()
  middleware/
    auth.js                   # Bearer token auth (ADMIN_API_KEY)
    error-handler.js          # Express error middleware
  routes/
    health.js                 # GET /health (public)
    stores.js                 # Store CRUD + POST /:id/scrape (filters by source='scraper')
    products.js               # Product listing + admin updates
    scrape-jobs.js            # Job history (queries scraping_sessions table)
    categories.js             # Category tree + CRUD
  services/
    pipeline.js               # runStorePipeline() - full end-to-end orchestration
    scraping/
      engine.js               # ScrapingEngine class (Crawlee primary, direct Playwright fallback)
      product-extractor.js    # extractProductData() - JSON-LD > platform selectors > meta tags > generic
      store-extractor.js      # extractStoreMetadata() - about/contact/shipping pages
      location-extractor.js   # extractStoreLocations() - store finder pages
      page-navigator.js       # extractProductUrls(), collectAllProductUrls(), getNextPageUrl()
      cookie-handler.js       # acceptCookies(), dismissOverlays()
      scroll-handler.js       # autoScroll(), clickLoadMore(), detectInfiniteScroll()
    ai/
      claude-client.js        # ClaudeClient class with retry strategies per error type
      categorizer.js          # categorizeProduct() - AI categorization + auto-create categories
      colour-mapper.js        # mapColourToBase() - static lookup > substring > Claude fallback
      ethical-analyzer.js     # analyzeEthics() - certification detection + AI analysis
      country-detector.js     # detectCountryAndCurrency() - TLD, lang, currency, Claude fallback
      training-dataset.js     # saveTrainingData() - stores AI decisions for future model training
    images/
      processor.js            # ImageProcessor - Sharp resize + JPEG conversion
      s3-uploader.js          # ImageUploader - DO Spaces (S3-compatible) upload
    catalog/
      manager.js              # CatalogManager - product lifecycle (insert/update/discontinue/remove)
      price-tracker.js        # PriceTracker - detect changes, record history, set on_sale
      deduplicator.js         # Deduplicator - URL match + pg_trgm similarity (0.85 threshold)
    search/
      typesense-client.js     # Typesense client init
      schema.js               # Collection schema with embedding field
      indexer.js              # TypesenseIndexer - upsert/remove products
    scheduler/
      job-runner.js           # BullMQ queues (scrape-jobs, health-checks) + workers
      scrape-scheduler.js     # ScrapeScheduler - repeatable jobs based on store frequency
    monitoring/
      health-checker.js       # SiteHealthChecker - HTTP HEAD checks, consecutive failure tracking
      site-status.js          # SiteStatusManager - auto-close stores, remove products
```

## Shared Database Schema

The scraper uses the **same Postgres database** (`livingsexy`) as the main `desmodas-next` app. Tables are shared, with the scraper adding columns as needed (all additive, no destructive changes).

### Table Name Mapping (Scraper concept → DB table)

| Scraper concept | DB table | Key column renames |
|---|---|---|
| Stores | `sites` | `store_name`→`site_name`, `url`→`site_url`, `description`→`site_description` |
| Products | `products` | `product_name`→`product_title`, `price`(cents)→`product_price`(decimal), `primary_image_url`→`product_image` |
| Categories | `categories` | `name`→`category_name`, IDs are integers (not UUIDs) |
| Scrape jobs | `scraping_sessions` | `products_found`→`products_discovered`, `products_added`→`products_new` |
| Store locations | `site_locations` | Address fields concatenated into single `address` column |
| Price history | `product_price_history` | `price`(cents)→`new_price`(decimal), includes `old_price`, `change_percentage` |
| Training data | `ai_training_data` | Same (scraper-only table) |

### Key relationships:
- sites 1:N site_locations
- sites 1:N products
- categories 1:N products (via `scraper_category_id`, self-referencing for hierarchy)
- products 1:N product_price_history
- products 1:N product_locations
- sites 1:N scraping_sessions

### Important schema notes:
- **Prices** are stored as `numeric` (decimal dollars, e.g., `25.00`). The scraper converts internally using `centsToDollars()`/`dollarsToCents()` in `column-maps.js`.
- **Status values**: scraper `active`→DB `approved`, scraper `closed`→DB `Archived`. Mapped via `STORE_STATUS_MAP` in `column-maps.js`.
- **Scrape frequency**: scraper uses integer days, DB uses PostgreSQL `INTERVAL`. Converted via `intervalToDays()`/`daysToInterval()`.
- **Source filtering**: The scraper only manages stores where `source = 'scraper'`. The ~973 existing stores have `source` of `shopify` or `awin`.
- **origin_country**: FK to `list` table — must be a 2-letter ISO country code (e.g., `GB`), not a country name.
- **Category IDs**: Integer auto-increment, linked to products via `products.scraper_category_id`.

### Image storage:
- **Bucket:** `livingsexy` on DO Spaces (ams3 region)
- **Path pattern:** `products/{uuid}/primary.jpg` and `products/{uuid}/thumbnail.jpg`
- **Public URL:** `https://livingsexy.ams3.digitaloceanspaces.com/products/{uuid}/primary.jpg`
- **ACL:** `public-read`, Cache-Control: 1 year

**DB function:** `find_similar_products(p_store_id, p_product_name, p_threshold)` using pg_trgm

## Scrape Pipeline Flow

`runStorePipeline(storeId, bullmqJobId)` in `pipeline.js`:

1. Create scraping_sessions record (status: running)
2. Fetch store details from `sites` table
3. Health check (HTTP HEAD, 15s timeout)
4. First scrape only: metadata extraction (description, contact, country, currency, ethics, locations)
5. Product discovery: crawl category/collection pages (same-domain only), extract product URLs
6. For each product URL (with 1.5s delay):
   - Extract product data (JSON-LD > platform selectors > meta tags > generic)
   - AI categorization via Claude
   - Colour mapping (static > substring > Claude)
   - Image download, resize (Sharp), upload to DO Spaces
7. Catalog management: insert new / update changed / discontinue missing (7-day grace)
8. Typesense sync: upsert active products, remove discontinued
9. Complete: update scraping_sessions stats, schedule next_run_at

## Key Design Decisions

- **Shared database** - Scraper writes to the same DO Postgres DB as the main Next.js app, filtered by `source = 'scraper'`
- **Column mapping layer** - `column-maps.js` provides bidirectional name/value conversion between scraper internals and DB schema
- **Crawlee `RequestList`** (not `RequestQueue`) - avoids cross-instance URL deduplication that caused 0 products extracted
- **dotenv `override: true`** - shell env vars (like empty ANTHROPIC_API_KEY) don't block .env values
- **Hydrogen platform detection** - checked BEFORE classic Shopify since both use cdn.shopify.com
- **`extractWithSelectors`** passes `{ selectors, baseUrl }` (outer scope vars) to `page.evaluate`
- **Pipeline always creates new scraping_sessions record** - BullMQ job ID is not a DB UUID
- **Shopify image URL cleanup** - strips width/height/crop params for full-size images
- **Same-domain category filtering** - product discovery only follows links on the store's own domain

## Running

```bash
npm run dev                  # Development with --watch + --env-file=.env
npm start                    # Production
docker compose up            # Docker (scraper + Redis)
```

Requires Redis running on localhost:6379 (or via REDIS_URL).

## Environment Variables

```
# Database (DO Managed Postgres)
DB_HOST=pg-livingsexy-do-user-3124615-0.b.db.ondigitalocean.com
DB_PORT=25060
DB_NAME=livingsexy
DB_USER=doadmin
DB_PASSWORD=...
DB_CERT="-----BEGIN CERTIFICATE-----\n..."

# Image Storage (DO Spaces)
SPACES_ENDPOINT=https://ams3.digitaloceanspaces.com
SPACES_KEY=...
SPACES_SECRET=...
SPACES_NAME=livingsexy
SPACES_REGION=ams3

# Other
ANTHROPIC_API_KEY=...
TYPESENSE_HOST=...
TYPESENSE_API_KEY=...
REDIS_URL=redis://localhost:6379
ADMIN_API_KEY=...
```

## Testing a Scrape

```bash
# Health check
curl http://localhost:4000/health

# Add a store (triggers initial scrape)
curl -X POST http://localhost:4000/api/stores \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"store_name":"Store Name","url":"https://example.com","scrape_frequency":7}'

# Trigger manual scrape
curl -X POST http://localhost:4000/api/stores/{id}/scrape \
  -H "Authorization: Bearer $ADMIN_API_KEY"

# Check job status
curl http://localhost:4000/api/scrape-jobs \
  -H "Authorization: Bearer $ADMIN_API_KEY"

# List products (default status=active, use status=draft for newly scraped)
curl "http://localhost:4000/api/products?store_id={id}&status=draft" \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

## Known Working Test

Hiut Denim (`https://hiutdenim.co.uk`) - Shopify Hydrogen store, store ID: `0eb2a776-ec6f-4e3f-bba3-e5c7ccd96e9e`. Successfully extracted 28 products, 9 AI-generated categories (Jeans, Services, Books, Gifts, Coats, Accessories, Socks, Bags, Stationery), all with images on DO Spaces and indexed in Typesense.
