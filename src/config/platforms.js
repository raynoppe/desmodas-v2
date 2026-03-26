export const PLATFORMS = {
  // Hydrogen/Oxygen (Shopify headless) must be checked BEFORE classic shopify
  hydrogen: {
    name: 'Shopify Hydrogen',
    detect: [
      'cdn.shopify.com/oxygen',
      'shopify.com/oxygen-v2',
    ],
    productSelectors: {
      name: 'h1, h2[class*="font-bold"][class*="text-xl"], h2[class*="product"], [class*="ProductTitle"]',
      price: '[class*="price"], [class*="Price"], [data-price]',
      description: '[class*="description"], [class*="Description"], .prose',
      images: 'img[src*="cdn.shopify.com/s/files"]',
      colour: '.swatch[data-color], [data-option*="Color"] option, [data-option*="Colour"] option',
      sizes: '[data-option*="Size"] option, [data-option*="size"] option',
    },
    categorySelectors: {
      nav: 'nav a[href*="/collections/"]',
      productList: 'a[href*="/products/"]',
      pagination: 'a[rel="next"]',
    },
  },

  shopify: {
    name: 'Shopify',
    detect: [
      'Shopify.shop',
      'cdn.shopify.com',
      'shopify-section',
      'myshopify.com',
    ],
    productApiPath: '/products.json',
    productSelectors: {
      name: '[data-product-title], .product__title, .product-single__title, h1.product-title',
      price: '[data-product-price], .product__price, .price--regular, .product-single__price',
      description: '.product__description, .product-single__description, [data-product-description]',
      images: '.product__media img, .product-single__photo img, [data-product-media] img',
      colour: '[data-option="Color"] .swatch, [data-option="Colour"] .swatch, .color-swatch',
      sizes: '[data-option="Size"] select option, .size-swatch',
    },
    categorySelectors: {
      nav: '.site-nav a, .main-menu a, nav[role="navigation"] a',
      productList: '.collection-products .product-card a, .grid__item .product-card a',
      pagination: '.pagination a, .pagination__next',
    },
  },

  woocommerce: {
    name: 'WooCommerce',
    detect: [
      'woocommerce',
      'wp-content/plugins/woocommerce',
      'wc-block',
      'add_to_cart',
    ],
    productSelectors: {
      name: '.product_title, h1.entry-title',
      price: '.woocommerce-Price-amount, .price ins .amount, .price > .amount',
      description: '.woocommerce-product-details__short-description, .product-description',
      images: '.woocommerce-product-gallery__image img, .wp-post-image',
      colour: '.variations select[id*="color"] option, .variations select[id*="colour"] option',
      sizes: '.variations select[id*="size"] option',
    },
    categorySelectors: {
      nav: '.product-categories a, .widget_product_categories a',
      productList: '.products .product a.woocommerce-LoopProduct-link',
      pagination: '.woocommerce-pagination a.next',
    },
  },

  magento: {
    name: 'Magento',
    detect: [
      'Magento_',
      'mage/cookies',
      'requirejs/require',
      'catalogsearch',
    ],
    productSelectors: {
      name: '.page-title span, h1.product-name',
      price: '.price-box .price, [data-price-type="finalPrice"] .price',
      description: '.product.attribute.description .value, #description .value',
      images: '.gallery-placeholder img, .product.media img',
      colour: '.swatch-attribute[data-attribute-code="color"] .swatch-option',
      sizes: '.swatch-attribute[data-attribute-code="size"] .swatch-option',
    },
    categorySelectors: {
      nav: '.nav-sections a, .navigation a',
      productList: '.products-grid .product-item a.product-item-link',
      pagination: '.pages-items a.next',
    },
  },

  bigcommerce: {
    name: 'BigCommerce',
    detect: [
      'bigcommerce',
      'cdn11.bigcommerce.com',
      'stencil-utils',
    ],
    productSelectors: {
      name: '.productView-title, h1[data-product-title]',
      price: '.productView-price .price--withoutTax, [data-product-price]',
      description: '.productView-description, [data-product-description]',
      images: '.productView-image img, [data-product-image]',
      colour: '.form-option-swatch',
      sizes: '.form-option[data-product-attribute-value]',
    },
    categorySelectors: {
      nav: '.navPages-list a, .navPage-subMenu a',
      productList: '.productGrid .product .card-figure a',
      pagination: '.pagination-item--next a',
    },
  },

  squarespace: {
    name: 'Squarespace',
    detect: [
      'squarespace',
      'static.squarespace.com',
      'sqs-block',
    ],
    productSelectors: {
      name: '.ProductItem-details-title, .product-title',
      price: '.product-price, .ProductItem-details-price',
      description: '.ProductItem-details-excerpt, .product-description',
      images: '.ProductItem-gallery img, .product-image img',
      colour: '.variant-option[data-variant-option-name="Color"]',
      sizes: '.variant-option[data-variant-option-name="Size"]',
    },
    categorySelectors: {
      nav: '.Header-nav a, nav a',
      productList: '.ProductList-item a, .products .grid-item a',
      pagination: '.ProductList-pagination-button--next',
    },
  },
};

export function detectPlatform(pageHtml, url) {
  const htmlLower = pageHtml.toLowerCase();
  const urlLower = url.toLowerCase();

  for (const [key, platform] of Object.entries(PLATFORMS)) {
    for (const indicator of platform.detect) {
      if (htmlLower.includes(indicator.toLowerCase()) || urlLower.includes(indicator.toLowerCase())) {
        return key;
      }
    }
  }

  return 'unknown';
}
