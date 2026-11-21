// tools/price-and-sell-by-contract/on-a-computer/serve-buy.mjs
//
// The program a computer's unit runs (serve-buy.service): /buy/<offer id> (src/buy-route.mjs) and /readyz for the front
// door's pool. Settings come from BUY_SETTINGS (the unit's settings file: origin, success_path, port, offers). The Stripe
// secret key comes from STRIPE_SECRET_KEY, which the unit loads from its sealed credential; nothing here names a key.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerBuy } from '../src/buy-route.mjs';

const PLAIN = { 'content-type': 'text/plain; charset=utf-8' };

/** The HTTP server for one settings object. `fetchImpl` is the Stripe transport (fetch by default; a test passes its own). */
export function createBuyServer({ settings, key, fetchImpl = fetch, log }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://buy.local');
    if (url.pathname === '/readyz') {
      response.writeHead(200, PLAIN);
      return response.end('ok\n');
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { ...PLAIN, allow: 'GET' });
      return response.end('Method not allowed.\n');
    }
    const answer = await answerBuy({
      pathname: url.pathname, searchParams: url.searchParams, offers: settings.offers, key,
      origin: settings.origin, successPath: settings.success_path, fetchImpl, log,
    });
    response.writeHead(answer.status, answer.headers);
    return response.end(answer.body ?? undefined);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const settings = JSON.parse(readFileSync(process.env.BUY_SETTINGS, 'utf8'));
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set.');
  createBuyServer({ settings, key }).listen(settings.port, '127.0.0.1');
}
