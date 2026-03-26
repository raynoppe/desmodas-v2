import sharp from 'sharp';
import { logger } from '../../lib/logger.js';

const SIZES = {
  primary: { maxWidth: 1600, maxHeight: 1600, quality: 80 },
  thumbnail: { maxWidth: 400, maxHeight: 400, quality: 80 },
};

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MIN_DIMENSION = 50;
const CONCURRENT_LIMIT = 5;

export class ImageProcessor {
  /**
   * Download an image from a URL and return the buffer.
   */
  async download(imageUrl) {
    try {
      const response = await fetch(imageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DesmodasBot/1.0)' },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(`Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
      }

      return buffer;
    } catch (error) {
      logger.warn({ url: imageUrl, error: error.message }, 'Failed to download image');
      return null;
    }
  }

  /**
   * Process an image buffer into primary and thumbnail sizes.
   */
  async process(buffer) {
    if (!buffer) return null;

    try {
      const metadata = await sharp(buffer).metadata();

      if (metadata.width < MIN_DIMENSION || metadata.height < MIN_DIMENSION) {
        logger.debug({ width: metadata.width, height: metadata.height }, 'Image too small, skipping');
        return null;
      }

      const primary = await sharp(buffer)
        .resize(SIZES.primary.maxWidth, SIZES.primary.maxHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: SIZES.primary.quality, progressive: true })
        .toBuffer();

      const thumbnail = await sharp(buffer)
        .resize(SIZES.thumbnail.maxWidth, SIZES.thumbnail.maxHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: SIZES.thumbnail.quality, progressive: true })
        .toBuffer();

      return { primary, thumbnail };
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to process image');
      return null;
    }
  }

  /**
   * Download and process an image from URL.
   */
  async downloadAndProcess(imageUrl) {
    const buffer = await this.download(imageUrl);
    if (!buffer) return null;
    return this.process(buffer);
  }

  /**
   * Process multiple images with concurrency limit.
   */
  async processBatch(imageUrls) {
    const results = [];
    for (let i = 0; i < imageUrls.length; i += CONCURRENT_LIMIT) {
      const batch = imageUrls.slice(i, i + CONCURRENT_LIMIT);
      const batchResults = await Promise.allSettled(
        batch.map(url => this.downloadAndProcess(url))
      );
      results.push(
        ...batchResults.map(r => r.status === 'fulfilled' ? r.value : null)
      );
    }
    return results;
  }
}

export const imageProcessor = new ImageProcessor();
