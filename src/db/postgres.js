import pg from 'pg';
import config from '../config/index.js';

const { Pool } = pg;

const pool = new Pool({
  user: config.DB_USER,
  host: config.DB_HOST,
  database: config.DB_NAME,
  password: config.DB_PASSWORD,
  port: config.DB_PORT,
  ssl: config.DB_CERT
    ? { rejectUnauthorized: false, cert: config.DB_CERT }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

export default pool;
