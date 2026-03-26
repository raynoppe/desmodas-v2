# Desmodas Scraper API Reference

Base URL: `http://localhost:4000`

## Authentication

All `/api/*` endpoints require a Bearer token in the Authorization header:

```
Authorization: Bearer {ADMIN_API_KEY}
```

The `/health` endpoint is public and requires no authentication.

**Auth error responses:**
```json
// 401
{ "error": "Missing or invalid Authorization header" }

// 403
{ "error": "Invalid API key" }
```

---

## Health

### GET /health

Check service status. No authentication required.

**Response:** `200 OK`
```json
{
  "status": "ok",
  "uptime": 3600,
  "timestamp": "2026-02-18T10:30:00.000Z"
}
```

---

## Stores

### GET /api/stores

List all stores with their physical locations.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| status | string | — | Filter by status: `new`, `review`, `active`, `suspended`, `blocked`, `closed` |
| limit | number | 50 | Results per page |
| offset | number | 0 | Pagination offset |

**Example:**
```bash
curl 'http://localhost:4000/api/stores?status=active&limit=10' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**Response:** `200 OK`
```json
{
  "data": [
    {
      "id": "ad3d4ea6-adec-4125-be97-acecd3f21da8",
      "store_name": "Hiut Denim",
      "description": "We make the best jeans, not the most jeans.",
      "url": "https://hiutdenim.co.uk",
      "email": null,
      "tel": null,
      "address_street": null,
      "address_city": null,
      "address_state": null,
      "address_postcode": null,
      "address_country": null,
      "logo": null,
      "cover_image": null,
      "status": "new",
      "scrape_frequency": 14,
      "country_of_origin": "United Kingdom",
      "ships_to_countries": [],
      "site_currency": "GBP",
      "is_ethical": false,
      "ethical_score": { "score": 15, "concerns": [...], "practices": [...], "certifications": [...] },
      "date_added": "2026-02-17T09:16:33.910096+00:00",
      "date_modified": "2026-02-17T09:17:22.682638+00:00",
      "store_locations": []
    }
  ],
  "total": 1
}
```

---

### GET /api/stores/:id

Get a single store by ID with its physical locations.

**Example:**
```bash
curl 'http://localhost:4000/api/stores/ad3d4ea6-adec-4125-be97-acecd3f21da8' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**Response:** `200 OK` — Single store object (same structure as list)

**Response:** `404 Not Found`
```json
{ "error": "Store not found" }
```

---

### POST /api/stores

Add a new store. Automatically triggers an initial scrape.

**Request Body:**
```json
{
  "store_name": "Hiut Denim",
  "url": "https://hiutdenim.co.uk",
  "scrape_frequency": 14,
  "description": "Optional",
  "email": "optional@example.com",
  "tel": "+44 1234 567890"
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| store_name | yes | — | Display name |
| url | yes | — | Store homepage URL (must be unique) |
| scrape_frequency | no | 7 | Days between automated scrapes |
| description | no | — | Store description |
| email | no | — | Contact email |
| tel | no | — | Contact phone |

**Example:**
```bash
curl -X POST 'http://localhost:4000/api/stores' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"store_name":"Hiut Denim","url":"https://hiutdenim.co.uk","scrape_frequency":14}'
```

**Response:** `201 Created`
```json
{
  "id": "ad3d4ea6-adec-4125-be97-acecd3f21da8",
  "store_name": "Hiut Denim",
  "url": "https://hiutdenim.co.uk",
  "status": "new",
  "scrape_frequency": 14,
  "scrape_job_id": "1"
}
```

**Error:** `422 Unprocessable Entity`
```json
{ "error": "store_name and url are required" }
{ "error": "Store URL already exists" }
```

---

### PATCH /api/stores/:id

Update store fields. If `scrape_frequency` is changed, the recurring schedule is automatically updated.

**Request Body** (all fields optional):
```json
{
  "store_name": "Updated Name",
  "description": "Updated description",
  "url": "https://newurl.com",
  "email": "new@example.com",
  "tel": "+44 9876 543210",
  "address_street": "123 Main St",
  "address_city": "London",
  "address_state": "England",
  "address_postcode": "SW1A 1AA",
  "address_country": "United Kingdom",
  "status": "active",
  "scrape_frequency": 7,
  "is_ethical": true,
  "ethical_score": 85
}
```

**Example:**
```bash
curl -X PATCH 'http://localhost:4000/api/stores/ad3d4ea6-adec-4125-be97-acecd3f21da8' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"status":"active","scrape_frequency":7}'
```

**Response:** `200 OK` — Updated store object

---

### DELETE /api/stores/:id

Soft-close a store. Sets status to `closed`, marks all products as `removed`, removes from Typesense.

**Example:**
```bash
curl -X DELETE 'http://localhost:4000/api/stores/ad3d4ea6-adec-4125-be97-acecd3f21da8' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**Response:** `200 OK`
```json
{ "message": "Store closed and products removed" }
```

---

### POST /api/stores/:id/scrape

Trigger an immediate scrape job for a store. Returns immediately; the scrape runs asynchronously via BullMQ.

**Example:**
```bash
curl -X POST 'http://localhost:4000/api/stores/ad3d4ea6-adec-4125-be97-acecd3f21da8/scrape' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**Response:** `200 OK`
```json
{
  "job_id": "4",
  "message": "Scrape job queued"
}
```

---

## Products

### GET /api/products

List products with category data.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| store_id | uuid | — | Filter by store |
| status | string | active | Filter: `active`, `discontinued`, `removed` |
| category_id | uuid | — | Filter by category |
| limit | number | 50 | Results per page |
| offset | number | 0 | Pagination offset |

**Example:**
```bash
curl 'http://localhost:4000/api/products?store_id=ad3d4ea6-adec-4125-be97-acecd3f21da8&limit=5' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**Response:** `200 OK`
```json
{
  "data": [
    {
      "id": "c9219ecf-06ce-4451-9b9d-498020255a04",
      "store_id": "ad3d4ea6-adec-4125-be97-acecd3f21da8",
      "category_id": "f1a2b3c4-...",
      "product_name": "The Hack@",
      "product_description": "Slim but not crazy slim...",
      "colour_base": null,
      "product_colour": null,
      "sizes_available": [],
      "composition": null,
      "dimensions": null,
      "gender": null,
      "age_group": null,
      "price": 32500,
      "currency": "GBP",
      "on_sale": false,
      "is_highlight": false,
      "is_promoted": false,
      "promotion_start": null,
      "promotion_end": null,
      "primary_image_url": "https://godlhzwfrvnceazuwuaq.supabase.co/storage/v1/object/public/product-images/products/.../primary.jpg",
      "thumbnail_url": "https://godlhzwfrvnceazuwuaq.supabase.co/storage/v1/object/public/product-images/products/.../thumbnail.jpg",
      "additional_images": [],
      "source_url": "https://hiutdenim.co.uk/products/the-hack-japanese-selvedge",
      "status": "active",
      "date_added": "2026-02-17T10:35:00.000+00:00",
      "date_modified": "2026-02-17T10:35:00.000+00:00",
      "categories": {
        "name": "Jeans",
        "slug": "jeans",
        "search_engine": "fashion"
      }
    }
  ],
  "total": 28
}
```

**Note:** Prices are in cents. Divide by 100 for display (e.g., 32500 = $325.00).

---

### GET /api/products/:id

Get a single product with its price history and store info.

**Example:**
```bash
curl 'http://localhost:4000/api/products/c9219ecf-06ce-4451-9b9d-498020255a04' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**Response:** `200 OK`
```json
{
  "id": "c9219ecf-06ce-4451-9b9d-498020255a04",
  "product_name": "The Hack@",
  "price": 32500,
  "currency": "GBP",
  "stores": {
    "store_name": "Hiut Denim",
    "url": "https://hiutdenim.co.uk"
  },
  "categories": {
    "name": "Jeans",
    "slug": "jeans",
    "search_engine": "fashion"
  },
  "product_price_history": [
    {
      "price": 32500,
      "currency": "GBP",
      "on_sale": false,
      "recorded_at": "2026-02-17T10:35:00.000+00:00"
    }
  ]
}
```

**Response:** `404 Not Found`
```json
{ "error": "Product not found" }
```

---

### PATCH /api/products/:id

Update admin-controlled product fields.

**Request Body** (all fields optional):
```json
{
  "is_highlight": true,
  "is_promoted": true,
  "promotion_start": "2026-03-01T00:00:00Z",
  "promotion_end": "2026-03-31T23:59:59Z",
  "category_id": "new-category-uuid"
}
```

| Field | Type | Description |
|-------|------|-------------|
| is_highlight | boolean | Mark as featured product |
| is_promoted | boolean | Mark as promoted |
| promotion_start | ISO datetime | Promotion start date |
| promotion_end | ISO datetime | Promotion end date |
| category_id | uuid | Re-assign category |

**Example:**
```bash
curl -X PATCH 'http://localhost:4000/api/products/c9219ecf-06ce-4451-9b9d-498020255a04' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"is_highlight":true}'
```

**Response:** `200 OK` — Updated product object

---

## Scrape Jobs

### GET /api/scrape-jobs

List scrape job history with store info.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| store_id | uuid | — | Filter by store |
| status | string | — | Filter: `running`, `completed`, `failed` |
| limit | number | 50 | Results per page |
| offset | number | 0 | Pagination offset |

**Example:**
```bash
curl 'http://localhost:4000/api/scrape-jobs?status=completed&limit=5' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**Response:** `200 OK`
```json
{
  "data": [
    {
      "id": "cb8830c6-a24c-49fc-8438-77a505de27ed",
      "store_id": "ad3d4ea6-adec-4125-be97-acecd3f21da8",
      "status": "completed",
      "started_at": "2026-02-17T10:28:34.771+00:00",
      "completed_at": "2026-02-17T10:42:51.862+00:00",
      "products_found": 45,
      "products_added": 13,
      "products_updated": 0,
      "products_removed": 0,
      "errors": [],
      "next_run_at": "2026-03-03T10:42:51.304+00:00",
      "created_at": "2026-02-17T10:28:34.953+00:00",
      "stores": {
        "store_name": "Hiut Denim",
        "url": "https://hiutdenim.co.uk"
      }
    }
  ],
  "total": 4
}
```

---

### GET /api/scrape-jobs/:id

Get a single scrape job by ID.

**Example:**
```bash
curl 'http://localhost:4000/api/scrape-jobs/cb8830c6-a24c-49fc-8438-77a505de27ed' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**Response:** `200 OK` — Single job object (same structure as list)

**Response:** `404 Not Found`
```json
{ "error": "Job not found" }
```

---

## Categories

### GET /api/categories

List all categories as a flat list or filtered by search engine.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| search_engine | string | — | Filter: `fashion`, `interior_design`, `lifestyle`, etc. |

**Example:**
```bash
curl 'http://localhost:4000/api/categories?search_engine=fashion' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**Response:** `200 OK`
```json
[
  {
    "id": "f1a2b3c4-...",
    "name": "Jeans",
    "slug": "jeans",
    "search_engine": "fashion",
    "parent_category_id": null,
    "description": null,
    "is_active": true
  },
  {
    "id": "a5b6c7d8-...",
    "name": "Socks",
    "slug": "socks",
    "search_engine": "fashion",
    "parent_category_id": null,
    "description": null,
    "is_active": true
  }
]
```

---

### POST /api/categories

Create a new category.

**Request Body:**
```json
{
  "name": "Dresses",
  "slug": "dresses",
  "search_engine": "fashion",
  "parent_category_id": null,
  "description": "All types of dresses"
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| name | yes | — | Category display name |
| slug | yes | — | URL-friendly identifier (must be unique) |
| search_engine | no | "fashion" | Which search engine this category belongs to |
| parent_category_id | no | null | UUID of parent category for hierarchy |
| description | no | — | Category description |

**Example:**
```bash
curl -X POST 'http://localhost:4000/api/categories' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dresses","slug":"dresses","search_engine":"fashion"}'
```

**Response:** `201 Created`
```json
{
  "id": "new-uuid",
  "name": "Dresses",
  "slug": "dresses",
  "search_engine": "fashion",
  "parent_category_id": null,
  "description": null,
  "is_active": true
}
```

**Error:** `422 Unprocessable Entity`
```json
{ "error": "name and slug are required" }
{ "error": "Category slug already exists" }
```

---

### PATCH /api/categories/:id

Update a category.

**Request Body** (all fields optional):
```json
{
  "name": "Updated Name",
  "slug": "updated-slug",
  "search_engine": "lifestyle",
  "parent_category_id": "parent-uuid",
  "description": "Updated description",
  "is_active": false
}
```

**Example:**
```bash
curl -X PATCH 'http://localhost:4000/api/categories/f1a2b3c4-...' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"description":"Premium denim jeans"}'
```

**Response:** `200 OK` — Updated category object

---

## Error Responses

All endpoints use consistent error formatting:

```json
// 400 Bad Request
{ "error": "Validation error message" }

// 401 Unauthorized
{ "error": "Missing or invalid Authorization header" }

// 403 Forbidden
{ "error": "Invalid API key" }

// 404 Not Found
{ "error": "Resource not found" }

// 500 Internal Server Error
{ "error": "Internal server error" }
```

---

## Notes

- All timestamps are ISO 8601 in UTC
- All prices are integers in **cents** (divide by 100 for display)
- UUIDs are v4 format
- Pagination uses `limit` + `offset` with `total` count in response
- Categories support hierarchical structure via `parent_category_id`
- Products are automatically categorized by AI when scraped — categories are created on-the-fly
- Scrape jobs run asynchronously; use `GET /api/scrape-jobs` to monitor progress
- The scraper automatically schedules recurring scrapes based on each store's `scrape_frequency`
