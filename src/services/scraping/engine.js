import { PlaywrightCrawler, RequestList } from 'crawlee';
import { chromium } from 'playwright';
import config from '../../config/index.js';
import { logger } from '../../lib/logger.js';
import { randomUserAgent } from '../../lib/utils.js';
import { acceptCookies, dismissOverlays } from './cookie-handler.js';
import { autoScroll, clickLoadMore } from './scroll-handler.js';

class ScrapingEngine {
  /**
   * Run a processing function on a page using PlaywrightCrawler as primary,
   * with direct Playwright as fallback.
   */
  async runOnPage(url, options = {}, processingFn) {
    const result = await this._runCrawler(url, options, processingFn);
    if (result && !result.error) return result;

    logger.warn({ url }, 'Crawler failed, falling back to direct Playwright');
    return this._runPlaywrightDirect(url, options, processingFn);
  }

  async _runCrawler(url, options, processingFn) {
    let result = null;
    const {
      cookies = [],
      userAgent = randomUserAgent(),
      maxScrolls = 30,
      scrollPauseMs = 800,
    } = options;

    let crawlError = null;
    // Use RequestList (not default RequestQueue) to avoid cross-instance URL deduplication.
    // Crawlee's default RequestQueue persists in-process and skips URLs already seen by prior
    // crawler instances, causing requestsFinished: 0 on subsequent calls.
    const requestList = await RequestList.open(null, [url]);

    const crawler = new PlaywrightCrawler({
      requestList,
      useSessionPool: false,
      launchContext: {
        launchOptions: {
          headless: config.PLAYWRIGHT_HEADLESS,
          args: [
            '--use-mock-keychain',
            '--password-store=basic',
            '--no-sandbox',
            '--disable-dev-shm-usage',
          ],
        },
        userAgent,
      },
      requestHandlerTimeoutSecs: 180,
      maxRequestRetries: 2,
      maxRequestsPerCrawl: 1,
      preNavigationHooks: [
        async ({ page }) => {
          if (cookies.length) await page.context().addCookies(cookies);
        },
      ],
      async requestHandler({ page, log }) {
        log.info(`Processing: ${url}`);

        try {
          await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
        } catch {}

        await acceptCookies(page);
        await dismissOverlays(page);

        try {
          await page.waitForLoadState('networkidle', { timeout: 30000 });
        } catch {}

        await clickLoadMore(page);
        await autoScroll(page, maxScrolls, scrollPauseMs);

        // Wait for lazy-loaded content
        await page.waitForTimeout(1500);

        result = await processingFn({ page, log });
      },
      failedRequestHandler({ request, error }) {
        crawlError = error || new Error('Unknown crawl error');
        logger.error({ url: request.url, error: crawlError.message }, 'Crawl failed');
      },
    });

    try {
      await crawler.run();
    } catch (e) {
      crawlError = e;
    }

    if (crawlError && !result) {
      return { error: crawlError.message, url };
    }
    return result;
  }

  async _runPlaywrightDirect(url, options, processingFn) {
    const {
      cookies = [],
      userAgent = randomUserAgent(),
      maxScrolls = 30,
      scrollPauseMs = 800,
    } = options;

    let browser;
    try {
      browser = await chromium.launch({
        headless: config.PLAYWRIGHT_HEADLESS,
        args: [
          '--use-mock-keychain',
          '--password-store=basic',
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
      });

      const context = await browser.newContext({ userAgent });
      if (cookies.length) await context.addCookies(cookies);
      const page = await context.newPage();

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try {
        await page.waitForLoadState('networkidle', { timeout: 30000 });
      } catch {}

      await acceptCookies(page);
      await dismissOverlays(page);
      await autoScroll(page, maxScrolls, scrollPauseMs);

      const result = await processingFn({ page, log: logger });
      await browser.close();
      return result;
    } catch (e) {
      try { await browser?.close(); } catch {}
      return { error: e.message, url };
    }
  }

  /**
   * Fetch page HTML content, prioritizing main content area.
   */
  async fetchPage(url, options = {}) {
    return this.runOnPage(url, options, async ({ page }) => {
      const mainContent = await page.evaluate(() => {
        const selectors = [
          'main', '[role="main"]', '.main-content', '.content',
          '#main-content', '#content', '.products', '.product-grid',
          '#product-grid', '.product-list', '.collection-grid',
          '.category-products', '.collection-products', 'body',
        ];

        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) {
            const productLinks = el.querySelectorAll('a[href*="/product"], a[href*="/products"]').length;
            if (productLinks > 0 || selector === 'body') {
              return el.outerHTML;
            }
          }
        }
        return document.body.outerHTML;
      });

      const title = await page.title();
      const pageUrl = page.url();
      return { title, content: mainContent, url: pageUrl };
    });
  }

  /**
   * Extract links from a page using CSS selectors.
   */
  async extractLinks(url, selectors, options = {}) {
    return this.runOnPage(url, options, async ({ page }) => {
      const links = [];
      for (const selector of selectors) {
        const pageLinks = await page.evaluate((sel) => {
          return Array.from(document.querySelectorAll(sel)).map(a => ({
            href: a.href,
            text: (a.innerText || '').trim(),
          }));
        }, selector);
        links.push(...pageLinks);
      }
      return links;
    });
  }

  /**
   * Extract structured data from a page using configurable selector definitions.
   */
  async extractData(url, selectorsConfig = {}, options = {}) {
    return this.runOnPage(url, options, async ({ page }) => {
      const baseUrl = (() => {
        try {
          const parsed = new URL(url);
          return `${parsed.protocol}//${parsed.host}`;
        } catch {
          return null;
        }
      })();

      const extractedData = {};
      for (const [key, definition] of Object.entries(selectorsConfig)) {
        try {
          extractedData[key] = await this._resolveDefinition(page, definition, baseUrl);
        } catch (error) {
          logger.debug({ key, error: error.message }, 'Failed to extract selector');
          extractedData[key] = null;
        }
      }
      return extractedData;
    });
  }

  async _resolveDefinition(page, definition, baseUrl) {
    if (definition == null) return null;

    if (typeof definition === 'string') {
      return this._evaluateSelector(page, {
        selectors: [definition], attribute: 'innerText', all: false, baseUrl,
      });
    }

    if (Array.isArray(definition)) {
      for (const entry of definition) {
        const value = await this._resolveDefinition(page, entry, baseUrl);
        if (value != null && (!Array.isArray(value) || value.length > 0)) {
          return value;
        }
      }
      return null;
    }

    if (typeof definition === 'object') {
      if ('constant' in definition) return definition.constant;

      const selectors = [];
      if (definition.selector) selectors.push(definition.selector);
      if (Array.isArray(definition.selectors)) {
        selectors.push(...definition.selectors.filter(Boolean));
      }
      if (!selectors.length) return null;

      const result = await this._evaluateSelector(page, {
        selectors,
        attribute: definition.attribute || definition.attr || 'innerText',
        all: Boolean(definition.all),
        unique: definition.unique !== false,
        baseUrl,
      });

      if (definition.all && Array.isArray(result) && definition.joinWith) {
        return result.join(String(definition.joinWith));
      }
      return result;
    }

    return null;
  }

  async _evaluateSelector(page, config) {
    return page.evaluate((cfg) => {
      const { selectors, attribute, all, unique = true, baseUrl } = cfg;
      const attr = (attribute || 'innerText').toLowerCase();

      const normalizeUrl = (value) => {
        if (!value || typeof value !== 'string') return null;
        const trimmed = value.trim();
        if (!trimmed) return null;
        if (/^https?:\/\//i.test(trimmed)) return trimmed;
        if (/^\/\//.test(trimmed)) {
          return baseUrl ? new URL(trimmed, baseUrl).href : `https:${trimmed}`;
        }
        if (baseUrl) {
          try { return new URL(trimmed, baseUrl).href; } catch {}
        }
        return trimmed;
      };

      const readValue = (el) => {
        if (!el) return null;
        switch (attr) {
          case 'html': case 'innerhtml': return el.innerHTML;
          case 'text': case 'innertext': return el.innerText;
          case 'textcontent': return el.textContent;
          case 'value': return el.value ?? el.getAttribute('value');
          case 'src': case 'href': return normalizeUrl(el.getAttribute(attr) || el[attr]);
          default: return el.getAttribute(attr) ?? el.innerText;
        }
      };

      const clean = (v) => (v != null && typeof v === 'string') ? (v.trim() || null) : v;

      if (!all) {
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            const val = clean(readValue(el));
            if (val != null) return val;
          } catch {}
        }
        return null;
      }

      const results = [];
      const seen = new Set();
      for (const sel of selectors) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            const val = clean(readValue(el));
            if (val == null) continue;
            if (!unique || !seen.has(val)) {
              results.push(val);
              if (unique) seen.add(val);
            }
          }
        } catch {}
      }
      return results;
    }, config);
  }
}

export const scrapingEngine = new ScrapingEngine();
