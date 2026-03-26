import dotenv from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Load .env file if it exists (development). In production (Docker),
// env vars are passed via env_file in docker-compose.yml.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath, override: true });
}

function required(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key, defaultValue) {
  return process.env[key] || defaultValue;
}

const config = Object.freeze({
  // PostgreSQL
  DB_HOST: required('DB_HOST'),
  DB_PORT: parseInt(optional('DB_PORT', '5432'), 10),
  DB_NAME: required('DB_NAME'),
  DB_USER: required('DB_USER'),
  DB_PASSWORD: required('DB_PASSWORD'),
  DB_CERT: optional('DB_CERT', ''),

  // S3-compatible object storage
  SPACES_ENDPOINT: required('SPACES_ENDPOINT'),
  SPACES_KEY: required('SPACES_KEY'),
  SPACES_SECRET: required('SPACES_SECRET'),
  SPACES_NAME: optional('SPACES_NAME', 'livingsexy'),
  SPACES_REGION: optional('SPACES_REGION', 'ams3'),
  STORAGE_PUBLIC_URL: optional('STORAGE_PUBLIC_URL', ''),

  // Anthropic
  ANTHROPIC_API_KEY: required('ANTHROPIC_API_KEY'),

  // Typesense
  TYPESENSE_HOST: required('TYPESENSE_HOST'),
  TYPESENSE_PORT: parseInt(optional('TYPESENSE_PORT', '443'), 10),
  TYPESENSE_PROTOCOL: optional('TYPESENSE_PROTOCOL', 'https'),
  TYPESENSE_API_KEY: required('TYPESENSE_API_KEY'),

  // Redis
  REDIS_URL: optional('REDIS_URL', 'redis://localhost:6379'),

  // Server
  PORT: parseInt(optional('PORT', '4000'), 10),
  NODE_ENV: optional('NODE_ENV', 'development'),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),

  // Scraper
  PLAYWRIGHT_HEADLESS: optional('PLAYWRIGHT_HEADLESS', 'true') === 'true',
  MAX_CONCURRENT_SCRAPES: parseInt(optional('MAX_CONCURRENT_SCRAPES', '2'), 10),
  REQUEST_DELAY_MS: parseInt(optional('REQUEST_DELAY_MS', '1500'), 10),

  // Admin
  ADMIN_API_KEY: required('ADMIN_API_KEY'),
});

export default config;
