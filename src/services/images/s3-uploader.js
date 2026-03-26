import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import config from '../../config/index.js';
import { logger } from '../../lib/logger.js';

const BUCKET = config.SPACES_NAME;
const BASE_URL = config.STORAGE_PUBLIC_URL
  || `https://${BUCKET}.${config.SPACES_REGION}.digitaloceanspaces.com`;

const s3Client = new S3Client({
  forcePathStyle: false,
  endpoint: config.SPACES_ENDPOINT,
  region: 'us-east-1', // DO Spaces requires this even for non-US regions
  credentials: {
    accessKeyId: config.SPACES_KEY,
    secretAccessKey: config.SPACES_SECRET,
  },
});

export class ImageUploader {
  async upload(buffer, path) {
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: path,
      Body: buffer,
      ACL: 'public-read',
      ContentType: 'image/jpeg',
      CacheControl: 'max-age=31536000',
    }));

    return `${BASE_URL}/${path}`;
  }

  /**
   * Upload primary + thumbnail for a product.
   * Returns { primaryUrl, thumbnailUrl, additionalUrls }
   */
  async uploadProductImages(productId, images) {
    const result = { primaryUrl: null, thumbnailUrl: null, additionalUrls: [] };

    if (images.primary) {
      try {
        result.primaryUrl = await this.upload(
          images.primary,
          `products/${productId}/primary.jpg`
        );
      } catch (error) {
        logger.warn({ productId, error: error.message }, 'Failed to upload primary image to S3');
      }
    }

    if (images.thumbnail) {
      try {
        result.thumbnailUrl = await this.upload(
          images.thumbnail,
          `products/${productId}/thumbnail.jpg`
        );
      } catch (error) {
        logger.warn({ productId, error: error.message }, 'Failed to upload thumbnail to S3');
      }
    }

    if (images.additional?.length) {
      for (let i = 0; i < images.additional.length; i++) {
        if (!images.additional[i]) continue;
        try {
          const url = await this.upload(
            images.additional[i],
            `products/${productId}/additional_${i}.jpg`
          );
          result.additionalUrls.push(url);
        } catch (error) {
          logger.warn({ productId, index: i, error: error.message }, 'Failed to upload additional image to S3');
        }
      }
    }

    return result;
  }

  async deleteProductImages(productId) {
    try {
      const listResponse = await s3Client.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: `products/${productId}/`,
      }));

      if (listResponse.Contents?.length) {
        await s3Client.send(new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: {
            Objects: listResponse.Contents.map(obj => ({ Key: obj.Key })),
          },
        }));
      }
    } catch (error) {
      logger.warn({ productId, error: error.message }, 'Failed to delete product images from S3');
    }
  }
}

export const imageUploader = new ImageUploader();
