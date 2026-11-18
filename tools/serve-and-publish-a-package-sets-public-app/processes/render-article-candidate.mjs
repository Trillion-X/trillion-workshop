import { blake3 } from '@noble/hashes/blake3.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright';
import { currentContainerBaseResult } from './run-provider-deploy.mjs';
import { inspectCurrentContainerImage } from '../../write-a-sales-page/packages/hosted-public-app/processes/flatten-current-container-base.mjs';

const SERVER_IN_IMAGE = '/opt/bitfield/public-entry-server';
const DESCRIPTION_IN_IMAGE = '/app/page-description.json';
const CONTAINER_PORT = 8080;
const VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
};
const retainedWorkspaces = new Map();

function byteIdentity(bytes) {
  return `1f:${Buffer.from(blake3(bytes)).toString('hex')}`;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error(`${label} must contain valid UTF-8 JSON`);
  }
}

function assertRoute(routePath) {
  if (typeof routePath !== 'string' || !routePath.startsWith('/') || routePath.startsWith('//')
    || routePath.includes('?') || routePath.includes('#') || routePath.includes('\\')
    || routePath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('candidate route_path must be one exact absolute path');
  }
}

function assertDescription(description) {
  object(description, 'page description');
  if (!Array.isArray(description.pages) || description.pages.length === 0) {
    throw new Error('image page description has no pages');
  }
  const archiveNames = new Set(description.pages
    .map((page) => page?.fallback_pages_file)
    .filter((value) => typeof value === 'string' && value.length > 0));
  if (archiveNames.size !== 1) throw new Error('image must declare exactly one fallback page archive');
  return [...archiveNames][0];
}

function normalizeContainerPath(descriptionPath, declaredPath) {
  if (typeof declaredPath !== 'string' || !declaredPath.trim()) {
    throw new Error('page description does not name its fallback archive');
  }
  return path.posix.isAbsolute(declaredPath)
    ? path.posix.normalize(declaredPath)
    : path.posix.resolve(path.posix.dirname(descriptionPath), declaredPath);
}

export function composeCandidateArchive(currentArchiveBytes, candidate) {
  const routePath = candidate?.route_path;
  assertRoute(routePath);
  const page = object(candidate.page, 'candidate.page');
  if (page.kind !== 'public-sales-page' || page.route_path !== routePath) {
    throw new Error('candidate page must be a public-sales-page row at candidate.route_path');
  }
  const current = parseJsonBytes(currentArchiveBytes, 'current page archive');
  if (!Array.isArray(current?.rows)) throw new Error('current page archive has no rows array');
  const matches = current.rows.map((row, index) => row?.route_path === routePath ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length > 1) throw new Error('current page archive contains duplicate candidate routes');
  const rows = [...current.rows];
  if (matches.length === 1) rows[matches[0]] = page;
  else rows.push(page);
  return Buffer.from(JSON.stringify({ ...current, ...(typeof current.count === 'number' ? {count:rows.length} : {}), rows }), 'utf8');
}

function assertProspectiveArchive(currentBytes, prospectiveBytes, candidate) {
  const expected = parseJsonBytes(composeCandidateArchive(currentBytes, candidate), 'expected candidate archive');
  const supplied = parseJsonBytes(prospectiveBytes, 'prospective page archive');
  if (!Array.isArray(supplied?.rows) || !isDeepStrictEqual(supplied, expected)) {
    throw new Error('prospective archive must replace exactly the candidate route and retain every other row');
  }
}

function envValue(inspected, name) {
  const prefix = `${name}=`;
  const value = inspected?.Config?.Env?.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : '';
}

function chooseHost(description, inspected) {
  for (const page of description.pages) {
    if (Array.isArray(page?.hosts)) {
      const host = page.hosts.find((entry) => typeof entry === 'string' && entry.trim());
      if (host) return host;
    }
  }
  const fromImage = envValue(inspected, 'BITFIELD_HOST_ENTRY_SCENE_HOSTS').split(',')
    .map((value) => value.trim()).find(Boolean);
  if (!fromImage) throw new Error('current image provides no public host for rendering');
  return fromImage;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options }).trim();
}

function dockerCopy(container, from, to) {
  run('docker', ['cp', `${container}:${from}`, to]);
}

export function dockerCopyIntoArguments(container, from, to) {
  if (typeof container !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
    throw new Error('Docker copy requires a container, local file, and image path');
  }
  return ['cp', from, `${container}:${to}`];
}

function dockerCopyInto(container, from, to) {
  run('docker', dockerCopyIntoArguments(container, from, to));
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(url, child = null, timeoutMs = 30_000, host = 'candidate.invalid') {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`candidate image exited before listening (${child.exitCode})`);
    try {
      const response = await new Promise((resolve,reject) => {
        const request = httpGet(url,{headers:{Host:host}},reply=>{
          let body='';reply.on('data',chunk=>{body+=chunk;});
          reply.on('end',()=>resolve({status:reply.statusCode,body}));
        });
        request.setTimeout(2000,()=>request.destroy(new Error('render connection timed out')));
        request.on('error',reject);
      });
      if (response.status < 500) return;
      lastError = new Error(`HTTP ${response.status} for ${host}: ${response.body.slice(0,300)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`current image public-entry-server did not listen: ${String(lastError?.message ?? 'timeout')}`);
}

export function needsMaskCompatibleBrowser(edges) {
  return edges.some(({ overflow, mask }) => overflow && (!mask || mask === 'none'));
}

async function captureWithObscura({ url, host, expectedTitle, outputDirectory }, useCompatibleBrowser = false) {
  const port = await allocatePort();
  const obscura = useCompatibleBrowser ? null : (await import('node:child_process')).spawn(
    'obscura', ['--allow-private-network', 'serve', '--port', String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  obscura?.stdout.on('data', (part) => { log += part.toString(); });
  obscura?.stderr.on('data', (part) => { log += part.toString(); });
  let browser;
  try {
    if (useCompatibleBrowser) browser = await chromium.launch({ headless: true,
      args: [`--host-resolver-rules=MAP ${host} 127.0.0.1`, '--no-proxy-server'] });
    else {
      await waitForServer(`http://127.0.0.1:${port}/json/version`, obscura, 10_000);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    }
    const captures = {};
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        isMobile: name === 'mobile',
        hasTouch: name === 'mobile',
        extraHTTPHeaders: useCompatibleBrowser ? {} : { Host: host },
      });
      const page = await context.newPage();
      const navigationUrl = new URL(url);
      if (useCompatibleBrowser) navigationUrl.hostname = host;
      const response = await page.goto(navigationUrl.href, { waitUntil: 'networkidle', timeout: 30_000 });
      if (response?.status() !== 200) {
        throw new Error(`candidate route returned HTTP ${response?.status() ?? 'no response'} at ${name} size`);
      }
      if (typeof expectedTitle === 'string' && expectedTitle.trim()
        && !(await page.locator('body').innerText()).includes(expectedTitle)) {
        throw new Error(`candidate title was absent from the rendered ${name} page`);
      }
      // Obscura can paint the cards while omitting their CSS masks. That is a
      // different visual from the customer browser, not evidence of clipping.
      const edges = await page.locator('.bf-scroll-viewport').evaluateAll(elements =>
        elements.map(element => ({
          overflow: Boolean(element.dataset.scrollFade),
          mask: getComputedStyle(element).maskImage,
        })));
      if (needsMaskCompatibleBrowser(edges)) {
        if (useCompatibleBrowser) throw new Error('The capture browser did not render required scroll-edge masks.');
        await context.close();
        await browser.close();
        browser = null;
        return await captureWithObscura({ url, host, expectedTitle, outputDirectory }, true);
      }
      const htmlBytes = Buffer.from(await page.content(), 'utf8');
      const screenshotBytes = Buffer.from(await page.screenshot({ type: 'png', fullPage: true }));
      const reviewImageBytes = Buffer.from(await page.screenshot({type:'jpeg',quality:75,fullPage:true}));
      await writeFile(path.join(outputDirectory,`${name}.jpg`),reviewImageBytes);
      const htmlPath = path.join(outputDirectory, `${name}.html`);
      const screenshotPath = path.join(outputDirectory, `${name}.png`);
      await writeFile(htmlPath, htmlBytes);
      await writeFile(screenshotPath, screenshotBytes);
      captures[name] = {
        html_identity: byteIdentity(htmlBytes),
        screenshot_identity: byteIdentity(screenshotBytes),
        html_path: htmlPath,
        screenshot_path: screenshotPath,
        viewport,
        renderer: useCompatibleBrowser ? 'chromium-mask-compatible' : 'obscura',
      };
      await context.close();
    }
    return captures;
  } catch (error) {
    throw new Error(`The capture browser could not render the public candidate: ${String(error?.message ?? error)}${log ? ` (${log.slice(-1200)})` : ''}`);
  } finally {
    await browser?.close().catch(() => {});
    obscura?.kill('SIGTERM');
    if (obscura) await new Promise((resolve) => {
      if (obscura.exitCode !== null) resolve();
      else obscura.once('exit', resolve);
      setTimeout(resolve, 1000).unref();
    });
  }
}

async function captureInCurrentImage({ image, inspected, descriptionPath, archivePath, description, prospectiveArchiveBytes, host, routePath, workspace }) {
  const container = `hosted-article-candidate-${randomUUID()}`;
  const port = await allocatePort();
  try {
    run('docker', [
      'create', '--name', container,
      '--publish', `127.0.0.1:${port}:${CONTAINER_PORT}`,
      '--entrypoint', 'node',
      '--env', 'BITFIELD_PUBLIC_ENTRY_LISTEN_HOST=0.0.0.0',
      '--env', `BITFIELD_PUBLIC_ENTRY_LISTEN_PORT=${CONTAINER_PORT}`,
      '--env', 'BITFIELD_PUBLIC_ENTRY_SHELL_URL=http://127.0.0.1:1',
      '--env', 'BITFIELD_BOOT_WAIT_MS=1000',
      '--env', `BITFIELD_HOST_ENTRY_SCENE_HOSTS=${host}`,
      '--env', `BITFIELD_PUBLIC_PAGE_DESCRIPTION_FILE=${descriptionPath}`,
      '--env', `BITFIELD_BROWSER_STATIC_DIR=${envValue(inspected, 'BITFIELD_BROWSER_STATIC_DIR') || '/app'}`,
      '--env', 'BITFIELD_INSTALL_ROOT=/var/lib/bitfield',
      image, SERVER_IN_IMAGE,
    ]);
    const descriptionFile = path.join(workspace, 'page-description.json');
    const archiveFile = path.join(workspace, 'prospective-archive.json');
    await writeFile(descriptionFile, `${JSON.stringify(description)}\n`, 'utf8');
    await writeFile(archiveFile, prospectiveArchiveBytes);
    dockerCopyInto(container, descriptionFile, descriptionPath);
    dockerCopyInto(container, archiveFile, archivePath);
    run('docker', ['start', container]);
    const localUrl = `http://127.0.0.1:${port}${routePath}`;
    await waitForServer(localUrl, null, 60_000, host);
    return { localUrl, container };
  } catch (error) {
    let logs = '';
    try { logs = run('docker', ['logs', container], { timeout: 5000 }); } catch { /* no logs for a failed create */ }
    try { run('docker', ['rm', '--force', container]); } catch { /* container may not have been created */ }
    throw new Error(`${String(error?.message ?? error)}${logs ? ` (${logs.slice(-1200)})` : ''}`);
  }
}

function retainWorkspace(directory, artifacts) {
  const token = randomUUID();
  retainedWorkspaces.set(token, { directory, artifacts });
  return Object.freeze({
    kind: 'hosted-public-app.render-workspace-handle',
    owner_ref: 'hosted-public-app',
    token,
  });
}

function resolveHandle(handle) {
  if (handle?.kind !== 'hosted-public-app.render-workspace-handle'
    || handle.owner_ref !== 'hosted-public-app' || typeof handle.token !== 'string') {
    throw new Error('render workspace handle is invalid');
  }
  const workspace = retainedWorkspaces.get(handle.token);
  if (!workspace) throw new Error('render workspace handle is no longer available');
  return workspace;
}

export async function readRenderArtifact(handle, name) {
  const { artifacts } = resolveHandle(handle);
  if (!Object.hasOwn(artifacts, name)) throw new Error('render artifact name is not available');
  return readFile(artifacts[name]);
}

export async function releaseRenderWorkspace(handle) {
  const workspace = resolveHandle(handle);
  retainedWorkspaces.delete(handle.token);
  await rm(workspace.directory, { recursive: true, force: true });
}

/** Render one internally prepared article against the image that currently serves the host. */
export async function captureArticleCandidate({
  application, candidate, description: pageDescription, archivePath: expectedArchivePath,
  proposedArchive, image: expectedImage,
}, dependencies = {}) {
  object(candidate, 'candidate');
  const routePath = candidate.route_path;
  assertRoute(routePath);
  const page = object(candidate.page, 'candidate.page');
  if (page.kind !== 'public-sales-page' || page.route_path !== routePath) {
    throw new Error('candidate.page must be the prepared public-sales-page row for candidate.route_path');
  }
  const prospective = Buffer.from(proposedArchive ?? []);
  if (!prospective.length) throw new Error('prospective archive bytes are required');
  const workspace = await mkdtemp(path.join(tmpdir(), 'hosted-article-candidate-'));
  let retained = false;
  let container;
  let rendererContainer;
  try {
    const base = await (dependencies.currentContainerBaseResult ?? currentContainerBaseResult)(application);
    if (base?.kind !== 'hosted-current-container-base-handle' || typeof base.image !== 'string') {
      throw new Error('hosted-public-app returned no current serving image');
    }
    if (expectedImage !== undefined && expectedImage !== base.image) {
      throw new Error('supplied image is no longer the current serving image');
    }
    const inspected = await (dependencies.inspectCurrentContainerImage ?? inspectCurrentContainerImage)(base.image);
    if (!inspected?.Config?.Entrypoint || !Array.isArray(inspected.Config.Env)) {
      throw new Error('current image is missing its entry metadata');
    }
    const descriptionFile = path.join(workspace, 'image-page-description.json');
    const imageArchiveFile = path.join(workspace, 'image-fallback-archive.json');
    container = `hosted-article-inspect-${randomUUID()}`;
    (dependencies.run ?? run)('docker', ['create', '--name', container, base.image]);
    await (dependencies.copyFromImage ?? dockerCopy)(container, DESCRIPTION_IN_IMAGE, descriptionFile);
    const imageDescriptionBytes = await readFile(descriptionFile);
    const imageDescription = parseJsonBytes(imageDescriptionBytes, 'current image page description');
    const declaredArchive = assertDescription(imageDescription);
    const archivePath = normalizeContainerPath(DESCRIPTION_IN_IMAGE, declaredArchive);
    const normalizedExpectedPath = typeof expectedArchivePath === 'string'
      ? (path.posix.isAbsolute(expectedArchivePath)
        ? path.posix.normalize(expectedArchivePath)
        : path.posix.resolve('/app', expectedArchivePath))
      : archivePath;
    if (normalizedExpectedPath !== archivePath) {
      throw new Error('archive path does not match the current image description');
    }
    await (dependencies.copyFromImage ?? dockerCopy)(container, archivePath, imageArchiveFile);
    const currentArchiveBytes = await readFile(imageArchiveFile);
    if (!isDeepStrictEqual(pageDescription, imageDescription)) {
      throw new Error('supplied page description does not match the current serving image');
    }
    assertProspectiveArchive(currentArchiveBytes, prospective, candidate);
    const host = chooseHost(imageDescription, inspected);
    const renderedHost = await (dependencies.startImage ?? captureInCurrentImage)(
      { image: base.image, inspected, descriptionPath: DESCRIPTION_IN_IMAGE, archivePath,
        description: imageDescription, prospectiveArchiveBytes: prospective, host,
        routePath, workspace },
    );
    rendererContainer = renderedHost.container;
    const captures = await (dependencies.capture ?? captureWithObscura)(
      { url: renderedHost.localUrl, host, expectedTitle: page.title, outputDirectory: workspace },
    );
    if (!captures?.desktop || !captures?.mobile) throw new Error('desktop and mobile render captures are required');
    const pageBytes = Buffer.from(JSON.stringify(page), 'utf8');
    const candidateBytes = Buffer.from(JSON.stringify(candidate), 'utf8');
    const artifactPaths = {
      'desktop.html': captures.desktop.html_path,
      'desktop.png': captures.desktop.screenshot_path,
      'desktop.jpg': path.join(workspace,'desktop.jpg'),
      'mobile.html': captures.mobile.html_path,
      'mobile.png': captures.mobile.screenshot_path,
      'mobile.jpg': path.join(workspace,'mobile.jpg'),
      'prospective-archive.json': path.join(workspace, 'prospective-archive.json'),
    };
    await writeFile(artifactPaths['prospective-archive.json'], prospective);
    const workspaceHandle = retainWorkspace(workspace, artifactPaths);
    retained = true;
    return {
      kind: 'hosted-public-app.rendered-article-candidate',
      application,
      image: base.image,
      route_path: routePath,
      identities: {
        page: byteIdentity(pageBytes),
        candidate: byteIdentity(candidateBytes),
        current_archive: byteIdentity(currentArchiveBytes),
        prospective_archive: byteIdentity(prospective),
        desktop_html: captures.desktop.html_identity,
        mobile_html: captures.mobile.html_identity,
        desktop_screenshot: captures.desktop.screenshot_identity,
        mobile_screenshot: captures.mobile.screenshot_identity,
      },
      rendered: {
        desktop_viewport: captures.desktop.viewport ?? VIEWPORTS.desktop,
        mobile_viewport: captures.mobile.viewport ?? VIEWPORTS.mobile,
      },
      candidate_identity: JSON.stringify(page),
      screenshot: {
        desktop: { identity: captures.desktop.screenshot_identity, viewport: captures.desktop.viewport ?? VIEWPORTS.desktop },
        mobile: { identity: captures.mobile.screenshot_identity, viewport: captures.mobile.viewport ?? VIEWPORTS.mobile },
        workspace_handle: workspaceHandle,
      },
      prospectiveArchiveBytes: prospective,
      workspace_handle: workspaceHandle,
    };
  } finally {
    if (rendererContainer) {
      try { (dependencies.run ?? run)('docker', ['rm', '--force', rendererContainer]); } catch { /* image container may already be gone */ }
    }
    if (container) {
      try { (dependencies.run ?? run)('docker', ['rm', '--force', container]); } catch { /* inspect container may already be gone */ }
    }
    if (!retained) await rm(workspace, { recursive: true, force: true });
  }
}
