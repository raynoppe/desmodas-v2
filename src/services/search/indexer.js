import { typesenseClient } from './typesense-client.js';
import { logger } from '../../lib/logger.js';

const COLLECTION = 'desmodas_products';

export class TypesenseIndexer {
  async ensureCollection() {
    try {
      await typesenseClient.collections(COLLECTION).retrieve();
      logger.info('Typesense desmodas_products collection exists');
    } catch (error) {
      logger.error('Typesense desmodas_products collection not found — create it manually or via the scraper schema');
      throw error;
    }
  }

  /**
   * Map scraper product data to the desmodas_products collection schema.
   */
  _mapToDoc(product, store) {
    const now = Math.floor(Date.now() / 1000);

    return {
      id: String(product.id),
      product_name: product.product_name || '',
      product_description: product.product_description || '',
      product_colour: product.product_colour || '',
      colour_base: product.colour_base || '',
      gender: product.gender || '',
      age_group: product.age_group || '',
      price: product.price || 0,
      currency: product.currency || 'GBP',
      on_sale: product.on_sale || false,
      sizes_available: product.sizes_available || [],
      composition: product.composition || '',
      category_name: product.category_name || '',
      category_slug: product.category_slug || '',
      store_id: store.id,
      store_name: store.store_name || '',
      primary_image_url: product.primary_image_url || '',
      thumbnail_url: product.thumbnail_url || product.primary_image_url || '',
      source_url: product.source_url || '',
      status: product.status || 'draft',
      country_of_origin: store.country_of_origin || '',
      date_added: product.date_added
        ? Math.floor(new Date(product.date_added).getTime() / 1000)
        : now,
      date_modified: product.date_modified
        ? Math.floor(new Date(product.date_modified).getTime() / 1000)
        : now,
    };
  }

  async upsertProduct(product, store) {
    const doc = this._mapToDoc(product, store);

    try {
      await typesenseClient
        .collections(COLLECTION)
        .documents()
        .upsert(doc);
    } catch (error) {
      logger.error({ productId: product.id, error: error.message }, 'Typesense upsert failed');
      throw error;
    }
  }

  async upsertBatch(products, store) {
    let success = 0;
    let failed = 0;

    for (const product of products) {
      try {
        await this.upsertProduct(product, store);
        success++;
      } catch {
        failed++;
      }
    }

    logger.info({ success, failed, storeId: store.id }, 'Batch upsert complete');
    return { success, failed };
  }

  async removeProduct(productId) {
    try {
      await typesenseClient
        .collections(COLLECTION)
        .documents(String(productId))
        .delete();
    } catch (error) {
      if (error.httpStatus !== 404) {
        logger.error({ productId, error: error.message }, 'Failed to remove from Typesense');
      }
    }
  }

  async removeStoreProducts(storeId) {
    try {
      await typesenseClient
        .collections(COLLECTION)
        .documents()
        .delete({ filter_by: `store_id:=${storeId}` });
      logger.info({ storeId }, 'Removed all store products from Typesense');
    } catch (error) {
      logger.error({ storeId, error: error.message }, 'Failed to remove store products');
    }
  }
}

export const typesenseIndexer = new TypesenseIndexer();
