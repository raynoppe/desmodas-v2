export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function extractDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function sanitizeFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

export function priceToCents(priceStr, defaultCurrency = 'GBP') {
  if (typeof priceStr === 'number') {
    return Math.round(priceStr * 100);
  }
  if (!priceStr || typeof priceStr !== 'string') return 0;

  const currencyMap = {
    '\u00A3': 'GBP', '$': 'USD', '\u20AC': 'EUR', '\u00A5': 'JPY',
    'kr': 'SEK', 'CHF': 'CHF', 'A$': 'AUD', 'C$': 'CAD',
  };

  let currency = defaultCurrency;
  for (const [symbol, code] of Object.entries(currencyMap)) {
    if (priceStr.includes(symbol)) {
      currency = code;
      break;
    }
  }

  const cleaned = priceStr.replace(/[^0-9.,]/g, '');
  // Handle comma as decimal separator (European format)
  let amount;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    // 1.234,56 format
    amount = parseFloat(cleaned.replace('.', '').replace(',', '.'));
  } else if (cleaned.includes(',') && cleaned.split(',').pop().length === 2) {
    // 12,99 format
    amount = parseFloat(cleaned.replace(',', '.'));
  } else {
    amount = parseFloat(cleaned.replace(',', ''));
  }

  return {
    cents: isNaN(amount) ? 0 : Math.round(amount * 100),
    currency,
  };
}

export function truncate(str, maxLength = 500) {
  if (!str || str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '...';
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

export function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
