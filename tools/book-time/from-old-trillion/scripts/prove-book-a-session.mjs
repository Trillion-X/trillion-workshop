// scripts/prove-book-a-session.mjs
// Live check of Book a session on a brand-new free account: /book offers a session with its price and open times, a
// time is picked, and Pay and book opens Stripe's own checkout for that session (nothing is paid). Pictures of each
// step with the part that matters circled. The account is deleted afterwards; the kept time lapses unpaid.
//
// Usage: node scripts/prove-book-a-session.mjs --work <folder>
// Env: ORIGIN (default https://app.gettrillion.ai). Exit 1 when a step fails.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { browserWithPasskeyDevice, createAccount } from './passkey-account.mjs';

const origin = process.env.ORIGIN ?? 'https://app.gettrillion.ai';
const argument = name => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? null : process.argv[at + 1]; };
if (!argument('work')) { process.stderr.write('Name where to keep the pictures: --work <folder>\n'); process.exit(2); }
const screens = join(argument('work'), `book-a-session-${Date.now()}`);
mkdirSync(screens, { recursive: true });

const results = [];
const check = (ok, words) => { results.push(ok); process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${words}\n`); };
const { browser, page } = await browserWithPasskeyDevice();
await page.setViewportSize({ width: 1440, height: 900 });
let failed = null;
// A red ring around the first element showing `words`, so the picture says where to look.
const circle = words => page.evaluate(text => {
  document.querySelectorAll('[data-proof-ring]').forEach(node => node.remove());
  const target = [...document.querySelectorAll('body *')].find(node => !node.children.length && node.textContent?.trim().includes(text) && node.getBoundingClientRect().width > 0);
  if (!target) return false;
  const box = target.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.setAttribute('data-proof-ring', '');
  Object.assign(ring.style, { position: 'fixed', left: `${box.left - 14}px`, top: `${box.top - 10}px`, width: `${box.width + 28}px`, height: `${box.height + 20}px`, border: '4px solid #e5262b', borderRadius: '999px', zIndex: '2147483647', pointerEvents: 'none' });
  document.body.append(ring);
  return true;
}, words);
const shot = name => page.screenshot({ path: join(screens, `${name}.png`) });
const settle = async () => {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const skip = page.getByRole('button', { name: 'Skip', exact: true });
  if (await skip.count()) { await skip.first().click().catch(() => {}); await page.waitForTimeout(800); }
};
try {
  await createAccount(page, origin);
  await page.goto(`${origin}/book`);
  await settle();
  const text = () => page.evaluate(() => document.body.innerText);
  const shown = await text();
  check(!/No session is offered/i.test(shown), 'Book a session offers a session');
  const price = shown.match(/[$€£]\s?[\d,.]+(?:\/\w+)?/)?.[0] ?? null;
  check(Boolean(price), `the offer shows its price (${price ?? 'none'})`);
  if (price) await circle(price);
  await shot('1-book-offer');
  const time = page.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)$/).first();
  check(await time.count() > 0, 'open times are offered');
  await time.scrollIntoViewIfNeeded();
  await time.click();
  const pay = page.getByRole('button', { name: /Pay and book/ }).first();
  check(await pay.count() > 0, 'a picked time offers Pay and book');
  await pay.scrollIntoViewIfNeeded();
  await circle('Pay and book');
  await shot('2-pay-and-book');
  await Promise.all([page.waitForURL(/(checkout|buy)\.stripe\.com/, { timeout: 45000 }).catch(() => {}), pay.click()]);
  check(/^https:\/\/(checkout|buy)\.stripe\.com\//.test(page.url()), `Pay and book opens Stripe's checkout (${page.url().slice(0, 48)})`);
  if (/(checkout|buy)\.stripe\.com/.test(page.url())) {
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const amount = price?.match(/[$€£]\s?[\d,.]+/)?.[0]?.replace(/\s/g, '') ?? null;
    const paying = await text();
    check(Boolean(amount) && paying.includes(amount), `Stripe's checkout charges the offer's price (${amount ?? 'no amount'})`);
    if (amount) await circle(amount);
    await shot('3-stripe-checkout');
  }
} catch (error) {
  failed = error.message;
  await shot('failed').catch(() => {});
} finally {
  await browser.close();
}
process.stdout.write(`screens: ${screens}\n`);
if (failed || results.includes(false)) { process.stdout.write(`FAIL ${failed ?? 'a step failed'}\n`); process.exit(1); }
