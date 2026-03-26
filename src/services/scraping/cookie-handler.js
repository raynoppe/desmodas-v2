import { logger } from '../../lib/logger.js';

const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler, button[aria-label="Accept cookies"]',
  '#CybotCookiebotDialogBodyButtonAccept, button#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '.qc-cmp2-summary-buttons .qc-cmp2-btn.qc-cmp2-accept-all, button[mode="primary"][aria-label*="Accept"]',
  'a#truste-consent-button, button#accept-cookies, button#truste-consent-button',
  '#shopify-pc__banner__btn-accept, .shopify-pc__banner__btn-accept',
  'button[data-action="accept"], button[data-testid="cookie-accept"]',
  '.cc-accept, .cc-btn.cc-allow, .cc-dismiss',
  'button:has-text("Accept all")',
  'button:has-text("Accept cookies")',
  'button:has-text("Allow all")',
  'button:has-text("I agree")',
  'button:has-text("Got it")',
];

const CLOSE_SELECTORS = [
  '[aria-label="Close"], [aria-label="close"], [aria-label*="Close"]',
  '[aria-label="Close dialog"], button[aria-label="Close dialog"]',
  '[data-testid="close"], [data-testid="close-button"]',
  '.modal-close, .Modal-close, .close, .Close, .klaviyo-close-form',
  'button:has-text("Close")',
  'button:has-text("\u00D7")',
  'button:has-text("\u2715")',
];

export async function acceptCookies(page) {
  for (const sel of CONSENT_SELECTORS) {
    try {
      const btn = await page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ timeout: 2000 });
        logger.debug({ selector: sel }, 'Clicked consent button');
        await page.waitForTimeout(1000);
        return true;
      }
    } catch {
      // Selector not found or click failed, try next
    }
  }
  return false;
}

export async function dismissOverlays(page) {
  // Try ESC first
  try { await page.keyboard.press('Escape'); } catch {}

  for (const sel of CLOSE_SELECTORS) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) {
        await page.locator(sel).first().click({ timeout: 1500 });
        logger.debug({ selector: sel }, 'Closed overlay');
        await page.waitForTimeout(800);
        return true;
      }
    } catch {}
  }

  // Remove high z-index fixed overlays as last resort
  try {
    await page.evaluate(() => {
      const isBlocking = (el) => {
        const s = window.getComputedStyle(el);
        const big = el.offsetWidth > window.innerWidth * 0.4 && el.offsetHeight > window.innerHeight * 0.3;
        const fixed = s.position === 'fixed' || s.position === 'sticky';
        const z = parseInt(s.zIndex || '0', 10);
        const txt = (el.innerText || '').toLowerCase();
        const suggestModal = txt.includes('newsletter') || txt.includes('subscribe') || txt.includes('sign up');
        return fixed && z >= 1000 && (big || suggestModal);
      };

      // Remove Klaviyo forms explicitly
      document.querySelectorAll('.klaviyo-form, [data-testid^="klaviyo-form"]').forEach(el => {
        try { el.remove(); } catch {}
      });
      document.querySelectorAll('div,section,aside,dialog,form').forEach(el => {
        try { if (isBlocking(el)) el.remove(); } catch {}
      });
    });
  } catch {}

  return false;
}
