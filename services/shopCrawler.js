const { chromium } = require('playwright');

const SHOP_CONFIG = [
  {
    name: 'Brau & Rauch',
    baseUrl: 'https://www.brauundrauchshop.ch',
    searchUrl: (query) =>
      `https://www.brauundrauchshop.ch/search?q=${formatShopQuery(query)}`,
    resultSelector: 'div.product-list div.product',
    titleSelector: '.product-title a',
    priceSelector: '.product-price .price-new, .product-price .price',
    availabilitySelector: '.stock-level, .stock',
    linkSelector: '.product-title a',
  },
  {
    name: 'SIOS Shop',
    baseUrl: 'https://www.sios.ch',
    searchUrl: (query) =>
      `https://www.sios.ch/search?sSearch=${formatShopQuery(query)}`,
    resultSelector: '.product--box',
    titleSelector: '.product--title a',
    priceSelector: '.product--price .price--default',
    availabilitySelector: '.product--delivery',
    linkSelector: '.product--title a',
  },
];

const MAX_RESULTS_PER_SHOP = 5;
const PAGE_TIMEOUT = 20000;

async function searchShops(query) {
  const browser = await chromium.launch({ headless: true });
  const aggregated = [];
  try {
    for (const shop of SHOP_CONFIG) {
      // eslint-disable-next-line no-await-in-loop
      const data = await scrapeShop(browser, shop, query);
      aggregated.push(data);
    }
  } finally {
    await browser.close();
  }
  return aggregated;
}

async function scrapeShop(browser, shop, query) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const url = shop.searchUrl(query);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await page.waitForTimeout(800);

    const items = await page.$$eval(
      shop.resultSelector,
      (nodes, selectors, limit) =>
        nodes.slice(0, limit).map((node) => {
          const titleNode = node.querySelector(selectors.titleSelector);
          const linkNode = node.querySelector(selectors.linkSelector);
          const priceNode = node.querySelector(selectors.priceSelector);
          const availabilityNode = node.querySelector(selectors.availabilitySelector);
          const title = titleNode?.textContent?.trim();
          if (!title) return null;
          return {
            title,
            link: linkNode?.href ?? null,
            price: priceNode?.textContent?.trim() ?? null,
            availability: availabilityNode?.textContent?.trim() ?? null,
          };
        }).filter(Boolean),
      {
        titleSelector: shop.titleSelector,
        linkSelector: shop.linkSelector,
        priceSelector: shop.priceSelector,
        availabilitySelector: shop.availabilitySelector,
      },
      MAX_RESULTS_PER_SHOP,
    );

    return {
      shop: shop.name,
      query,
      url,
      results: normalizeLinks(items, shop.baseUrl),
    };
  } catch (error) {
    return {
      shop: shop.name,
      query,
      url: shop.searchUrl(query),
      results: [],
      error: error.message || 'Unbekannter Fehler beim Crawling.',
    };
  } finally {
    await context.close();
  }
}

function normalizeLinks(items, baseUrl) {
  return items.map((item) => {
    if (item.link && item.link.startsWith('/')) {
      return { ...item, link: `${baseUrl}${item.link}` };
    }
    return item;
  });
}

function formatShopQuery(query) {
  const trimmed = query.trim();
  if (!trimmed) return '';
  return encodeURIComponent(trimmed).replace(/%20/g, '+');
}

module.exports = {
  searchShops,
};
