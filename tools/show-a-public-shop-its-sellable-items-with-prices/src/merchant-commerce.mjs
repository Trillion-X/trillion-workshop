// A public shop reads sellable items from its merchant. Prices and stock never
// come from the page or the visitor's checkout request.

const SHOP_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+myshopify\.com$/i;
const VARIANT_ID = /^gid:\/\/shopify\/ProductVariant\/([1-9][0-9]*)$/;
const QUANTITY_LIMIT = 20;
const QUERY = `query PublicShopCatalog($after: String) {
  shop { currencyCode }
  products(first: 50, after: $after, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle description onlineStoreUrl
      featuredImage { url altText }
      variants(first: 100) { pageInfo { hasNextPage } nodes { id title price inventoryQuantity inventoryPolicy } }
    }
  }
}`;
const ORDERS_QUERY = `query MerchantOrders($after: String) {
  orders(first: 50, after: $after, reverse: true, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id name createdAt displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 50) { pageInfo { hasNextPage endCursor } nodes { title quantity variant { id } } }
    }
  }
}`;
const VARIANTS_QUERY = `query MerchantCart($ids: [ID!]!) {
  nodes(ids: $ids) { ... on ProductVariant {
    id title price inventoryQuantity inventoryPolicy
    product { id title status onlineStoreUrl }
  } }
}`;

export function checkedMerchantConnection(connection, plain) {
  if (connection?.vendor !== 'shopify' || connection.status !== 'connected' || connection.can_send !== true) {
    throw new Error('Connect the merchant store before showing products.');
  }
  const domain = String(plain?.shop_domain ?? '').toLowerCase();
  if (!SHOP_DOMAIN.test(domain)) throw new Error('This merchant store has no verified Shopify address.');
  return { vendor: 'shopify', connection_id: connection.connection_id, domain };
}

export function merchantProducts(answer) {
  if (answer?.errors?.length) throw new Error('The merchant store could not list products.');
  const nodes = answer?.data?.products?.nodes;
  if (!Array.isArray(nodes)) throw new Error('The merchant store returned no usable catalog.');
  return nodes.filter(product => typeof product?.onlineStoreUrl === 'string' && product.onlineStoreUrl.startsWith('https://'))
    .map(product => ({
      id: product.id, title: product.title, description: product.description ?? '',
      image: product.featuredImage?.url ?? null, image_alt: product.featuredImage?.altText ?? product.title,
      product_url: product.onlineStoreUrl,
      more_variants: product.variants?.pageInfo?.hasNextPage === true,
      variants: (product.variants?.nodes ?? []).filter(variant => VARIANT_ID.test(variant?.id ?? '')).map(variant => ({
        id: variant.id, title: variant.title, price: variant.price,
        available: variant.inventoryPolicy === 'CONTINUE' || Number(variant.inventoryQuantity) > 0,
        stock: variant.inventoryPolicy === 'CONTINUE' ? null : Math.max(0, Number(variant.inventoryQuantity) || 0),
      })),
    })).filter(product => product.variants.length > 0);
}

export function merchantCheckoutUrl({ domain, products, items }) {
  if (!Array.isArray(items) || !items.length || items.length > 20 || !SHOP_DOMAIN.test(domain)) {
    throw new Error('Choose up to 20 items.');
  }
  const variants = products.flatMap(product => product.variants);
  const selected = new Map();
  for (const item of items) {
    const count = Number(item?.quantity);
    if (!Number.isInteger(count) || count < 1 || count > QUANTITY_LIMIT) throw new Error('Choose between 1 and 20 of each item.');
    const variant = variants.find(row => row.id === item?.variant_id);
    if (!variant || !variant.available) throw new Error('That item is no longer available.');
    selected.set(variant.id, (selected.get(variant.id) ?? 0) + count);
  }
  const cart = [];
  for (const [id, count] of selected) {
    const variant = variants.find(row => row.id === id);
    if (count > QUANTITY_LIMIT || (variant.stock !== null && count > variant.stock)) throw new Error('That item is no longer available.');
    const numericId = VARIANT_ID.exec(id)?.[1];
    if (!numericId) throw new Error('The merchant store cannot open checkout.');
    cart.push(`${numericId}:${count}`);
  }
  return `https://${domain}/cart/${cart.join(',')}`;
}

async function askMerchant({ connection, plain, send, secretName, query, after = null, variables = {} }) {
  const source = checkedMerchantConnection(connection, plain);
  if (after !== null && (typeof after !== 'string' || after.length > 512)) throw new Error('The catalog page is invalid.');
  const reply = await send({
    url: `https://${source.domain}/admin/api/2026-01/graphql.json`, method: 'POST',
    headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ query, variables: { after, ...variables } })),
    credential_injections: [{
      secret_name: secretName,
      placement: { kind: 'header', name: 'X-Shopify-Access-Token', prefix: '' },
    }], timeout_ms: 15000,
  }, { allowed_hosts: [source.domain], allowed_schemes: ['https'] });
  if (reply.status_code < 200 || reply.status_code >= 300) throw new Error(`The merchant store answered ${reply.status_code}.`);
  let answer;
  try { answer = JSON.parse(new TextDecoder().decode(reply.body)); } catch { throw new Error('The merchant store returned an unreadable catalog.'); }
  if (answer?.errors?.length) throw new Error('The merchant store could not answer this request.');
  return { source: { vendor: source.vendor, domain: source.domain }, answer };
}

export async function readMerchantCatalog(input) {
  const { source, answer } = await askMerchant({ ...input, query: QUERY });
  const pageInfo = answer?.data?.products?.pageInfo;
  return { source: { ...source, currency: answer?.data?.shop?.currencyCode ?? null }, products: merchantProducts(answer),
    next_cursor: pageInfo?.hasNextPage ? pageInfo.endCursor : null };
}

export async function readMerchantOrders(input) {
  const { source, answer } = await askMerchant({ ...input, query: ORDERS_QUERY });
  const nodes = answer?.data?.orders?.nodes;
  if (!Array.isArray(nodes)) throw new Error('The merchant store returned no usable orders.');
  return { source, next_cursor: answer.data.orders.pageInfo?.hasNextPage ? answer.data.orders.pageInfo.endCursor : null,
    orders: nodes.map(order => ({
    id: order.id, name: order.name, created_at: order.createdAt,
    payment_status: order.displayFinancialStatus, fulfillment_status: order.displayFulfillmentStatus,
    total: order.totalPriceSet?.shopMoney ?? null,
    items: (order.lineItems?.nodes ?? []).map(item => ({ title: item.title, quantity: item.quantity, variant_id: item.variant?.id ?? null })),
    more_items: order.lineItems?.pageInfo?.hasNextPage === true,
    })) };
}

export async function readMerchantCheckoutVariants(input) {
  const ids = input.items?.map(item => item?.variant_id);
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => !VARIANT_ID.test(id ?? ''))) {
    throw new Error('Choose up to 20 merchant items.');
  }
  const { source, answer } = await askMerchant({ ...input, query: VARIANTS_QUERY, variables: { ids: [...new Set(ids)] } });
  if (!Array.isArray(answer?.data?.nodes)) throw new Error('The merchant store could not check these items.');
  const products = answer.data.nodes.filter(node => node?.product?.status === 'ACTIVE' && typeof node.product.onlineStoreUrl === 'string')
    .map(node => ({ id: node.product.id, variants: [{ id: node.id, price: node.price,
      available: node.inventoryPolicy === 'CONTINUE' || Number(node.inventoryQuantity) > 0,
      stock: node.inventoryPolicy === 'CONTINUE' ? null : Math.max(0, Number(node.inventoryQuantity) || 0) }] }));
  return { source, products };
}
