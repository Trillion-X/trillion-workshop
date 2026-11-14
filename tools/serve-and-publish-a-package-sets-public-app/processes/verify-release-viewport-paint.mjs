import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import pngjs from 'pngjs';

const { PNG } = pngjs;
function eligibleRequest(request, host) {
  const url = new URL(request.url());
  if (url.protocol !== 'https:' || url.hostname !== host) return false;
  const path = url.pathname;
  if (request.method() === 'GET' || request.method() === 'HEAD') {
    // A signed-in journey can enter a member route such as /account after the
    // first scene. Keep the trial on this exact private host; GET and HEAD may
    // read its current scene, while writes remain limited below.
    return true;
  }
  return request.method() === 'POST' && (path === '/boot-phase'
    || path === '/target/engine.operation'
    || path === '/target/engine.operation.label-addressed'
    || path === '/target/account-session.browser-session');
}

function memberReadinessPlan(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('member readiness must be an object');
  }
  const storage = value.storage;
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)
      || Object.keys(storage).length === 0 || Object.keys(storage).length > 16
      || Object.entries(storage).some(([key, item]) => !key || typeof item !== 'string')) {
    throw new Error('member readiness requires caller-supplied browser session storage');
  }
  if (typeof value.authenticatedSelector !== 'string' || !value.authenticatedSelector.trim()) {
    throw new Error('member readiness requires a member-only authenticated selector');
  }
  if (!Array.isArray(value.journeys) || value.journeys.length === 0 || value.journeys.length > 30) {
    throw new Error('member readiness requires 1–30 named journeys');
  }
  const journeys = value.journeys.map((journey, index) => {
    if (!journey || typeof journey !== 'object' || Array.isArray(journey)
        || typeof journey.name !== 'string' || !journey.name.trim()
        || typeof journey.clickSelector !== 'string' || !journey.clickSelector.trim()
        || typeof journey.readySelector !== 'string' || !journey.readySelector.trim()) {
      throw new Error(`member journey ${index + 1} requires a name, navigation selector, and ready selector`);
    }
    return {
      name: journey.name.trim().slice(0, 80),
      clickSelector: journey.clickSelector,
      readySelector: journey.readySelector,
      errorSelector: typeof journey.errorSelector === 'string' && journey.errorSelector.trim()
        ? journey.errorSelector : null,
      textLayoutSelector: typeof journey.textLayoutSelector === 'string' && journey.textLayoutSelector.trim()
        ? journey.textLayoutSelector : null,
      timeoutMs: Number.isInteger(journey.timeoutMs) ? Math.min(Math.max(journey.timeoutMs, 1_000), 60_000) : 15_000,
    };
  });
  return {
    storage: { ...storage }, authenticatedSelector: value.authenticatedSelector, journeys,
    timeoutMs: Number.isInteger(value.timeoutMs) ? Math.min(Math.max(value.timeoutMs, 1_000), 300_000) : 120_000,
  };
}

async function confineTrialPage(page, url) {
  const trialOrigin = new URL(url).origin;
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== trialOrigin) return route.abort();
    return route.continue();
  });
}

async function verifyMemberJourneys({ browser, url, plan }) {
  if (!plan) return [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const page = await context.newPage();
    await confineTrialPage(page, url);
    const failedTargetResponses = [];
    const failedDocuments = [];
    page.on('response', (response) => {
      const pathname = new URL(response.url()).pathname;
      if (response.request().isNavigationRequest() && response.status() >= 400) {
        failedDocuments.push({ pathname, status: response.status() });
      }
      if (pathname.startsWith('/target/') && response.status() >= 400) {
        failedTargetResponses.push({ pathname, status: response.status() });
      }
    });
    const deadline = Date.now() + plan.timeoutMs;
    const remaining = () => {
      const milliseconds = deadline - Date.now();
      if (milliseconds <= 0) throw new Error('member journeys exceeded their time limit');
      return milliseconds;
    };
    // Session values exist only in this isolated browser context. They are
    // neither written to disk nor included in readiness output or diagnostics.
    await page.addInitScript((storage) => {
      for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    }, plan.storage);
    const results = [];
    for (const journey of plan.journeys) {
      try {
        const timeout = Math.min(journey.timeoutMs, remaining());
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        if (!response || response.status() < 200 || response.status() >= 300) {
          throw new Error(`page returned HTTP ${response?.status() ?? 'no response'}`);
        }
        await page.locator(plan.authenticatedSelector).first().waitFor({ state: 'visible', timeout: Math.min(journey.timeoutMs, remaining()) });
        const navigation = page.locator(journey.clickSelector).first();
        const safeNavigation = await navigation.evaluate((element) => element.matches('a[href], [role="tab"], [aria-controls], [data-navigation-item]'));
        if (!safeNavigation) throw new Error('the requested click target is not a declared navigation control');
        await navigation.click({ timeout: Math.min(journey.timeoutMs, remaining()) });
        if (failedDocuments.length) {
          const failed = failedDocuments[0];
          throw new Error(`member page failed: ${failed.pathname} returned HTTP ${failed.status}`);
        }
        await page.locator(journey.readySelector).first().waitFor({ state: 'visible', timeout: Math.min(journey.timeoutMs, remaining()) });
        if (journey.errorSelector && await page.locator(journey.errorSelector).first().isVisible()) {
          throw new Error('the selected member pane shows an error');
        }
        if (failedDocuments.length) {
          const failed = failedDocuments[0];
          throw new Error(`member page failed: ${failed.pathname} returned HTTP ${failed.status}`);
        }
        if (failedTargetResponses.length) {
          const failed = failedTargetResponses[0];
          throw new Error(`member data request failed: ${failed.pathname} returned HTTP ${failed.status}`);
        }
        const scene = await page.evaluate(viewportScene);
        if (scene.busy) throw new Error('the selected member pane is still opening');
        const readyRoot = page.locator(journey.readySelector).first();
        const readyScene = await readyRoot.evaluate((root) => {
          const nodes = [root, ...root.querySelectorAll('*')];
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const rootRect = root.getBoundingClientRect();
            return style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) !== 0
              && rect.width > 0 && rect.height > 0 && rect.right > rootRect.left && rect.left < rootRect.right
              && rect.bottom > rootRect.top && rect.top < rootRect.bottom;
          };
          return {
            visibleContent: nodes.some((element) => visible(element) &&
              ((element.children.length === 0 && element.textContent?.trim())
                || element.matches('img,svg,video,canvas,picture'))),
            busy: Boolean(root.closest('[aria-busy="true"]') || root.querySelector('[aria-busy="true"]')),
          };
        });
        const readyPixels = pixelEvidence(await readyRoot.screenshot());
        const readyDecision = viewportPaintDecision({ responseStatus: 200, ...readyScene, ...readyPixels });
        if (!readyDecision.ready) throw new Error(`the selected member scene is blank: ${readyDecision.reason}`);
        const screenshot = await page.screenshot();
        const decision = viewportPaintDecision({ responseStatus: response.status(), ...scene, ...pixelEvidence(screenshot) });
        if (!decision.ready) throw new Error(decision.reason);
        if (journey.textLayoutSelector) {
          const textRects = await page.locator(journey.textLayoutSelector).first().evaluate((root) => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            const result = [];
            let node;
            let nodeIndex = 0;
            while ((node = walker.nextNode())) {
              if (!node.textContent?.trim()) continue;
              const element = node.parentElement;
              const style = element && getComputedStyle(element);
              if (!style || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const rect of range.getClientRects()) {
                if (rect.width < 4 || rect.height < 4) continue;
                result.push({ text: node.textContent.trim().slice(0, 80), left: rect.left, top: rect.top,
                  right: rect.right, bottom: rect.bottom, nodeIndex });
              }
              nodeIndex += 1;
            }
            return result;
          });
          if (textRects.length === 0) throw new Error('the selected member pane has no readable text');
          const overlap = findTextOverlap(textRects);
          if (overlap) throw new Error(`visible text overlaps: ${overlap.first} / ${overlap.second}`);
        }
        results.push({ name: journey.name, ready: true });
      } catch (error) {
        results.push({ name: journey.name, ready: false, reason: String(error instanceof Error ? error.message : error).slice(0, 240) });
        break;
      }
    }
    return results;
  } finally {
    await context.close();
  }
}

export function findTextOverlap(rects) {
  for (let first = 0; first < rects.length; first += 1) {
    const a = rects[first];
    for (let second = first + 1; second < rects.length; second += 1) {
      const b = rects[second];
      if (a.nodeIndex === b.nodeIndex) continue;
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width > 3 && height > 3) return { first: a.text, second: b.text };
    }
  }
  return null;
}

export function viewportPaintDecision({ responseStatus, visibleContent, busy, distinctColors, foregroundFraction }) {
  if (!Number.isInteger(responseStatus) || responseStatus < 200 || responseStatus >= 300) {
    return { ready: false, reason: `the page returned HTTP ${responseStatus ?? 'no response'}` };
  }
  if (busy) return { ready: false, reason: 'the first scene is still busy' };
  if (!visibleContent) return { ready: false, reason: 'no meaningful content intersects the viewport' };
  if (distinctColors < 2 || foregroundFraction < 0.002) {
    return { ready: false, reason: 'the viewport screenshot has no meaningful painted content' };
  }
  return { ready: true, reason: 'the current scene paints in the viewport' };
}

function pixelEvidence(screenshot) {
  const png = PNG.sync.read(screenshot);
  const seen = new Set();
  const counts = new Map();
  const stride = Math.max(1, Math.floor(Math.min(png.width, png.height) / 140));
  let total = 0;
  for (let y = 0; y < png.height; y += stride) {
    for (let x = 0; x < png.width; x += stride) {
      const offset = (y * png.width + x) * 4;
      const color = `${png.data[offset] >> 3}:${png.data[offset + 1] >> 3}:${png.data[offset + 2] >> 3}`;
      seen.add(color);
      counts.set(color, (counts.get(color) ?? 0) + 1);
      total += 1;
    }
  }
  const dominant = Math.max(...counts.values());
  return { distinctColors: seen.size, foregroundFraction: (total - dominant) / total };
}

export function viewportScene() {
  const root = document.querySelector('#root') ?? document.querySelector('main') ?? document.body;
  const intersects = (element) => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.left < innerWidth
      && rect.bottom > 0 && rect.right > 0;
  };
  const nodes = [root, ...root.querySelectorAll('*')];
  const text = nodes.some((element) => element.children.length === 0
    && element.textContent.trim() && intersects(element)
    && !element.closest('.boot-status,[aria-busy="true"]'));
  const media = nodes.some((element) => element.matches('img,svg,video,canvas,picture') && intersects(element));
  return { visibleContent: text || media, busy: Boolean(root.querySelector('[aria-busy="true"]')) };
}

async function openBrowserProxy({ port, host, refused }) {
  const server = createHttpServer((incoming, outgoing) => {
    const pathname = new URL(incoming.url, 'http://localhost').pathname;
    if (!eligibleRequest({ url: () => `https://${host}${incoming.url}`, method: () => incoming.method }, host)) {
      refused.push(`${incoming.method} ${pathname}`);
      outgoing.writeHead(403).end();
      return;
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port, path: incoming.url,
      method: incoming.method, headers: { ...incoming.headers, host, 'accept-encoding': 'identity' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let body = Buffer.concat(chunks);
        const headers = { ...response.headers, 'content-length': body.length };
        delete headers['content-encoding'];
        outgoing.writeHead(response.statusCode || 502, headers);
        outgoing.end(body);
      });
    });
    upstream.on('error', (error) => { refused.push(`HTTP ${pathname}: ${error.message}`); outgoing.writeHead(502).end(); });
    incoming.pipe(upstream);
  });
  const upgrades = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') {
      refused.push(`WebSocket ${request.url}`);
      socket.destroy();
      return;
    }
    upgrades.handleUpgrade(request, socket, head, (browserSocket) => {
      const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host } });
      browserSocket.on('message', (message) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
        else upstream.once('open', () => upstream.send(message));
      });
      upstream.on('message', (message) => browserSocket.send(message));
      upstream.on('error', (error) => { refused.push(`WebSocket: ${error.message}`); browserSocket.terminate(); });
      browserSocket.on('close', () => upstream.terminate());
      upstream.on('close', () => browserSocket.terminate());
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: async () => {
    for (const client of upgrades.clients) client.terminate();
    await new Promise((resolve) => upgrades.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  } };
}

// Obscura's private-trial navigation failed with "Chromium Page.navigate did not
// answer" and its local WebSocket scene produced no paint in the focused test.
// The installed Chromium renders this exact trial through the same bounded proxy.
//
// Playwright is resolved when a trial is actually painted, never when the deploy
// program loads. It cannot live inside the one-file deploy bundle (its core finds
// its own files through `__dirname`, which a module bundle does not have), and a
// top-level import made every deploy operation fail to start, including ones that
// never open a browser. Where Playwright is not installed the paint check fails,
// so the release is refused rather than passed.
async function runChromium({ url, waitMs, memberReadiness }) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await confineTrialPage(page, url);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: waitMs });
    let scene = await page.evaluate(viewportScene);
    const deadline = Date.now() + waitMs;
    while ((!scene.visibleContent || scene.busy) && Date.now() < deadline) {
      await page.waitForTimeout(500);
      scene = await page.evaluate(viewportScene);
    }
    const screenshot = await page.screenshot();
    const members = await verifyMemberJourneys({ browser, url, plan: memberReadiness });
    return { scene, responseStatus: response?.status() ?? null, screenshot, members };
  } finally {
    await browser.close();
  }
}

/** Browser traffic goes through Fly's private tunnel to the exact trial machine. */
export async function verifyReleaseViewportPaint({
  application, privateIp, host, waitMs = 20_000, openTunnel, memberReadiness = null,
}) {
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('release trial has no valid app host');
  if (typeof openTunnel !== 'function') throw new Error('release trial has no provider-owned private tunnel');
  const tunnel = await openTunnel({ application, privateIp });
  const refused = [];
  let proxy;
  try {
    proxy = await openBrowserProxy({ port: tunnel.port, host, refused });
    const url = `http://127.0.0.1:${proxy.port}/`;
    const memberPlan = memberReadinessPlan(memberReadiness);
    const rendered = await runChromium({ url, waitMs, memberReadiness: memberPlan });
    if (refused.length) return { ready: false, reason: `trial browser request refused: ${refused[0]}` };
    const pixels = pixelEvidence(rendered.screenshot);
    const decision = viewportPaintDecision({ responseStatus: rendered.responseStatus, ...rendered.scene, ...pixels });
    const failedJourney = rendered.members.find((journey) => !journey.ready);
    if (decision.ready && failedJourney) {
      return { ready: false, reason: `member journey ${failedJourney.name} failed: ${failedJourney.reason}` };
    }
    return process.env.BITFIELD_RELEASE_TRIAL_DIAGNOSTICS
      ? { ...decision, journeys: rendered.members.map(({ name, ready }) => ({ name, ready })), reason: `${decision.reason}; scene=${JSON.stringify(rendered.scene)}; pixels=${JSON.stringify(pixels)}` }
      : { ...decision, ...(rendered.members.length ? { journeys: rendered.members.map(({ name, ready }) => ({ name, ready })) } : {}) };
  } finally {
    await proxy?.close();
    tunnel.close();
  }
}
