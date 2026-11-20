#!/usr/bin/env node
// packages/adaptive-program-landing/do-work/publish-hosted-landing-island.mjs
//
// Purpose: put the CURRENT landing (package source + one package set's DATA and
// public assets) onto the hosted application that already serves it, without
// touching anything else in that application.
//
// Why this exists: the hosted image's `/app/assets/program-landing/app.{js,css}`
// was produced by `hosted-public-app/processes/build-public-entry-server.mjs`,
// deleted 2026-09-17 (4e845153e). No package set had moved to its successor, so
// from that day nothing could rebuild a landing that was already live: a source
// change reached tests and proofs and never the page a visitor sees.
//
// Non-negotiable invariants:
// - Everything except the island bytes, the public assets, the prices and the
//   public server comes from the image the provider is running NOW (read, never
//   transcribed), so the runtime, environment and volume are carried forward
//   untouched.
// - The public server is hosted-public-app's declared stored bytes
//   `public-entry-server`, placed where the launcher starts it
//   (`/opt/bitfield/public-entry-server`). It is the program that reads prices
//   and answers checkout for this page, so a page change that needs a server
//   change cannot ship half of itself.
// - The provider is reached only through `hosted-public-app`'s package-owned
//   deployment plan (`fly-remote-only`). This file composes no provider command.
// - The workspace is this process's own, created and removed by it. A caller
//   names a package set and an application, never a directory.
// - The application name is an argument: this package never names an app.
//
// Usage:
//   node publish-hosted-landing-island.mjs --package-set <set> --application <provider-app>
//   add --build-only to build and report sizes without deploying.

import esbuild from 'esbuild';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  currentContainerBaseResult,
  runProviderDeployment,
} from '../../../../serve-and-publish-a-package-sets-public-app/processes/run-provider-deploy.mjs';
import { readCurrentImageArchive } from '../../hosted-public-app/processes/publish-reviewed-article.mjs';
import { dockerfileForCurrentImage, inspectCurrentContainerImage } from '../../hosted-public-app/processes/flatten-current-container-base.mjs';
import { pageSectionsHtml } from '../../ui/show/server-rendered-page/page-sections-html.mjs';
import { makeDeclaredStoredBytesExist } from '../../make-packages-match-their-source/do-work/build-declared-stored-bytes-for-chosen-packages.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);
const packagesRoot = path.dirname(path.dirname(packageRoot));

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
}

function ordinaryFile(file) {
  return existsSync(file) && !lstatSync(file).isSymbolicLink() && statSync(file).isFile();
}

export function partitionForPackageSet(packageSet, root = packagesRoot) {
  if (typeof packageSet !== 'string' || !/^[a-z][a-z0-9-]*$/.test(packageSet)) {
    throw new Error('package set name is invalid');
  }
  const file = path.join(root, 'package-sets', packageSet, 'package-set-partition.json');
  if (!ordinaryFile(file)) throw new Error(`package set ${packageSet} carries no partition DATA`);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.set_name !== packageSet || typeof record.partition !== 'string'
    || !/^[a-z][a-z0-9-]*$/.test(record.partition)) {
    throw new Error(`package set ${packageSet} has an invalid partition DATA record`);
  }
  return record.partition;
}

export function renderFallbackBody(page) {
  return pageSectionsHtml(page?.fallback_sections);
}

export function carryForwardPublishedRecoveryFile(fileAt, assetsDir) {
  const assets = path.resolve(assetsDir);
  const file = path.resolve(fileAt);
  if (!file.startsWith(`${assets}${path.sep}`)) {
    throw new Error('public-page recovery file must live under the copied assets');
  }
  // Docker COPY assets/ merges into the current serving image. Omit both the
  // selected Article archive and its public fallback body so a landing-only
  // release carries the served recovery files forward byte for byte.
  rmSync(file, { force: true });
}

function isArticlePage(record) {
  const schema = record?.schema;
  return schema?.['@type'] === 'Article'
    || schema?.type === 'Article'
    || (Array.isArray(schema?.['@graph']) && schema['@graph'].some((node) => node?.['@type'] === 'Article'))
    || (record?.kind === 'public-sales-page' && record?.article === true);
}

/**
 * A landing release carries reviewed Articles forward from the serving image,
 * while refreshing the rest of the recovery archive from the current page DATA.
 * Otherwise a stale CollectionPage (for example /articles) remains frozen in
 * the archive forever even after its live DATA has changed.
 */
export function refreshRecoveryArchive(currentArchiveBytes, currentPageRecordsBytes) {
  const current = JSON.parse(Buffer.from(currentArchiveBytes).toString('utf8'));
  const source = JSON.parse(Buffer.from(currentPageRecordsBytes).toString('utf8'));
  if (!Array.isArray(current?.rows)) throw new Error('serving image page archive has no rows');
  if (!Array.isArray(source?.records)) throw new Error('current public page DATA has no records');

  const sourceArticlesByRoute = new Map(source.records.filter(isArticlePage)
    .filter((record) => typeof record.route_path === 'string')
    .map((record) => [record.route_path, record]));
  const reviewedArticles = current.rows.filter(isArticlePage).map((reviewed) => {
    const sourceArticle = sourceArticlesByRoute.get(reviewed.route_path);
    if (!sourceArticle) return reviewed;
    // Refresh only site chrome. The reviewed document body, title, citations,
    // metadata and checkout remain byte-for-byte from the serving image.
    return {
      ...reviewed,
      ...(typeof sourceArticle.brand_logo === 'string' ? { brand_logo: sourceArticle.brand_logo } : {}),
      ...(Array.isArray(sourceArticle.navigation) ? { navigation: sourceArticle.navigation } : {}),
      ...(typeof sourceArticle.image_url === 'string' && sourceArticle.image_url.startsWith('/')
        ? { image_url: sourceArticle.image_url } : {}),
      ...(typeof sourceArticle.meta_description === 'string'
        ? { discovery_description: sourceArticle.meta_description } : {}),
      ...(typeof sourceArticle.eyebrow === 'string'
        ? { discovery_eyebrow: sourceArticle.eyebrow } : {}),
    };
  });
  const currentNonArticles = source.records.filter((record) => record?.kind === 'public-sales-page'
    && typeof record.route_path === 'string' && record.route_path.startsWith('/') && !isArticlePage(record));
  const seen = new Set();
  for (const row of [...reviewedArticles, ...currentNonArticles]) {
    if (seen.has(row.route_path)) throw new Error(`recovery archive has duplicate route ${row.route_path}`);
    seen.add(row.route_path);
  }
  const rows = [...reviewedArticles, ...currentNonArticles];
  return Buffer.from(JSON.stringify({
    ...current,
    ...(typeof current.count === 'number' ? { count: rows.length } : {}),
    rows,
  }), 'utf8');
}

export function excludeCopiedRecoveryAssets(assetsDir) {
  if (!existsSync(assetsDir)) return;
  for (const item of readdirSync(assetsDir, { withFileTypes: true, recursive: true })) {
    if (!item.isFile()) continue;
    const name = item.name;
    if (!/^public-(?:articles-)?recovery\.(?:json|html)$/.test(name)) continue;
    carryForwardPublishedRecoveryFile(path.join(item.parentPath, name), assetsDir);
  }
}

/** Build the self-mounting island exactly where the hosted page loads it:
 * `/assets/program-landing/app.js` + `app.css`, a classic script on `#root`. */
export async function buildLandingIsland({ packageSet, assetsDir }) {
  const dataPath = path.join(packagesRoot, 'package-sets', packageSet, 'package-set-records', 'adaptive-program-landing.json');
  if (!ordinaryFile(dataPath)) throw new Error(`package set ${packageSet} carries no adaptive-program-landing DATA`);
  const entry = [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import { assertProgramLandingData } from ${JSON.stringify(path.join(packageRoot, 'read-data', 'program-landing-data'))};`,
    `import { ProgramLanding } from ${JSON.stringify(path.join(packageRoot, 'show', 'ProgramLanding.tsx'))};`,
    `import data from ${JSON.stringify(dataPath)};`,
    'assertProgramLandingData(data);',
    // A hosted public page has no runtime connection, so the pricing card's
    // default sender (a runtime-kit target request) waits forever and a pay
    // click does nothing at all. This host answers the same target over HTTP
    // at `/target/checkout.start-checkout`, and the card already accepts a
    // host-provided sender through `window.__programStartCheckout__`.
    'window.__programStartCheckout__ = async (request) => {',
    "  const response = await fetch('/target/checkout.start-checkout', {",
    "    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),",
    '  });',
    '  const text = await response.text();',
    '  let result = {};',
    "  try { result = text.trim() ? JSON.parse(text) : {}; } catch { throw new Error('Checkout could not start. Please try again.'); }",
    "  if (!response.ok || result.error) throw new Error(result.error || 'Checkout could not start. Please try again.');",
    '  return result;',
    '};',
    // This host counts who reached a price (POST /observe/reached-price); a
    // discovered price moves down when people see it and do not buy.
    'window.__programReachedPrice__ = (offerIds) => {',
    "  const body = JSON.stringify({ offer_ids: offerIds });",
    "  if (navigator.sendBeacon?.('/observe/reached-price', new Blob([body], { type: 'application/json' }))) return;",
    "  fetch('/observe/reached-price', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});",
    '};',
    "const mount = document.getElementById('root');",
    "if (!mount) throw new Error('The program landing mount is missing.');",
    'createRoot(mount).render(React.createElement(React.StrictMode, null, React.createElement(ProgramLanding, { data })));',
  ].join('\n');
  const outdir = path.join(assetsDir, 'program-landing');
  const result = await esbuild.build({
    absWorkingDir: packagesRoot,
    alias: { '@': packagesRoot },
    bundle: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    entryNames: 'app',
    assetNames: 'assets/[name]-[hash]',
    format: 'iife',
    jsx: 'automatic',
    legalComments: 'none',
    logLevel: 'warning',
    minify: true,
    outdir,
    platform: 'browser',
    stdin: { contents: entry, loader: 'tsx', resolveDir: packageRoot, sourcefile: 'hosted-landing-island.tsx' },
    target: ['es2020'],
  });
  for (const name of ['app.js', 'app.css']) {
    if (!ordinaryFile(path.join(outdir, name))) throw new Error(`the island build produced no ${name}`);
  }
  return result;
}

/** Articles mount the home's actual pricing card, with the offer selected by
 * their current public-page record. A static checkout form has no event handlers. */
export async function buildArticlePricingIsland({ packageSet, assetsDir }) {
  const dataPath = path.join(packagesRoot, 'package-sets', packageSet, 'package-set-records', 'adaptive-program-landing.json');
  if (!ordinaryFile(dataPath)) throw new Error(`package set ${packageSet} carries no adaptive-program-landing DATA`);
  const entry = [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import { ProgramLandingDataProvider } from ${JSON.stringify(path.join(packageRoot, 'show', 'ProgramLandingData.tsx'))};`,
    `import { ProgramPricingSection } from ${JSON.stringify(path.join(packageRoot, 'show', 'ProgramPricingSection.tsx'))};`,
    "import { MARKETING_PAGE_LAYOUT_CSS } from '../../../../ui/show/marketing-page/MarketingPagePrimitives';",
    `import data from ${JSON.stringify(dataPath)};`,
    "const mount = document.getElementById('shared-pricing-island');",
    'const offer = window.__inlineCheckoutOfferForThisPage__?.offer;',
    'const price = offer?.price_options?.find((candidate) => candidate?.voluntary_amount_policy);',
    'if (mount && offer && price && offer.id === data.pricing.membership) {',
    '  window.__programOffersForThisPage__ = { [offer.id]: { offer_id: offer.id, price_option_id: price.id, policy: price.voluntary_amount_policy } };',
    '  window.__programStartCheckout__ = async (request) => {',
    "    const response = await fetch('/target/checkout.start-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });",
    '    const text = await response.text();',
    '    let result = {};',
    "    try { result = text.trim() ? JSON.parse(text) : {}; } catch { throw new Error('Checkout could not start. Please try again.'); }",
    "    if (!response.ok || result.error) throw new Error(result.error || 'Checkout could not start. Please try again.');",
    '    return result;',
    '  };',
    '  createRoot(mount).render(React.createElement(ProgramLandingDataProvider, { data }, React.createElement(React.Fragment, null, React.createElement("style", null, MARKETING_PAGE_LAYOUT_CSS), React.createElement(ProgramPricingSection, { embedded: true, instanceId: "article-pricing", offerIds: [data.pricing.membership] }))));',
    '}',
  ].join('\n');
  const outdir = path.join(assetsDir, 'program-landing');
  await esbuild.build({
    absWorkingDir: packagesRoot,
    alias: { '@': packagesRoot },
    bundle: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    entryNames: 'article-pricing',
    assetNames: 'assets/[name]-[hash]',
    format: 'iife',
    jsx: 'automatic',
    legalComments: 'none',
    logLevel: 'warning',
    minify: true,
    outdir,
    platform: 'browser',
    stdin: { contents: entry, loader: 'tsx', resolveDir: packageRoot, sourcefile: 'hosted-article-pricing.tsx' },
    target: ['es2020'],
  });
  for (const name of ['article-pricing.js']) {
    if (!ordinaryFile(path.join(outdir, name))) throw new Error(`the article pricing build produced no ${name}`);
  }
}

/** Build the shared player's browser mount for citations rendered by the article SSR page. */
export async function buildCitationControlsIsland({ assetsDir }) {
  const uiRoot = path.join(packagesRoot, 'packages', 'ui');
  const entry = [
    `import { mountSourceCitationPreviews } from ${JSON.stringify(path.join(uiRoot, 'show', 'source-citation', 'SourceCitation.tsx'))};`,
    'mountSourceCitationPreviews(document);',
  ].join('\n');
  const outdir = path.join(assetsDir, 'program-landing');
  await esbuild.build({
    absWorkingDir: packagesRoot,
    alias: { '@': packagesRoot },
    bundle: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    entryNames: 'citation-controls',
    assetNames: 'assets/[name]-[hash]',
    format: 'iife',
    jsx: 'automatic',
    legalComments: 'none',
    logLevel: 'warning',
    minify: true,
    outdir,
    platform: 'browser',
    stdin: { contents: entry, loader: 'tsx', resolveDir: packageRoot, sourcefile: 'hosted-citation-controls.tsx' },
    target: ['es2020'],
  });
  if (!ordinaryFile(path.join(outdir, 'citation-controls.js'))) {
    throw new Error('the citation controls build produced no citation-controls.js');
  }
}

async function main() {
  const packageSet = argument('package-set');
  const application = argument('application');
  const buildOnly = process.argv.includes('--build-only');
  const localBuild = process.argv.includes('--local-build');
  if (!packageSet || (!application && !buildOnly)) {
    throw new Error('usage: --package-set <set> --application <provider-app> [--build-only]');
  }
  const partition = partitionForPackageSet(packageSet);
  const workspace = mkdtempSync(path.join(tmpdir(), 'landing-island-'));
  try {
    const site = path.join(workspace, 'site');
    const assetsDir = path.join(site, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    const publicAssets = path.join(packagesRoot, 'package-sets', packageSet, 'public-assets');
    if (existsSync(publicAssets)) cpSync(publicAssets, assetsDir, { recursive: true, dereference: false });
    // A mutable page description cannot authorize replacing an accepted
    // Article archive. Strip the reserved recovery assets regardless of which
    // fields the new description happens to contain.
    excludeCopiedRecoveryAssets(assetsDir);
    const descriptionSource = path.join(packagesRoot, 'package-sets', packageSet, 'public-page-description.json');
    if (ordinaryFile(descriptionSource)) {
      const description = JSON.parse(readFileSync(descriptionSource, 'utf8'));
      if (!Array.isArray(description.pages) || description.pages.length === 0) {
        throw new Error('public page description has no pages');
      }
      for (const page of description.pages) {
        if (!page.fallback_pages_file || !page.fallback_body_file) {
          throw new Error('public pages require a recovery archive and fallback body before release');
        }
        if (!/^public-(?:articles-)?recovery\.json$/.test(path.basename(page.fallback_pages_file))
          || path.basename(page.fallback_body_file) !== 'public-recovery.html') {
          throw new Error('public page recovery paths cannot be renamed by a landing release');
        }
        if (page.fallback_pages_file || page.fallback_body_file) {
          if (typeof page.fallback_pages_file !== 'string' || typeof page.fallback_body_file !== 'string') {
            throw new Error('public pages require a recovery archive and fallback body before release');
          }
          const archiveAt = path.resolve(site, page.fallback_pages_file);
          const bodyAt = path.resolve(site, page.fallback_body_file);
          if (!archiveAt.startsWith(`${path.resolve(assetsDir)}${path.sep}`)
            || !bodyAt.startsWith(`${path.resolve(assetsDir)}${path.sep}`)) {
            throw new Error('public-page recovery files must live under the copied assets');
          }
          if (!ordinaryFile(bodyAt) && Array.isArray(page.fallback_sections)) {
            const body = renderFallbackBody(page);
            if (body.trim()) {
              mkdirSync(path.dirname(bodyAt), { recursive: true });
              writeFileSync(bodyAt, body);
            }
          }
          if (!ordinaryFile(bodyAt) || !readFileSync(bodyAt, 'utf8').trim()) {
            throw new Error('public-page fallback body is missing or blank');
          }
          // Page records are candidates, not accepted publications. The base
          // image already carries the archive it serves. A landing-only release
          // must leave those exact bytes in place until a trusted Article
          // selection has been reviewed and installed by its publication owner.
          // Remove any archive copied from source assets so Docker COPY cannot
          // silently replace the serving image's selected pages.
          carryForwardPublishedRecoveryFile(archiveAt, assetsDir);
          carryForwardPublishedRecoveryFile(bodyAt, assetsDir);
        }
      }
    }
    await buildLandingIsland({ packageSet, assetsDir });
    await buildArticlePricingIsland({ packageSet, assetsDir });
    await buildCitationControlsIsland({ assetsDir });
    for (const name of ['app.js', 'app.css']) {
      console.log(`${name} ${statSync(path.join(assetsDir, 'program-landing', name)).size} bytes`);
    }
    if (buildOnly) return;

    // The image's price file is what the entry server falls back to, and a
    // provider deploy resets any per-machine setting that pointed elsewhere.
    // So the image must carry the set's CURRENT prices: carrying the running
    // image's copy forward put a months-old $0.50 floor back on the page.
    const offers = path.join(packagesRoot, 'package-sets', packageSet, 'package-set-records', 'commercial-offer-records.json');
    const base = await currentContainerBaseResult(application);
    const description = JSON.parse(readFileSync(descriptionSource, 'utf8'));
    const archivePaths = [...new Set(description.pages.map((page) => page?.fallback_pages_file)
      .filter((value) => typeof value === 'string' && value.trim()))];
    if (archivePaths.length !== 1) throw new Error('current page description must name one shared recovery archive');
    const imageArchive = readCurrentImageArchive({ image: base.image, workspace });
    const imageArchivePath = path.posix.isAbsolute(imageArchive.archivePath)
      ? path.posix.normalize(imageArchive.archivePath)
      : path.posix.resolve('/app', imageArchive.archivePath);
    const describedArchivePath = path.posix.isAbsolute(archivePaths[0])
      ? path.posix.normalize(archivePaths[0])
      : path.posix.resolve('/app', archivePaths[0]);
    if (imageArchivePath !== describedArchivePath) {
      throw new Error('current page description does not name the serving image recovery archive');
    }
    const pageRecordsFile = path.join(packagesRoot, 'package-sets', packageSet,
      'package-set-records', 'public-sales-page-records.json');
    if (!ordinaryFile(pageRecordsFile)) throw new Error('package set has no current public page DATA');
    const refreshedArchive = refreshRecoveryArchive(imageArchive.archiveBytes, readFileSync(pageRecordsFile));
    const refreshedArchiveFile = path.resolve(site, archivePaths[0]);
    if (!refreshedArchiveFile.startsWith(`${path.resolve(assetsDir)}${path.sep}`)) {
      throw new Error('public-page recovery archive must live under copied assets');
    }
    mkdirSync(path.dirname(refreshedArchiveFile), { recursive: true });
    writeFileSync(refreshedArchiveFile, refreshedArchive);
    // Repeated presentation-only layers can exhaust Docker's parent depth.
    // An earlier image of this same app is a valid base because every mutable
    // page asset, description, offer and server is copied below from current source.
    const requestedBaseImage = argument('base-image');
    if (requestedBaseImage && requestedBaseImage !== base.image) {
      throw new Error('base image must be the image currently serving this provider application');
    }
    const dockerfile = localBuild
      ? dockerfileForCurrentImage(base.image, inspectCurrentContainerImage(base.image))
      : [`FROM ${base.image}`];
    dockerfile.push(`ENV BITFIELD_PARTITION=${partition}`);
    dockerfile.push('COPY assets/ /app/assets/');
    if (ordinaryFile(descriptionSource)) {
      cpSync(descriptionSource, path.join(site, 'page-description.json'));
      dockerfile.push('COPY page-description.json /app/page-description.json');
    }
    if (ordinaryFile(offers)) {
      cpSync(offers, path.join(site, 'commercial-offer-records.json'));
      dockerfile.push('COPY commercial-offer-records.json /app/commercial-offer-records.json');
    }
    await makeDeclaredStoredBytesExist({
      packageSetFolder: path.join(packagesRoot, 'package-sets', packageSet),
      packagesSourceRoot: path.join(packagesRoot, 'packages'),
      packageNames: ['hosted-public-app'],
      storedBytesNames: ['public-entry-server', 'public-entry-server.css'],
    });
    const server = path.join(packagesRoot, 'packages', 'hosted-public-app', 'built-stored-bytes', 'public-entry-server');
    if (!ordinaryFile(server)) throw new Error('hosted-public-app carries no built public-entry-server');
    cpSync(server, path.join(site, 'public-entry-server'));
    dockerfile.push('COPY public-entry-server /opt/bitfield/public-entry-server');
    const serverCss = path.join(packagesRoot, 'packages', 'hosted-public-app', 'built-stored-bytes', 'public-entry-server.css');
    if (!ordinaryFile(serverCss)) throw new Error('hosted-public-app carries no built public-entry-server CSS');
    cpSync(serverCss, path.join(site, 'public-entry-server.css'));
    dockerfile.push('COPY public-entry-server.css /opt/bitfield/public-entry-server.css');
    // The serving image already owns its launcher. Carry that executable
    // forward with the base image rather than copying another package's source.
    console.log(dockerfile.join('\n'));
    writeFileSync(path.join(site, 'Dockerfile'), `${dockerfile.join('\n')}\n`);

    const result = await runProviderDeployment({
      // The managed builder cannot re-export a running image's layers ("failed
      // to get compression blob zstd"), identically on every retry, and a
      // FROM-the-running-image build is exactly that case. The in-account
      // builder has no such limit; the deploy owner names it as DATA.
      //
      // The machine's current size is read and handed to the deploy owner,
      // which keeps it: a deploy otherwise re-applies the provider's stored
      // size, and this app's engine is killed for memory below 8 GB.
      descriptor: {
        kind: 'package-owned-deployment-request',
        profile: 'fly-remote-only',
        parameters: {
          application,
          build_service: localBuild ? 'local' : 'in-account',
          vm_size: base.vm_size,
          memory_megabytes: String(base.memory_megabytes),
        },
      },
      spawnChild: spawn,
      parentEnv: process.env,
      spawnOptionsBase: { stdio: ['ignore', 'pipe', 'pipe'], cwd: site },
      resultFile: null,
    });
    console.log(JSON.stringify(result));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
