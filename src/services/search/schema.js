// Schema matches the existing `products` collection used by the desmodas-next frontend.
// The scraper indexes into this same collection so all products appear together.
export const PRODUCTS_COLLECTION = 'products';

// Price range thresholds (in whole currency units)
function getPriceRange(price) {
  if (price <= 50) return 'low';
  if (price <= 150) return 'mid';
  return 'high';
}

export { getPriceRange };
