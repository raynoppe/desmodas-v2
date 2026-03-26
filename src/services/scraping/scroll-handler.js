import { logger } from '../../lib/logger.js';

const LOAD_MORE_SELECTORS = [
  'button:has-text("Load more")',
  'button:has-text("Show more")',
  'button:has-text("View more")',
  'button:has-text("Load More Products")',
  'a:has-text("Load more")',
  '[data-action="load-more"]',
  '.load-more-btn, .load-more, .show-more',
];

export async function clickLoadMore(page) {
  let clicked = 0;
  for (const sel of LOAD_MORE_SELECTORS) {
    let attempts = 0;
    while (attempts < 50) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click({ timeout: 3000 });
          clicked++;
          attempts++;
          await page.waitForTimeout(1200);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
    if (clicked > 0) break;
  }
  if (clicked > 0) {
    logger.debug({ clicks: clicked }, 'Clicked load-more buttons');
  }
  return clicked;
}

export async function autoScroll(page, maxSteps = 30, pauseMs = 800) {
  let lastHeight = 0;
  let scrolled = 0;

  for (let i = 0; i < maxSteps; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(pauseMs);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight <= lastHeight) break;
    lastHeight = newHeight;
    scrolled++;
  }

  if (scrolled > 0) {
    logger.debug({ scrolls: scrolled }, 'Auto-scrolled page');
  }
  return scrolled;
}

export async function detectInfiniteScroll(page) {
  const initialHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  const newHeight = await page.evaluate(() => document.body.scrollHeight);
  // Scroll back to top
  await page.evaluate(() => window.scrollTo(0, 0));
  return newHeight > initialHeight;
}
