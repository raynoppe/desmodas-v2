import Typesense from 'typesense';
import config from '../../config/index.js';

export const typesenseClient = new Typesense.Client({
  nodes: [{
    host: config.TYPESENSE_HOST,
    port: config.TYPESENSE_PORT,
    protocol: config.TYPESENSE_PROTOCOL,
  }],
  apiKey: config.TYPESENSE_API_KEY,
  connectionTimeoutSeconds: 30,
  retryIntervalSeconds: 2,
  numRetries: 3,
});
