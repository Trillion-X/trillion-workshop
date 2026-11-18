import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { currentContainerBaseResult, runProviderDeployment } from '../../../../serve-and-publish-a-package-sets-public-app/processes/run-provider-deploy.mjs';
import { dockerfileForCurrentImage, inspectCurrentContainerImage } from './flatten-current-container-base.mjs';

const PAGE_DESCRIPTION_PATH = '/app/page-description.json';
const ARTICLE_KIND = 'public-sales-page';

function safeArchivePath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('/')
      || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('page description names an unsafe archive path');
  }
  return value;
}

function articleRoute(row) {
  return row?.schema?.['@type'] === 'Article'
    || row?.schema?.type === 'Article'
    || row?.schema?.['@graph']?.some(node => node?.['@type'] === 'Article')
    || row?.kind === ARTICLE_KIND && row?.article === true;
}

/** Replace the one archived Article at the same route, preserving every other
 * row and archive field. This function accepts page data, never verdicts. */
export function replaceArchivedArticle(archiveBytes, candidate) {
  const archive = JSON.parse(Buffer.from(archiveBytes).toString('utf8'));
  if (!archive || typeof archive !== 'object' || Array.isArray(archive) || !Array.isArray(archive.rows)) {
    throw new Error('current page archive has no rows');
  }
  const page = candidate?.page;
  const route = candidate?.route_path ?? page?.route_path;
  if (!page || typeof page !== 'object' || !articleRoute(page)
      || typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')
      || route.split('/').includes('..') || page.route_path !== route) {
    throw new Error('prepared document is not one Article for a safe route');
  }
  const matches = [];
  for (let index = 0; index < archive.rows.length; index += 1) {
    const row = archive.rows[index];
    if (row?.route_path === route && articleRoute(row)) matches.push(index);
  }
  if (matches.length > 1 || archive.rows.some(row => row?.route_path === route && !articleRoute(row))) {
    throw new Error('candidate route conflicts with the current archive');
  }
  const rows = [...archive.rows];
  if (matches.length === 1) rows[matches[0]] = page;
  else rows.push(page);
  return Buffer.from(`${JSON.stringify({ ...archive, ...(typeof archive.count === 'number' ? {count:rows.length} : {}), rows })}\n`);
}

function descriptionArchivePath(description) {
  const pages = description?.pages;
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('current page description has no pages');
  const paths = [...new Set(pages.map((page) => page?.fallback_pages_file)
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(safeArchivePath))];
  if (paths.length !== 1) throw new Error('current page description must name one shared page archive');
  return paths[0];
}

function docker(run, args, options = {}) {
  return run('docker', args, { stdio: 'pipe', timeout: 60_000, ...options });
}

/** Read the files selected by the live image's page description. Docker owns
 * the extraction: only those exact in-image paths are copied into this
 * process's private workspace. */
export function readCurrentImageArchive({ image, workspace, run = execFileSync }) {
  if (typeof image !== 'string' || !/^registry\.fly\.io\/[a-z0-9][a-z0-9-]*:release-[a-z0-9]+$/.test(image)) {
    throw new Error('current serving image is invalid');
  }
  run('fly', ['auth', 'docker'], { stdio: 'ignore', timeout: 30_000 });
  docker(run, ['pull', image], { stdio: 'ignore', timeout: 120_000 });
  const container = String(docker(run, ['create', image], { encoding: 'utf8' })).trim();
  if (!/^[0-9a-f]{12,64}$/i.test(container)) throw new Error('container runtime returned no current-image container');
  const descriptionFile = resolve(workspace, 'page-description.json');
  const archiveFile = resolve(workspace, 'current-archive.json');
  try {
    docker(run, ['cp', `${container}:${PAGE_DESCRIPTION_PATH}`, descriptionFile]);
    const description = JSON.parse(readFileSync(descriptionFile, 'utf8'));
    const archivePath = descriptionArchivePath(description);
    docker(run, ['cp', `${container}:/app/${archivePath}`, archiveFile]);
    return { description, archivePath, archiveBytes: readFileSync(archiveFile) };
  } finally {
    docker(run, ['rm', '-f', container], { stdio: 'ignore' });
  }
}

function writeImageContext({ workspace, base, archivePath, archiveBytes, inspectImage }) {
  const site = join(workspace, 'site');
  const archiveFile = resolve(site, archivePath);
  if (!archiveFile.startsWith(`${site}${sep}`)) throw new Error('page archive escapes the deploy context');
  mkdirSync(dirname(archiveFile), { recursive: true, mode: 0o700 });
  writeFileSync(archiveFile, archiveBytes, { mode: 0o600 });
  const inspected = inspectImage(base.image);
  const dockerfile = dockerfileForCurrentImage(base.image, inspected);
  dockerfile.push(`COPY ${archivePath} /app/${archivePath}`);
  writeFileSync(join(site, 'Dockerfile'), `${dockerfile.join('\n')}\n`, { mode: 0o600 });
  return site;
}

function requireInputBases(candidate) {
  if (!Array.isArray(candidate?.input_bases) || candidate.input_bases.length === 0) {
    throw new Error('prepared document has no current input bases');
  }
}

/**
 * The request surface accepts only a Documents reference. Every operation that
 * can create a candidate, render it, judge it, inspect the provider, or deploy
 * it is supplied by the enclosing owner and is never taken from request data.
 */
export async function publishReviewedArticle(
  { session, send, document_ref },
  {
    prepareCurrentDocument,
    currentProviderApplication,
    inputBasesAreCurrent,
    reviewRenderedCandidate,
    createWorkspace = () => mkdtempSync(join(tmpdir(), 'hosted-article-publish-')),
    removeWorkspace = (path) => rmSync(path, { recursive: true, force: true }),
    readBase = currentContainerBaseResult,
    readArchive = readCurrentImageArchive,
    inspectImage = (image) => inspectCurrentContainerImage(image),
    deploy = ({ application, siteRoot, base }) => runProviderDeployment({
      expectedServingImage: base.image,
      descriptor: {
        kind: 'package-owned-deployment-request',
        profile: 'fly-remote-only',
        parameters: { application, build_service: 'local', reuse_build_cache: 'no' },
      },
      spawnChild: spawn,
      parentEnv: process.env,
      spawnOptionsBase: { stdio: ['ignore', 'pipe', 'pipe'], cwd: siteRoot },
      resultFile: null,
    }),
  },
) {
  if (typeof document_ref !== 'string' || !document_ref.trim()) throw new Error('document_ref is required');
  for (const [name, dependency] of Object.entries({
    prepareCurrentDocument, currentProviderApplication, inputBasesAreCurrent, reviewRenderedCandidate,
  })) {
    if (typeof dependency !== 'function') throw new Error(`${name} owner is unavailable`);
  }
  const application = await currentProviderApplication({ session, send, document_ref });
  if (typeof application !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(application)) {
    throw new Error('current provider application is invalid');
  }
  const prepared = await prepareCurrentDocument({ session, send, document_ref });
  const candidate = prepared?.candidate
    ? { ...prepared.candidate, input_bases: prepared.candidate.input_bases ?? prepared.input_bases }
    : prepared;
  requireInputBases(candidate);
  const base = await readBase(application);
  if (base?.provider_application !== application || typeof base.image !== 'string') {
    throw new Error('provider returned no current serving image');
  }
  const workspace = createWorkspace();
  try {
    const current = await readArchive({ image: base.image, workspace });
    const proposedArchive = replaceArchivedArticle(current.archiveBytes, candidate);
    const review = await reviewRenderedCandidate({
      session, send, application, candidate, description: current.description,
      prepared, archivePath: current.archivePath, proposedArchive, image: base.image,
    });
    const requiredVerdicts = new Set(['factual', 'writing', 'design']);
    const passedVerdicts = new Set((Array.isArray(review?.verdicts) ? review.verdicts : [])
      .filter((verdict) => verdict?.status === 'passed').map((verdict) => verdict.kind));
    if (!review || typeof review !== 'object' || Array.isArray(review)
        || review.status !== 'passed'
        || review.candidate_identity !== JSON.stringify(candidate.page)
        || !Buffer.from(review.prospectiveArchiveBytes ?? []).equals(proposedArchive)
        || [...requiredVerdicts].some((kind) => !passedVerdicts.has(kind))
        || review.screenshot == null) {
      throw new Error('rendered Article review did not return factual, writing, and design evidence');
    }
    if (!await inputBasesAreCurrent({ session, send, input_bases: candidate.input_bases })) {
      throw new Error('document inputs changed during rendered Article review');
    }
    const siteRoot = writeImageContext({
      workspace, base, archivePath: current.archivePath, archiveBytes: proposedArchive, inspectImage,
    });
    const currentBase = await readBase(application);
    if (currentBase.image !== base.image) throw new Error('Serving image changed during article review.');
    const result = await deploy({ application, siteRoot, base, review });
    const deployedBase = await readBase(application);
    const deployedArchive = await readArchive({image:deployedBase.image,workspace});
    if (!deployedArchive.archiveBytes.equals(proposedArchive)) throw new Error('The serving image does not contain the reviewed article archive.');
    return {...result,article_readback:{verified:true,image:deployedBase.image,
      document_revision_hash:candidate.document_revision_hash,route_path:candidate.route_path,
      archive_path:deployedArchive.archivePath}};
  } finally {
    removeWorkspace(workspace);
  }
}
