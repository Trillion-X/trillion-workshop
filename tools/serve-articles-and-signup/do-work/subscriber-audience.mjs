// The subscriber rows and one-click links a site's own signup and newsletter delivery share. No database or sender lives here.
import { createHmac } from 'node:crypto';

export function subscriberTags(value = []) {
  const tags = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
    throw new TypeError('Subscriber tags must be an array of nonempty strings.');
  }
  return [...new Set(tags.map((tag) => tag.trim()))].sort();
}

export function subscriberLinks({ origin, secret }) {
  const site = new URL(origin);
  if (site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/' || site.search || site.hash) {
    throw new TypeError('The subscriber site must be an HTTPS origin, without a path, credentials or query.');
  }
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('Subscriber links need the site\'s held secret (at least 32 characters).');
  return (id) => {
    if (typeof id !== 'string' || !id) throw new TypeError('A subscriber link needs the subscriber id.');
    const token = createHmac('sha256', secret).update(`unsubscribe\n${id}`).digest('base64url');
    const link = new URL('/unsubscribe', site);
    link.searchParams.set('s', id);
    link.searchParams.set('t', token);
    return link.href;
  };
}

// Only confirmed rows may enter a send. Unknown states fail closed, malformed tags fail the page, and conflicting duplicates fail
// rather than picking a different identity for the same address. Tags are routing data, never a grant to send an unconfirmed row.
export function newsletterAudience({ subscribers, origin, secret, required_tags = [], excluded_tags = [] }) {
  if (!Array.isArray(subscribers)) throw new TypeError('Subscribers must be the rows read from this pursuit\'s own store.');
  const required = subscriberTags(required_tags), excluded = subscriberTags(excluded_tags);
  const link = subscriberLinks({ origin, secret });
  const identities = new Map(), addresses = new Map(), audience = [];
  for (const row of subscribers) {
    if (typeof row.id !== 'string' || !row.id || typeof row.email !== 'string' || !row.email.trim()) throw new TypeError('A subscriber needs an id and email.');
    const email = row.email.trim().toLowerCase();
    const tags = subscriberTags(row.tags ?? []);
    const previous = identities.get(row.id), addressId = addresses.get(email);
    if ((previous && (previous.email !== email || previous.status !== row.status || JSON.stringify(previous.tags) !== JSON.stringify(tags))) || (addressId && addressId !== row.id)) {
      throw new TypeError('The subscriber page has conflicting ids, addresses, states or tags.');
    }
    identities.set(row.id, { email, status: row.status, tags });
    addresses.set(email, row.id);
  }
  for (const [id, { email, status, tags }] of identities) {
    if (status !== 'confirmed') continue;
    if (!required.every((tag) => tags.includes(tag)) || excluded.some((tag) => tags.includes(tag))) continue;
    audience.push({ id, email, status, tags, unsubscribe_url: link(id) });
  }
  return { audience, count: audience.length, excluded: subscribers.length - audience.length };
}
