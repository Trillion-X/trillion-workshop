import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { liftPersistentEntryStyles } from './persistent-entry-styles.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { readFile, appendFile, stat, readdir, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { describedFilesResolvedIn } from '../read-data/described-file-at.mjs';
import { canonicalUrlFor, pageShellHtml } from '../../ui/show/server-rendered-page/page-sections-html.mjs';
import { pendingDestinationHtml } from '../../ui/show/server-rendered-page/pending-destination-html.mjs';
import { keepTheLastGoodAnswer } from '@bitfield-package-entry-scope/keep-the-last-good-answer/do-work/keep-the-last-good-answer.mjs';
import { namedPriceOption } from '../read-data/named-price-option.mjs';
import { shouldRetirePublicRoute, replyRetiredPublicRoute } from './public-route-retirement.mjs';
import { composeArchiveArticleDiscovery } from './compose-article-discovery.mjs';
import { executeHostedUrlReturnAction } from './hosted-url-return-action.mjs';
import { proxyRuntimeHttp, proxyRuntimeUpgradeTo } from './runtime-upstream-transport.mjs';
import {
  readPerAccountRuntime,
  resolveRuntimeInstance,
  directoryBackedResolvers,
} from './runtime-instance-for-this-request.mjs';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readInteractionSnapshot } from '../../public-sales-page/read-data/read-interaction-snapshot.ts';
import { resolvePage } from '../../public-sales-page/read-data/resolve-page.ts';
import { resolveSelectionForPath } from '../../public-sales-page/read-data/resolve-selection-surface.ts';
import { salesPageChrome, salesPageRenderPlan } from '../../public-sales-page/read-data/sales-page-render-plan.ts';
import { deriveObserverContext } from '../../public-sales-page/read-data/derive-observer-context.ts';
import { buildPageSelectWinnerFn } from '../../public-sales-page/read-data/page-selection-adapter.ts';
import { SalesPageView } from '../../public-sales-page/show/SalesPageView.tsx';
import { PUBLIC_EDITORIAL_PAGE_CSS } from '../../screen-look/show/public-editorial-page-style.mjs';
import { LANDING_FILM_GRAIN_TEXTURE } from '../../ui/show/marketing-page/MarketingPagePrimitives.tsx';
import { findCheckoutOfferBySelector, readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';
import { pageCtaPrice } from '../read-data/page-cta-price.mjs';
import { createOfferPriceObservations, offersWithPriceDiscovery, withObservedCounts } from './offer-price-observations.mjs';
import { resolveFunnelFlow, advanceFunnel, funnelStepAtCursor, resolveCtaLinks } from '../../funnels-screen/funnel-offer-graph/read-data/resolve-funnel-flow.ts';
import { scopeRecordsForObserver } from '../../run-experiments/packages/choose-per-observer/read-data/scope-records.ts';
import { applyOfferEligibility } from '../../take-payments/read-data/offer-eligibility.ts';
import { CheckoutFlow } from '../../take-payments/packages/checkout/show/CheckoutFlow.tsx';
// The absolute machine path that used to sit here is GONE (T2, 2026-09-05). It read:
//   import { PUBLIC_SALES_PAGE_CHROME } from '/Users/<someone>/.bitfield/runtime-kit/package-sets/<one-set>/scripts/public-sales-page-chrome.mjs'
// Package source reaching into one machine's runtime folder, so this package built on exactly
// one computer and named one tenant in an import statement. Same defect the build step removed
// from the builder and left standing in the thing it builds.
//
// The obvious replacement was to copy that CSS into the page description. That is WRONG, and
// the file itself says why in its first line: it is the single source for TWO consumers, this
// server and the document-attachment record builder, and they must never diverge because the
// divergence caused a real regression once. Copying it here would have created the second
// source of truth on purpose.
//
// So the description carries the PATH and the server reads it at runtime. One source of truth,
// no compile-time coupling, and each tenant points at its own chrome.
import publicSalesPagePackage from '../../public-sales-page/things-to-store-and-run.json' with { type: 'json' };
import {
  CarrierHttpEffectError,
  encodeBrowserTargetResponse,
  executeCarrierHttpEffect,
  resolveCheckoutTransport,
} from './carrier-http-effect.mjs';
import {
  finalizeHostedSessionCarrierEffect,
  materializeHostedSessionCarrierEffect,
} from '../../take-payments/do-work/create-hosted-session.ts';

// Three defaults naming one tenant used to sit here. They are gone, for the reason the
// pageDescriptionFile comment below already gives: a default lets a host boot as somebody,
// and it must boot as nobody until it is told. That rule was written six lines from these
// three counterexamples, which is how they survived being read.
//
// Two of them were DEAD: every deployment declares BITFIELD_PARTITION and
// BITFIELD_HOST_ENTRY_SCENE_HOSTS. Deleting an unreachable default changes no behaviour.
//
// The third was LOAD-BEARING FOR THE WRONG TENANT. An undeclared app-entry host was silently
// treated as belonging to whichever tenant value had been typed into the engine first. That
// is the whole defect these defaults create: an unconfigured host does not fail closed.
// beside the redirect URL that already named the same domain one line away.
const INDEX_START_MARKER = '<!--BITFIELD_ENTRY_ROOT_START-->';
const INDEX_END_MARKER = '<!--BITFIELD_ENTRY_ROOT_END-->';
const OBSERVER_COOKIE_NAME = 'bf_observer';
const TARGET_BASIS_HEADER = 'X-Bitfield-Running-Command-List-Basis';
const TEXT_DECODER = new TextDecoder();
const SNAPSHOT_REFRESH_MS = 500;
// Every operator-facing variable in this file was named after the first tenant and is now read
// under a BITFIELD_ name, with the old name kept as a legacy alias so a deploy carrying it keeps
// working. The rename is additive on purpose: nothing about it can break a running host, and the
// aliases can be deleted once no deploy sets them.
//
// The ONLY place a tenant's name may appear in this file, and every line says so ON ITSELF rather
// than sitting inside a block, because the shared declared-rules checker exempts PER LINE and a
// block marker is invisible to it. Two exemption mechanisms for one meaning is a dialect.
//
// These are MIGRATION artifacts with an end date: a running deploy may still set the old name, and
// A generic host has no tenant-named compatibility aliases. Deployments provide
// the BITFIELD_* names directly through package-set deployment DATA.
const LEGACY_ENV_ALIASES = {};

function readEnvValue(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function env(name, fallback) {
  const direct = readEnvValue(name);
  if (direct !== undefined) return direct;
  const legacy = LEGACY_ENV_ALIASES[name];
  const carried = legacy ? readEnvValue(legacy) : undefined;
  if (carried !== undefined) {
    console.warn(`[public-entry] ${legacy} is set and is the OLD name for ${name}. It still works;`
      + ' rename it in the deploy and the alias can be deleted.');
    return carried;
  }
  return fallback;
}

const APP_ENTRY_SCENE_REFRESH_MS = Number(env('BITFIELD_APP_ENTRY_SCENE_REFRESH_MS', '30000'));

// WHERE A TENANT'S ISLAND ASSET BYTES LIVE ON DISK, declared by the deploy, with NO default.
//
// The variable used to be `customer_SITE_DIR`, defaulting to `/opt/customer/site`. That is one tenant's
// name on the operator-facing surface: a second tenant's operator would configure a variable
// named after the first. `customer_SITE_DIR` is still read as a legacy alias, so a deploy carrying
// the old name keeps working and this rename cannot break a running host.
//
// The default was deleted rather than renamed, for the reason this file already applies to the
// page description: a default is one tenant's value compiled back into the generic package. Here
// it was also pointing at nothing. SEARCHED-AND-CONFIRMED, by reading every Dockerfile in the set
// rather than grepping one word: no image COPY creates `/opt/customer/site`, no fly.toml or start
// script exports the variable, and no island asset directory exists anywhere in the package set,
// so the route could only ever 404. The comment that used to sit here named
// `deploy/fly-app/customer-landing-island/build-island.mjs` as the builder; that path does not
// exist. What is NOT established is what the RUNNING machine has, because it was built from an
// image whose Dockerfile history is unreadable.
//
// ⛔ CORRECTED 2026-09-20 BY MEASUREMENT. The clause that used to end that sentence, "the runtime
// kit is not in any repository", is FALSE and it is the expensive kind of false: it reads as a
// closed door, so the next reader stops at it instead of looking. The runtime kit is an ordinary
// checkout at `bitfield-runtime-kit`, and it declares exactly what a hosted image contains, in
// `runtime-kit-files-to-copy.x86_64-unknown-linux-musl.json`, which maps
// `references/background-runner-shell/src/static/*` onto `share/background-runner-shell/static/*`
// under this machine's `BITFIELD_RUNTIME_KIT_HOME`. So the served shell HAS a source, and an
// image that disagrees with it is stale rather than mysterious. What is genuinely absent is a
// Dockerfile, which is a missing PRODUCER and not a missing source; `native-artifact` now owns
// one. Read the manifest before concluding anything about what a running machine holds.
//
// AND THE HALVES ARE ONE UNIT. Those static files are served BY the `background-runner-shell`
// executable named in the same manifest, and they agree on when the shell may report itself
// ready, so anything replacing one of those two should replace both.
//
// ⛔ THE EVIDENCE THIS PARAGRAPH ORIGINALLY CITED WAS FALSE, and it is corrected here rather
// than quietly dropped, because it was the same defect as the repository claim above: a
// confident measurement that a later reader would have trusted. It said current static bytes on
// an older shell executable had been tried and had stopped the machine booting. The logs say
// otherwise. That deploy reached the final step and listened on the public port normally. What
// actually happened is that a page was fetched DURING the roughly two minutes this machine takes
// between booting the shell and listening, the fetch timed out, a grep of the timed out answer
// found zero occurrences of the stale marker it was looking for, and zero was read as a crash
// rather than as an empty answer. A good deploy was reverted on that reading.
//
// So the rule stands on its own merits and NOT on that story, and the durable lesson is the
// measurement discipline: an absence check against this host needs a control proving the page
// was served at all, and the logs need to show the listening step before any conclusion is drawn.
//
// Unset now means the route serves nothing AND SAYS SO ONCE, rather than 404ing in silence,
// because a tenant that declares an island bundle and gets a quiet 404 renders a blank page that
// passes every structural check.
const ISLAND_ASSET_DIR = env('BITFIELD_ISLAND_ASSET_DIR', null);
let announcedMissingIslandAssetDir = false;

// THE ASSET PREFIX IS DERIVED FROM THE BUNDLE URL THE DESCRIPTION ALREADY CARRIES.
//
// It was a constant, `/assets/customer-landing/`, and it was the last tenant name deciding server
// BEHAVIOUR rather than appearance. Building a second package set is what turned that from a
// note into a demonstration: the second tenant's `bundle_url` is `/assets/kettle/app.js`, the
// static route only answered under the first tenant's prefix, so its island would have fetched
// a 404 and rendered an empty mount point. A blank page again, from the one field nobody had
// moved.
//
// No new description key. `island.bundle_url` already states where this tenant's assets live,
// and a second field saying the same thing is two sources of truth one typo apart. The prefix
// is that URL's directory.
function islandAssetPrefixFor(description) {
  const bundleUrl = description?.island?.bundle_url;
  if (typeof bundleUrl !== 'string' || !bundleUrl.startsWith('/')) return null;
  // The PREFIX is now checked too, not only the path under it. As a constant it could not
  // contain a traversal; as data it can, and it is joined to a directory on disk. A tenant is
  // trusted input, but "trusted input joined to a filesystem path" is how this goes wrong
  // everywhere it goes wrong, and the check costs one comparison.
  if (bundleUrl.includes('..') || bundleUrl.includes('\0')) return null;
  const lastSlash = bundleUrl.lastIndexOf('/');
  return lastSlash > 0 ? bundleUrl.slice(0, lastSlash + 1) : null;
}
const STATIC_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.otf': 'font/otf', '.ttf': 'font/ttf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary',
};

const APP_IDENTITY_ASSET_PATHS = new Set([
  '/favicon.ico',
  '/favicon.png',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/site.webmanifest',
]);

async function appIconExists() {
  const iconFile = await appIconFile();
  if (!iconFile) return false;
  try {
    return (await stat(iconFile)).isFile();
  } catch {
    return false;
  }
}

function appIdentityHeadLinks(hasIcon) {
  if (!hasIcon) return '';
  return [
    '<link rel="icon" href="/favicon.png" type="image/png">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
  ].join('\n');
}

async function appIdentityDocument(html) {
  if (typeof html !== 'string'
    || !html.includes('</head>')
    || /rel=["'](?:shortcut )?icon["']/i.test(html)
    || !await appIconExists()) return html;
  return html.replace('</head>', `${appIdentityHeadLinks(true)}\n</head>`);
}

// Answer with the bytes of one file, or say it could not. The ONE place this server turns a path
// on disk into an HTTP answer.
//
// Extracted rather than copied when the static-site fallthrough arrived, because that route wanted
// exactly this and a second copy is how the two drift: an extension added to one map, a HEAD case
// fixed in one branch. Knows nothing about who is asking or which route wanted it, so both callers
// pass a path they have already decided is theirs to serve.
async function answerWithFileBytes(req, res, filePath, extraHeaders = {}) {
  let bytes;
  try {
    const found = await stat(filePath);
    if (!found.isFile()) return false;
    bytes = await readFile(filePath);
  } catch {
    return false;
  }
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  res.writeHead(200, {
    'Content-Type': STATIC_CONTENT_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store, max-age=0',
    'Content-Length': bytes.length,
    ...extraHeaders,
  });
  if (req?.method === 'HEAD') res.end();
  else res.end(bytes);
  return true;
}

async function serveAppShellStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!isAppEntryHost(req) || !url.pathname.startsWith('/src/')) return false;
  const assetName = url.pathname.slice('/src/'.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(assetName)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
    res.end('app shell asset not found');
    return true;
  }
  if (await answerWithFileBytes(req, res, join(config.staticDir, assetName))) return true;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
  res.end('app shell asset not found');
  return true;
}

async function serveAppIdentityAsset(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!APP_IDENTITY_ASSET_PATHS.has(url.pathname)) return false;
  if (!isPublicHost(req) && !isAppEntryHost(req)) return false;

  // Keep legacy browser requests valid without serving PNG bytes under an ICO or SVG MIME/path.
  // Every current document links the explicit PNG URL below; older tabs that ask for a favicon
  // by convention are sent to those same bytes with their true media type.
  if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
    res.writeHead(302, {
      Location: '/favicon.png',
      'Cache-Control': 'no-store, max-age=0',
      'Content-Length': '0',
    });
    res.end();
    return true;
  }

  if (url.pathname === '/site.webmanifest') {
    const identity = await appIdentityFromBundle();
    const hasIcon = await appIconExists();
    if (identity && hasIcon) {
      const bytes = Buffer.from(JSON.stringify({
        name: identity.app_name,
        short_name: identity.app_name,
        start_url: '/',
        scope: '/',
        display: 'standalone',
        icons: [{
          src: '/apple-touch-icon.png',
          sizes: '1024x1024',
          type: 'image/png',
        }],
      }));
      res.writeHead(200, {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'Content-Length': bytes.length,
      });
      if (req.method === 'HEAD') res.end();
      else res.end(bytes);
      return true;
    }
  } else {
    const iconFile = await appIconFile();
    if (iconFile
      && await answerWithFileBytes(req, res, iconFile, { 'Content-Type': 'image/png' })) {
      return true;
    }
  }

  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
  });
  res.end('app identity asset not found');
  return true;
}

async function serveIslandAsset(req, res, url, prefix) {
  if (!ISLAND_ASSET_DIR) {
    if (!announcedMissingIslandAssetDir) {
      announcedMissingIslandAssetDir = true;
      console.error('[public-entry] a host asked for an island asset and no BITFIELD_ISLAND_ASSET_DIR'
        + ` is set, so ${prefix}* cannot be served. The description declares an island bundle; the`
        + ' deploy must declare where its bytes live.');
    }
    return false;
  }
  const rel = url.pathname.slice(prefix.length);
  if (!rel || rel.includes('..') || rel.includes('\0')) return false;
  // The prefix is a URL path and the files live under the same path on disk, so the tenant's
  // assets are found by the same string that addresses them. `..` and NUL are rejected above
  // before the prefix is ever joined to a path, which is why a description-supplied prefix is
  // no more dangerous than the constant it replaced.
  const filePath = `${ISLAND_ASSET_DIR}${prefix}${rel}`;
  return answerWithFileBytes(req, res, filePath);
}

// Emit a client-hydrated island page from a description. Knows nothing about who it is for.
//
// The state envelopes are named by the DESCRIPTION rather than by this code. That was the
// subtlest product leak in the file: `window.__customerPatronPolicyForThisPage__` is a contract
// between a server and a browser bundle, and hardcoding the tenant's name into it meant the
// bundle could only ever be that tenant's bundle. A second tenant ships its own bundle and
// names its own envelopes, in DATA, and this function does not change.
// The files a tenant's own site directory currently holds under one served path, as the URL paths
// a browser can ask for, sorted so the same directory always yields the same page.
//
// Knows nothing about what the files are for. A hero mosaic, a logo wall, a photo strip and a font
// list are the same question asked by different tenants, and the answer is whatever is on disk, so
// adding one is a DATA row rather than a code path. Empty on every failure, because this runs while
// BUILDING an answer and a listing that throws would replace a page with its own problem.
async function servedDirectoryPaths(pathPrefix) {
  if (!config.staticSiteDir) return [];
  if (typeof pathPrefix !== 'string' || !pathPrefix.startsWith('/')) return [];
  if (pathPrefix.includes('..') || pathPrefix.includes('\0')) return [];
  const withoutTrailingSlash = pathPrefix.replace(/\/+$/, '');
  try {
    const found = await readdir(`${config.staticSiteDir}${withoutTrailingSlash}`, { withFileTypes: true });
    return found
      .filter((entry) => entry.isFile())
      .map((entry) => `${withoutTrailingSlash}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

// WHERE AN ENVELOPE'S VALUE COMES FROM, as a capability map rather than a branch.
//
// `state_envelopes` used to read one hardcoded source, the landing-offer table, which is a closed
// set with one member and reads as no set at all. A tenant wanting an envelope filled from anything
// else had to edit this file. Each entry here binds a `from` to a resolver; adding a source is a row
// here, adding an ENVELOPE is DATA in the description, and this dispatcher never changes.
const ENVELOPE_SOURCES = {
  landing_offer: (spec, context) => context.landingOffers?.[spec.key] ?? { status: 'unavailable' },
  served_directory: async (spec) => {
    const paths = await servedDirectoryPaths(spec.path);
    return paths.length ? { status: 'available', paths } : { status: 'unavailable' };
  },
};

// A description may name its source explicitly, `{from, key}` or `{from, path}`, or write the bare
// string that meant a landing offer before there was a choice. The shorthand is kept because live
// descriptions carry it, and it is normalized HERE so exactly one shape reaches the resolvers.
function envelopeSpecOf(value) {
  if (typeof value === 'string') return { from: 'landing_offer', key: value };
  return value && typeof value === 'object' ? value : null;
}

async function stateEnvelopeScripts(island, context) {
  const entries = Object.entries(island.state_envelopes ?? {});
  const scripts = await Promise.all(entries.map(async ([globalName, value]) => {
    const spec = envelopeSpecOf(value);
    const resolve = spec && ENVELOPE_SOURCES[spec.from];
    if (!resolve) {
      // An undeclared source is an unavailable envelope and a line saying so, never a throw and
      // never a silent omission: the bundle already renders `unavailable` as an absent card, and a
      // missing `window.` global is a ReferenceError in someone's browser instead.
      console.error(`[public-entry] envelope ${globalName} names source ${JSON.stringify(spec?.from)},`
        + ` which nothing here provides. Serving it as unavailable.`);
      return `<script>window.${globalName}={"status":"unavailable"};</script>`;
    }
    const envelope = await resolve(spec, context);
    return `<script>window.${globalName}=${JSON.stringify(envelope).replace(/</g, '\\u003c')};</script>`;
  }));
  return scripts.join('');
}

// This server resolves what only it can know, the state envelopes, and hands
// the description onward. It writes no markup: the shared UI owner is the one
// place tags are authored, and a process emitting its own was how a page could
// declare a bundle nothing built and answer 200 with nothing on it.
async function islandShellHtml(description, landingOffers = {}) {
  const stateScripts = await stateEnvelopeScripts(description?.island ?? {}, { landingOffers });
  return pageShellHtml(description, { stateScripts });
}

// ⛔ A CLOSED SET, AND THE FUNCTION IS NAMED AFTER ITS ONLY MEMBER. A landing envelope can be
// projected from a MONTHLY price option and from nothing else: `interval === 'month'`, with a
// legacy arm enumerating two `payment_timing` values. The near-term member that breaks it is not
// hypothetical, it is ANNUAL PRICING, and a one-time price or a weekly plan break it the same way.
// `landing_offers` DATA carries `{offer_id, fields}` with no way to say WHICH price option, so a
// tenant cannot express the choice even though everything around this is DATA-driven.
//
// The shape: the selector belongs in the `landing_offers` entry, so this becomes a generic
// `priceOptionForLanding(offer, selector)` and adding annual is a DATA row.
//
// THE DELETE STEP IS SETTLED, AND IT NEEDS NO LIVE RECORD READ. The first pass of this comment said
// the question was what the live offer records hold, which was the wrong question. Read the CHARGE
// PATH instead: `checkout/do-work/gate-checkout.ts:998` takes `input.priceOptionId` from its caller
// and charges what it is told.
//
// ⛔ THIS COMMENT USED TO CONTINUE "NOTHING IN `checkout` SELECTS AMONG AN OFFER'S PRICE OPTIONS",
// AND THAT WAS FALSE. It was published after reading the charge path and the offer decoder and
// finding no selection in either. `checkout/show/CheckoutFlow.tsx:226` EXPORTS
// `offerPriceForDisplay(offer)`, the first PAID option else the first, documented there as the SSOT
// for both the displayed price and the default selection. A negative claim can be true of the files
// you opened and false of the package, so name every LAYER that could hold the rule rather than the
// one that would hold it if the design were clean.
//
// There are THREE rules for one question: checkout's first-paid-else-first; this one's
// `interval === 'month'`; and `public-sales-page`'s first option carrying a numeric `amount_cents`
// INCLUDING zero. For the same offer those can show three different prices, each claiming to be what
// is charged. What stays true is that the CHARGE path selects nothing, so an inferred option is only
// a DEFAULT for when nobody named one, and a default is not a decision.
//
// So this whole function is a DELETION, not a generalisation. The price option is named by id by
// whoever sells it, exactly as `offer_id` already is: `landing_offers` gains a price option id
// beside the offer id, and the envelope already carries `priceOptionId` as a field the tenant's
// bundle validates, so the id is in the shape already. That removes the interval arm, the
// `payment_timing` arm and the question about legacy records in one move, because no shape is
// inspected at all.
//
// Left in place for exactly one more step: adding the id is a DATA change to every installed page
// description, so it lands with those rows and their tests rather than ahead of them, which would
// leave every tenant's envelope unavailable in between.
//
// ⚠️ THAT COST IS UNVERIFIED, and it is recorded as unverified on purpose. The identical sentence
// guarded `resolveEffectiveOffer` below until a live read showed the funnel population is ZERO and
// the migration it priced did not exist. This one is a DIFFERENT population and the funnel result
// does NOT transfer to it. The attempt, so the next reader starts from a known state instead of
// repeating it: `ask-the-running-app-what-it-can-do.mjs read-record --app-id the selected app --partition
// the selected app --address "package-set-records::public-page-description-records"` returns
// `{"found": false}`, AND SO DOES the `commercial-offer-records` control on the same partition,
// which is known-live. A failing control means that address form or partition is wrong, so both
// zeroes are the instrument and neither is an answer. Measure this before quoting the cost again;
// the working shape for a live read is `scan-current-under-path --path current-item` filtered on
// `payload.kind`, because path segments are address-hashed.
function priceOptionForLanding(offer, requestedPriceOptionId) {
  const options = Array.isArray(offer?.price_options) ? offer.price_options : [];
  if (typeof requestedPriceOptionId === 'string' && requestedPriceOptionId.trim()) {
    return options.find((option) => option.id === requestedPriceOptionId.trim());
  }
  const exactMonthly = options.find((option) => option.interval === 'month');
  if (exactMonthly) return exactMonthly;
  const legacyMonthly = options.filter((option) => (
    !option.interval
    && (option.payment_timing === 'subscription' || option.payment_timing === 'recurring')
  ));
  return legacyMonthly.length === 1 ? legacyMonthly[0] : undefined;
}

// WHICH OFFERS FILL WHICH ENVELOPES, AND WHAT EACH ENVELOPE CARRIES, are both the tenant's.
//
// The envelope belongs to the tenant's browser bundle: that bundle declares the types, validates
// every field harder than this server does, and asserts the offer id itself, rendering nothing
// when it disagrees. ⛔ THAT LAST CLAUSE DESCRIBES A DEFECT AND THIS COMMENT USED TO READ IT AS A
// DESIGN PROPERTY. The bundle at `bitfield-site/hosts/bitfield-site/src/customer/customerPricingPolicy.ts`
// compares `offerId` against two string literals (lines 31 and 87), and that was harmless only
// while this server also had those ids compiled in. The ids are DATA now, so a second tenant
// declaring its own ids gets an envelope this server publishes, the bundle silently refuses, and a
// BLANK PRICING CARD with no error at either end. The bundle reads each envelope from its own
// named global, so the slot already says which envelope it is and the id equality test is a second
// discriminant for a question already answered, kept in another repository. It is a deletion, and
// it is written up with an exact receipt in §11aa of this package's plan.
//
// This server is a projector into someone else's shape, so it reads both the
// id and the shape from the same description that names the bundle. Keys match
// `island.state_envelopes` on purpose rather than by accident: one vocabulary for which envelope
// is meant, not two a typo apart.
//
// THE KEY SET IS NOT ENUMERATED HERE, and that is the point. An earlier pass moved the two offer
// IDS into data and left `patronPolicy` and `systemOffer` written into FIVE places: the
// projection, the readiness test, the legacy-claim test, the line copying a kept file into
// memory, and the no-answer fallback. A tenant adding a third envelope would have added a data
// row and been silently dropped, which is the worse failure because it reports nothing. The count
// grew twice while removing them, once from a test and once from a sweep, which is the argument
// for both: a capability test finds the sites that change behaviour, a name sweep finds the rest.
// Everything below iterates what the tenant declared.
//
// A field says WHERE it comes from as structure rather than as an encoded path, so a dumb reader
// gets every part without string work: `{ "from": "price_option", "key": "amount_cents" }`.
// `offer` and `price_option` are the two things a landing envelope is projected from, which is a
// property of the projection itself and not a list that grows with tenants.
//
// No defaults anywhere. A tenant that declares nothing gets unavailable cards, which the keeper
// treats as no answer, so previous good prices survive. A default here would be one tenant's
// product compiled back into the generic package under a new name.
function landingEnvelopesFor(description) {
  const declared = description?.landing_offers;
  return declared && typeof declared === 'object' && !Array.isArray(declared) ? declared : {};
}

// The ONE numeric rule, stated as a rule rather than as a field name. Every declared numeric
// field must be a safe integer above zero, because a landing envelope's numbers are money and a
// non-positive or unsafe price is not a smaller version of a correct one: kept, it would displace
// the last good price and render a dead buy button. SEARCHED-AND-CONFIRMED that nothing upstream
// does this: `checkout/read-data/read-offers.ts` checks `typeof === 'number'` and never
// positivity, so this server is the only guard before the keeper.
function landingFieldValueIsUsable(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return true;
}

function projectLandingEnvelope(offer, priceOption, fields) {
  const projected = {};
  for (const [envelopeField, source] of Object.entries(fields ?? {})) {
    const from = source?.from === 'offer' ? offer : source?.from === 'price_option' ? priceOption : null;
    const key = typeof source?.key === 'string' ? source.key : null;
    if (!from || !key) return null;
    const value = from[key];
    if (!landingFieldValueIsUsable(value)) return null;
    projected[envelopeField] = value;
  }
  return projected;
}

function landingEnvelopeFor(records, spec) {
  try {
    const wantedId = typeof spec?.offer_id === 'string' && spec.offer_id.trim() ? spec.offer_id.trim() : null;
    if (!wantedId) return { status: 'unavailable' };
    const offer = readCheckoutOffers(records?.commercialOffers).find((candidate) => candidate.id === wantedId);
    const priceOption = priceOptionForLanding(offer, spec?.price_option_id);
    if (!offer || !priceOption) return { status: 'unavailable' };
    const projected = projectLandingEnvelope(offer, priceOption, spec?.fields);
    if (!projected) return { status: 'unavailable' };
    return { status: 'ready', offerId: offer.id, priceOptionId: priceOption.id, ...projected };
  } catch (error) {
    console.error('[public-entry] live landing offer invalid', error);
    return { status: 'unavailable' };
  }
}

// The two named projections that used to sit here are DELETED rather than kept beside the
// generic one, which is the half that makes this a genericisation instead of an extra layer:
// `systemOfferForLanding` and `patronPolicyForLanding` each hand-listed the fields of one
// envelope, and both are now the same `landingEnvelopeFor` reading a declared field map.

// OFFERS BELONG TO A TENANT, NOT TO THE PROCESS, and until 2026-09-05 every piece of this
// subsystem was process-wide: one cache file, one in-memory value, one refresh throttle, one
// keeper built at module scope with no request in hand. One binary serves many hosts, so two
// tenants shared one set of prices and whichever resolved first won for both.
//
// It was never visible because the two offer ids were hardcoded, so a process could only ever
// mean one tenant. That is the ordering this change had to respect: scoping FIRST, then the ids
// into DATA. Ids-first would have handed every tenant the same offers under different names,
// which is worse than the honest single-tenant assumption it replaced.
//
// Everything below is per tenant now: its own file, its own memory, its own throttle, its own
// keeper. That last one matters most, because the keeper's third invariant is "a source that
// answers with NOTHING must not overwrite a good kept value", and a shared keeper made one
// tenant's silence able to discard another tenant's good prices.
//
// The live-offer cache must survive process restarts: every deploy restarts this server while
// the engine replays its log for minutes, and an in-memory cache alone leaves the pricing card
// "unavailable" (a disabled buy button) for that whole window. Last-known-good offers persist on
// the install volume, so pricing serves instantly across deploys and replays.
function installRoot() {
  return process.env.BITFIELD_INSTALL_ROOT || '/var/lib/bitfield';
}

// The key is the tenant's OWN declared identity, its first host, rather than the request's host,
// so a tenant serving several hostnames keeps one set of prices instead of one per hostname.
// A single description serving every host has no `hosts` key by design, and gets a fixed key.
function tenantKeyFor(description) {
  const declared = Array.isArray(description?.hosts) ? description.hosts : [];
  const first = declared.find((host) => typeof host === 'string' && host.trim());
  if (!first) return 'the-only-described-tenant';
  return first.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
}

// The legacy path is read when the tenant's own file is absent, so a deploy carrying prices kept
// under the old process-wide name does not serve a disabled buy button until the engine answers.
// The first successful keep writes the per-tenant file and the legacy one stops being consulted.
// Two tenants on a first boot both read it, which is exactly today's behaviour and converges.
const LEGACY_SHARED_OFFERS_FILE = 'landing-offers-cache.json';

// Both envelopes must name ids this tenant declares. Requiring BOTH rather than either is the
// point: a partial match means the file was built from a different mix of offers, and half of
// someone else's prices is not a smaller version of the right answer.
function keptOffersBelongTo(parsed, description) {
  const declared = Object.entries(landingEnvelopesFor(description));
  if (declared.length === 0) return false;
  return declared.every(([envelopeKey, spec]) => {
    const wantedId = typeof spec?.offer_id === 'string' ? spec.offer_id.trim() : '';
    return Boolean(wantedId) && parsed?.[envelopeKey]?.offerId === wantedId;
  });
}

// Offers are only worth keeping when BOTH halves priced. A half-priced answer would render a
// card with a disabled buy button, which is worse than the previous good price, so it is
// treated as no answer at all rather than as an answer that happens to be bad.
function landingOffersAreReady(offers, description) {
  const declared = Object.keys(landingEnvelopesFor(description));
  // An empty declaration is NOT vacuously ready. `every` over nothing is true, which would keep an
  // empty answer forever and make a tenant that declares no envelopes look permanently priced.
  if (declared.length === 0) return false;
  return declared.every((envelopeKey) => offers?.[envelopeKey]?.status === 'ready');
}

// THE KEPT TIER IS TWO DEEP, and that is not an accident of history. Memory answers within the
// process; the file answers across the restarts a deploy causes while the engine replays its
// log for minutes. Reading them in that order makes the file cost nothing on the warm path.
// Both tiers are per tenant now, so the memory tier cannot answer one host with another's price.
function makeKeptOffersReader(state, file, description) {
  return async function readKeptLandingOffers() {
    if (state.cache) return state.cache;
    const legacy = `${installRoot()}/${LEGACY_SHARED_OFFERS_FILE}`;
    for (const candidate of [file, legacy]) {
      try {
        const parsed = JSON.parse(await readFile(candidate, 'utf8'));
        if (!landingOffersAreReady(parsed, description)) continue;
        // THE LEGACY FILE IS CLAIMED, NOT INHERITED. It was written before offers were per
        // tenant, so it carries no owner, and letting any tenant read it would rebuild the exact
        // collision this change removes: on a first boot every tenant would serve whoever kept
        // last. It carries the offer ids it was built from, so a tenant may take it only when
        // those are the ids that tenant declares. The tenant that actually owns those prices
        // keeps them across the deploy; everyone else starts empty, which is correct and quiet.
        if (candidate === legacy && !keptOffersBelongTo(parsed, description)) continue;
        // The declared keys, not a literal pair. This line named `patronPolicy` and `systemOffer`
        // and was the LAST place the envelope key set was hardcoded, so a tenant declaring a
        // third envelope had it read, judged ready, and then dropped on the way into memory.
        // Caught by requiring a novel key to REACH THE PAGE rather than by requiring the other
        // tenant's values to be absent, which the old code already satisfied.
        state.cache = Object.fromEntries(
          Object.keys(landingEnvelopesFor(description)).map((envelopeKey) => [envelopeKey, parsed[envelopeKey]]),
        );
        return state.cache;
      } catch (error) {
        // A first boot has no file, and that is the normal case rather than a fault.
        if (error?.code !== 'ENOENT') {
          console.error(`[public-entry] kept landing offers unreadable at ${candidate}:`,
            String(error?.message ?? error).slice(0, 160));
        }
      }
    }
    return null;
  };
}

// The temp name was `${file}.tmp`, ONE name shared by every writer, which is the same defect
// found and fixed twice already today in the scene path and is worse here: two concurrent
// writers do not merely race to rename, they write into the same open file and rename each
// other's half. A per-attempt name makes that collision impossible rather than unlikely, and
// the pending file is removed on the failure path so only a crash leaves one behind.
let landingOffersKeepAttempts = 0;
function makeOffersKeeper(state, file) {
  return async function keepLandingOffers(offers) {
    state.cache = offers;
    const pending = `${file}.${Date.now().toString(36)}-${(landingOffersKeepAttempts += 1)}-${Math.random().toString(36).slice(2, 8)}.pending`;
    try {
      await writeFile(pending, JSON.stringify({ ...offers, persisted_at: new Date().toISOString() }), 'utf8');
      await rename(pending, file);
    } catch (error) {
      // Failing to keep costs the NEXT restart its prices. It must never cost THIS request its
      // page, which is why this only logs, and why the cleanup below cannot raise either.
      console.error('[public-entry] landing offers not kept:',
        String(error?.message ?? error).slice(0, 160));
      await rm(pending, { force: true }).catch(() => {});
    }
  };
}

// A source that never answers is indistinguishable from one that answers slowly, and a visitor
// cannot wait for the difference. The bound belongs on the SOURCE rather than on the whole
// lookup: the old code raced the entire read against 15 seconds and so returned `unavailable`
// on a slow engine even when good kept prices were sitting right there. Timing out into "no
// answer" hands the question back to the kept tier, which is the whole point of keeping.
function stopWaitingAfter(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

// PRICES THAT MOVE WITH SALES. An offer whose policy carries `price_discovery`
// derives its minimum from two observed counts: paid checkouts, read from the
// payment provider, and distinct people who had the price on screen, reported
// by the page. Both are merged into the offer records HERE, the one place every
// page and every checkout on this host reads offers from, so what a buyer is
// shown and what checkout accepts are the same number. Offers without the rule
// pass through untouched. See ./offer-price-observations.mjs.
let offerPriceObservationsStore = null;
function offerPriceObservations() {
  if (offerPriceObservationsStore) return offerPriceObservationsStore;
  let providerSecret = null;
  try {
    const bindings = JSON.parse(process.env.BITFIELD_CARRIER_CREDENTIAL_BINDINGS_JSON || '{}');
    const names = Object.values(bindings).filter((name) => typeof name === 'string');
    providerSecret = names.map((name) => process.env[name]).find((value) => typeof value === 'string' && value) ?? null;
  } catch {
    providerSecret = null;
  }
  offerPriceObservationsStore = createOfferPriceObservations({
    file: `${installRoot()}/offer-reached-price.jsonl`,
    saltFile: `${installRoot()}/offer-reached-price.salt`,
    readText: (path) => readFile(path, 'utf8'),
    appendText: (path, text) => appendFile(path, text, 'utf8'),
    writeText: (path, text) => writeFile(path, text, 'utf8'),
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    providerSecret,
    fetchImplementation: fetch,
  });
  return offerPriceObservationsStore;
}

async function withObservedPrices(payload) {
  if (!payload || offersWithPriceDiscovery(payload).length === 0) return payload;
  return withObservedCounts(payload, await offerPriceObservations().counts());
}

// The page reports that a person had these offers' prices on screen. Counted
// once per person per offer (see the store); anything else in the body is ignored.
async function handleReachedPrice(req, res) {
  const request = await readBoundedJsonBody(req, 4096).catch(() => null);
  const offerIds = Array.isArray(request?.offer_ids)
    ? request.offer_ids.filter((id) => typeof id === 'string').slice(0, 10)
    : [];
  const forwarded = String(req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const address = forwarded || req.socket?.remoteAddress || '';
  const known = offersWithPriceDiscovery(await readCommercialOffers().catch(() => null));
  await offerPriceObservations().recordReachedPrice({ address, offerIds, knownOfferIds: known })
    .catch((error) => console.error('[public-entry] could not record who reached the price', String(error?.message ?? error).slice(0, 160)));
  res.writeHead(204, { 'Cache-Control': 'no-store, max-age=0' });
  res.end();
}

let packagedCommercialOffersPromise = null;
let announcedCommercialOfferSourceFailure = false;

async function readPackagedCommercialOffers() {
  if (!config.commercialOffersFile) return null;
  packagedCommercialOffersPromise ??= readFile(config.commercialOffersFile, 'utf8')
    .then((bytes) => JSON.parse(bytes))
    .catch((error) => {
      console.error(`[public-entry] packaged commercial offers unreadable at ${config.commercialOffersFile}:`,
        String(error?.message ?? error).slice(0, 160));
      return null;
    });
  return packagedCommercialOffersPromise;
}

async function readCommercialOffers() {
  try {
    const live = await stopWaitingAfter(readCurrentPayload(LABELS.commercialOffers), 15_000);
    if (live !== null) return withObservedPrices(live);
  } catch (error) {
    if (!announcedCommercialOfferSourceFailure) {
      announcedCommercialOfferSourceFailure = true;
      console.error('[public-entry] live commercial offers unavailable; using the packaged offers:',
        String(error?.message ?? error).slice(0, 160));
    }
  }
  return withObservedPrices(await readPackagedCommercialOffers());
}

function makeOfferSourceReader(description) {
  return async function askTheOfferSource() {
    const commercialOffers = await readCommercialOffers();
    if (commercialOffers === null) return null;
    const offers = Object.fromEntries(
      Object.entries(landingEnvelopesFor(description))
        .map(([envelopeKey, spec]) => [envelopeKey, landingEnvelopeFor({ commercialOffers }, spec)]),
    );
    // Not ready is NO ANSWER, so invariant 3 of the holder keeps the previous good prices rather
    // than overwriting them with an unavailable card. The old code got this right by hand, in a
    // condition that had to be repeated in both the keep branch and the fall-back branch.
    return landingOffersAreReady(offers, description) ? offers : null;
  };
}

// ONE OWNER PER TENANT, built the first time that tenant is asked for and then reused. Everything
// a tenant's offers need is inside it: its file, its memory, its throttle, its keeper. Nothing
// here is reachable without a description, which is the structural half of the fix; the previous
// shape could not be called wrongly because it could not be called with a tenant at all.
const offerOwnersByTenant = new Map();

function offerOwnerFor(description) {
  const key = tenantKeyFor(description);
  const existing = offerOwnersByTenant.get(key);
  if (existing) return existing;
  const state = { cache: null, refreshPromise: null, lastCheck: 0 };
  const file = `${installRoot()}/landing-offers-cache.${key}.json`;
  const owner = {
    state,
    answer: keepTheLastGoodAnswer({
      askTheSource: makeOfferSourceReader(description),
      readWhatWasKept: makeKeptOffersReader(state, file, description),
      keepThisAnswer: makeOffersKeeper(state, file),
    }),
    readWhatWasKept: makeKeptOffersReader(state, file, description),
  };
  offerOwnersByTenant.set(key, owner);
  return owner;
}

// Same read-throttle and in-flight dedupe as the prices below, for the same reasons.
let pageDescriptionRefreshPromise = null;
let lastPageDescriptionCheck = 0;
// The descriptions this process last managed to read, held so a throttled
// request answers with them instead of with nothing.
let lastGoodPageDescriptions = null;
// Takes the REQUEST, because who a page is for is a property of the host it was asked of, not
// of the process. That argument is what turns "this binary is a tenant" into "this binary
// serves tenants", which is the whole of T3.
async function livePageDescription(req) {
  if (!pageDescriptionRefreshPromise
      && Date.now() - lastPageDescriptionCheck >= SNAPSHOT_REFRESH_MS) {
    lastPageDescriptionCheck = Date.now();
    pageDescriptionRefreshPromise = answerPageDescription()
      .then((answer) => {
        if (answer.value) lastGoodPageDescriptions = answer.value;
        return answer;
      })
      .catch((error) => ({ value: lastGoodPageDescriptions, sourceFailure: error }))
      .finally(() => {
        pageDescriptionRefreshPromise = null;
      });
  }
  // BETWEEN REFRESHES, USE THE ANSWER WE ALREADY HAVE.
  //
  // The throttle exists so a busy host does not ask the engine on every request,
  // and it was throwing the answer away instead of reusing it: the request that
  // happened to trigger a refresh got the real description and every other
  // request fell to a file that a package set does not have to supply, so the
  // host refused. From outside it looked intermittent, which sent every reading
  // of it towards the engine being slow, and the engine was never the problem.
  // The whole point of a throttle is that the value survives it.
  // A slow refresh must not hold every page request behind the engine. The
  // last good description is already authoritative for this process until a
  // newer current answer arrives. The retained file covers a fresh process.
  const availableNow = lastGoodPageDescriptions
    ?? await readPageDescriptionsFromFile(config.pageDescriptionFile)
    ?? await readPageDescriptionsFromFile(keptPageDescriptionFile());
  if (availableNow) {
    lastGoodPageDescriptions = availableNow;
    return pickDescriptionForHost(availableNow, req?.headers?.host);
  }
  const answer = pageDescriptionRefreshPromise
    ? await pageDescriptionRefreshPromise
    : { value: null, sourceFailure: null };
  if (answer.sourceFailure) {
    console.error('[public-entry] live page description unavailable; serving the last good one:',
      String(answer.sourceFailure?.message ?? answer.sourceFailure).slice(0, 160));
  }
  if (answer.value) lastGoodPageDescriptions = answer.value;
  return pickDescriptionForHost(answer.value, req?.headers?.host);
}

// A HOST WITH NO DESCRIPTION MUST SAY SO, and this exists because the change that introduced
// the description also introduced the worst possible failure for it.
//
// With no description the shells render a document with an empty title, no brand, no bundle
// and an empty mount point: a page that returns 200, looks structurally fine to every check
// here, and is blank to a visitor. That is strictly worse than the hardcoded copy it replaced,
// because the hardcoded version could not fail this way. Silence is the defect, not the
// missing file.
//
// So the absence is answered honestly: 503, the reason, and the two places a description can
// come from. It names no tenant and cannot be mistaken for one.
// TWO CAUSES, and telling them apart is the whole value of this message.
//
// It began as one cause, no description anywhere. Once descriptions became a LIST there is a
// second: descriptions exist and none of them names THIS host, which is what a typo in a
// `hosts` entry looks like. A single message would have told an operator who had already
// written the file to go and write the file, sending them to look at the one thing that is
// fine. So it reports which situation it is and names the host it could not place.
async function refuseForLackOfADescription(req, res) {
  const host = canonicalHost(req?.headers?.host) || '(no host header)';
  const anyExist = Boolean(await readPageDescriptionsFromFile(config.pageDescriptionFile)
    ?? await readPageDescriptionsFromFile(keptPageDescriptionFile()));
  const reason = anyExist
    ? `page descriptions exist but none of them lists the host ${host}`
    : 'no page description could be read at all';
  const remedy = anyExist
    ? `Add ${host} to the "hosts" of the entry that should serve it.`
    : `Set BITFIELD_PUBLIC_PAGE_DESCRIPTION_FILE, or publish a record at ${LABELS.pageDescription}.`;
  console.error(`[public-entry] NO PAGE DESCRIPTION FOR ${host}: ${reason}. ${remedy}`
    + ' Refusing to serve a blank page.'
    + ` Last look at the set's records: ${lastPackageSetRecordsScan.scanned} record(s)`
    + `, kinds: ${lastPackageSetRecordsScan.kinds.join(', ') || '(none)'}.`);
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`This host has not been configured with a page description: ${reason}.\n`);
}

// A DESCRIBED HOST WITH NO BODY FILE IS A DIFFERENT FAULT, and it gets its own message.
//
// Its sibling above answers "nobody told this host who it is". This one answers "this host
// knows who it is and its editorial body is missing or unreadable", which sends an operator to
// a path on disk rather than to a `hosts` list. Collapsing them into one 503 would send the
// person who already wrote the description to go and write the description.
async function refuseForLackOfAFallbackBody(req, res) {
  const host = canonicalHost(req?.headers?.host) || '(no host header)';
  const path = (await livePageDescription(req))?.fallback_body_file;
  const reason = path
    ? `its fallback_body_file could not be read at ${path}`
    : 'its page description names no fallback_body_file';
  console.error(`[public-entry] NO FALLBACK BODY FOR ${host}: ${reason}.`
    + ' Refusing to serve a page with an empty body.');
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`This host is described but has no fallback page body: ${reason}.\n`);
}

// Ask the engine because someone is reading, at most once per refresh window, and never twice
// at the same time. Without the throttle every landing-page render was an engine round trip;
// without the in-flight dedupe a burst of visitors became a burst of identical reads.
async function liveLandingOffers(description) {
  const { state, answer: answerLandingOffers, readWhatWasKept } = offerOwnerFor(description);
  if (!state.refreshPromise && Date.now() - state.lastCheck >= SNAPSHOT_REFRESH_MS) {
    state.lastCheck = Date.now();
    state.refreshPromise = answerLandingOffers().finally(() => {
      state.refreshPromise = null;
    });
  }
  const answer = state.refreshPromise
    ? await state.refreshPromise
    : { value: await readWhatWasKept(), sourceFailure: null };
  if (answer.sourceFailure) {
    console.error('[public-entry] live landing offers unavailable; serving the last good prices:',
      String(answer.sourceFailure?.message ?? answer.sourceFailure).slice(0, 160));
  }
  // The FIFTH place the envelope key set was written into this file, found by sweeping for the
  // two names after the other four were removed. It was harmless today, because the shell already
  // treats a missing envelope as unavailable, and it is still wrong: a tenant with its own
  // envelope names got a map describing two envelopes it does not have. Nothing generic here may
  // know a tenant's vocabulary even when knowing it costs nothing.
  return answer.value ?? Object.fromEntries(
    Object.keys(landingEnvelopesFor(description)).map((envelopeKey) => [envelopeKey, { status: 'unavailable' }]),
  );
}


const LABELS = Object.freeze({
  publicPages: 'package-set-records::public-sales-page-records',
  mediaLibrary: 'package-set-records::media-library-records',
  descriptor: 'package::public-sales-page::descriptor::interaction-surface',
  selectionSurfaces: 'package-set-records::selection-surface-records',
  deciders: 'package-set-records::decider-records',
  commercialOffers: 'package-set-records::commercial-offer-records',
  offerScoping: 'package-set-records::offer-scoping-records',
  offerEligibility: 'package-set-records::offer-eligibility-records',
  pageDescription: 'package-set-records::public-page-description-records',
});

// WHAT A HOST MUST BE TOLD BEFORE IT CAN EMIT A PAGE.
//
// Everything this server used to write into string templates by hand: the title, the brand,
// the nav, the footer, the chrome, where the client island mounts and which bundle fills it.
// None of it is Physics. Every field here answers YES to "could a second tenant want this
// different", which is the test that decides Society from Physics, so every one of them is a
// value in a record rather than a line of code.
//
// It is NOT shipped with a default. A default here would be the product copy compiled back
// into the generic package under a new name, which is a relocation wearing a split's clothes:
// the second tenant would still cost a code change, which is the exact thing being removed.
// A host with no description is a configuration error and says so (see the caller).
// A SOURCE YIELDS A LIST, always, even when a set has one tenant.
//
// T3 is the reason. "One source serves many package sets" was a claim in a plan with exactly
// one set exercising it, and the thing standing in the way was that a description was a single
// object, so one process could only ever be one tenant. A list costs a set with one tenant
// nothing and is what makes a second tenant a ROW rather than a deploy.
//
// A bare object is deliberately NOT accepted. It would work, and it would be a union: two
// shapes meaning the same thing, so every reader has to handle both forever, which is how a
// format grows a dialect. Both files were converted instead.
function readPageDescriptionsFrom(payload) {
  const list = payload?.pages ?? payload?.rows;
  if (!Array.isArray(list)) return null;
  const usable = list.filter((entry) => entry && typeof entry === 'object' && entry.title);
  // SAY WHEN AN ENTRY IS DROPPED. The filter above is the right rule and it was SILENT, which
  // is the defect this file keeps producing in new costumes: a tenant whose `title` key is
  // misspelled simply vanishes, and the operator is then told their host is not listed, which
  // sends them to look at `hosts` when the problem is two lines above it. Naming the position
  // is what makes it findable, since a dropped entry has no name to report by definition.
  if (usable.length !== list.length) {
    const dropped = list
      .map((entry, index) => (usable.includes(entry) ? null : index))
      .filter((index) => index !== null);
    console.error(`[public-entry] ignored ${dropped.length} page description entr${dropped.length === 1 ? 'y' : 'ies'}`
      + ` at position(s) ${dropped.join(', ')}: an entry must be an object with a title.`);
  }
  // A described file path is the TENANT'S fact and an absolute one is this machine's, so it is
  // resolved HERE, where descriptions enter, which is what makes the engine record, the deployed
  // file and the kept last-good copy give one answer. The rule and its reasoning live in
  // `read-data/described-file-at.mjs`; the only decision belonging to this file is the BASE, which
  // is the directory of BITFIELD_PUBLIC_PAGE_DESCRIPTION_FILE rather than a variable of its own,
  // since that file already sits beside the ones it names and every deploy wants it anyway.
  return usable.length
    ? usable.map((page) => describedFilesResolvedIn(page, config.pageDescriptionFile,
      (problem) => console.error(`[public-entry] ${problem}.`)))
    : null;
}

// ONE description serves every host this process answers for. MANY must each say which hosts
// they are, and an unmatched host is an error rather than a guess.
//
// Matching is only required when there is a choice, which is why a single-tenant set writes no
// `hosts` at all. Requiring it always would duplicate BITFIELD_HOST_ENTRY_SCENE_HOSTS into the
// description, and those answer different questions: the environment says WHICH HOSTS THIS
// PROCESS ANSWERS FOR, the description says WHO EACH HOST IS.
function pickDescriptionForHost(descriptions, host) {
  if (!descriptions?.length) return null;
  if (descriptions.length === 1) return descriptions[0];
  const wanted = canonicalHost(host);
  return descriptions.find((entry) => (entry.hosts ?? []).some((h) => canonicalHost(h) === wanted)) ?? null;
}

function keptPageDescriptionFile() {
  return `${env('BITFIELD_INSTALL_ROOT', '/var/lib/bitfield')}/last-good-page-description.json`;
}

// The engine-down source. A package set supplies this file; the package never does.
async function readPageDescriptionsFromFile(path) {
  if (!path) return null;
  try {
    const stored = JSON.parse(await readFile(path, 'utf8'));
    // Earlier retained answers were written as a bare array. Only this
    // private recovery file accepts that historical shape; package-set files
    // still use the declared pages/rows envelope.
    return readPageDescriptionsFrom(
      path === keptPageDescriptionFile() && Array.isArray(stored) ? { pages: stored } : stored,
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error(`[public-entry] page description unreadable at ${path}:`,
        String(error?.message ?? error).slice(0, 160));
    }
    return null;
  }
}

let pageDescriptionKeepAttempts = 0;
async function keepPageDescription(description) {
  const file = keptPageDescriptionFile();
  const pending = `${file}.${Date.now().toString(36)}-${(pageDescriptionKeepAttempts += 1)}-${Math.random().toString(36).slice(2, 8)}.pending`;
  try {
    await writeFile(pending, JSON.stringify({ pages: description }), 'utf8');
    await rename(pending, file);
  } catch (error) {
    console.error('[public-entry] page description not kept:',
      String(error?.message ?? error).slice(0, 160));
    await rm(pending, { force: true }).catch(() => {});
  }
}

// Third adoption of the same primitive, after the app scene and the landing prices. The engine
// owns the live description; when it cannot answer, the last one it served is served instead,
// and only a first boot with a dead engine and nothing kept has no answer at all.
// HOW THESE RECORDS ARE ACTUALLY ADDRESSED, measured rather than assumed.
//
// A package set's records sit under a PATH whose segments are address-hashed,
// and the joined `a::b` label above resolves to a different address entirely.
// Asking for `package-set-records::public-page-description-records` returns
// `found: false` with no error, which is indistinguishable from a set that
// never published one, so the host answered 503 and said the description was
// missing while it sat in the log the whole time. The same is true of the
// `::`-joined label with the set name added, so it is the FORM that is wrong,
// not a missing segment.
//
// The path's middle segment is the set's own name, which this process has no
// business knowing, so the scan stops one level above it and the record is
// found by the kind it declares. That also means a set can rename itself
// without this server learning about it.
const PAGE_DESCRIPTION_KIND = 'hosted-public-page-description';
const PACKAGE_SET_RECORDS_PATH = ['package-set-records'];

// A SCAN THAT MATCHES NOTHING MUST SAY WHAT IT LOOKED AT.
//
// "Nothing of that kind" and "nothing at all" send a reader to opposite ends of
// the system, and both arrive here as an empty array. The count and the kinds
// actually seen are what tell them apart, and they cost one line.
let lastPackageSetRecordsScan = { scanned: 0, kinds: [] };

async function scanPackageSetRecordsForKind(kind) {
  const found = [];
  const kindsSeen = new Set();
  let scanned = 0;
  let cursor = 0;
  do {
    const reply = await invokeLabelAddressed({
      operation_label: 'engine.operation.scan-current-under-path',
      partition_label: config.partition,
      path_labels: PACKAGE_SET_RECORDS_PATH,
      cursor,
      limit: 1000,
    });
    if (!Array.isArray(reply.entries)) {
      throw new Error('scan-current-under-path returned no entries array');
    }
    for (const entry of reply.entries) {
      scanned += 1;
      const payload = entry?.payload ?? (typeof entry?.payload_base64 === 'string'
        ? JSON.parse(TEXT_DECODER.decode(Buffer.from(entry.payload_base64, 'base64')))
        : null);
      if (typeof payload?.kind === 'string') kindsSeen.add(payload.kind);
      if (payload?.kind === kind) found.push(payload);
    }
    cursor = reply.next_cursor ?? null;
  } while (cursor !== null);
  lastPackageSetRecordsScan = { scanned, kinds: [...kindsSeen].sort() };
  return found;
}

const answerPageDescription = keepTheLastGoodAnswer({
  askTheSource: async () => {
    const records = await stopWaitingAfter(scanPackageSetRecordsForKind(PAGE_DESCRIPTION_KIND), 15_000);
    return readPageDescriptionsFrom(records?.[0] ?? null);
  },
  readWhatWasKept: async () => (
    await readPageDescriptionsFromFile(config.pageDescriptionFile)
    ?? await readPageDescriptionsFromFile(keptPageDescriptionFile())
  ),
  keepThisAnswer: keepPageDescription,
});

// Read once per path and held, because it is a file on the same disk that does not change
// while the process runs, and re-reading it per request would be an open() on the hot path for
// bytes that are already in hand. A description that names no chrome file yields no chrome,
// which renders unstyled rather than blank, so this is not the silent-blank hazard the missing
// DESCRIPTION was: the page still says everything it says.
const tenantCssByPath = new Map();
// ONE READER FOR EVERY TENANT STYLESHEET, because there is more than one and they arrive the
// same way. The sales-page renderer's chrome and this server's own page shell are DIFFERENT
// stylesheets for different markup, verified by selector: the chrome is entirely
// `.public-sales-page__*` and the shell is entirely the editorial body's classes. They are not
// two sources of truth for one thing, so they are not merged. They ARE two copies of the same
// READING, so that is what got merged.
async function tenantCssAt(path, exportName) {
  if (!path) return '';
  if (tenantCssByPath.has(path)) return tenantCssByPath.get(path);
  let css = '';
  try {
    css = exportName
      ? String((await import(pathToFileURL(path).href))[exportName] ?? '')
      : await readFile(path, 'utf8');
  } catch (error) {
    console.error(`[public-entry] tenant css unreadable at ${path}:`,
      String(error?.message ?? error).slice(0, 160));
  }
  tenantCssByPath.set(path, css);
  return css;
}

// HOW to take the css is DATA, not a file-extension guess.
//
// This set's chrome is a module exporting a template literal rather than a .css file, so
// reading it as text yields JavaScript source. Sniffing the extension would work today and
// is an enum over an open set: the next tenant ships a plain .css, the one after that a
// .json bundle. The description names the EXPORT to take when there is one, and its absence
// means the file IS the css. Adding a tenant never edits this function.
const chromeCssFor = (description) =>
  tenantCssAt(description?.chrome_css_file, description?.chrome_css_export);

// The stylesheet for pages THIS SERVER renders itself, the editorial body and the thank-you
// page. Separate from the chrome above because it styles different markup, not because it is
// a second copy of it.
const shellCssFor = (description) =>
  tenantCssAt(description?.shell_css_file, description?.shell_css_export);

// esbuild emits the shared screen-look CSS module beside this executable. Its
// class-name map is in the JS bundle, but the declarations are in this sidecar;
// SSR must include both for EditorialLinkCard to look like the same component
// on the hosted page. A source-mode test may have no adjacent built CSS.
let bundledComponentCssPromise;
function bundledComponentCss() {
  bundledComponentCssPromise ??= readFile(join(dirname(process.argv[1]), 'public-entry-server.css'), 'utf8')
    .catch((error) => {
      console.error('[public-entry] shared component css unavailable:', String(error?.message ?? error).slice(0, 160));
      return '';
    });
  return bundledComponentCssPromise;
}

async function styleBlockFor(description) {
  return `<style data-bitfield-entry-critical>\nbody { background: #050505; color: #fff; }\n:root { --landing-page-grain: ${LANDING_FILM_GRAIN_TEXTURE}; }\n${await chromeCssFor(description)}\n${PUBLIC_EDITORIAL_PAGE_CSS}\n${await bundledComponentCss()}\n</style>`;
}
// ⛔ THE ARCHIVE OF PAGES A HOST CAN STILL SERVE WHILE THE ENGINE RECOVERS IS THE TENANT'S, AND IT
// USED TO BE A 4.4 MB CONSTANT IN THIS FILE.
//
// `import fallbackPublicPageArchive from './fallback-public-page-records.json'` shipped ONE tenant's
// 385 articles inside the generic package, bundled into EVERY tenant's binary, and
// `renderRecoveryPublicEntry` matched them by `route_path === pathname` and nothing else: no host,
// no partition, no reference to the description that says who this host IS. So during recovery,
// which is the normal state after a deploy, ANY host asked for one of those 385 paths answered with
// another customer's page. Proven, then fixed, by
// `__tests__/a-recovering-host-serves-only-its-own-archive.test.mjs`.
//
// The tenant-name suite could not see it: it reads `.mjs` files under `processes/`, and this was a
// `.json`. The two-tenant suite could not see it either, because it asks each tenant for ITS OWN
// routes, and a leak that only appears on a path NEITHER tenant declared is invisible to a test that
// asks each tenant what it has.
//
// So the archive is named by the description, like every other file a tenant brings, and the pages
// a host may serve are the pages that host declared.
const fallbackPagesByPath = new Map();
const publishedPageDescriptionsByHost = new Map();
async function publicationPageDescription(req) {
  const host = canonicalHost(req?.headers?.host) || '';
  if (publishedPageDescriptionsByHost.has(host)) return publishedPageDescriptionsByHost.get(host);
  const deployed = pickDescriptionForHost(
    await readPageDescriptionsFromFile(config.pageDescriptionFile), host);
  if (deployed) {
    publishedPageDescriptionsByHost.set(host, deployed);
    return deployed;
  }
  return livePageDescription(req);
}
async function fallbackPagesFor(description) {
  const path = description?.fallback_pages_file;
  if (!path) return [];
  if (fallbackPagesByPath.has(path)) return fallbackPagesByPath.get(path);
  let rows = [];
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (Array.isArray(parsed?.rows)) {
      rows = parsed.rows;
    } else {
      // Named rather than tolerated. A silently empty archive and a correctly empty one look the
      // same to a visitor, and only one of them is somebody's mistake.
      console.error(`[public-entry] ${path} has no "rows" array, so this host can serve none of its`
        + ' archived pages while the engine recovers.');
    }
  } catch (error) {
    console.error(`[public-entry] could not read the archived pages at ${path}:`,
      String(error?.message ?? error));
  }
  fallbackPagesByPath.set(path, rows);
  return rows;
}
const FALLBACK_PUBLIC_PAGE_DESCRIPTOR = Array.isArray(publicSalesPagePackage?.things)
  ? publicSalesPagePackage.things.find((thing) => thing?.payload?.kind === 'interaction-surface-descriptor')?.payload
  : undefined;

// `env` and its alias table live at the TOP of this file, above their first caller, because a
// hoisted function reading a `const` declared later throws at module load. That is exactly what
// this rename did on its first run: the suites crashed with "Cannot read properties of undefined"
// rather than failing a check, because a top-of-file constant called env() 500 lines before the
// table existed.

const config = {
  // Fly's private trial tunnel reaches the machine over IPv6. Node's dual-stack
  // listener also continues to accept the public proxy's IPv4 connections.
  listenHost: env('BITFIELD_PUBLIC_ENTRY_LISTEN_HOST', '::'),
  listenPort: Number(env('BITFIELD_PUBLIC_ENTRY_LISTEN_PORT', process.env.PORT || '8080')),
  partition: env('BITFIELD_PARTITION', ''),
  publicHosts: splitHostList(env('BITFIELD_HOST_ENTRY_SCENE_HOSTS', '')),
  appEntryHosts: splitHostList(env('BITFIELD_APP_ENTRY_SCENE_HOSTS', '')),
  shellUrl: env('BITFIELD_PUBLIC_ENTRY_SHELL_URL', 'http://127.0.0.1:8081'),
  staticDir: env('BITFIELD_BROWSER_STATIC_DIR', '/opt/bitfield/share/background-runner-shell/static'),
  // The baked public scene file the shell serves at /entry-scene. This proxy
  // resolves its source_bytes addresses server-side (same module_url path the
  // app host uses), so the browser imports entry modules over plain HTTP and
  // never depends on client-side WebSocket engine reads to hydrate.
  publicEntrySceneFile: env('BITFIELD_HOST_ENTRY_SCENE_FILE', ''),
  // The package set says who this host is serving. Empty by default ON PURPOSE: a default
  // path here would let a host boot as somebody, and the whole point is that it boots as
  // nobody until it is told.
  pageDescriptionFile: env('BITFIELD_PUBLIC_PAGE_DESCRIPTION_FILE', ''),
  commercialOffersFile: env('BITFIELD_COMMERCIAL_OFFERS_FILE', ''),
  // The app scene's fallback is WRITTEN, not BAKED, and that is deliberate.
  //
  // This was going to be `BITFIELD_APP_ENTRY_SCENE_FILE`, a twin of the line above,
  // reasoning that the public host survives a dead engine because it has a baked scene
  // so the app host should get one too. Two things were wrong with that.
  //
  // The public host does not survive by falling back. Its `sceneBytes` ignores `cursor`
  // and never asks the engine at all, so its baked file is the SOURCE, not a fallback.
  // Sharing `liveEntryScene` made the two look symmetric; the difference lives entirely
  // in the callback each was handed.
  //
  // And the app scene HAS a live source: the engine. Baking a copy into the image would
  // need a Dockerfile COPY, an env var, an export in the init script, a new image layer
  // and a rebuild to ever refresh, while being out of date the moment it was baked, for
  // a value the engine already owns. The volume mounted at BITFIELD_INSTALL_ROOT
  // survives restarts, which is the only window the fallback covers, so the last scene
  // the engine actually served is both cheaper to keep and always current.
  lastGoodSceneDir: `${env('BITFIELD_INSTALL_ROOT', '/var/lib/bitfield')}/last-good-entry-scene`,
  // A directory of hand-authored files this tenant serves alongside the rendered pages.
  //
  // Empty by default, and that is the whole of the on/off switch. A tenant with no such site
  // configures nothing and the route never matches, which is the same shape the kept-answer file
  // already uses: a capability whose dependency is injected and whose absence is an early return
  // is optional already, and a second boolean saying so would be a second way to express one state.
  staticSiteDir: env('BITFIELD_PUBLIC_ENTRY_STATIC_SITE_DIR', ''),
  // The deploy may name one exact image already carried by the application image. New app-open
  // bundles discover the signed app icon automatically; this explicit input keeps older hosted
  // applications on the same generic route without inventing a tenant filename convention.
  appIconFile: env('BITFIELD_PUBLIC_ENTRY_ICON_FILE', ''),
  bundledAssetDir: env('BITFIELD_PUBLIC_BUNDLED_ASSET_DIR', '/app'),
  // Hosts whose answers carry X-Robots-Tag: noindex. A preview or staging domain serving the same
  // bytes as production must not compete with it in an index. Named in DATA because which domain
  // is a preview is the deploy's fact, never this file's.
  noIndexHosts: splitHostList(env('BITFIELD_PUBLIC_ENTRY_NOINDEX_HOSTS', '')),
};

let basisPromise = null;
let indexHtmlPromise = null;
let cache = null;
// The three offers variables that used to live here are GONE rather than kept alongside the new
// shape: a cache, a refresh promise and a last-check stamp, all process-wide. They are now fields
// on the per-tenant owner's `state`, whose `lastCheck` still starts at zero, so the FIRST read
// always asks. Starting it at Date.now() would serve one visitor a kept price for no reason on a
// boot where the engine was up the whole time.
let refreshPromise = null;
let lastRefreshCheck = 0;
let applicationLeadDrainPromise = null;
let checkoutCompletionDrainPromise = null;

function splitHostList(value) {
  return value.split(',').map((item) => canonicalHost(item)).filter(Boolean);
}

function canonicalHost(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw) return '';
  if (raw.startsWith('[')) return raw;
  return raw.split(':')[0].replace(/\.$/, '');
}

function isPublicHost(req) {
  const host = canonicalHost(req.headers.host);
  return config.publicHosts.includes(host);
}

function isAppEntryHost(req) {
  const host = canonicalHost(req.headers.host);
  return config.appEntryHosts.includes(host);
}

function isNoIndexHost(req) {
  const host = canonicalHost(req.headers.host);
  return config.noIndexHosts.includes(host);
}

// Serve a hand-authored file from the tenant's static site, if the tenant has one and the request
// names a file in it.
//
// WHERE THIS IS CALLED IS THE DESIGN, and the spot is one line above `shouldRenderPublicEntry`
// rather than at the end of `handle`. That render is a CATCH-ALL: on a public host it answers
// every path its own exclusion list does not name, so a call placed after it never runs and the
// first version of this suite proved it by returning 503 for every authored file.
//
// The fork this collapses called its equivalent EARLY, ahead of the specific routes, and paid for
// that position with two hand-maintained closed sets: a reserved-prefix set ('boot', 'entry-scene',
// 'ws', 'app', 'checkout', …) and a regex of the tenant's own page names
// (declaration|events|deck|book). Both enumerate things that change, and a route added without a
// matching prefix row would have been shadowed by a file silently. Neither is needed here: every
// specific route is above this line and has already returned, and the reserved set the fork
// duplicated is the exclusion list `shouldRenderPublicEntry` already owns. So a tenant's files
// outrank only the generic page render, never a route.
//
// Knows nothing about which files exist or what the tenant calls them.
async function serveStaticSite(req, res, url) {
  if (!config.staticSiteDir) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // `/` IS NOT MAPPED TO index.html, and that is the difference between adding a capability and
  // taking one away. Every web server makes that mapping, so writing it was automatic and it was
  // measured wrong: a tenant's site directory holds an index.html, its home page is rendered by
  // this server from its description, and the mapping would have silently replaced the rendered
  // home page with the file. The fork excluded `/` from its own static gate for exactly this
  // reason, and the reason survives the collapse.
  //
  // A request names a file or it does not. Serving `/` would be this server deciding which file a
  // directory means, which is a convention rather than a fact, and it belongs to whoever renders
  // the home page. An authored home page is still reachable at its own name.
  const rel = url.pathname.replace(/^\/+/, '');
  // A tenant is trusted input, but the pathname is not: it is joined to a directory on disk, which
  // is how this goes wrong everywhere it goes wrong.
  if (!rel || rel.includes('..') || rel.includes('\0')) return false;
  const headers = isNoIndexHost(req)
    ? { 'X-Robots-Tag': 'noindex, nofollow, noarchive' }
    : {};
  const filePath = `${config.staticSiteDir}/${rel}`;
  if (await answerWithFileBytes(req, res, filePath, headers)) return true;
  // An asset URL names exact bytes. It must never inherit the authored-page clean-URL rule:
  // `/assets/app` resolving to `/assets/app.html` is the same HTML-as-JavaScript failure as the
  // public-page fallback, just one branch earlier.
  if (isStaticAssetRequest(req, url)) return false;
  // Clean URLs: /declaration reaches declaration.html. Authored links leave the extension off, and
  // without this they miss the file and fall through to a shell that renders them blank.
  const lastSegment = filePath.slice(filePath.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return false;
  return answerWithFileBytes(req, res, `${filePath}.html`, headers);
}

function acceptsHtml(req) {
  const accept = String(req.headers.accept || '');
  return !accept || accept.includes('text/html') || accept.includes('*/*');
}

function shouldRenderPublicEntry(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!isPublicHost(req) || !acceptsHtml(req)) return false;
  const path = url.pathname;
  if (
    path === '/boot'
    || path === '/boot-phase'
    || path === '/entry-scene'
    || path === '/ws'
    || path === '/app'
    || path.startsWith('/app/')
    || path.startsWith('/src/')
    || path.startsWith('/target/')
    || path.startsWith('/cas/')
    || path.startsWith('/byte-address/')
    || path.startsWith('/guarded-object/')
  ) return false;
  return true;
}

function isStaticAssetRequest(req, url) {
  return (req.method === 'GET' || req.method === 'HEAD')
    && (url.pathname.startsWith('/assets/') || APP_IDENTITY_ASSET_PATHS.has(url.pathname));
}

function shouldRenderAppEntryScene(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return isAppEntryHost(req) && url.pathname === '/entry-scene';
}

function shouldRenderAppShell(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!isAppEntryHost(req) || !acceptsHtml(req)) return false;
  return url.pathname === '/' || url.pathname === '/index.html';
}

async function currentBasis() {
  basisPromise ??= discoverBasis();
  return basisPromise;
}

async function discoverBasis() {
  const response = await fetch(new URL('/boot', config.shellUrl), {
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`/boot failed: ${response.status} ${body.slice(0, 200)}`);
  const configs = JSON.parse(body);
  const basis = configs?.[0]?.running_command_list_basis;
  if (typeof basis !== 'string' || basis.length === 0) {
    throw new Error('/boot did not return running_command_list_basis');
  }
  return basis;
}

function targetUrl(target) {
  return new URL(`/target/${target.split('/').map(encodeURIComponent).join('/')}`, config.shellUrl);
}

async function invokeLabelAddressed(request) {
  const basis = await currentBasis();
  const response = await fetch(targetUrl('engine.operation.label-addressed'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [TARGET_BASIS_HEADER]: basis,
    },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  if (!response.ok) {
    basisPromise = null;
    throw new Error(`${request.operation_label} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function invokeTarget(target, payload) {
  const basis = await currentBasis();
  const response = await fetch(targetUrl(target), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [TARGET_BASIS_HEADER]: basis,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    basisPromise = null;
    throw new Error(`${target} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  if (!text.trim()) return {};
  const reply = JSON.parse(text);
  if (typeof reply?.payload_base64 === 'string') {
    return JSON.parse(Buffer.from(reply.payload_base64, 'base64').toString('utf8'));
  }
  if (typeof reply?.payload_text === 'string') return JSON.parse(reply.payload_text);
  return reply;
}

async function readBoundedJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new CarrierHttpEffectError('Checkout request is too large.', 413);
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new CarrierHttpEffectError('Checkout request is not valid JSON.', 400);
  }
}

function publicRequestOrigin(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwarded === 'http' || forwarded === 'https' ? forwarded : 'https';
  const host = canonicalHost(req.headers.host);
  if (!host || (config.publicHosts.length > 0 && !config.publicHosts.includes(host))) {
    throw new CarrierHttpEffectError('Checkout host is not admitted.', 400);
  }
  return `${protocol}://${host}`;
}

function paidAmountFor(price, requestedAmount) {
  const policy = price?.voluntary_amount_policy;
  if (!policy) return Number(price?.amount_cents);
  const amount = Number(requestedAmount ?? price.amount_cents);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new CarrierHttpEffectError('Choose a positive contribution amount.', 400);
  }
  const minimum = Number(policy.min_cents);
  const maximum = policy.max_cents == null ? null : Number(policy.max_cents);
  if (Number.isSafeInteger(minimum) && amount < minimum) {
    throw new CarrierHttpEffectError('The contribution amount is below the published minimum.', 400);
  }
  if (Number.isSafeInteger(maximum) && amount > maximum) {
    throw new CarrierHttpEffectError('The contribution amount is above the published maximum.', 400);
  }
  return amount;
}

async function startCheckoutFromPackagedOffer(req, request, currentOffers = null) {
  if (process.env.BITFIELD_RELEASE_TRIAL_NO_EXTERNAL_EFFECTS) {
    throw new CarrierHttpEffectError('Checkout is unavailable in a release trial.', 503);
  }
  const offers = currentOffers ?? readCheckoutOffers(await withObservedPrices(await readPackagedCommercialOffers()));
  const offer = findCheckoutOfferBySelector(offers, String(request?.offerId || ''));
  if (!offer) throw new CarrierHttpEffectError('This offer is unavailable.', 404);
  const price = offer.price_options.find((candidate) => candidate.id === request?.priceOptionId);
  if (!price) throw new CarrierHttpEffectError('This price is unavailable.', 400);
  const checkoutAttemptId = String(request?.checkoutAttemptId || '').trim();
  if (!checkoutAttemptId) throw new CarrierHttpEffectError('Checkout attempt identity is required.', 400);
  if (request?.consent?.billing !== true || request?.consent?.legal !== true) {
    throw new CarrierHttpEffectError('Accept the billing and purchase terms to continue.', 400);
  }
  const amountCents = paidAmountFor(price, request?.customerSelectedAmountCents);
  const origin = publicRequestOrigin(req);
  const recurring = price.payment_timing === 'recurring' || price.payment_timing === 'subscription';
  const effect = materializeHostedSessionCarrierEffect({
    carrier_transport: 'materialize',
    idempotency_key: checkoutAttemptId,
    session: {
      currency: price.currency,
      payment_mode: recurring ? 'subscription' : 'payment',
      ...(recurring ? { interval: price.interval || 'month' } : {}),
      client_reference_id: checkoutAttemptId,
      offer_id: offer.id,
      price_option_id: price.id,
      validated_amount_cents: amountCents,
      initial_amount_cents: amountCents,
      cadence: recurring ? (price.interval || 'month') : 'one_time',
      success_url: `${origin}/welcome?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#program-pricing`,
      line_items: [{
        amount_cents: amountCents,
        billing_mode: recurring ? 'recurring' : 'one_time',
        product_name: offer.label,
        quantity: 1,
      }],
    },
  });
  const provider = await executeCarrierHttpEffect(effect, {
    invokeTarget: async (target, payload) => {
      if (target !== 'stripe-payment-provider.create-hosted-session') {
        throw new CarrierHttpEffectError('Checkout provider finalizer is not admitted.');
      }
      return finalizeHostedSessionCarrierEffect(payload);
    },
  });
  return {
    amountDueTodayCents: String(amountCents),
    currency: price.currency,
    offerId: offer.id,
    paymentMode: 'provider',
    postPurchaseRoutePath: offer.post_purchase_route_path || '/welcome',
    priceOptionId: price.id,
    providerSessionId: provider.provider_session_id,
    redirectUrl: provider.url,
    status: 'ready',
  };
}

function engineIsUnavailableForCheckout(error) {
  const message = String(error?.message ?? error);
  return /fetch failed|ECONNREFUSED|\/boot failed|public entry proxy unavailable/i.test(message);
}

function engineHasStaleObservedMinimum(error, price, requestedAmount) {
  if (!price?.voluntary_amount_policy) return false;
  const message = String(error?.message ?? error);
  const rejectedMinimum = /FE_INTERNAL_ERROR: Enter 0 for free, or at least (\d+) ([a-z]{3})\./i.exec(message);
  if (!rejectedMinimum || rejectedMinimum[2].toLowerCase() !== String(price.currency).toLowerCase()) return false;
  const amount = Number(requestedAmount ?? price.amount_cents);
  const currentMinimum = Number(price.voluntary_amount_policy.min_cents);
  return Number.isSafeInteger(amount) && Number.isSafeInteger(currentMinimum)
    && amount >= currentMinimum && amount < Number(rejectedMinimum[1]);
}

async function handleCheckoutCarrierTransport(req, res) {
  const startedAt = performance.now();
  const request = await readBoundedJsonBody(req);
  // The engine checks amounts against ITS copy of the offer, which has no
  // observed counts, so a price that has moved up would still accept the old
  // minimum there. The moved minimum is enforced here first.
  const observedOffers = readCheckoutOffers(await readCommercialOffers().catch(() => null) ?? { records: [] });
  const observedOffer = findCheckoutOfferBySelector(observedOffers, String(request?.offerId || ''));
  const observedPrice = observedOffer?.price_options.find((candidate) => candidate.id === request?.priceOptionId);
  if (observedPrice?.voluntary_amount_policy) {
    try {
      paidAmountFor(observedPrice, request?.customerSelectedAmountCents);
    } catch (error) {
      const body = JSON.stringify({ error: String(error?.message ?? error) });
      res.writeHead(Number(error?.status) || 400, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
  }
  let output;
  let transport;
  let operationId;
  try {
    const materialization = await invokeTarget('checkout.start-checkout', {
      ...request,
      returnProviderTransportIntent: true,
    });
    const completed = await resolveCheckoutTransport(materialization, { invokeTarget });
    ({ output, transport, operationId } = completed);
  } catch (error) {
    const staleMinimum = engineHasStaleObservedMinimum(error, observedPrice, request?.customerSelectedAmountCents);
    if (!engineIsUnavailableForCheckout(error) && !staleMinimum) throw error;
    output = await startCheckoutFromPackagedOffer(req, request, staleMinimum ? observedOffers : null);
    transport = staleMinimum ? 'observed-price-provider' : 'packaged-provider-fallback';
    operationId = output.providerSessionId;
  }
  // `/target/*` is the browser transport boundary. The shared shell returns the
  // target's payload bytes directly on this route, and Runtime Kit hands those
  // bytes to the package caller. Wrapping this one successful checkout reply in
  // `{ payload_base64 }` made CheckoutFlow parse the wrapper as the result, miss
  // `redirectUrl`, and leave a buyer on the form even though Stripe had already
  // created the hosted session. Keep carrier-effect envelopes internal; the
  // browser receives the same raw target payload shape as every other target.
  const body = encodeBrowserTargetResponse(output);
  const elapsedMs = Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
  console.log('[public-entry] checkout transport completed', {
    elapsedMs,
    operationId,
    status: 'finalized',
    transport,
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function applicationLeadFiles() {
  const root = process.env.BITFIELD_INSTALL_ROOT || '/var/lib/bitfield';
  return {
    queue: `${root}/pending-leads.jsonl`,
    receipts: `${root}/pending-leads.drained.jsonl`,
  };
}

function checkoutCompletionFiles() {
  const root = process.env.BITFIELD_INSTALL_ROOT || '/var/lib/bitfield';
  return {
    queue: `${root}/pending-checkout-completions.jsonl`,
    receipts: `${root}/pending-checkout-completions.drained.jsonl`,
  };
}

function checkoutSessionId(value) {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  return /^cs_[A-Za-z0-9_]+$/.test(sessionId) && sessionId.length <= 255 ? sessionId : '';
}

function checkoutCompletionFinished(reply) {
  return reply?.completed === true
    || reply?.granted === true
    || (reply?.status === 'completed' && (reply?.paymentRecorded === true || reply?.grantedCount === 0));
}

async function queueCheckoutCompletion(target, sessionId) {
  const files = checkoutCompletionFiles();
  const record = { id: sessionId, session_id: sessionId, target, queued_at: new Date().toISOString() };
  const [queuedText, receiptText] = await Promise.all([
    readFile(files.queue, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error)),
    readFile(files.receipts, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error)),
  ]);
  const alreadyStored = [...parseJsonLines(queuedText), ...parseJsonLines(receiptText)]
    .some((candidate) => candidate?.id === sessionId);
  if (!alreadyStored) await appendFile(files.queue, `${JSON.stringify(record)}\n`, 'utf8');
}

async function completeCheckoutOrQueue(target, sessionId) {
  if (process.env.BITFIELD_RELEASE_TRIAL_NO_EXTERNAL_EFFECTS) return;
  try {
    const reply = await invokeTarget(target, { session_id: sessionId });
    if (checkoutCompletionFinished(reply)) {
      const files = checkoutCompletionFiles();
      await appendFile(files.receipts, `${JSON.stringify({ id: sessionId, completed_at: new Date().toISOString() })}\n`, 'utf8');
      return;
    }
  } catch (error) {
    console.error(`[public-entry] checkout ${sessionId} could not complete immediately; keeping it queued`, error);
  }
  await queueCheckoutCompletion(target, sessionId);
}

async function drainQueuedCheckoutCompletions() {
  if (process.env.BITFIELD_RELEASE_TRIAL_NO_EXTERNAL_EFFECTS) return;
  checkoutCompletionDrainPromise ??= (async () => {
    const files = checkoutCompletionFiles();
    const [queuedText, receiptText] = await Promise.all([
      readFile(files.queue, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error)),
      readFile(files.receipts, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error)),
    ]);
    const completed = new Set(parseJsonLines(receiptText).map((record) => record?.id).filter(Boolean));
    for (const record of parseJsonLines(queuedText)) {
      const sessionId = checkoutSessionId(record?.session_id);
      const target = typeof record?.target === 'string' ? record.target.trim() : '';
      if (!sessionId || !target || completed.has(sessionId)) continue;
      try {
        const reply = await invokeTarget(target, { session_id: sessionId });
        if (!checkoutCompletionFinished(reply)) continue;
        await appendFile(files.receipts, `${JSON.stringify({ id: sessionId, completed_at: new Date().toISOString() })}\n`, 'utf8');
        completed.add(sessionId);
      } catch (error) {
        console.error(`[public-entry] checkout ${sessionId} remains durably queued`, error);
      }
    }
  })().finally(() => {
    checkoutCompletionDrainPromise = null;
  });
  return checkoutCompletionDrainPromise;
}

function publicRouteRedirect(description, pathname) {
  const redirects = Array.isArray(description?.route_redirects) ? description.route_redirects : [];
  const route = redirects.find((candidate) => normalizePath(candidate?.from) === normalizePath(pathname));
  if (!route || typeof route.to !== 'string' || !route.to.trim()) return null;
  const destination = route.to.trim();
  if (!destination.startsWith('/') && !/^https:\/\//i.test(destination)) return null;
  return {
    checkoutCompletionTarget: typeof route.checkout_completion_target === 'string'
      ? route.checkout_completion_target.trim()
      : '',
    destination,
  };
}

function parseJsonLines(text) {
  return String(text || '').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function applicationLeadId(record) {
  if (typeof record?.id === 'string' && record.id.trim()) return record.id.trim();
  return Buffer.from(blake3(Buffer.from(JSON.stringify(record || {}), 'utf8'))).toString('hex').slice(0, 32);
}

// HOW A CAPTURED LEAD DESCRIBES ITSELF TO THE OWNERS THAT FILE IT.
//
// These five values used to be one tenant's product literals in this file: an customer contact
// source, an customer source_ref, an customer activity prefix and the sentence "Applied for an customer
// swing rebuild", which is customer copy. A second tenant sharing this binary would have had
// every lead filed under the first tenant's name, and the sentence would have described a
// product that tenant does not sell.
//
// The tenant supplies them in its page description under `lead_capture`, and `/apply` stamps
// them onto the queued record so the drain needs no tenant context at all.
//
// A record with no `lead_capture` is not an error and is NOT given invented attribution. It gets
// values that describe the MECHANISM, which is all that is actually known about it: it arrived
// through this server's public application form. Records queued before this change, and any
// tenant that declares no lead_capture, still drain and still reach the CRM; they simply claim
// nothing about which product was applied for. Filing them under a guessed tenant would be worse
// than filing them plainly, because a wrong attribution is indistinguishable from a right one.
const LEAD_CAPTURE_WHEN_UNDESCRIBED = {
  contact_source: 'public-entry-application',
  contact_source_ref: 'application:public-entry',
  activity_ref_prefix: 'public-entry-application-',
  note: 'Applied through the public entry form',
  channel: 'website-application',
};

function leadCaptureFor(record) {
  const described = record?.lead_capture;
  if (!described || typeof described !== 'object') return LEAD_CAPTURE_WHEN_UNDESCRIBED;
  const chosen = { ...LEAD_CAPTURE_WHEN_UNDESCRIBED };
  for (const key of Object.keys(LEAD_CAPTURE_WHEN_UNDESCRIBED)) {
    const value = described[key];
    if (typeof value === 'string' && value.trim()) chosen[key] = value;
  }
  return chosen;
}

function completedWorkflowReply(reply) {
  const status = reply?.status ?? reply?.output?.status ?? reply?.result?.status;
  return status === 'completed';
}

async function drainQueuedApplicationLeads() {
  if (process.env.BITFIELD_RELEASE_TRIAL_NO_EXTERNAL_EFFECTS) return;
  applicationLeadDrainPromise ??= (async () => {
    const files = applicationLeadFiles();
    const [queuedText, receiptText] = await Promise.all([
      readFile(files.queue, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error)),
      readFile(files.receipts, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error)),
    ]);
    const drained = new Set(parseJsonLines(receiptText).map((record) => applicationLeadId(record)));
    for (const record of parseJsonLines(queuedText)) {
      const id = applicationLeadId(record);
      if (drained.has(id)) continue;
      const email = String(record.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        console.error(`[public-entry] queued application ${id} has no valid email; leaving it queued`);
        continue;
      }
      // The attribution comes off the RECORD, not off this process, because one binary serves
      // many tenants and the drain runs long after the request that knew which one this was.
      // Stamping it at capture time is what makes a second tenant's leads land under the second
      // tenant's name; reading it from process config would file every lead under whichever
      // tenant the config happened to name.
      const capture = leadCaptureFor(record);
      try {
        const imported = await invokeTarget('account-contact-points.import', {
          source: capture.contact_source,
          rows: [{ email, source_ref: capture.contact_source_ref, at: record.ts }],
        });
        const importedRow = imported?.rows?.find((row) => row?.status === 'imported');
        const accountId = String(importedRow?.account_id || '');
        if (!accountId) throw new Error(`contact import did not return an account id: ${JSON.stringify(imported).slice(0, 300)}`);
        const crmReply = await invokeTarget('slot::workflow', {
          operation: 'execute_definition',
          definition_id: 'action:record-event',
          include_steps: false,
          include_output: true,
          input: {
            activity_ref: `${capture.activity_ref_prefix}${id}`,
            identity: accountId,
            subject_prefix: 'lead:',
            occurred_at: record.ts,
            note: capture.note,
            channel: capture.channel,
          },
        });
        if (!completedWorkflowReply(crmReply)) {
          throw new Error(`CRM action did not complete: ${JSON.stringify(crmReply).slice(0, 300)}`);
        }
        await appendFile(files.receipts, `${JSON.stringify({ id, drained_at: new Date().toISOString(), account_id: accountId, contact_imported: true, crm_recorded: true })}\n`, 'utf8');
        drained.add(id);
        console.log(`[public-entry] drained application ${id} into contact-point + CRM owners`);
      } catch (error) {
        console.error(`[public-entry] application ${id} remains durably queued`, error);
      }
    }
  })().finally(() => {
    applicationLeadDrainPromise = null;
  });
  return applicationLeadDrainPromise;
}

async function readCurrentReply(addressLabel) {
  return invokeLabelAddressed({
    operation_label: 'engine.operation.read-current',
    partition_label: config.partition,
    address_label: addressLabel,
  });
}

// Read current-item records by kind (the funnel-offer-graph records are keyed
// by kind, not under an aggregate label). Returns the raw payload array.
async function findCurrentItems(kinds) {
  const basis = await currentBasis();
  const response = await fetch(targetUrl('slot::find-current-items'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TARGET_BASIS_HEADER]: basis },
    body: JSON.stringify({
      operation: 'find-current-items',
      in: 'published-record',
      where: { all: [{ field: 'kind', in: kinds }] },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    basisPromise = null;
    throw new Error(`find-current-items failed: ${response.status} ${text.slice(0, 200)}`);
  }
  const body = JSON.parse(text);
  const items = body?.items || body?.records || body?.results || [];
  return Array.isArray(items) ? items.map((it) => it?.payload ?? it?.value ?? it) : [];
}

async function completeHostedUrlReturn(req, res, url) {
  if (req.method !== 'GET' || url.searchParams.size === 0) return false;
  let actions;
  try {
    actions = await findCurrentItems(['hosted-url-return-action']);
  } catch (error) {
    console.error('[public-entry] hosted URL return actions could not be read:',
      String(error?.message ?? error).slice(0, 160));
    return false;
  }
  let completed;
  try {
    completed = await executeHostedUrlReturnAction(actions, url, invokeTarget);
  } catch (error) {
    console.error('[public-entry] hosted URL return action failed:',
      String(error?.message ?? error).slice(0, 160));
    res.writeHead(400, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
    });
    res.end('This sign-in link could not be completed. Request a new link and try again.');
    return true;
  }
  if (!completed) return false;
  const headers = {
    Location: completed.location,
    'Cache-Control': 'no-store, max-age=0',
  };
  if (completed.cookies.length > 0) headers['Set-Cookie'] = completed.cookies;
  res.writeHead(303, headers);
  res.end();
  return true;
}

async function currentCursor() {
  const reply = await invokeLabelAddressed({
    operation_label: 'engine.operation.current-cursor',
    partition_label: config.partition,
  });
  return Number(reply.cursor || 0);
}

async function readCurrentPayload(addressLabel) {
  const reply = await readCurrentReply(addressLabel);
  if (!reply.found) return null;
  if (Object.hasOwn(reply, 'payload')) return reply.payload;
  if (typeof reply.payload_base64 === 'string') {
    return JSON.parse(TEXT_DECODER.decode(Buffer.from(reply.payload_base64, 'base64')));
  }
  return null;
}

const emailCourseRequestTimes = new Map();
function emailCourseService() {
  const ask = (operation, input) => invokeTarget('myletter-newsletter.manage-email-course', { operation, ...input });
  return {
    enroll: (input) => ask('enroll', input),
    captureInterest: (input) => ask('capture-interest', input),
    unsubscribe: (token) => ask('unsubscribe', { token }),
  };
}

function emailCourseJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function handlePublicEmailCourse(req, res, url) {
  if (!isPublicHost(req) || !url.pathname.startsWith('/email-course/')) return false;
  const action = url.pathname.slice('/email-course/'.length);
  if (!['enroll', 'capture', 'unsubscribe'].includes(action)) return false;
  if ((action === 'enroll' || action === 'capture') && req.method !== 'POST') {
    emailCourseJson(res, 405, { error: 'Use the form to request an email update.' });
    return true;
  }
  if (action === 'unsubscribe' && req.method !== 'GET' && req.method !== 'POST') {
    emailCourseJson(res, 405, { error: 'This unsubscribe link is invalid.' });
    return true;
  }
  try {
    const description = await livePageDescription(req);
    if (!description?.email_course) {
      emailCourseJson(res, 404, { error: 'Email lessons are unavailable.' });
      return true;
    }
    const origin = new URL(description.email_course.public_origin);
    if (origin.host !== String(req.headers.host || '').toLowerCase()) {
      emailCourseJson(res, 404, { error: 'Email lessons are unavailable on this site.' });
      return true;
    }
    if (action === 'enroll' || action === 'capture') {
      const requestOrigin = req.headers.origin;
      if (typeof requestOrigin === 'string' && requestOrigin !== origin.origin) {
        emailCourseJson(res, 403, { error: 'Open the form on this site to request an update.' });
        return true;
      }
      const client = String(req.headers['fly-client-ip'] || req.socket.remoteAddress || 'unknown');
      const recent = (emailCourseRequestTimes.get(client) || []).filter((time) => Date.now() - time < 600_000);
      if (recent.length >= 5) {
        emailCourseJson(res, 429, { error: 'Too many attempts. Please try again shortly.' });
        return true;
      }
      recent.push(Date.now());
      emailCourseRequestTimes.set(client, recent);
      if (emailCourseRequestTimes.size > 5000) {
        for (const [key, times] of emailCourseRequestTimes) {
          if (times.every((time) => Date.now() - time >= 600_000)) emailCourseRequestTimes.delete(key);
        }
      }
      const body = await readBoundedJsonBody(req, 8192);
      if (body.website) {
        emailCourseJson(res, 200, { status: action === 'capture' ? 'interest_saved' : 'enrolled' });
        return true;
      }
      const source = typeof req.headers.referer === 'string' && req.headers.referer.startsWith(origin.origin)
        ? new URL(req.headers.referer).pathname : '/';
      const input = { email: body.email, consent: body.consent, course: description.email_course, source };
      const result = action === 'capture'
        ? await emailCourseService().captureInterest(input)
        : await emailCourseService().enroll(input);
      emailCourseJson(res, 200, result);
      return true;
    }
    const body = req.method === 'POST' ? await readBoundedJsonBody(req, 8192) : {};
    const token = req.method === 'GET' ? url.searchParams.get('token') : url.searchParams.get('token') || body.token;
    await emailCourseService().unsubscribe(token);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
    res.end('You have unsubscribed from these lessons.');
    return true;
  } catch (error) {
    const message = String(error?.message ?? error);
    const invalid = /valid email|agree to receive|Invalid (lesson|unsubscribe)|course is unavailable|update list is unavailable/.test(message);
    console.error('[public-entry] email course request failed:', action, message.slice(0, 240));
    emailCourseJson(res, invalid ? 400 : 503, { error: invalid ? message : 'Email lessons could not start. Please try again.' });
    return true;
  }
}

async function readCurrentPayloadBase64(addressLabel) {
  const reply = await readCurrentReply(addressLabel);
  if (!reply.found) return null;
  if (typeof reply.payload_base64 === 'string' && reply.payload_base64.length > 0) {
    return reply.payload_base64;
  }
  if (typeof reply.payload_text === 'string') {
    return Buffer.from(reply.payload_text, 'utf8').toString('base64');
  }
  if (Object.hasOwn(reply, 'payload')) {
    return Buffer.from(JSON.stringify(reply.payload), 'utf8').toString('base64');
  }
  return null;
}

async function refreshRecords() {
  const now = Date.now();
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    lastRefreshCheck = now;
    const cursor = await currentCursor();
    if (cache?.cursor === cursor) return cache;
    // Public pages are route-scoped current records. Never reopen the retired
    // whole-set aggregate here: one reclaimed payload inside that historical
    // container would otherwise make every route fall back together, and every
    // refresh would reintroduce an O(all pages) read.
    const [mediaLibrary, descriptor, selectionSurfaces, deciders, commercialOffers, offerScoping, offerEligibility, funnelRecords] = await Promise.all([
      readCurrentPayload(LABELS.mediaLibrary),
      readCurrentPayload(LABELS.descriptor),
      readCurrentPayload(LABELS.selectionSurfaces),
      readCurrentPayload(LABELS.deciders),
      readCommercialOffers(),
      readCurrentPayload(LABELS.offerScoping),
      readCurrentPayload(LABELS.offerEligibility),
      // The rich funnel value-ladder records are keyed by kind (find-current-items),
      // not under an aggregate label. Read them so resolveFunnelFlow can drive the site.
      findCurrentItems(['funnel-graph', 'funnel-node', 'experiment', 'experiment-variant', 'offer-experiment', 'cta-link']).catch(() => []),
    ]);
    cache = { cursor, mediaLibrary, descriptor, selectionSurfaces, deciders, commercialOffers, offerScoping, offerEligibility, funnelRecords };
    return cache;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

// Refresh because someone ASKED, never because a clock fired.
//
// This used to be kept warm by a 500ms background timer, which did work continuously whether
// or not anyone was reading, and which was a self-scheduling poll loop inside a package
// process: the exact shape L136 forbids, because scheduling belongs to the engine's own
// clock waiter (notice-when-something-shows-up) and timed-action rather than to a hand-rolled loop.
//
// The timer had two jobs and BOTH were already covered elsewhere. `liveLandingOffers()`
// re-checks the offer source on read, so that half was pure duplication. Records are this
// half, and re-checking on read is what `liveEntryScene`'s own reader already does a few
// hundred lines below. So the loop was deleted rather than annotated as an exception, which
// is the difference between removing a thing and negotiating with a rule about it.
//
// Offers were louder about it: they hit the engine on EVERY landing render and simply did not
// wait for the reply. Read-throttled at the same window is fewer engine reads than either the
// timer or the old unthrottled path, so this is not a latency trade.
//
// It AWAITS rather than refreshing in the background, deliberately. Fire-and-forget would
// hand the first visitor after an idle period a stale page and converge only for the next
// one. `refreshRecords` compares the cursor first and returns the same cache when nothing
// moved, so the steady-state cost is one cursor read, and under traffic the staleness window
// is never reached at all.
async function liveRecords() {
  if (!cache) return refreshRecords();
  if (Date.now() - lastRefreshCheck >= SNAPSHOT_REFRESH_MS) {
    try {
      return await refreshRecords();
    } catch (error) {
      // An unreachable engine costs freshness, never the page.
      console.error('[public-entry] live snapshot refresh failed, serving the last good records:',
        String(error?.message ?? error).slice(0, 160));
      return cache;
    }
  }
  return cache;
}

function recordList(value) {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.records)) return value.records.filter(isRecord);
  if (isRecord(value)) return [value];
  return [];
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sourceAddressLabel(sourceBytes) {
  if (!isRecord(sourceBytes)) return null;
  const label = sourceBytes.address_label || sourceBytes.addressLabel || sourceBytes.source_address_label;
  return typeof label === 'string' && label.length > 0 ? label : null;
}

function appModuleSourceUrl(addressLabel, cursor) {
  const params = new URLSearchParams();
  params.set('address_label', addressLabel);
  if (Number.isFinite(cursor) && cursor > 0) params.set('cursor', String(cursor));
  return `/entry-module?${params.toString()}`;
}

function shouldRenderAppModuleSource(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // Both hosts import entry modules over HTTP from this proxy — the public
  // funnel scene and the app scene resolve through the same module cache.
  return (isAppEntryHost(req) || isPublicHost(req)) && url.pathname === '/entry-module';
}

function shouldRenderPublicEntryScene(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return isPublicHost(req) && url.pathname === '/entry-scene';
}

function replyPayloadBytes(reply) {
  if (!reply?.found) return null;
  if (typeof reply.payload_base64 === 'string' && reply.payload_base64.length > 0) {
    return Buffer.from(reply.payload_base64, 'base64');
  }
  if (typeof reply.payload_text === 'string') {
    return Buffer.from(reply.payload_text, 'utf8');
  }
  if (Object.hasOwn(reply, 'payload')) {
    return Buffer.from(JSON.stringify(reply.payload), 'utf8');
  }
  return null;
}

async function readCurrentModuleSource(addressLabel) {
  const reply = await readCurrentReply(addressLabel);
  const bytes = replyPayloadBytes(reply);
  if (!bytes) return null;
  const resolvedAddress = typeof reply.resolved_address === 'string' && reply.resolved_address.length > 0
    ? reply.resolved_address
    : null;
  return { addressLabel, resolvedAddress, bytes };
}

async function addressLiveSourceModules(value, sourceModuleCache, cursor) {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => addressLiveSourceModules(item, sourceModuleCache, cursor)));
  }
  if (!isRecord(value)) return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'source_bytes') {
      const addressLabel = sourceAddressLabel(child);
      if (!addressLabel) {
        output[key] = await addressLiveSourceModules(child, sourceModuleCache, cursor);
        continue;
      }
      if (!sourceModuleCache.has(addressLabel)) {
        sourceModuleCache.set(addressLabel, readCurrentModuleSource(addressLabel));
      }
      const source = await sourceModuleCache.get(addressLabel);
      output[key] = source
        ? {
            ...child,
            address_label: addressLabel,
            module_url: appModuleSourceUrl(addressLabel, cursor),
            resolved_address: source.resolvedAddress,
          }
        : child;
      continue;
    }
    output[key] = await addressLiveSourceModules(child, sourceModuleCache, cursor);
  }
  return output;
}

// ---- live entry scenes -------------------------------------------------------------
// ONE holder for every entry scene this server serves. A scene is DATA: a name for the
// log line, where its bytes come from, and whether the app shell wants modulepreload
// links. Adding a host is one more entry below, never another copy of this machinery —
// copying it is exactly how the app host ended up WITHOUT the engine-tolerance the
// public host already carried, and that gap left an app host unavailable.
//
// The invariant every scene inherits, and the whole reason this is one function:
// **reading a scene NEVER throws because the engine is unreachable.** cursor 0 means
// "no engine". It is never cached as a fresh answer, so a scene converges to live the
// moment the engine answers.
function liveEntryScene({ name, sceneBytes, withPreloadLinks = false }) {
  let cache = null;
  let refreshing = null;
  let lastCheck = 0;

  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      lastCheck = Date.now();
      let cursor = 0;
      try {
        cursor = await currentCursor();
      } catch (error) {
        console.error(`[public-entry] engine unreachable for the ${name} scene cursor; serving the published scene:`,
          String(error?.message ?? error).slice(0, 160));
      }
      if (cursor > 0 && cache?.cursor === cursor && cache.text) return cache;

      const scene = await sceneBytes(cursor, name);
      if (!scene) {
        cache = { cursor, text: null };
        return cache;
      }
      // Addressing needs the engine; the scene itself does not. A failure here costs
      // the browser its direct /entry-module URLs, never the page.
      const sourceModuleCache = new Map();
      const modules = new Map();
      let addressedScene = scene;
      try {
        addressedScene = await addressLiveSourceModules(scene, sourceModuleCache, cursor);
        for (const [addressLabel, sourcePromise] of sourceModuleCache.entries()) {
          const source = await sourcePromise;
          if (source) modules.set(addressLabel, source);
        }
      } catch (error) {
        console.error(`[public-entry] engine unreachable for ${name} scene modules; serving the scene verbatim:`,
          String(error?.message ?? error).slice(0, 160));
        addressedScene = scene;
        modules.clear();
      }
      const text = JSON.stringify(addressedScene);
      const bytes = Buffer.from(text, 'utf8');
      cache = {
        cursor,
        text,
        gzip: gzipSync(bytes),
        br: brotliCompressSync(bytes, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
        }),
        modules,
        ...(withPreloadLinks
          ? {
              modulePreloadLinks: Array.from(modules.keys(), (addressLabel) => (
                `<${appModuleSourceUrl(addressLabel, cursor)}>; rel=modulepreload`
              )),
            }
          : {}),
      };
      return cache;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  return async function read() {
    if (!cache) return refresh();
    // A cursor-0 cache is the engine-absent answer, not a fresh one: re-check it on
    // every request (refresh de-dupes concurrent callers) so the host converges the
    // instant the engine answers instead of serving published bytes for a full
    // interval longer.
    if (cache.cursor === 0 || Date.now() - lastCheck >= APP_ENTRY_SCENE_REFRESH_MS) {
      void refresh().catch((error) => {
        console.error(`[public-entry] ${name} scene refresh failed`, error);
      });
    }
    return cache;
  };
}

// A scene published to disk. Engine-INDEPENDENT, which is why it is what a host shows
// while the engine is unreachable. Not memoized: it is re-read at most once per refresh
// interval, and that keeps a republished file taking effect without a restart.
async function publishedScene(path, name) {
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    console.error(`[public-entry] published ${name} scene unreadable at ${path}:`,
      String(error?.message ?? error).slice(0, 160));
    return null;
  }
}

function lastGoodScenePath(name) {
  return `${config.lastGoodSceneDir}/${name}.json`;
}

// Keep the last scene the engine actually served, so a cold boot with the engine down
// paints the real page instead of an empty shell. Written through a temp file and a
// rename so a boot landing mid-write reads the previous scene rather than half of this
// one. A failure here costs the NEXT cold boot its pixels and must never cost THIS
// request its page, which is why it only logs.
// The temp name used to be `${target}.${process.pid}.pending`, and an adversarial pass on
// 2026-09-04 found two defects in that. A crashed writer leaves its pending file behind
// forever and nothing removes it, and because PIDs are REUSED a later process can land on
// an orphan, where writeFile truncates it with no sign anything was wrong. PID is also not
// a writer identity across containers mounting one volume, which is not today's topology
// but is not something this should encode either. A counter plus randomness is unique per
// attempt rather than per process, and the pending file is removed on the failure path so
// a crash is the only way one survives.
let keepAttempts = 0;
async function rememberLastGoodScene(name, scene) {
  const target = lastGoodScenePath(name);
  const pending = `${target}.${Date.now().toString(36)}-${(keepAttempts += 1)}-${Math.random().toString(36).slice(2, 8)}.pending`;
  try {
    await mkdir(config.lastGoodSceneDir, { recursive: true });
    await writeFile(pending, JSON.stringify(scene), 'utf8');
    await rename(pending, target);
  } catch (error) {
    console.error(`[public-entry] could not keep the last good ${name} scene at ${target}:`,
      String(error?.message ?? error).slice(0, 160));
    // Best effort, and deliberately silent: the caller already has its page, and a failure
    // to clean up a temp file must not become a second error about the first error.
    await rm(pending, { force: true }).catch(() => {});
  }
}

// The engine owns the LIVE app scene. When it answers, that answer is kept; when it
// cannot, the kept one is served. The fallback is therefore always the last thing that
// was really true, rather than whatever was true when an image was built.
const liveAppEntryScene = liveEntryScene({
  name: 'app',
  withPreloadLinks: true,
  // The try/keep/fall-back dance this used to spell out by hand is now the
  // keep-the-last-good-answer package. The behaviour is identical, including the subtle
  // part: an engine that answers with NOTHING must not overwrite a good kept scene, which
  // the old `if (live)` happened to get right and which is now structural rather than
  // incidental. What is new is that the answer says WHERE it came from, so this call site
  // can log honestly instead of the holder guessing on its behalf.
  //
  // The holder is built per call rather than once, because `cursor` is an argument and
  // closing over it here is clearer than threading it into a longer-lived object. Scene
  // refreshes are throttled, so this is one closure per refresh and not per request.
  sceneBytes: async (cursor, name) => {
    const answer = await keepTheLastGoodAnswer({
      // A cursor of 0 IS the engine-absent answer, so there is nothing to ask.
      askTheSource: () => (cursor > 0 ? readCurrentPayload('scene') : null),
      readWhatWasKept: () => publishedScene(lastGoodScenePath(name), name),
      keepThisAnswer: (scene) => rememberLastGoodScene(name, scene),
    })();
    if (answer.sourceFailure) {
      console.error(`[public-entry] engine unreachable for the live ${name} scene; serving the last good scene:`,
        String(answer.sourceFailure?.message ?? answer.sourceFailure).slice(0, 160));
    }
    return answer.value;
  },
});

// The funnel pages boot from the published public scene. Resolving its addresses HERE
// and handing the browser direct /entry-module URLs is what stopped funnel pages hanging
// on their SSR tree waiting for source_bytes reads over the WebSocket lane (incident
// 2026-07-10/11).
const livePublicEntryScene = liveEntryScene({
  name: 'public',
  sceneBytes: (cursor, name) => publishedScene(config.publicEntrySceneFile, name),
});

function appEntrySceneResponseBody(req, entry) {
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (entry?.br && /\bbr\b/.test(acceptEncoding)) {
    return { body: entry.br, encoding: 'br' };
  }
  if (entry?.gzip && /\bgzip\b/.test(acceptEncoding)) {
    return { body: entry.gzip, encoding: 'gzip' };
  }
  return { body: entry?.text || '', encoding: null };
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseSelectablePages(pageSource) {
  return recordList(pageSource).flatMap((record) => {
    const id = readString(record.id);
    if (!id || record.kind !== 'public-sales-page') return [];
    return [{ ...record, id, route_path: readString(record.route_path) }];
  });
}

function articleRouteParent(routePath) {
  const path = normalizePath(routePath);
  const slash = path.lastIndexOf('/');
  return slash > 0 ? path.slice(0, slash + 1) : null;
}

function selectedPublicPagesForRoute(exactPages, archivedPages, pathname) {
  const path = normalizePath(pathname);
  const archivedArticles = archivedPages.filter((page) => schemaIsArticle(page.schema));
  const archivedMatch = archivedArticles.find((page) => normalizePath(page.route_path) === path);
  const archivedCollection = archivedPages.find((page) => normalizePath(page.route_path) === path
    && page?.schema?.['@type'] === 'CollectionPage');
  const protectedArticleRoute = Boolean(archivedMatch)
    || exactPages.some((page) => schemaIsArticle(page.schema))
    || archivedArticles.some((page) => {
      const parent = articleRouteParent(page.route_path);
      return parent !== null && path.startsWith(parent);
    });
  return protectedArticleRoute
    ? { pages: archivedMatch ? [archivedMatch] : [], protectedArticleRoute }
    : { pages: archivedCollection ? [archivedCollection] : (exactPages.length > 0 ? exactPages : archivedPages), protectedArticleRoute };
}

function parseCookies(cookieHeader) {
  const cookies = new Map();
  for (const part of String(cookieHeader || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }
  return cookies;
}

function anonObserverId(seed) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `anon_${hash.toString(16)}`;
}

function requestSnapshot(req, url) {
  const cookies = parseCookies(req.headers.cookie);
  const cookieId = cookies.get(OBSERVER_COOKIE_NAME) || null;
  const ua = String(req.headers['user-agent'] || '');
  const lang = String(req.headers['accept-language'] || '').split(',')[0] || '';
  const anonId = anonObserverId(`${ua}|${lang}`);
  const get = (key) => {
    const value = url.searchParams.get(key);
    return value && value.trim() ? value : null;
  };
  return {
    observerIdSources: [
      { source_id: 'cookie', value: cookieId },
      { source_id: 'anon-hash', value: anonId },
    ],
    context: {
      source: get('source') ?? undefined,
      referrer: String(req.headers.referer || '') || null,
      utm_source: get('utm_source'),
      utm_medium: get('utm_medium'),
      utm_campaign: get('utm_campaign'),
      geo: null,
      device: null,
      is_returning: Boolean(cookieId),
    },
  };
}

// The document every page this server renders itself is wrapped in: the editorial fallback body
// and the thank-you page. It now holds NO tenant styling; the stylesheet arrives as
// `shell_css_file`, read through the same reader the chrome uses.
//
// An absent shell stylesheet serves an UNSTYLED page rather than refusing, and that asymmetry
// against the missing-body 503 is deliberate. A missing body is a blank page, which tells a
// visitor nothing and is worse than an error. A missing stylesheet is ugly and completely
// readable, so refusing would take a working page away from someone. It is logged, once per
// path, because silent degradation is still the thing to avoid.
async function pageShell(description, bodyHtml, title) {
  const css = await shellCssFor(description);
  if (!css) console.error('[public-entry] no shell_css_file for this host;'
    + ' serving an unstyled but readable page.');
  return appIdentityDocument(`<!doctype html>
<html lang="${description?.language ?? 'en'}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${css}
</style>
</head>
<body><main class="wrap">${bodyHtml}</main></body></html>`);
}

// THE EDITORIAL BODY IS A FILE THE TENANT SUPPLIES, and choosing that over a schema was the
// whole decision here, so the reasoning is worth keeping.
//
// The obvious move was to describe this page: a `sections` list of hero, carousel, form,
// testimonials. That is an enum over an open set wearing a data costume. The renderer would
// know the name of every section kind, the sixth tenant wanting a FAQ would edit this file,
// and the vocabulary would grow one entry per customer forever.
//
// This page only ever renders when the engine cannot answer. It is an emergency page, and the
// generic form of an emergency page is a document its owner wrote. So the description names a
// file, this server reads it, and adding a tenant adds a file. No kind is ever enumerated.
//
// Read at runtime and cached by path, matching chromeCssFor, because a rebuild of this server
// is not the right price for an editorial edit.
const fallbackBodyByPath = new Map();
async function fallbackBodyFor(description) {
  const path = description?.fallback_body_file;
  if (!path) return null;
  if (fallbackBodyByPath.has(path)) return fallbackBodyByPath.get(path);
  let body = null;
  try {
    const text = await readFile(path, 'utf8');
    // A FILE THAT EXISTS AND SAYS NOTHING IS NOT A BODY.
    //
    // Found by emptying the test fixture to check the suite could fail: the server answered
    // 200 with an empty <main> and every structural check stayed green. A truncated copy, a
    // half-finished deploy and a cleared file all produce exactly that. Blank is treated as
    // absent so it reaches the same honest 503 as a missing path.
    body = text.trim() ? text : null;
    if (body === null) console.error(`[public-entry] fallback page body at ${path} is blank;`
      + ' treating it as absent rather than serving an empty page.');
  } catch (error) {
    console.error(`[public-entry] fallback page body unreadable at ${path}:`,
      String(error?.message ?? error).slice(0, 160));
  }
  // An unreadable file is NOT cached. A missing mount, a deploy still copying, or a permission
  // that gets fixed would otherwise be remembered as emptiness until the process restarts.
  if (body !== null) fallbackBodyByPath.set(path, body);
  return body;
}

// Returns null when there is no body to serve, and every caller must answer that honestly.
//
// This function used to be incapable of failing: the body was compiled in. Turning it into a
// runtime lookup created a way for it to return nothing, and the lesson this package already
// paid for is that silence is the answer to reject. An empty <main> is a 200 that satisfies
// every structural check and is blank to a visitor.
async function holdingPageHtml(description, landingOffers = {}) {
  const body = await fallbackBodyFor(description);
  if (body === null) return null;
  // THE ENVELOPES BELONG TO THE PAGE, NOT TO THE ISLAND. They were emitted only by the island
  // shell, which was invisible for as long as every tenant with envelopes also had a bundle. A
  // tenant whose landing is server-rendered markup with a small script that reads an envelope (the
  // shape this collapse is for) would have been served the markup and none of its data, and the
  // script would have found nothing rather than failed, which is the quiet version.
  const stateScripts = await stateEnvelopeScripts(description?.island ?? {}, { landingOffers });
  return pageShell(description, `${stateScripts}${body}`, description?.title ?? '');
}


// Every string a visitor reads here now arrives in the description. The page structure, a
// brand link back to the root, a heading, a line of body copy and a footer, is the only part
// this server is entitled to decide, because that structure is the same for any tenant.
async function thankYouHtml(description) {
  const thanks = description?.thank_you ?? {};
  const body = `
    <a class="brand" href="/">${description?.brand ?? ''}</a>
    <h1>${thanks.heading ?? ''}</h1>
    <p class="sub">${thanks.body ?? ''}</p>
    <footer>${description?.brand ?? ''}</footer>`;
  return pageShell(description, body, thanks.title ?? description?.title ?? '');
}

async function indexHtml() {
  indexHtmlPromise ??= (async () => {
    const html = await readFile(`${config.staticDir}/index.html`, 'utf8');
    if (!await appIconExists() || /rel=["'](?:shortcut )?icon["']/i.test(html)) return html;
    if (!html.includes('</head>')) return html;
    return html.replace('</head>', `${appIdentityHeadLinks(true)}\n</head>`);
  })();
  return indexHtmlPromise;
}

let appIdentityFromBundlePromise;
let appIconFilePromise;

async function appOpenSourceBundle() {
  const bundleFile = env('BITFIELD_APP_OPEN_SOURCE_BUNDLE', '');
  if (!bundleFile) return null;
  const bundle = JSON.parse(await readFile(bundleFile, 'utf8'));
  return bundle && typeof bundle === 'object' && !Array.isArray(bundle) ? bundle : null;
}

function appOpenSourceBundlePath(file) {
  if (typeof file !== 'string' || !file) return null;
  if (file.startsWith('/')) return file;
  const bundleFile = env('BITFIELD_APP_OPEN_SOURCE_BUNDLE', '');
  return bundleFile ? join(dirname(bundleFile), file) : null;
}

async function appIdentityFromBundle() {
  appIdentityFromBundlePromise ??= (async () => {
    const bundle = await appOpenSourceBundle();
    const exact = bundle?.copy_files?.[config.partition];
    const candidates = [exact, ...Object.values(bundle?.copy_files ?? {})]
      .filter((value, index, values) => typeof value === 'string' && values.indexOf(value) === index);
    for (const identityFile of candidates) {
      const resolvedIdentityFile = appOpenSourceBundlePath(identityFile);
      if (!resolvedIdentityFile) continue;
      let identity;
      try { identity = JSON.parse(await readFile(resolvedIdentityFile, 'utf8')); } catch { continue; }
      if (identity?.schema === 'bitfield.app_identity'
        && typeof identity.app_name === 'string'
        && identity.app_name.trim()) return identity;
    }
    return null;
  })().catch(() => null);
  return appIdentityFromBundlePromise;
}

async function appIconFile() {
  appIconFilePromise ??= (async () => {
    if (config.appIconFile) {
      try {
        if ((await stat(config.appIconFile)).isFile()) return config.appIconFile;
      } catch {
        // A missing explicitly named image falls through to the signed app-open bundle.
      }
    }
    const bundle = await appOpenSourceBundle();
    const copyFiles = Object.entries(bundle?.copy_files ?? {});
    const currentPackageSet = `package-set:${config.partition}/copy-files`;
    copyFiles.sort(([left], [right]) => Number(right === currentPackageSet) - Number(left === currentPackageSet));
    for (const [, receiptFile] of copyFiles) {
      if (typeof receiptFile !== 'string' || !receiptFile.endsWith('/copied-file-receipt.json')) continue;
      const resolvedReceiptFile = appOpenSourceBundlePath(receiptFile);
      if (!resolvedReceiptFile) continue;
      let receipt;
      try { receipt = JSON.parse(await readFile(resolvedReceiptFile, 'utf8')); } catch { continue; }
      const icon = receipt?.copied_files?.find((file) =>
        typeof file?.output_relative_path === 'string'
        && file.output_relative_path.endsWith('/files-that-name-and-picture-this-app/app-icon-for-macos-dock.png'));
      if (icon) return join(dirname(resolvedReceiptFile), icon.output_relative_path);
    }
    return null;
  })().catch(() => null);
  return appIconFilePromise;
}


// Walk any schema.org DATA shape (single node, array, or a `@graph`) and return the
// first non-empty `description` string. Generic and blind (L090): the description is
// authored per-tenant in the page record's `schema` DATA, never invented here. A
// record with no description yields '' so no meta description is emitted (deletion
// test passes).
function descriptionFromSchema(schema) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return '';
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) { const d = walk(item); if (d) return d; }
      return '';
    }
    if (typeof node.description === 'string' && node.description.trim()) return node.description.trim();
    if (Array.isArray(node['@graph'])) { const d = walk(node['@graph']); if (d) return d; }
    return '';
  };
  return walk(schema);
}

// Does the schema DATA describe an Article (any *Article @type)? Chooses og:type
// article vs website. Generic, reads the DATA, names no tenant vocabulary.
function schemaIsArticle(schema) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some(walk);
    const t = node['@type'];
    const types = Array.isArray(t) ? t : (t ? [t] : []);
    if (types.some((x) => typeof x === 'string' && /Article/i.test(x))) return true;
    if (Array.isArray(node['@graph'])) return walk(node['@graph']);
    return false;
  };
  return walk(schema);
}

// Crawler head SEO/AEO tags: description, canonical, and Open Graph. Each tag is
// emitted ONLY when its value exists, so a page with no description/URL emits fewer
// tags (deletion test passes). All values are DATA (page schema plus served host),
// never hardcoded.
function headMetaTags({ title, description, canonicalUrl, ogType, imageUrl }) {
  const tags = [];
  const t = (title || '').trim();
  const d = (description || '').trim();
  const u = (canonicalUrl || '').trim();
  const image = (imageUrl || '').trim();
  if (d) tags.push(`<meta name="description" content="${escapeHtml(d)}">`);
  if (u) tags.push(`<link rel="canonical" href="${escapeHtml(u)}">`);
  tags.push(`<meta property="og:type" content="${escapeHtml(ogType || 'website')}">`);
  if (t) tags.push(`<meta property="og:title" content="${escapeHtml(t)}">`);
  if (d) tags.push(`<meta property="og:description" content="${escapeHtml(d)}">`);
  if (u) tags.push(`<meta property="og:url" content="${escapeHtml(u)}">`);
  if (image) tags.push(`<meta property="og:image" content="${escapeHtml(image)}">`);
  tags.push('<meta name="twitter:card" content="summary_large_image">');
  if (t) tags.push(`<meta name="twitter:title" content="${escapeHtml(t)}">`);
  if (d) tags.push(`<meta name="twitter:description" content="${escapeHtml(d)}">`);
  if (image) tags.push(`<meta name="twitter:image" content="${escapeHtml(image)}">`);
  return tags.join('\n');
}

function injectRoot(index, rootHtml, title, bodyTail = '', headMeta = '') {
  const start = index.indexOf(INDEX_START_MARKER);
  const end = index.indexOf(INDEX_END_MARKER);
  if (start < 0 || end < start) {
    throw new Error('index.html is missing entry root markers');
  }
  // Critical entry CSS must outlive the entry markup it styles. The browser shell replaces
  // everything inside #root when the current scene paints, so putting this style block beside
  // the server-rendered page made a successful hydration delete the stylesheet and leave the
  // signed-in application as unpositioned HTML. Keep the public markup replaceable, but lift the
  // explicitly persistent stylesheet into <head> before inserting that markup.
  const { persistentStyles, replaceableRootHtml } = liftPersistentEntryStyles(rootHtml);
  const contentStart = start + INDEX_START_MARKER.length;
  let html = `${index.slice(0, contentStart)}\n${replaceableRootHtml}\n${index.slice(end)}`;
  if (persistentStyles.length > 0) {
    if (!html.includes('</head>')) throw new Error('index.html is missing a head for critical entry styles');
    html = html.replace('</head>', `${persistentStyles.join('\n')}\n</head>`);
  }
  const safeTitle = escapeHtml(title || 'Application');
  // Inject the crawler head meta right after the title so description/canonical/og
  // sit in head for non-JS bots (the JSON-LD @graph already renders in-body).
  const titleReplacement = headMeta
    ? `<title>${safeTitle}</title>\n${headMeta}`
    : `<title>${safeTitle}</title>`;
  html = html.replace('<title>Application</title>', titleReplacement);
  // bodyTail renders OUTSIDE the entry root (which the client scene replaces on
  // hydration) so it persists in the live DOM — used for the funnel ladder.
  if (bodyTail) {
    html = html.includes('</body>') ? html.replace('</body>', `${bodyTail}\n</body>`) : `${html}\n${bodyTail}`;
  }
  return html;
}

function appShellPreloadLinks() {
  return [
    '<link rel="preload" href="/entry-scene" as="fetch" type="application/json" crossorigin="anonymous">',
    '<link rel="modulepreload" href="/src/shell-runtime.js">',
    '<link rel="modulepreload" href="/src/things-to-put-on-screen.js">',
    '<link rel="modulepreload" href="/src/slot-host.js">',
    '<link rel="modulepreload" href="/src/platform-shell-contract.js">',
  ].join('\n');
}

function appShellLinkHeader(entry) {
  return [
    '</entry-scene>; rel=preload; as=fetch; crossorigin=anonymous; type=application/json',
    '</src/shell-runtime.js>; rel=modulepreload',
    '</src/things-to-put-on-screen.js>; rel=modulepreload',
    '</src/slot-host.js>; rel=modulepreload',
    '</src/platform-shell-contract.js>; rel=modulepreload',
    ...(entry?.modulePreloadLinks || []),
  ].join(', ');
}

async function renderAppShell(req) {
  const html = await indexHtml();
  const [description, identity, hasIcon] = await Promise.all([
    livePageDescription(req).catch(() => null),
    appIdentityFromBundle(),
    appIconExists(),
  ]);
  const title = description?.title || description?.brand || identity?.app_name;
  let shell = title
    ? html.replace(/<title>Application<\/title>/i, `<title>${escapeHtml(title)}</title>`)
    : html;
  if (hasIcon && !/rel=["'](?:shortcut )?icon["']/i.test(shell)) {
    shell = shell.replace('</head>', `${appIdentityHeadLinks(true)}\n</head>`);
  }
  if (!shell.includes('rel="preload" href="/entry-scene"')) {
    shell = shell.replace('</head>', `${appShellPreloadLinks()}\n</head>`);
  }
  return shell;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPublicPageHtml({ chrome, directives, loaded, sourceId, checkoutPrice, checkoutOfferId, inlineCheckout }) {
  return renderToStaticMarkup(React.createElement(SalesPageView, {
    chrome,
    directives,
    loaded,
    sourceId,
    checkoutPrice,
    checkoutOfferId,
    inlineCheckout,
  }));
}

function normalizePath(value) {
  return (String(value || '').replace(/\/+$/, '') || '/').toLowerCase();
}

function checkoutForPublicRoute(records, path, cookieString, requestedOfferId = '') {
  const parsed = readCheckoutOffers(records.commercialOffers);
  if (parsed.length === 0) return null;
  // Observer-conditioned scoping (choose-per-observer): price/offer experiments
  // resolve per visitor from the offer-scoping projection + the request cookie.
  // No projection / no observer → list returned unchanged. Then eligibility
  // (offer-eligibility DATA rules × held refs) hides held-gated upsells for the
  // anonymous SSR visitor (heldRefs=[]); the base catalog is untouched. Both are
  // blind filters over the offer list — the renderer names no offer vocabulary.
  const { records: scoped } = scopeRecordsForObserver(parsed, records.offerScoping, cookieString || '');
  const { offers: allOffers } = applyOfferEligibility(scoped, [], records.offerEligibility);
  if (allOffers.length === 0) return null;
  const requestedOffer = requestedOfferId
    ? findCheckoutOfferBySelector(allOffers, requestedOfferId)
    : undefined;
  if (requestedOffer) return { offers: [requestedOffer], selectedOfferId: requestedOffer.id };
  const here = normalizePath(path);
  // ROUTE AUTHORITY = the funnel (supersedes offer.oto_route_path — L030/L101).
  // A funnel node owns its route (`route_path`) and links to the access-granting
  // commercial-offer (`offer_ref`). The request path resolves to the funnel
  // node, then to its linked offer. The offer's own oto_route_path is no longer
  // read here — the funnel graph is the single route→offer authority.
  const funnelNodes = Array.isArray(records.funnelRecords)
    ? records.funnelRecords.filter((r) => r && r.kind === 'funnel-node' && r.route_path && r.offer_ref)
    : [];
  const routedNode = funnelNodes.find((n) => normalizePath(n.route_path) === here);
  if (routedNode) {
    const offer = allOffers.find((o) => o.id === routedNode.offer_ref);
    if (offer) return { offers: [offer], selectedOfferId: offer.id };
  }
  // Default (multi-plan) checkout = every offer NOT claimed by a funnel route.
  const funnelRoutedOfferIds = new Set(funnelNodes.map((n) => n.offer_ref));
  return {
    offers: allOffers.filter((offer) => !funnelRoutedOfferIds.has(offer.id)),
    selectedOfferId: undefined,
  };
}

function publicPageWantsCheckout(chrome, directives) {
  if (chrome?.checkout?.enabled) return true;
  return directives.some((directive) => directive?.kind === 'cta' && directive?.action?.enabled);
}

function renderPublicCheckoutHtml({ offers, selectedOfferId, title }) {
  if (!offers.length) return '';
  return renderToStaticMarkup(React.createElement(CheckoutFlow, {
    offers,
    selectedOfferId,
    title,
  }));
}

// A direct checkout visit needs only the commercial-offer catalog. It must not
// wait for the full sales-page snapshot, funnel graph, media library, or page
// selection state. The requested offer remains DATA-driven, and an unscoped
// /checkout visit renders the published catalog as the fallback chooser.
async function renderDirectCheckoutEntry(req, url) {
  const commercialOffers = await readCommercialOffers();
  const requestedOfferId = url.searchParams.get('offer') || '';
  const checkout = checkoutForPublicRoute({
    commercialOffers,
    offerScoping: null,
    offerEligibility: null,
    funnelRecords: [],
  }, url.pathname, req.headers.cookie, requestedOfferId);
  if (!checkout || checkout.offers.length === 0) return null;
  const checkoutHtml = `<div id="checkout-form">${renderPublicCheckoutHtml({
    offers: checkout.offers,
    selectedOfferId: checkout.selectedOfferId,
    title: 'Your details',
  })}</div>`;
  const checkoutScopeScript = `<script>window.__checkoutOffersForThisPage__=${JSON.stringify({
    selectedOfferId: checkout.selectedOfferId ?? null,
    offerIds: checkout.offers.map((offer) => offer.id),
    offers: checkout.offers,
  }).replace(/</g, '\\u003c')};</script>`;
  const checkoutMountScript = `<script type="module">import mountCheckout from "/assets/checkout/app.js";mountCheckout({el:document.getElementById("checkout-form"),props:{offers:window.__checkoutOffersForThisPage__.offers,selectedOfferId:window.__checkoutOffersForThisPage__.selectedOfferId||undefined,title:"Your details"}});</script>`;
  const selectedOffer = checkout.selectedOfferId
    ? checkout.offers.find((offer) => offer.id === checkout.selectedOfferId)
    : null;
  // The document title when no offer is selected was one tenant's brand, which every other
  // tenant would have worn in its own browser tab. The tenant names it, and the default names
  // the PAGE rather than a company, for the same reason the lead attribution default does: a
  // generic word is honest, and a borrowed brand is wrong in a way nobody would notice quickly.
  const checkoutDescription = await livePageDescription(req);
  const title = selectedOffer?.label || checkoutDescription?.checkout_title || 'Checkout';
  return {
    html: injectRoot(await indexHtml(), `${await styleBlockFor(checkoutDescription)}\n${checkoutHtml}`, title, `${checkoutScopeScript}${checkoutMountScript}`),
  };
}

// Resolve the rich value-ladder funnel from the live funnel-offer-graph records.
function resolveFunnelForRequest(records) {
  const fr = Array.isArray(records.funnelRecords) ? records.funnelRecords : [];
  const byKind = (k) => fr.filter((p) => p && typeof p === 'object' && p.kind === k);
  try {
    return resolveFunnelFlow(
      byKind('funnel-graph'), byKind('funnel-node'),
      byKind('experiment'), byKind('experiment-variant'), byKind('offer-experiment'),
    );
  } catch {
    return null;
  }
}

// Render the resolved funnel value-ladder as a visible section. Every value
// (name, price, A/B provenance) comes from the funnel records — data-* attrs
// carry the provenance so consumption is browser-verifiable.
function renderFunnelLadderHtml(flow) {
  if (!flow || !flow.order || flow.order.length === 0) return '';
  const dollars = (c) => `$${(c / 100).toLocaleString('en-US')}`;
  const steps = flow.order.map((id) => {
    const s = flow.steps[id];
    if (!s) return '';
    const entry = s.id === flow.entry.id;
    const recur = s.offer.recurring ? `<span style="opacity:.6">/${escapeHtml(s.offer.recurring)}</span>` : '';
    const ab = entry && s.price_source === 'experiment-winner'
      ? `<span data-experiment="${escapeHtml(s.price_source_ref || '')}" style="margin-left:8px;font-size:11px;color:#9fe870;border:1px solid #2c5a2c;border-radius:99px;padding:1px 8px">A/B winner</span>`
      : '';
    return `<li data-funnel-node="${escapeHtml(s.id)}" data-amount-cents="${s.display_amount_cents}" data-price-source="${escapeHtml(s.price_source)}" style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;border:1px solid #1c1c1c;border-radius:12px;background:${entry ? '#0d0d0d' : 'transparent'}">
      <span style="font-weight:${entry ? 600 : 400}">${escapeHtml(s.offer.name)}</span>
      <span style="font-variant-numeric:tabular-nums;white-space:nowrap">${dollars(s.display_amount_cents)}${recur}${ab}</span>
    </li>`;
  }).join('');
  return `<section data-surface="funnel" data-funnel-graph="${escapeHtml(flow.graph_id)}" style="max-width:640px;margin:48px auto;padding:0 20px;color:#fff;font-family:system-ui,-apple-system,sans-serif">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.5;margin-bottom:12px">the path</div>
    <ol style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px">${steps}</ol>
  </section>`;
}

// F4 — the funnel STATE MACHINE drives checkout. The buyer occupies one node
// (the cursor, persisted in the `funnel_cursor` cookie; default = entry). The
// active-step panel renders the current node's offer with a purchase action and
// a decline action. Each action advances the cursor along the funnel-node's OWN
// `transitions` (advanceFunnel) — the NEXT offer is decided by the record, NOT
// by oto_route_path. Terminal targets end the flow. Zero hardcoded ids/prices.
const FUNNEL_CURSOR_COOKIE = 'funnel_cursor';

// Resolve the effective cursor + any Set-Cookie needed, given the request's
// current cursor cookie and an optional outcome (?fo=purchase|decline). Returns
// {flow, step, setCookie}. An outcome advances the cursor and stamps the cookie.
function resolveFunnelCursor(flow, cookieString, outcome, routeNodeId) {
  if (!flow) return { flow: null, step: null, setCookie: null };
  const cookies = parseCookies(cookieString);
  // Cursor priority: an explicit outcome advances from the cookie; otherwise a
  // route that maps to a funnel node seeds the cursor there (so /book shows the
  // downsell-book node, /master-class the example-person node), else the cookie, else
  // the graph entry. This unifies the active offer with the page route.
  const current = cookies.get(FUNNEL_CURSOR_COOKIE)
    || (routeNodeId && flow.steps[routeNodeId] ? routeNodeId : null)
    || flow.entry.id;
  if (outcome) {
    const adv = advanceFunnel(flow, flow.steps[current] ? current : flow.entry.id, outcome);
    // Terminal transition → reset to entry so the ladder can be walked again.
    const nextId = adv.next ? adv.next.id : flow.entry.id;
    return {
      flow,
      step: funnelStepAtCursor(flow, nextId),
      setCookie: `${FUNNEL_CURSOR_COOKIE}=${encodeURIComponent(nextId)}; Path=/; Max-Age=1800; SameSite=Lax`,
      terminalReached: adv.terminal,
    };
  }
  return { flow, step: funnelStepAtCursor(flow, current), setCookie: null };
}

// Humanize a raw transition outcome token into a button label WITHOUT enumerating
// known tokens — "purchase" → "Purchase", "add_to_cart" → "Add To Cart". A DATA
// `label` on the transition wins when present. Generic for any outcome vocabulary.
function humanizeOutcome(token) {
  return String(token || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || 'Continue';
}

// Render the current funnel step as the ACTIVE offer. GENERIC: one action per
// funnel-node transition (the transition's OWN `on` token is the outcome passed
// to ?fo=<on>) — the handler never enumerates outcome names, so a node with
// {upgrade, gift, decline} renders all three with zero code change (L090). The
// primary action is the transition flagged `primary`/`role:primary`, else the
// first; only the primary carries the node's price. data-* attrs carry the
// cursor + transition targets so the state machine is browser-verifiable.
function renderFunnelActiveStepHtml(flow, step, opts = {}) {
  if (!flow || !step) return '';
  const dollars = (c) => `$${(c / 100).toLocaleString('en-US')}`;
  // SSOT: for a node linked to a commercial-offer, the DISPLAYED price + name
  // come from the SAME source the checkout charges (opts.displayOffer), so the
  // shown price can never diverge from the charged price. Unlinked nodes fall
  // back to the node's own inline offer (the funnel-authored SSOT).
  const shown = opts.displayOffer || { amount_cents: step.display_amount_cents, name: step.offer.name, recurring: step.offer.recurring };
  const recur = shown.recurring ? `<span style="opacity:.6">/${escapeHtml(shown.recurring)}</span>` : '';
  const path = opts.path || '/book';
  const transitions = Array.isArray(step.transitions) ? step.transitions : [];
  const primaryIdx = Math.max(0, transitions.findIndex((t) => t.primary === true || t.role === 'primary'));
  // The PRIMARY (paid) action leads to the real checkout form (#checkout-form) —
  // the buyer actually pays; the funnel only advances after payment.confirmed
  // (the offer's post_purchase_route_path fires ?fo=<primary outcome>). Secondary
  // actions (decline/skip) advance immediately via ?fo=<outcome> WITHOUT payment.
  // The PRIMARY (paid) action scrolls to the live checkout form. The SSR
  // checkout lives inside the entry-root (replaced on hydration), so we can't
  // rely on an SSR anchor — the onclick finds the real (client-rendered)
  // checkout in the browser (its email field, or #checkout-form pre-hydration).
  const scrollJs = "var e=document.querySelector('#checkout-form,input[type=email],input[name*=mail]');if(e){e.scrollIntoView({behavior:'smooth',block:'center'});e.focus&&e.focus();return false;}";
  // HONEST CTA: the paid "<label> — $X" button is shown ONLY when this node has a
  // genuinely sellable linked offer the checkout will charge at this price
  // (opts.sellable). Otherwise the checkout can't charge this price, so we do NOT
  // promise it — the primary action is a neutral scroll to the real options
  // (no false price promise — L114/L117).
  const sellable = opts.sellable !== false;
  const actions = transitions.map((t, i) => {
    const label = escapeHtml(t.label ? t.label : humanizeOutcome(t.on));
    if (i === primaryIdx) {
      const cta = sellable ? `${label} — ${dollars(shown.amount_cents)}${recur}` : 'See your options';
      return `<a data-funnel-action="${escapeHtml(t.on)}" data-transition-to="${escapeHtml(t.to)}" data-requires-payment="${sellable ? 'true' : 'false'}" href="#checkout-form" onclick="${escapeHtml(scrollJs)}" style="display:inline-block;background:#9fe870;color:#04210a;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:10px">${cta}</a>`;
    }
    return `<a data-funnel-action="${escapeHtml(t.on)}" data-transition-to="${escapeHtml(t.to)}" href="${escapeHtml(path)}?fo=${escapeHtml(t.on)}" style="margin-left:16px;color:#888;text-decoration:underline;font-size:14px">${label}</a>`;
  }).join('');
  const actionRow = actions || `<span style="opacity:.6">${dollars(shown.amount_cents)}${recur}</span>`;
  return `<section id="funnel-checkout" data-surface="funnel-active" data-funnel-graph="${escapeHtml(flow.graph_id)}" data-active-node="${escapeHtml(step.id)}" data-active-cents="${shown.amount_cents}" data-price-source="${escapeHtml(step.price_source)}" style="max-width:640px;margin:24px auto 0;padding:20px;border:1px solid #244; border-radius:14px;background:#08130c;color:#fff;font-family:system-ui,-apple-system,sans-serif">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.5;margin-bottom:8px">your offer</div>
    <div style="font-size:20px;font-weight:600;margin-bottom:4px">${escapeHtml(shown.name)}</div>
    <div style="font-size:15px;opacity:.7;margin-bottom:16px;font-variant-numeric:tabular-nums">${dollars(shown.amount_cents)}${recur}</div>
    <div>${actionRow}</div>
  </section>`;
}

// Project a resolved funnel step → a CheckoutOffer the checkout can charge
// (dynamic from amount_cents; no pre-provisioned Stripe price). Used ONLY when
// the node has no linked commercial-offer (offer_ref) — the funnel node is the
// offer authority (SSOT); the projection carries no access grant (empty
// access_refs), so linked offers are preferred for anything that grants access.
// post_purchase_route_path advances the funnel on payment.confirmed.
function funnelNodeToCheckoutOffer(step, advanceUrl) {
  return {
    access_refs: [], benefits: [step.offer.name], content_refs: [], curriculum: [],
    id: step.id, label: step.offer.name, sort_order: 0, summary: step.offer.name,
    post_purchase_route_path: advanceUrl,
    price_options: [{
      id: `${step.id}:price`, label: `$${(step.display_amount_cents / 100).toLocaleString('en-US')}`,
      amount_cents: step.display_amount_cents, currency: 'usd',
      payment_timing: step.offer.recurring ? 'recurring' : 'one_time',
    }],
  };
}

// Resolve the effective offer for a funnel step: the SINGLE source the active
// step DISPLAYS and the checkout CHARGES. For a linked node (offer_ref) that
// source is the commercial-offer (price + name); the node's inline offer is used
// only for unlinked nodes (the funnel-authored SSOT). Returns {amount_cents,
// name, recurring, linkedOffer|null}.
//
// ⛔ THIS COMMENT ONCE ENDED "Prevents display/charge price divergence" AND THAT WAS THE OPPOSITE OF
// WHAT THE CODE DID. It took `linked.price_options[0]`, a POSITIONAL pick, and position in that
// array is a value nobody authored. The pick is gone as of 2026-09-05 evening; the reasoning is kept
// because it is the argument for why a named id is the only correct shape here, and because two
// siblings named at the bottom of this block still carry the rule:
//
//   * `CommercialPriceOption` (checkout/read-data/read-offers.ts:1-28) has NO `sort_order`, while
//     `CheckoutOffer` HAS one and `readCheckoutOffers:301` sorts by it. The schema gives offers an
//     ordering key and options none, deliberately.
//   * `readPriceOptions` MUTATES position while decoding: `:202` DROPS any option with no `label`,
//     and `:180` assigns `price:${index}` when `id` is absent.
//
// So an unrelated DATA edit reorders this, and the price shown here silently changes. Every path
// that actually CHARGES resolves by id or by set membership instead (verify-paid-amount.ts:35-38,
// :80, :104-112; checkout-quote.ts:206; gate-checkout.ts:1145; CheckoutFlow.tsx:767), which is why
// a positional pick here can disagree with the charge rather than prevent disagreement.
//
// IT WAS NOT HYPOTHETICAL. checkout/show/CheckoutFlow.tsx:592-598 records the incident that this
// exact expression caused there: a paid offer whose first option is a $0/trial row rendered the
// green "Create free access" CTA on a PAID product, "the stray green button students reported".
// That was fixed in CheckoutFlow and left standing here for months, so this was the pre-fix code
// verbatim, in a second package, after the first one had already cost real trust.
//
// THE REPAIR IS A DELETION, NOT A BETTER GUESS, and it is sequenced rather than deferred: the
// seller NAMES the price option id, exactly as `offer_id` is already named. Independent adversarial
// convergence, verdict and full evidence:
// ai-command-center/notes/projects/packages-and-package-sets/checkout/convergence/2026-09-05-which-price-option-a-surface-shows-and-charges.md
//
// ⛔ THIS COMMENT USED TO PRICE THE REPAIR AS "a DATA change to every installed page description
// which must land WITH this code or every tenant's envelope goes unavailable in between". THAT COST
// IS FALSE and it was the reason this line stood. A second convergence attacked it and a live read
// settled it: against the running app, a complete scan of `current-item` (114 pages,
// `hit_limit: false`) returns `funnel-node` **0** and `funnel-graph` **0**, with `commercial-offer`
// **1** in the same command as the control that proves the scan reaches records at all. There is no
// tenant population to migrate, because there is none.
//
// AND THE LINE BELOW IS UNREACHABLE, WHICH IS SHARPER THAN IT BEING WRONG. This branch is gated on
// `step.offer_ref`, but `readFunnelNode` (`funnel-offer-graph/read-data/resolve-funnel-flow.ts:75`)
// returns null unless the record ALSO carries a top-level `offer.amount_cents` and `offer.name`.
// Every funnel-node instance in the tree has exactly one of the two, so the intersection is empty
// and this expression has never run. Deleting it therefore does not repair a live wrong price; the
// live defect is upstream, in a decoder that rejects the only node shape anyone authors.
//
// ✅ THE POSITIONAL PICK IS DELETED, 2026-09-05 evening, and the counterintuitive ordering below is
// what forced it to go first rather than last. This comment used to end by sequencing the repair
// after a decoder change, which left an armed expression sitting here: the moment `readFunnelNode`
// accepts the node shape people actually author, `price_options[0]` runs on real money for the
// first time. A defect that is unreachable today and becomes reachable through somebody else's
// correct fix is worse than a live one, because the person who trips it will be looking at their
// own change. Deleting it costs nothing to migrate, proven rather than assumed: a complete live
// scan of `current-item` (114 pages, `hit_limit: false`) returns `funnel-node` 0 and `funnel-graph`
// 0, with `commercial-offer` 1 in the same command as the control that proves the scan reaches
// records at all. There is no tenant population, so there is no window to land DATA and code
// together across.
//
// STILL OPEN, and it is a decision rather than a search: at `:2161` the `??` silently makes a
// linked offer outrank a graduated A/B experiment winner and discards `resolveExperimentWinnerAmount`
// with no report. Untouched here on purpose, because "does a graduated winner beat a linked offer's
// price, or are linked offers not experimentable" is a product call. The other two siblings of this
// rule are no longer positional (repaired 2026-09-05, verified 2026-09-08): `funnel-definition.ts`
// `offerAmount` resolves named-or-sole and falls through to the offer's flat amount, and
// `author-studio-funnel.mjs` `declaredPrices` lists every declared amount rather than picking one. No
// live positional money pick remains in this lane; the deletion here was the last of them.
//
// ALSO STILL OPEN: `readFunnelNode` (`funnel-offer-graph/read-data/resolve-funnel-flow.ts:75`)
// returns null unless the record carries a top-level `offer.amount_cents` AND `offer.name`, while
// every authored node has one of the two, so the live defect is that decoder rejecting the only
// shape anyone writes. That repair is now SAFE to make in either order, which is the point of doing
// this deletion first. Full evidence:
// ai-command-center/notes/projects/packages-and-package-sets/funnel-offer-graph/convergence/2026-09-05-does-a-funnel-node-name-the-price-option-it-sells.md
// Which option of a linked offer this step sells, NAMED rather than inferred from position.
//
// The step names it as `price_option_ref`, beside the `offer_ref` it already names, which is the
// same shape `public-sales-page` settled on (`checkout_price_option_id` beside `checkout_offer_id`).
// A sole option needs no name because there is nothing to choose between. Anything else returns
// null and the caller falls back to `display_amount_cents`, the number the funnel author actually
// wrote, rather than to whichever row a decoder happened to leave first.
//
// This is deliberately NOT a shared helper with the sibling packages. Centralising it would make one
// owner for a rule whose whole defect was being applied where nobody had authored an answer; the
// convergence verdict says so outright. What is shared is the DATA vocabulary, not the code.
//
// It now lives in `../read-data/named-price-option.mjs`, still package-local, imported at the top of
// this file. Moving it out of this program is not a step toward centralising it: this file exports
// nothing, so while the rule sat here nothing could import the expression that decides which price a
// funnel step charges, and it was the only one of this lane's four sites with no test of its own.

function resolveEffectiveOffer(records, step) {
  if (step && step.offer_ref) {
    const parsed = readCheckoutOffers(records.commercialOffers);
    const linked = parsed.find((o) => o.id === step.offer_ref);
    if (linked) {
      const price = namedPriceOption(linked, step.price_option_ref);
      return {
        amount_cents: price?.amount_cents ?? step.display_amount_cents,
        name: linked.label || step.offer.name,
        recurring: price && price.payment_timing && price.payment_timing !== 'one_time' ? (price.interval || 'monthly') : step.offer.recurring,
        linkedOffer: linked,
      };
    }
  }
  return { amount_cents: step ? step.display_amount_cents : 0, name: step ? step.offer.name : '', recurring: step ? step.offer.recurring : undefined, linkedOffer: null };
}

// The checkout offer = the funnel cursor node's offer: its linked commercial-
// offer (offer_ref → full access grant) when present, else the node projection.
// Falls back to the route/default checkout when there is no funnel/cursor.
function checkoutForFunnelCursor(records, step, advanceUrl, path, cookieString, requestedOfferId = '') {
  if (requestedOfferId) {
    const requested = checkoutForPublicRoute(records, path, cookieString, requestedOfferId);
    if (requested?.selectedOfferId) return requested;
  }
  if (step) {
    if (step.offer_ref) {
      const parsed = readCheckoutOffers(records.commercialOffers);
      const { records: scoped } = scopeRecordsForObserver(parsed, records.offerScoping, cookieString || '');
      const { offers } = applyOfferEligibility(scoped, [], records.offerEligibility);
      const linked = offers.find((o) => o.id === step.offer_ref);
      // Advance the funnel after a real payment: the offer navigates to the
      // primary transition's ?fo=<outcome> on payment.confirmed. advanceUrl is
      // null when the primary transition is terminal (no next node) — then keep
      // the offer's own post-purchase destination (a thank-you/watch page).
      if (linked) {
        const offer = advanceUrl ? { ...linked, post_purchase_route_path: advanceUrl } : linked;
        return { offers: [offer], selectedOfferId: offer.id };
      }
    }
    const projected = funnelNodeToCheckoutOffer(step, advanceUrl);
    return { offers: [projected], selectedOfferId: projected.id };
  }
  return checkoutForPublicRoute(records, path, cookieString, requestedOfferId);
}

// Scope a checkout to a single offer id — a DEDICATED sales page's own `offer_ref`
// (the route→offer authority when NO funnel node claims the route). Same observer
// scoping + eligibility filter as the funnel-cursor checkout. Makes the wrong-offer
// fallback (a sales-page-only route silently showing the funnel ENTRY offer)
// structurally impossible: any sales page scopes to its own offer, no funnel node needed.
function checkoutForOfferRef(records, offerRef, cookieString) {
  if (!offerRef) return null;
  const parsed = readCheckoutOffers(records.commercialOffers);
  const { records: scoped } = scopeRecordsForObserver(parsed, records.offerScoping, cookieString || '');
  const { offers } = applyOfferEligibility(scoped, [], records.offerEligibility);
  const offer = offers.find((o) => o.id === offerRef);
  return offer ? { offers: [offer], selectedOfferId: offer.id } : null;
}

// Render the page's cta-link records as the on-page CTAs (DATA-driven). The
// primary CTA whose href is an in-page anchor (#checkout) is retargeted to the
// funnel active-step (#funnel-checkout); the attribution_key rides as a data
// attr for conversion attribution. Generic: one button per cta-link record,
// role styling from DATA, zero hardcoded labels/hrefs.
function renderCtaLinksHtml(ctas) {
  if (!Array.isArray(ctas) || ctas.length === 0) return '';
  const buttons = ctas.map((c) => {
    const href = /^#/.test(c.href) ? '#funnel-checkout' : c.href;
    const primary = c.role === 'primary';
    const style = primary
      ? 'display:inline-block;background:#9fe870;color:#04210a;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:10px'
      : 'display:inline-block;margin-left:14px;color:#9aa;text-decoration:underline;font-size:14px;padding:12px 0';
    return `<a data-surface="cta-link" data-cta-id="${escapeHtml(c.id)}" data-cta-role="${escapeHtml(c.role)}" data-attribution="${escapeHtml(c.attribution || '')}" href="${escapeHtml(href)}" style="${style}">${escapeHtml(c.label)}</a>`;
  }).join('');
  return `<section data-surface="cta-links" style="max-width:640px;margin:32px auto 0;padding:0 20px;text-align:center">${buttons}</section>`;
}

async function renderPublicEntry(req, url) {
  if (normalizePath(url.pathname) === '/checkout') {
    const checkoutEntry = await renderDirectCheckoutEntry(req, url);
    if (checkoutEntry) return checkoutEntry;
  }
  // The archive is the selected Article source for both normal and recovery
  // reads. An exact log row can be a candidate, but cannot replace an Article
  // route before the publisher carries it into that archive. The publisher
  // must separately refuse archive replacement without current reviews.
  const exactPublicPage = await readCurrentPayload(`${LABELS.publicPages}::${url.pathname}`).catch(() => null);
  const exactPages = parseSelectablePages(exactPublicPage);
  const archivedPages = parseSelectablePages(await fallbackPagesFor(await publicationPageDescription(req)));
  const selected = selectedPublicPagesForRoute(exactPages, archivedPages, url.pathname);
  if (selected.protectedArticleRoute && selected.pages.length === 0) return { notFound: true };
  // Raw documents do not depend on the sales-page descriptor, offers, funnel,
  // media library, or selection state. Return a single exact raw owner before
  // hydrating those unrelated records. This keeps HTML, XML, JSON, and text
  // route records O(1), and prevents one slow optional sales dependency from
  // blocking an independently complete document.
  if (selected.pages.length === 1) {
    const exact = composeArchiveArticleDiscovery(selected.pages, archivedPages, url.pathname)[0];
    if (exact && typeof exact === 'object'
      && typeof exact.content_type === 'string' && exact.content_type.trim()
      && typeof exact.body_text === 'string') {
      return { raw: { body: exact.body_text, contentType: exact.content_type.trim() } };
    }
  }
  const records = await liveRecords();
  const pages = composeArchiveArticleDiscovery(selected.pages, archivedPages, url.pathname);
  const selectionSurface = resolveSelectionForPath(records.selectionSurfaces, records.deciders, url.pathname);
  const observer = deriveObserverContext(requestSnapshot(req, url));
  const selectionConfig = selectionSurface && observer.observerId
    ? {
        selectionSurface: {
          address: selectionSurface.address,
          decider_program_ref: selectionSurface.decider_program_ref,
          decider: selectionSurface.decider,
        },
        observerFacts: observer.facts,
        stickyKey: observer.stickyKeyFor(selectionSurface.stickyAddress),
        selectWinnerFn: buildPageSelectWinnerFn(pages),
      }
    : undefined;
  const winner = resolvePage({
    pages,
    currentPath: url.pathname,
    selectionSurface: selectionConfig?.selectionSurface,
    observerFacts: selectionConfig?.observerFacts,
    stickyKey: selectionConfig?.stickyKey,
    selectWinnerFn: selectionConfig?.selectWinnerFn,
  }).page;
  // Generic raw-document serving (L090): a resolved page record that carries
  // `content_type` + `body_text` is served verbatim with that content type —
  // no HTML shell, no directives. llms.txt, robots.txt, sitemap.xml, or ANY
  // future plain/XML/JSON document is then pure record DATA (route_path +
  // content_type + body_text); the renderer names no route and no format.
  // A record without these fields renders as a normal page (deletion test).
  if (winner && typeof winner === 'object'
    && typeof winner.content_type === 'string' && winner.content_type.trim()
    && typeof winner.body_text === 'string') {
    return { raw: { body: winner.body_text, contentType: winner.content_type.trim() } };
  }
  const snapshot = readInteractionSnapshot(
    winner,
    records.mediaLibrary,
    { records: [records.descriptor] },
    'public-sales-page',
  );
  const chrome = salesPageChrome(snapshot);
  if (!chrome.brandLogo && typeof winner.brand_logo === 'string') chrome.brandLogo = winner.brand_logo;
  // AEO / JSON-LD: emit the resolved page record's own `schema` DATA verbatim as a
  // <script type="application/ld+json"> (SalesPageView reads chrome.schema). Generic +
  // blind — ANY page record that carries a `schema` object (an schema.org @graph,
  // Article, Organization, WebSite, …) gets it emitted; a record without one emits
  // nothing (deletion test passes). Zero entity vocabulary lives here — the schema
  // content is 100% record DATA authored per-tenant (L090 / L117).
  if (winner && typeof winner === 'object' && winner.schema != null) {
    chrome.schema = winner.schema;
  }
  const directives = salesPageRenderPlan(snapshot);
  const isCheckoutRoute = normalizePath(url.pathname) === '/checkout';
  // Public HTML and the hydrated page use the same record-authored price path.
  // This matters for crawlers and for the first pixels before the browser island
  // runs: a price-bearing label is composed from the current commercial-offer
  // row, never from stale copy embedded in an article record.
  const { price: pageCheckoutPrice, offerId: pageCheckoutOfferId } = pageCtaPrice(records.commercialOffers, winner);
  const inlineCheckoutOffer = winner?.inline_checkout === true && pageCheckoutOfferId
    ? readCheckoutOffers(records.commercialOffers).find((offer) => offer.id === pageCheckoutOfferId)
    : undefined;
  const page = isCheckoutRoute ? '' : renderPublicPageHtml({
    chrome,
    directives,
    loaded: winner.id !== 'public-sales-page:empty',
    sourceId: typeof winner.id === 'string' ? winner.id : undefined,
    checkoutPrice: pageCheckoutPrice,
    checkoutOfferId: pageCheckoutOfferId,
    inlineCheckout: inlineCheckoutOffer ? {
      offer: inlineCheckoutOffer,
      title: typeof winner.checkout_title === 'string' ? winner.checkout_title : undefined,
      description: typeof winner.checkout_description === 'string' ? winner.checkout_description : undefined,
      sharedPricingIsland: true,
    } : undefined,
  });
  const flow = resolveFunnelForRequest(records);
  const funnelHtml = renderFunnelLadderHtml(flow);
  // F4: advance the buyer-session cursor when an outcome is present (?fo=...),
  // render the current step as the active offer. The cursor cookie is returned
  // to the caller so the state machine persists across requests.
  const outcome = url.searchParams.get('fo') || '';
  // Which funnel node owns this route (route_path match) — seeds the cursor.
  const here = normalizePath(url.pathname);
  const routeNode = Array.isArray(records.funnelRecords)
    ? records.funnelRecords.find((r) => r && r.kind === 'funnel-node' && r.route_path && normalizePath(r.route_path) === here)
    : undefined;
  // Route→offer authority (SSOT): a funnel-node's `route_path` scopes funnel routes; a
  // DEDICATED sales page with NO funnel node scopes via its OWN `offer_ref`. Without this
  // fallback a sales-page-only route silently shows the funnel ENTRY offer (the
  // /full-program → $47 wrong-offer trap). One resolver; no redundant per-route funnel
  // node needed for a pure sales page.
  const salesPageOfferRef = (!routeNode && winner && typeof winner.offer_ref === 'string' && winner.offer_ref.trim())
    ? winner.offer_ref.trim()
    : '';
  const cursor = resolveFunnelCursor(flow, req.headers.cookie, outcome, routeNode?.id);
  // SSOT: display + charge read the same effective offer (linked commercial-offer
  // for linked nodes, else the node's inline offer).
  const effectiveOffer = cursor.step ? resolveEffectiveOffer(records, cursor.step) : null;
  // A node is "sellable" only when it links to a real commercial-offer the
  // checkout can charge at this price. Unlinked entry nodes (e.g. front-diagnosis
  // $47, with no commercial-offer yet) are NOT sellable → no false price CTA.
  const sellable = !!(effectiveOffer && effectiveOffer.linkedOffer);
  const activeStepHtml = renderFunnelActiveStepHtml(cursor.flow, cursor.step, { path: url.pathname, displayOffer: effectiveOffer || undefined, sellable });
  // The post-payment advance outcome = the primary (paid) transition's token
  // (generic — never hardcoded "purchase"). After a real payment the offer's
  // post_purchase_route_path fires this ?fo=<outcome> to advance the funnel.
  const primaryTransition = cursor.step && Array.isArray(cursor.step.transitions)
    ? (cursor.step.transitions.find((t) => t.primary === true || t.role === 'primary') || cursor.step.transitions[0])
    : undefined;
  // Only advance after payment when the primary transition leads to a real node
  // (non-terminal). advanceFunnel returns terminal=true when there is no next
  // node — then advanceUrl is null and the offer keeps its own destination.
  const primaryAdvance = flow && cursor.step && primaryTransition
    ? advanceFunnel(flow, cursor.step.id, primaryTransition.on)
    : null;
  const advanceUrl = primaryAdvance && !primaryAdvance.terminal
    ? `${url.pathname}?fo=${encodeURIComponent(primaryTransition.on)}`
    : null;
  const requestedCheckoutOfferId = isCheckoutRoute ? (url.searchParams.get('offer') || '') : '';
  // The checkout charges the funnel cursor node's offer (linked commercial-offer
  // for access, else the node projection) — the funnel drives the real charge.
  const checkout = !publicPageWantsCheckout(chrome, directives)
    ? null
    : requestedCheckoutOfferId
      ? checkoutForPublicRoute(records, url.pathname, req.headers.cookie, requestedCheckoutOfferId)
      : salesPageOfferRef
      ? checkoutForOfferRef(records, salesPageOfferRef, req.headers.cookie)
      : checkoutForFunnelCursor(
          records,
          cursor.step,
          advanceUrl,
          url.pathname,
          req.headers.cookie,
          requestedCheckoutOfferId,
        );
  // A MULTI-PLAN page (the main page / any page with no single scoped offer) shows
  // ONLY the offers it DECLARES in `checkout_offer_ids` — the page is the authority
  // for its own plan set. This closes the category "every catalog offer auto-leaks
  // onto the main page" (L063): a new offer never appears on the home unless the
  // home page's declared list names it. Single-offer scoped checkouts (OTO routes,
  // `selectedOfferId` set) are untouched — they always show their one offer.
  const declaredOfferIds = Array.isArray(winner.checkout_offer_ids)
    ? winner.checkout_offer_ids.filter((id) => typeof id === 'string')
    : [];
  if (checkout && !checkout.selectedOfferId && declaredOfferIds.length > 0) {
    const declared = new Set(declaredOfferIds);
    checkout.offers = checkout.offers.filter((offer) => declared.has(offer.id));
  }
  const checkoutHtml = checkout
    ? `<div id="checkout-form">${renderPublicCheckoutHtml({
        offers: checkout.offers,
        selectedOfferId: checkout.selectedOfferId,
        title: 'Your details',
      })}</div>`
    : '';
  // cta-link records for the current page → on-page CTAs (DATA-driven copy/utm).
  const ctaRecords = Array.isArray(records.funnelRecords)
    ? records.funnelRecords.filter((p) => p && typeof p === 'object' && p.kind === 'cta-link')
    : [];
  const pageId = typeof winner.id === 'string' ? winner.id : undefined;
  const ctaHtml = renderCtaLinksHtml(resolveCtaLinks(ctaRecords, pageId));
  // Route→offer authority is the funnel (the ONE resolver, checkoutForPublicRoute).
  // Its resolved scope is injected as a generic environment hook in bodyTail (OUTSIDE
  // the entry-root, so it survives client hydration) — the client checkout READS this
  // scope instead of re-resolving the route itself. This replaces the deleted
  // offer.oto_route_path client resolver (L030/L101): one authority, no second resolver,
  // no package coupling. Absent (non-checkout page / Johnny's app) → client falls back.
  // The scope hook tells the CLIENT checkout which offers THIS page sells (the client
  // picker narrows to these + drops the rest). Prefer the resolved checkout's offers;
  // else fall back to the page's DECLARED `checkout_offer_ids` so a multi-plan page
  // (the main page) scopes the client to its declared set even when the SSR form path
  // did not resolve a checkout — this is what stops every catalog offer leaking onto
  // the client-rendered main-page picker (L063 category fix, paired with the SSR filter).
  const scopeOfferIds = checkout && Array.isArray(checkout.offers) && checkout.offers.length
    ? checkout.offers.map((o) => o.id)
    : (Array.isArray(winner.checkout_offer_ids) ? winner.checkout_offer_ids.filter((id) => typeof id === 'string') : []);
  const checkoutScopeScript = scopeOfferIds.length
    ? `<script>window.__checkoutOffersForThisPage__=${JSON.stringify({
        selectedOfferId: (checkout && checkout.selectedOfferId) ?? null,
        offerIds: scopeOfferIds,
      }).replace(/</g, '\\u003c')};</script>`
    : '';
  const inlineCheckoutScript = inlineCheckoutOffer
    ? `<script>window.__inlineCheckoutOfferForThisPage__=${JSON.stringify({
        pageId: winner.id,
        offer: inlineCheckoutOffer,
      }).replace(/</g, '\\u003c')};</script><script defer src="/assets/program-landing/article-pricing.js"></script>`
    : '';
  const body = `${await styleBlockFor(await livePageDescription(req))}\n${page}\n${checkoutHtml}`;
  // A DIRECT single-offer sales route (the buyer landed on /book, /stroke-diagnosis,
  // /founding, /master-class …, i.e. `routeNode` matched this path) shows exactly ONE
  // clean inline checkout. The funnel-active card, the value ladder, and the on-page
  // cta-links are the funnel-TRAVERSAL surface (home/entry) — rendering all three on a
  // dedicated sales page stacks THREE competing purchase affordances (redirect CTA +
  // inline form + green "Purchase" card) plus a downsell ladder, which confuses the
  // buyer and creates the scroll-anchor jump (L114/L118: one clear action per surface).
  // Home / funnel traversal keeps the full value-ladder funnel. IMPORTANT: only a
  // FRESH direct visit (no `?fo=` outcome) is a clean sales page — the POST-PURCHASE
  // ADVANCE view (`?fo=purchase|decline`, the buyer just paid and is being upsold)
  // MUST keep the funnel-active card so accept/decline → the upsell/downsell still
  // works (removing it on `?fo=` too would delete the downsell path — L101).
  const isDirectOfferRoute = (!!routeNode || !!salesPageOfferRef) && !outcome;
  // A CURATED LANDING page (one that DECLARES its own `checkout_offer_ids`, e.g. the
  // main page → $250/$2,500/$0) is the authority for the offers it surfaces. The full
  // value-ladder funnel — the "THE PATH" ladder listing every tripwire/upsell price
  // ($47/$27/$13 …) AND the fresh-visit entry card — is the funnel-TRAVERSAL surface,
  // NOT the landing. Rendering it on a curated landing re-leaks every funnel offer onto
  // the main page ("too many offers"), the SAME category the checkout-picker filter
  // closes (L063). So on a curated landing it renders ONLY while a funnel OUTCOME is in
  // progress (`?fo=` — the buyer just paid and is being upsold/downsold), preserving the
  // funnel flow while a fresh main-page visit stays the declared offers + entry CTAs.
  // Non-curated funnel-traversal surfaces (no declared set) keep the full ladder.
  const isCuratedLanding = declaredOfferIds.length > 0;
  const showFunnelSurface = !isCuratedLanding || !!outcome;
  // The funnel product (funnel-offer-graph: cta-links green "access now" bar,
  // value ladder, funnel-active upsell card) was removed from the product. Its
  // orphaned DATA records still sit in the append-only log, but the landing page
  // must NOT render the dead funnel. The real inline checkout form (checkoutHtml)
  // is a separate surface and is unaffected. See the removed-funnel cleanup.
  void ctaHtml; void activeStepHtml; void funnelHtml; void showFunnelSurface; void isDirectOfferRoute;
  const funnelTail = '';
  // Crawler head SEO/AEO: description + canonical + Open Graph. The description is
  // DATA (the page schema the JSON-LD already carries); the canonical is the served
  // public host + path; og:type follows whether the schema is an Article. All values
  // are DATA, so a page without a schema description just emits fewer tags.
  const canonicalOriginHost = canonicalHost(req.headers.host) || config.publicHosts[0] || '';
  const canonicalUrl = canonicalUrlFor(await livePageDescription(req), url.pathname)
    || (canonicalOriginHost ? `https://${canonicalOriginHost}${url.pathname}` : '');
  const headMeta = headMetaTags({
    title: chrome.title || chrome.brand,
    description: descriptionFromSchema(chrome.schema),
    canonicalUrl,
    ogType: schemaIsArticle(chrome.schema) ? 'article' : 'website',
    imageUrl: typeof winner.image_url === 'string' && winner.image_url.startsWith('/') && canonicalOriginHost
      ? `https://${canonicalOriginHost}${winner.image_url}` : '',
  });
  const citationControlsScript = body.includes('data-source-citation=""')
    ? '<script defer src="/assets/program-landing/citation-controls.js"></script>' : '';
  const html = injectRoot(await indexHtml(), body, chrome.title || chrome.brand,
    `${funnelTail}${checkoutScopeScript}${inlineCheckoutScript}${citationControlsScript}`, headMeta);
  return { html, setCookie: cursor.setCookie };
}

// Recovery rendering uses a bounded, baked snapshot of the same public-page
// DATA and the same descriptor-driven renderer as the live path. It never
// invents a page template or maps routes in code. Any exact non-root route match
// can therefore remain readable while the owner log is recovering. The root
// keeps the focused application landing as its availability surface.
async function renderRecoveryPublicEntry(req, url) {
  if (!FALLBACK_PUBLIC_PAGE_DESCRIPTOR) return null;
  const here = normalizePath(url.pathname);
  if (here === '/') return null;
  // THIS host's archive, from THIS host's description. The match below is still by path, and that is
  // fine once the candidate set belongs to the tenant being asked.
  const archived = await fallbackPagesFor(await publicationPageDescription(req));
  const archivedPages = parseSelectablePages(archived);
  const winner = composeArchiveArticleDiscovery(
    archivedPages.filter((page) => normalizePath(page.route_path) === here),
    archivedPages,
    url.pathname,
  )[0];
  if (!winner) return null;

  const snapshot = readInteractionSnapshot(
    winner,
    undefined,
    { records: [FALLBACK_PUBLIC_PAGE_DESCRIPTOR] },
    'public-sales-page',
  );
  const chrome = salesPageChrome(snapshot);
  if (!chrome.brandLogo && typeof winner.brand_logo === 'string') chrome.brandLogo = winner.brand_logo;
  chrome.schema = winner.schema;
  const directives = salesPageRenderPlan(snapshot);
  const recoveryOfferId = typeof winner.checkout_offer_id === 'string' ? winner.checkout_offer_id.trim() : '';
  const recoveryCheckoutOffer = winner.inline_checkout === true && recoveryOfferId
    ? readCheckoutOffers(await readCommercialOffers()).find((offer) => offer.id === recoveryOfferId)
    : undefined;
  const page = renderPublicPageHtml({
    chrome,
    directives,
    loaded: true,
    sourceId: winner.id,
    ...(recoveryCheckoutOffer ? { inlineCheckout: {
      offer: recoveryCheckoutOffer,
      title: typeof winner.checkout_title === 'string' ? winner.checkout_title : undefined,
      description: typeof winner.checkout_description === 'string' ? winner.checkout_description : undefined,
      sharedPricingIsland: true,
    } } : {}),
  });
  const canonicalOriginHost = canonicalHost(req.headers.host) || config.publicHosts[0] || '';
  const canonicalUrl = canonicalUrlFor(await livePageDescription(req), url.pathname)
    || (canonicalOriginHost ? `https://${canonicalOriginHost}${url.pathname}` : '');
  const headMeta = headMetaTags({
    title: chrome.title || chrome.brand,
    description: descriptionFromSchema(chrome.schema),
    canonicalUrl,
    ogType: schemaIsArticle(chrome.schema) ? 'article' : 'website',
    imageUrl: typeof winner.image_url === 'string' && winner.image_url.startsWith('/') && canonicalOriginHost
      ? `https://${canonicalOriginHost}${winner.image_url}` : '',
  });
  const html = injectRoot(
    await indexHtml(),
    `${await styleBlockFor(await livePageDescription(req))}\n${page}`,
    chrome.title || chrome.brand,
    [
      recoveryCheckoutOffer ? `<script>window.__inlineCheckoutOfferForThisPage__=${JSON.stringify({ pageId: winner.id, offer: recoveryCheckoutOffer }).replace(/</g, '\\u003c')};</script><script defer src="/assets/program-landing/article-pricing.js"></script>` : '',
      page.includes('data-source-citation=""') ? '<script defer src="/assets/program-landing/citation-controls.js"></script>' : '',
    ].join(''),
    headMeta,
  );
  return { html };
}

// One JSON ask of a shell's target carrier. Used to reach the directory
// instance's declared session and workspace owners.
// ASKING A TARGET REQUIRES SAYING WHICH SET OF TARGETS YOU THINK IS RUNNING.
//
// Every other call this file makes to a target carries that, and this one did
// not, so the instance refused it with "the current basis is required" on every
// single request. That refusal is raised rather than swallowed, correctly, so
// each visitor to the application host was told their session could not be
// verified, which reads as a directory that is down and sends a reader to look
// at the directory. The directory was answering perfectly; it was being asked
// without the one header it requires.
//
// Nothing ever noticed because until the public server sat in front of the
// application, this path carried no traffic at all.
async function askTargetForJson(endpoint, payload) {
  const url = new URL(endpoint);
  const client = url.protocol === 'https:' ? https : http;
  const body = Buffer.from(JSON.stringify(payload ?? {}));
  const basis = await currentBasis();
  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        [TARGET_BASIS_HEADER]: basis,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode ?? 0) >= 400) {
          // The set of running targets changes when the instance restarts, and
          // the copy held here goes stale at that moment. Forgetting it means
          // the next attempt asks again rather than repeating a refusal that
          // will never stop on its own.
          basisPromise = null;
          // A refusal is not an absent session. Raising it keeps a directory
          // that is down from reading as "nobody is signed in".
          reject(new Error(`${endpoint} answered ${response.statusCode}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch (error) {
          reject(new Error(`${endpoint} did not answer JSON: ${String(error?.message ?? error)}`));
        }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

// Which upstream answers this request. `null` means this host declares no
// per-account runtime, so the caller keeps its existing single-shell behaviour.
async function runtimeInstanceFor(req, url) {
  const binding = readPerAccountRuntime(await livePageDescription(req));
  if (!binding) return null;
  // The public sign-in island always needs the directory command basis, even
  // when this browser already holds an account cookie. The ordinary /boot
  // request is resolved to the verified account worker below.
  if (url?.pathname === '/boot' && url.searchParams.get('for') === 'sign-in') {
    return { kind: 'directory', shellUrl: binding.directoryShellUrl };
  }
  const { verifySession, startWorkspace } = directoryBackedResolvers({
    binding,
    postJson: askTargetForJson,
  });
  return resolveRuntimeInstance({
    binding,
    method: req.method,
    pathname: url?.pathname ?? '/',
    headers: req.headers,
    verifySession,
    startWorkspace,
  });
}

async function proxyHttp(req, res, upstream) {
  return proxyRuntimeHttp(req, res, upstream, config.shellUrl);
}

// A WebSocket carries the live engine feed, so routing it to the wrong instance
// is the same leak as routing a page there, and it would be a quieter one.
async function proxyUpgrade(req, socket, head) {
  let upstreamUrl = config.shellUrl;
  let upstreamSocketPath = null;
  try {
    const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
    const instance = await runtimeInstanceFor(req, url);
    if (instance) {
      if (instance.kind !== 'directory' && instance.kind !== 'workspace') {
        // Not signed in, or refused. A socket has no page to redirect to, so
        // the honest answer is no socket.
        socket.destroy();
        return;
      }
      upstreamUrl = instance.shellUrl;
      upstreamSocketPath = instance.socketPath ?? null;
    }
  } catch (error) {
    console.error('[public-entry] could not route an upgrade:', String(error?.message ?? error));
    socket.destroy();
    return;
  }
  proxyRuntimeUpgradeTo(upstreamUrl, req, socket, head, upstreamSocketPath);
}

async function handle(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (await handlePublicEmailCourse(req, res, url)) return;
    if (await completeHostedUrlReturn(req, res, url)) return;
    if (await serveAppShellStatic(req, res, url)) return;
    if (await serveAppIdentityAsset(req, res, url)) return;
    const publicDescription = isPublicHost(req) && (req.method === 'GET' || req.method === 'HEAD')
      ? await livePageDescription(req)
      : null;
    const retired = publicDescription?.retired_routes;
    if (shouldRetirePublicRoute({
      method: req.method,
      publicHost: isPublicHost(req),
      pathname: url.pathname,
      exactPaths: retired?.exact_paths ?? [],
      pathPrefixes: retired?.path_prefixes ?? [],
    })) {
      replyRetiredPublicRoute(req, res);
      return;
    }
    const routeRedirect = publicDescription ? publicRouteRedirect(publicDescription, url.pathname) : null;
    if (routeRedirect && (req.method === 'GET' || req.method === 'HEAD')) {
      const sessionId = checkoutSessionId(url.searchParams.get('session_id'));
      if (sessionId) offerPriceObservations().salesMayHaveChanged();
      if (req.method === 'GET' && routeRedirect.checkoutCompletionTarget && sessionId) {
        await completeCheckoutOrQueue(routeRedirect.checkoutCompletionTarget, sessionId);
      }
      res.writeHead(302, {
        Location: routeRedirect.destination,
        'Cache-Control': 'no-store, max-age=0',
      });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/observe/reached-price') {
      await handleReachedPrice(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/target/checkout.start-checkout') {
      await handleCheckoutCarrierTransport(req, res);
      return;
    }
    // This tenant's island assets (app.js/app.css/fonts) serve static from the baked site dir
    // before anything else. The prefix comes from the host's own description, so two tenants
    // serve two asset trees from one process, and a host with no description serves none rather
    // than falling back to somebody else's.
    const islandAssetPrefix = (req.method === 'GET' || req.method === 'HEAD')
      ? islandAssetPrefixFor(publicDescription ?? await livePageDescription(req))
      : null;
    if (islandAssetPrefix && url.pathname.startsWith(islandAssetPrefix)) {
      const served = await serveIslandAsset(req, res, url, islandAssetPrefix);
      if (served) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('island asset not found');
      return;
    }
    // Lead capture: the emergency landing's Apply form posts here. Persist every
    // application to a durable file on the volume so NO lead is lost while the
    // engine recovers (drained into the CRM once the runtime is back). Never 500
    // a lead and never throw out of this branch.
    if (req.method === 'POST' && url.pathname === '/apply') {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 65536) break;
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        let fields = {};
        const contentType = String(req.headers['content-type'] || '');
        if (contentType.includes('application/json')) {
          try { fields = JSON.parse(raw) || {}; } catch { fields = {}; }
        } else {
          for (const [k, v] of new URLSearchParams(raw)) fields[k] = v;
        }
        // WHO this lead applied to is known HERE and nowhere later. The drain runs on a timer
        // and at startup with no request in hand, so if the tenant's attribution is not written
        // into the record now it is gone. Resolved best-effort: a lead is never lost because a
        // description could not be read, it just drains with mechanism-only attribution.
        const capturingDescription = await livePageDescription(req).catch((error) => {
          console.error('[public-entry] lead captured without its tenant attribution',
            String(error?.message ?? error).slice(0, 160));
          return null;
        });
        const record = {
          id: randomUUID(),
          ts: new Date().toISOString(),
          name: String(fields.name || '').slice(0, 200),
          email: String(fields.email || '').slice(0, 200),
          phone: String(fields.phone || '').slice(0, 60),
          ua: String(req.headers['user-agent'] || '').slice(0, 300),
          ref: String(req.headers.referer || '').slice(0, 300),
          lead_capture: capturingDescription?.lead_capture ?? null,
        };
        const leadsFile = applicationLeadFiles().queue;
        await appendFile(leadsFile, `${JSON.stringify(record)}\n`, 'utf8');
        void drainQueuedApplicationLeads().catch((error) => {
          console.error('[public-entry] application drain attempt failed; lead remains queued', error);
        });
      } catch (leadError) {
        console.error('[public-entry] lead capture write failed (still thanking the lead)', leadError);
      }
      const thankYouDescription = await livePageDescription(req);
      if (!thankYouDescription) { await refuseForLackOfADescription(req, res); return; }
      const thanks = await thankYouHtml(thankYouDescription);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      res.end(thanks);
      return;
    }
    if (shouldRenderAppShell(req, url)
      && !readPerAccountRuntime(await livePageDescription(req))) {
      const start = performance.now();
      // The app shell is bytes already on disk (indexHtml reads staticDir) and needs NO
      // engine. The entry scene DOES, so it is optional here and converges as soon as the
      // engine answers. Awaiting both together took an app host down: with the engine
      // unable to open its log, liveAppEntryScene's
      // fetch to 127.0.0.1:8081 was refused, Promise.all rejected, the render threw, and
      // every visitor got 502 `public entry unavailable` while index.html sat readable on
      // disk the whole time. A dead engine must cost a stale page, never a dead one.
      const [html, entry] = await Promise.all([
        renderAppShell(req),
        liveAppEntryScene().catch((error) => {
          console.error('[public-entry] app entry scene unavailable, serving the shell and converging later:',
            String(error?.message ?? error).slice(0, 160));
          return null;
        }),
      ]);
      const elapsed = Math.max(0, Math.round((performance.now() - start) * 10) / 10);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Cross-Origin-Opener-Policy': 'same-origin',
        Link: appShellLinkHeader(entry),
        'Server-Timing': `app-shell;dur=${elapsed}`,
      });
      if (req.method === 'HEAD') res.end();
      else res.end(html);
      return;
    }
    // A sign-in page is public, but the directory's entry scene and current
    // snapshot are private. Paint the exact public island declared by this
    // page instead of booting the directory shell for an anonymous visitor.
    if (isAppEntryHost(req) && (req.method === 'GET' || req.method === 'HEAD')) {
      const description = await livePageDescription(req);
      const binding = readPerAccountRuntime(description);
      if (binding && url.pathname === `${binding.signInRoute}/`) {
        res.writeHead(308, { Location: `${binding.signInRoute}${url.search}`, 'Cache-Control': 'no-store, max-age=0' });
        res.end();
        return;
      }
      if (binding && url.pathname === binding.signInRoute) {
        const identity = await runtimeInstanceFor(req, url);
        if (identity?.kind === 'signed-in-already') {
          res.writeHead(302, { Location: identity.location, 'Cache-Control': 'no-store, max-age=0' });
          res.end();
          return;
        }
        const island = description?.public_sign_in_island;
        if (!island || typeof island !== 'object'
          || typeof island.bundle_url !== 'string'
          || !/^\/assets\/[A-Za-z0-9._/-]+\.js$/.test(island.bundle_url)
          || island.bundle_url.includes('..')) {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
          res.end('Sign-in is unavailable. Please try again in a moment.');
          return;
        }
        const html = pageShellHtml({ ...description, island: { ...island, mount_element_id: 'root' } });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          'Cross-Origin-Opener-Policy': 'same-origin',
        });
        if (req.method === 'HEAD') res.end();
        else res.end(html);
        return;
      }
    }
    if (shouldRenderAppModuleSource(req, url)) {
      const start = performance.now();
      const addressLabel = url.searchParams.get('address_label') || '';
      const entry = isPublicHost(req) ? await livePublicEntryScene() : await liveAppEntryScene();
      const source = entry?.modules?.get(addressLabel) || null;
      const elapsed = Math.max(0, Math.round((performance.now() - start) * 10) / 10);
      if (!source) {
        res.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          'Server-Timing': `entry-module;dur=${elapsed}`,
        });
        res.end('module source not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Content-Length': source.bytes.length,
        'Server-Timing': `entry-module;dur=${elapsed}`,
      });
      if (req.method === 'HEAD') res.end();
      else res.end(source.bytes);
      return;
    }
    if (shouldRenderPublicEntryScene(req, url)) {
      const start = performance.now();
      const entry = await livePublicEntryScene();
      const elapsed = Math.max(0, Math.round((performance.now() - start) * 10) / 10);
      if (!entry?.text) {
        // No baked scene configured — fall back to the shell's own /entry-scene.
        await proxyHttp(req, res);
        return;
      }
      const { body, encoding } = appEntrySceneResponseBody(req, entry);
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Server-Timing': `public-entry-scene;dur=${elapsed}`,
        'Content-Length': Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body),
      };
      if (encoding) headers['Content-Encoding'] = encoding;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') res.end();
      else res.end(body);
      return;
    }
    if (shouldRenderAppEntryScene(req, url)
      && !readPerAccountRuntime(await livePageDescription(req))) {
      const start = performance.now();
      const entry = await liveAppEntryScene();
      const elapsed = Math.max(0, Math.round((performance.now() - start) * 10) / 10);
      if (!entry?.text) {
        res.writeHead(204, {
          'Cache-Control': 'no-store, max-age=0',
          'Server-Timing': `app-entry-scene;dur=${elapsed}`,
        });
        res.end();
        return;
      }
      const { body, encoding } = appEntrySceneResponseBody(req, entry);
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Server-Timing': `app-entry-scene;dur=${elapsed}`,
        'Content-Length': Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body),
      };
      if (encoding) headers['Content-Encoding'] = encoding;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') res.end();
      else res.end(body);
      return;
    }
    if (await serveStaticSite(req, res, url)) return;
    // A public sign-in bundle is one exact DATA-named asset baked into this
    // image. The volume-owned landing asset root is a different storage owner;
    // it cannot expose image bytes, and broad static serving would expose
    // unrelated files. Serve only this declared URL from the bundled root.
    if (isAppEntryHost(req) && (req.method === 'GET' || req.method === 'HEAD')) {
      const description = await livePageDescription(req);
      const island = description?.public_sign_in_island;
      const bundleUrl = island?.bundle_url;
      if (typeof bundleUrl === 'string'
        && /^\/assets\/[A-Za-z0-9._/-]+\.js$/.test(bundleUrl)
        && !bundleUrl.includes('..')
        && url.pathname === bundleUrl) {
        if (await answerWithFileBytes(req, res, `${config.bundledAssetDir}${bundleUrl}`)) return;
      }
    }
    // `/assets/` names bytes, never a page. Falling through to the public-page renderer made a
    // missing script or stylesheet answer with the entire HTML document at 200, so browsers
    // reported a misleading JavaScript syntax or CSS MIME failure instead of the missing file.
    // It also let a stale shell appear publishable: every referenced URL was technically green
    // even though none of its bytes existed. Make absence explicit before any HTML fallback.
    if (isStaticAssetRequest(req, url)) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
      });
      res.end('asset not found');
      return;
    }
    if (shouldRenderPublicEntry(req, url)) {
      if (isPublicHost(req) && (url.pathname === '/' || url.pathname === '/index.html')) {
        // SEQUENTIAL now, and that is a correctness change rather than a regression. Offers are
        // resolved per tenant, so they cannot be fetched before the tenant is known. The
        // description is the cheap half (a kept value or a file, never the engine on this path),
        // and a host with no description refuses without ever asking for offers, so the work
        // that used to run in parallel with a doomed request is no longer done at all.
        const pageDescription = await livePageDescription(req);
        if (!pageDescription) { await refuseForLackOfADescription(req, res); return; }
        // A tenant with an island keeps its existing page and checkout unchanged. A tenant
        // without one falls through to the same record-backed public page renderer used by
        // every other public route. Serving a holding page here would hide its real home record.
        if (pageDescription.island?.bundle_url) {
          const landingOffers = await liveLandingOffers(pageDescription);
          const shell = await islandShellHtml(pageDescription, landingOffers);
          if (shell === null) { await refuseForLackOfAFallbackBody(req, res); return; }
          const shellWithIdentity = await appIdentityDocument(shell);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, max-age=0',
            Pragma: 'no-cache',
            Expires: '0',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'X-Bitfield-Public-Surface': 'rich-landing-island',
            'Server-Timing': 'composition-landing',
          });
          if (req.method === 'HEAD') res.end();
          else res.end(shellWithIdentity);
          return;
        }
      }
      // The exact route record remains the public owner, including `/`. The
      // rich landing island below is only an availability fallback when the
      // live owner cannot be read during engine recovery.
      if (isPublicHost(req) && (url.pathname === '/classic' || url.pathname === '/classic/')) {
        const urlClassic = new URL('/index.html', url);
        // Serve the previous root behavior at /classic (live record root if
        // present, else the baked editorial landing).
        const shell = await holdingPageHtml(await livePageDescription(req));
        if (shell === null) { await refuseForLackOfAFallbackBody(req, res); return; }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          Pragma: 'no-cache',
          Expires: '0',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'X-Bitfield-Public-Surface': 'editorial-landing',
        });
        if (req.method === 'HEAD') res.end();
        else res.end(shell);
        return;
      }
      // Every public route, including the root landing, resolves through the
      // same route-scoped record owner. Raw-document records can carry a full
      // interactive landing; structured records continue through the generic
      // public-sales-page renderer. The baked holding page remains the bounded
      // recovery surface if the live owner cannot be read.
      const start = performance.now();
      let rendered;
      try {
        rendered = await renderPublicEntry(req, url);
      } catch (error) {
        // Engine not ready (cold boot/replay) or SSR enrichment threw. Preserve
        // route identity from the baked public-page snapshot when an exact
        // Article record exists; all other public routes use the focused
        // application landing. The live path resumes automatically with the log.
        console.error('[public-entry] live SSR unavailable, selecting a recovery surface', error);
        let recoveryArticle = null;
        try {
          recoveryArticle = await renderRecoveryPublicEntry(req, url);
        } catch (recoveryError) {
          console.error('[public-entry] recovery article render failed', recoveryError);
        }
        const isRoot = isPublicHost(req) && (url.pathname === '/' || url.pathname === '/index.html');
        // Read ONCE. It was read twice, on two branches that can never both run, which is harmless
        // until someone adds a third branch and reads it a third time.
        const recoveryDescription = await livePageDescription(req);
        // THE SURFACE IS CHOSEN BY WHAT THE DESCRIPTION DECLARES, NOT BY WHICH PATH WAS ASKED FOR.
        //
        // The root used to take the island shell unconditionally. That is right for a tenant whose
        // landing is a client-hydrated island and silently wrong for one whose landing is
        // server-rendered markup: with no `bundle_url`, the shell emits `<div id="root"></div>` and
        // nothing that will ever fill it, so the tenant is served a blank page at 200. The comment
        // below has said "a blank body here would be the second failure hiding the first" the whole
        // time, and it was guarded only against `null`, which the island shell never returns.
        //
        // A mount point with no bundle to fill it is not a page, so serve the island when there is
        // an island to serve, and otherwise the body the tenant declared.
        const hasAnIslandToServe = Boolean(recoveryDescription?.island?.bundle_url);
        const shell = recoveryArticle?.html
          || (isRoot && hasAnIslandToServe
            ? await islandShellHtml(recoveryDescription)
            : await holdingPageHtml(recoveryDescription));
        // The recovery path is the one that MUST NOT invent a page. It is already answering
        // because the live owner could not be read, so a blank body here would be the second
        // failure hiding the first.
        if (shell === null) { await refuseForLackOfAFallbackBody(req, res); return; }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          Pragma: 'no-cache',
          Expires: '0',
          'X-Bitfield-Recovery-Surface': recoveryArticle ? 'page-snapshot' : (isRoot ? 'rich-landing-island' : 'application-landing'),
        });
        if (req.method === 'HEAD') res.end();
        else res.end(shell);
        return;
      }
      if (rendered?.notFound === true) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
        res.end('Page not found.');
        return;
      }
      // Raw-document records (content_type + body_text DATA) bypass the HTML shell.
      if (rendered && typeof rendered === 'object' && rendered.raw) {
        const elapsedRaw = Math.max(0, Math.round((performance.now() - start) * 10) / 10);
        res.writeHead(200, {
          'Content-Type': `${rendered.raw.contentType}; charset=utf-8`,
          'Cache-Control': 'no-store, max-age=0',
          'Server-Timing': `entry;dur=${elapsedRaw}`,
        });
        if (req.method === 'HEAD') res.end();
        else res.end(rendered.raw.body);
        return;
      }
      const html = typeof rendered === 'string' ? rendered : rendered.html;
      const setCookie = typeof rendered === 'string' ? null : rendered.setCookie;
      const elapsed = Math.max(0, Math.round((performance.now() - start) * 10) / 10);
      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Server-Timing': `entry;dur=${elapsed}`,
      };
      if (setCookie) headers['Set-Cookie'] = setCookie;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') res.end();
      else res.end(html);
      return;
    }
    const instance = await runtimeInstanceFor(req, url);
    // Both are the same answer, "you are in the wrong place for who you are",
    // pointed in opposite directions: someone without a session is sent to sign
    // in, and someone who already has one is sent into the product rather than
    // shown the sign-in address serving their own open work.
    if (instance?.kind === 'sign-in' || instance?.kind === 'signed-in-already') {
      res.writeHead(302, { Location: instance.location, 'Cache-Control': 'no-store, max-age=0' });
      res.end();
      return;
    }
    if (instance?.kind === 'sign-in-required') {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      res.end('Sign in to continue.');
      return;
    }
    if (instance?.kind === 'opening') {
      // Nothing is wrong and nothing is lost: this person's workspace is
      // booting. Say that in their language and come back for them, rather
      // than holding the connection open for however long a cold boot takes.
      const page = pendingDestinationHtml({
        title: 'Opening your workspace',
        message: 'This page will continue on its own.',
      });
      res.writeHead(503, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'Retry-After': '3',
        'Content-Length': Buffer.byteLength(page),
      });
      if (req.method === 'HEAD') res.end();
      else res.end(page);
      return;
    }
    if (instance?.kind === 'refuse') {
      // 503 rather than 500: the person did nothing wrong and their work is
      // not gone. Naming the reason without naming an account or an instance.
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      res.end(`${instance.reason}. Please try again in a moment.`);
      return;
    }
    await proxyHttp(req, res, instance?.socketPath ? { socketPath: instance.socketPath } : instance?.shellUrl);
  } catch (error) {
    console.error('[public-entry] request failed', error);
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('public entry unavailable');
  }
}

async function main() {
  // Bind :8080 IMMEDIATELY so the public entry is NEVER a dead socket during the
  // engine's cold boot/replay. Previously main() awaited waitForShell() (up to
  // BITFIELD_BOOT_WAIT_MS, currently 6h) BEFORE server.listen(), so nothing bound
  // for the entire multi-hour boot -> external /boot returned 000 -> a fully black
  // site while real leads arrived (incident 2026-08-07). The public landing (baked
  // static shell + baked /entry-scene file at BITFIELD_HOST_ENTRY_SCENE_FILE) needs
  // NO engine; only the funnel-offer SSR enrichment does, and handle() now degrades
  // that to the baked shell when the engine is not ready. The engine still boots in
  // the background and the full SSR app takes over the instant it becomes ready.
  const server = http.createServer(handle);
  server.on('upgrade', proxyUpgrade);
  // Category guard (L063): ANY raw client-socket error (reset, malformed bytes,
  // abrupt TLS teardown) is scoped to that one socket, never the process. The
  // per-connection handlers above cover the proxied flows; these cover sockets
  // that error before/outside a proxied exchange.
  server.on('clientError', (error, socket) => {
    if (!socket.destroyed) socket.destroy();
  });
  server.on('connection', (socket) => {
    socket.on('error', () => {
      if (!socket.destroyed) socket.destroy();
    });
  });
  server.listen(config.listenPort, config.listenHost, () => {
    console.log(`[public-entry] listening on ${config.listenHost}:${config.listenPort}, shell=${config.shellUrl}`);
    // An unset host list is now EMPTY rather than one tenant's, which is the correct default
    // and a silent one: nothing throws, the host simply matches no request and every visitor
    // falls through to the proxy. That is harder to diagnose than the wrong page, so say it.
    // A warning and not a failure, matching what the build check already chose: a set may
    // legitimately serve only one of these two roles.
    for (const [name, hosts] of [['BITFIELD_HOST_ENTRY_SCENE_HOSTS', config.publicHosts],
                                 ['BITFIELD_APP_ENTRY_SCENE_HOSTS', config.appEntryHosts]]) {
      if (hosts.length === 0) {
        console.warn(`[public-entry] ${name} is unset, so no request will match that role. `
          + 'If this host is meant to serve it, the package set has to name the domain.');
      }
    }
  });
  // Warm caches + wait for the engine in the BACKGROUND; never block listen().
  void (async () => {
    try {
      await waitForShell();
      // A release trial uses a fork of the live volume. It must render the
      // visitor's page, but must never replay queued external effects from the
      // copied data. The serving machine has no trial flag and keeps draining.
      if (!process.env.BITFIELD_RELEASE_TRIAL_NO_EXTERNAL_EFFECTS) {
        await Promise.all([drainQueuedApplicationLeads(), drainQueuedCheckoutCompletions()]);
      }
    } catch (error) {
      console.error('[public-entry] shell wait ended without readiness (serving baked landing meanwhile)', error);
    }
    try {
      await Promise.all([liveRecords(), liveAppEntryScene()]);
    } catch (error) {
      console.error('[public-entry] warm caches failed (serving baked landing meanwhile)', error);
    }
    // A background refresh loop used to start here. It is gone: `liveRecords()` re-checks on
    // read and `liveLandingOffers()` already refreshed on every read, so the loop was doing
    // duplicated work on a timer nobody was waiting for. The warm-up above still runs, because
    // filling the cache ONCE at boot is not scheduling, it is starting.
  })();
}

async function waitForShell() {
  // Boot tolerance MUST exceed a full-log replay (cold recovery with no usable boot
  // snapshot), or a prolonged /boot "recovering" 503 makes this throw -> the process
  // exits -> Fly crash-loops to max-restart-count. That is exactly the cont.131 prod
  // outage. Default 15 min covers a from-scratch replay of the customer log + CAS; a warm
  // snapshot boot returns in ~25s and exits this loop immediately, so the fast path is
  // unaffected. Env-tunable via BITFIELD_BOOT_WAIT_MS.
  const waitMs = Number(process.env.BITFIELD_BOOT_WAIT_MS || 900_000);
  const deadline = Date.now() + waitMs;
  const startedAt = Date.now();
  let lastError = null;
  let lastLoggedMs = -Infinity;
  while (Date.now() < deadline) {
    try {
      await currentBasis();
      return;
    } catch (error) {
      lastError = error;
      basisPromise = null;
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs - lastLoggedMs >= 5_000) {
        console.log(
          `[public-entry] waiting for shell /boot (${Math.round(elapsedMs / 1000)}s elapsed, tolerating replay): ${String(error?.message ?? error).slice(0, 160)}`,
        );
        lastLoggedMs = elapsedMs;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error('shell did not become ready');
}

void main();
