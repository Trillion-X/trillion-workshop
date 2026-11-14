// =============================================================================
// /tmp/browsing-surface-provider.mjs  (authoring scratch — LIVE truth = the log)
// -----------------------------------------------------------------------------
// PURPOSE
//   Log-delivered realm "brain" giving the web-frame package REAL cross-origin
//   browsing. It orchestrates ONE Chromium engine through the generic admitted
//   process-session boundary
//   (an OS process via compute.process_session, by default headless-new with no
//   OS window). The portable request names an owner-contained profile directory;
//   durable persistence remains an owner proof. It multiplexes N independent
//   browsing surfaces as N page targets inside that
//   one browser — the way a browser is built to host N tabs. The realm speaks Chrome
//   DevTools Protocol directly over one WebSocket (flatten mode: per-target sessionId
//   routing), Page.startScreencast → canvas, and forwards the user's Input events.
//
// ARCHITECTURE (gauntlet-derived — plan 2026-06-19-multi-surface-and-render-quality)
//   - browserConnection (module singleton, REF-COUNTED, Pattern 34): owns the
//     Chrome process + the one CDP socket. Booted on the first surface,
//     Browser.close + end_session on the last. Routes target-scoped events to the
//     owning SurfacePage by sessionId.
//   - SurfacePage (ONE per surface): a page target (Target.createTarget) with its
//     own sessionId, screencast, input, navigation. Dispose = Target.closeTarget
//     (NOT Browser.close). N surfaces = N isolated pages, one browser.
//   - surfacePool: Map<surfaceKey, {page, views, disposeTimer}>. surfaceKey =
//     element 'surface-key' attribute if the consumer supplies one, else a
//     per-element token. Identity is OPAQUE — no enum of surface "types".
//   - RENDER INVARIANT (kills blur + stretch): rendered viewport = element CSS box
//     × devicePixelRatio; screencast captured at device pixels (no downscale);
//     canvas backing = device-pixel frame; canvas CSS box = element box → frame
//     aspect always equals element-box aspect (no distortion) at retina sharpness.
//   - rAF coalescing (Pattern 58): paint only the latest frame, once per frame.
//
// NON-NEGOTIABLE INVARIANTS
//   - Never throws out of putOnScreen / element lifecycle.
//   - customElements.define is idempotent (guarded).
//   - Zero Society leakage: package material delivered as bytes through the log.
//     All numeric tunables are config (overridable), not magic constants.
// =============================================================================

import { captureDomSnapshot } from './dom-snapshot-contract.mjs';

const SURFACE_TAG = 'bitfield-browsing-surface'; // stable production tag
const READY_EVENT = 'bitfield-browsing-surface-ready';
const TASK_SURFACE_OBSERVATION_KIND = 'process-session.task-surface-isolation-observation';
const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const MAX_TASK_REF_BYTES = 512;
const TASK_SURFACE_OBSERVATION_LIFETIME_MS = 5_000;

const PROCESS_SESSION_TARGET = 'compute.process_session';
const LABEL_ADDRESSED_TARGET = 'engine.operation.label-addressed';
const READ_CURRENT_OP = 'engine.operation.read-current';

// The native process owner resolves this portable runtime alias. The provider never
// chooses a machine path; different browser engines are owner-registered DATA.
const DEFAULT_BROWSER_RUNTIME_ALIAS = 'browser';

// Realness modes are DATA (enum-dissolution / Pattern 81): a map from mode NAME → the exact
// extra Chrome launch args for that mode. `_boot` does a TABLE LOOKUP and never branches on
// the mode string, so adding a realness mode = one data entry (here or via config override),
// ZERO code change. Each value is `(cfg) => string[]` so window position etc. stays data-driven.
const DEFAULT_REALNESS_MODES = {
  // Genuinely windowed real Chrome positioned off-screen. SUPERSEDED as default: macOS does NOT
  // keep a real window hidden — it CLAMPS off-screen window bounds back on-screen (a -32000
  // request lands at ~-1240,33) and HTML5 fullscreen forces the window onto a display — so a
  // headful window unavoidably leaks onto the user's screen (live screenshot-confirmed). Kept,
  // data-selectable, for platforms that CAN hide a window.
  'headful-offscreen': (cfg) => [`--window-position=${cfg.offscreenLeft},${cfg.offscreenTop}`],
  // Real Chromium engine with NO OS window — structurally invisible (the DEFAULT). The only
  // historical tell was the UA's "HeadlessChrome" token; the provider corrects it to "Chrome"
  // (Emulation.setUserAgentOverride in SurfacePage.start — same engine, human-driven, the same
  // honest disclosure-correction class as the webdriver flag), so browser-security gates (Google
  // sign-in) pass. EMPIRICALLY VERIFIED: renders, screencasts at 60fps, passes Google's gate.
  'headless-new': () => ['--headless=new'],
};

// Capture limits/defaults are injected DATA. The CDP capture leaf owns no numeric
// policy, so a different runtime profile changes capacity without code branches.
const DEFAULT_SPATIAL_CAPTURE_POLICY = Object.freeze({
  default_computed_styles: Object.freeze([
    'display', 'position', 'z-index', 'box-sizing', 'width', 'height',
    'min-width', 'min-height', 'max-width', 'max-height',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'color', 'background-color', 'background-image',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius',
    'opacity', 'overflow', 'overflow-x', 'overflow-y', 'clip', 'clip-path',
    'transform', 'transform-origin', 'filter', 'mix-blend-mode',
    'font-family', 'font-size', 'font-style', 'font-weight', 'line-height',
    'letter-spacing', 'text-align', 'text-decoration-line', 'text-transform',
    'white-space', 'word-break', 'object-fit', 'object-position',
    'flex-direction', 'align-items', 'justify-content', 'gap',
    'grid-template-columns', 'grid-template-rows',
  ]),
  maximum_computed_styles: 256,
  maximum_selector_bytes: 4_096,
  maximum_surface_key_bytes: 1_024,
  backend_node_id_minimum: 1,
  backend_node_id_maximum: 2_147_483_647,
  matched_style_nodes_minimum: 0,
  default_matched_style_nodes: 64,
  maximum_matched_style_nodes: 256,
  resources_minimum: 0,
  default_resources: 128,
  maximum_resources: 512,
  resource_bytes_minimum: 0,
  default_resource_bytes: 16 * 1024 * 1024,
  maximum_resource_bytes: 50 * 1024 * 1024,
});

// Society-as-config: every tunable is overridable at runtime via the global,
// flippable without recompiling. Defaults are maximally capable (L083).
const CONFIG = Object.assign({
  browserRuntimeAlias: DEFAULT_BROWSER_RUNTIME_ALIAS,
  browserPrivateVolume: 'browser-profile',
  surfaceGraceMs: 8_000,   // keep a surface's page alive this long after its last view detaches (React remount churn)
  browserGraceMs: 8_000,   // Browser.close this long after the last surface closes
  screencastQuality: 92,   // JPEG quality (retina-sharp); device-pixel capture makes this the only fidelity knob
  muteAudio: false,        // DEFAULT audio ON (a real browser plays sound). Set true to launch Chrome with --mute-audio.
  sessionTimeoutMs: 86_400_000,
  // Hybrid frame source: startScreencast streams only the FOREGROUND/composited window
  // (background windows go dark). A captureScreenshot poll renders ANY target on demand,
  // so backgrounded surfaces stay live. The poll only fires when screencast has gone idle
  // for this surface (foreground surface → screencast delivers → poll self-suppresses).
  backgroundPollMs: 180,   // ~5.5fps for backgrounded surfaces (not focused → low rate is fine)
  // Frame source strategy (DATA). 'capture-loop' = a single self-pacing Page.captureScreenshot
  // loop — in HEADLESS the ONLY full-resolution source: startScreencast there emits a low-res
  // (~800px, wrong-aspect) frame regardless of the emulated viewport, and when it alternated with
  // the sharp capture poll it produced the "pulsing blur" (sharp on static frames, blurry on
  // motion). captureScreenshot honors deviceScaleFactor → device-pixel (retina) frames at the
  // emulated viewport size, ONE consistent source → no pulse. EMPIRICALLY VERIFIED
  // (prove-headless-frame-source.mjs): capture ~26fps full-res; headless screencast 61fps but only
  // ~800px. 'screencast' = startScreencast (60fps device-px in HEADFUL) + captureScreenshot backup.
  frameSource: 'capture-loop',
  captureLoopMs: 0,        // gap after a CHANGED frame (fast path; capture time dominates → ~26fps).
  // Idle path (UNCHANGED frame) reuses backgroundPollMs → a static page drops to ~5fps, low CPU.
  // Browser profile directory beneath the owner-created contained session root. This
  // portable request names only a relative directory and never carries a host path.
  // It is not durable until the owner binds the session to an app/account-scoped volume.
  browserProfileDirectory: 'browser-profile',
  // Realness level (DATA, not per-site code). DEFAULT 'headless-new': a real Chromium engine with
  // NO OS window — structurally invisible, so the genuine browser can NEVER leak onto the user's
  // screen. This REPLACED 'headful-offscreen' after live proof that macOS will not keep a real
  // (headful) window hidden: it CLAMPS off-screen window bounds back on-screen (a -32000 request
  // lands at ~-1240,33) and HTML5 fullscreen forces the window onto a display — so a headful
  // window is unavoidably visible (user-reported + screenshot-confirmed). Headless's only
  // historical tell was the UA's "HeadlessChrome" token, which the provider corrects to "Chrome"
  // (same engine, human-driven — the same honest disclosure-correction class as the webdriver
  // flag, NOT a manufactured fingerprint). EMPIRICALLY VERIFIED (prove-headless-google.mjs +
  // prove-headless-screencast.mjs): headless renders, screencasts at ~60fps, AND passes Google
  // sign-in's browser-security gate with the UA correction (webdriver=false, plugins/window.chrome
  // genuine). 'headful-offscreen' stays selectable for platforms that CAN hide a window. Flip this
  // value to switch modes (see realnessModes) — never add per-site logic.
  realness: 'headless-new',
  // Off-screen window origin — the SINGLE source of truth for BOTH the launch flag and the
  // per-window bounds enforcement (a launch flag only places Chrome's FIRST window; every
  // surface window is its OWN window and is additionally, CONTINUOUSLY positioned here via
  // Browser.setWindowBounds — see SurfacePage._enforceOffscreen).
  offscreenLeft: -32000,
  offscreenTop: -32000,
  // How often to re-assert each surface window's off-screen bounds. The OS or the PAGE can move
  // a real window on-screen (most visibly an HTML5 fullscreen request), so the off-screen
  // invariant is re-enforced rather than set once.
  offscreenGuardMs: 700,
  realnessModes: DEFAULT_REALNESS_MODES, // mode NAME → extra-args (DATA; table lookup, no enum branch)
  spatialCapturePolicy: DEFAULT_SPATIAL_CAPTURE_POLICY,
}, (typeof globalThis !== 'undefined' && globalThis.__BITFIELD_BROWSING_CONFIG__) || {});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const enc = (s) => textEncoder.encode(s);
const dec = (b) => textDecoder.decode(b);

// Diagnostics go to the console only. Until 2026-09-09 this also POSTed every report to a
// bring-up beacon at a frozen loopback port, stamped with a hand-typed version marker, which
// was a second network reach the package did not own and a host address no shipped file may
// carry. The console line is the whole of it now.
function report(obj) {
  try { console.debug('[browsing-provider]', JSON.stringify(obj)); } catch {}
}

function requireBoundedIdentity(value, name, maximumBytes = MAX_TASK_REF_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumBytes || /[\r\n\0]/u.test(value)) {
    throw new TypeError(`${name} must be a nonempty bounded identity`);
  }
  return value;
}

function requireExactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unexpected fields`);
  }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
  return u8;
}

// ---------------------------------------------------------------------------
// process-session event feed decoder — only the stdout/stderr TEXT (to find the
// "DevTools listening on ws://..." line). Structured, not blob-scanning.
// ---------------------------------------------------------------------------
function decodeFeedOutputText(bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 0;
    const u8 = () => { const v = dv.getUint8(o); o += 1; return v; };
    const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
    const u64 = () => { const v = dv.getBigUint64(o, true); o += 8; return Number(v); };
    const version = u8();
    if (version === 2) {
      const skipBytes = () => { const length = u32(); o += length; };
      skipBytes(); // session_id
      skipBytes(); // event_stream_address
      u8(); // state
      u64(); u64(); u64(); // event counters + total bytes
      if (u8() === 1) o += 4; // exit_code
      if (u8() === 1) skipBytes(); // failure_reason
      if (o === bytes.byteLength) return ''; // historical V2 head
      const tailLength = u32();
      return textDecoder.decode(bytes.subarray(o, o + tailLength));
    }
    if (version !== 1) return '';
    const sessionCount = u32();
    for (let i = 0; i < sessionCount; i += 1) { const l = u32(); o += l; }
    const eventCount = u32();
    let out = '';
    for (let i = 0; i < eventCount; i += 1) {
      u32(); u64(); u64();
      const kind = u8();
      if (kind === 0) { u8(); const len = u32(); out += textDecoder.decode(bytes.subarray(o, o + len)); o += len; }
      else if (kind === 1) { u8(); if (u8() === 1) o += 4; if (u8() === 1) { const l = u32(); o += l; } }
      else if (kind === 2) { const l = u32(); o += l; }
      else break;
    }
    return out;
  } catch { return ''; }
}

const PROCESS_ENDPOINT_SCHEMA = 'bitfield.process_endpoint.v1';
const DEVTOOLS_ENDPOINT_NAME = 'devtools';
const DEVTOOLS_PROVIDER_PORT = 9222;

function endpointBaseUrl(host, port) {
  // URL requires brackets around an IPv6 literal; a hostname / IPv4 address
  // must not contain brackets, a scheme, credentials, or path syntax.
  if (typeof host !== 'string' || host.length === 0 || /[/?#@\s]/.test(host)) {
    throw new TypeError('process endpoint host must be a bare hostname or IP address');
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('process endpoint port must be an exact TCP port');
  }
  const authority = host.includes(':') ? `[${host}]` : host;
  return new URL(`http://${authority}:${port}/`);
}

// The line is emitted by the admitted process owner, not by Chrome. It binds
// a stable provider-side port to the owner-selected reachable host/port without
// leaking Docker/Podman/etc. into this package.
export function parseExternalProcessEndpointLine(text) {
  if (typeof text !== 'string') return null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('BITFIELD_PROCESS_ENDPOINT ')) continue;
    const encoded = line.slice('BITFIELD_PROCESS_ENDPOINT '.length);
    let endpoint;
    try { endpoint = JSON.parse(encoded); } catch { continue; }
    if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) continue;
    if (
      endpoint.schema !== PROCESS_ENDPOINT_SCHEMA
      || endpoint.name !== DEVTOOLS_ENDPOINT_NAME
      || endpoint.transport !== 'tcp'
      || endpoint.provider_port !== DEVTOOLS_PROVIDER_PORT
    ) continue;
    try { endpointBaseUrl(endpoint.host, endpoint.port); } catch { continue; }
    const canonical = {
      schema: PROCESS_ENDPOINT_SCHEMA,
      name: DEVTOOLS_ENDPOINT_NAME,
      transport: 'tcp',
      provider_port: DEVTOOLS_PROVIDER_PORT,
      host: endpoint.host,
      port: endpoint.port,
    };
    // The producer is required to emit canonical bytes. Reject alternate key
    // order and unrecognized fields rather than accepting a look-alike line.
    if (encoded !== JSON.stringify(canonical)) continue;
    return Object.freeze(canonical);
  }
  return null;
}

export async function resolveDevtoolsWsFromExternalEndpoint(endpoint, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const base = endpointBaseUrl(endpoint && endpoint.host, endpoint && endpoint.port);
  const response = await fetchImpl(new URL('json/version', base).href, { method: 'GET', credentials: 'omit' });
  if (!response || !response.ok) throw new Error('external provider DevTools version endpoint was not available');
  const payload = await response.json();
  const value = payload && payload.webSocketDebuggerUrl;
  if (typeof value !== 'string') throw new Error('external provider DevTools version endpoint omitted webSocketDebuggerUrl');
  let ws;
  try { ws = new URL(value); } catch { throw new Error('external provider returned an invalid DevTools websocket URL'); }
  if ((ws.protocol !== 'ws:' && ws.protocol !== 'wss:') || ws.hostname !== base.hostname || ws.port !== base.port) {
    throw new Error('external provider returned a DevTools websocket outside its admitted endpoint');
  }
  return ws.href;
}

// ---------------------------------------------------------------------------
// Cdp — ONE WebSocket, flatten mode. Replies routed by id; target-scoped events
// routed to the BrowserConnection's eventSink (which dispatches by sessionId).
// CDP method names are a fixed wire protocol (Physics), not user-extensible —
// handling them by name is protocol decoding, not a Society enum.
// ---------------------------------------------------------------------------
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.eventSink = null; this.ws = null; }
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('cdp websocket error: ' + this.url));
      ws.onclose = () => { if (typeof this.onClose === 'function') { try { this.onClose(); } catch {} } };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error))); else p.resolve(m.result);
          return;
        }
        if (m.method && this.eventSink) { try { this.eventSink(m.method, m.params, m.sessionId); } catch {} }
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = (this.id += 1);
    const msg = sessionId ? { id, method, params, sessionId } : { id, method, params };
    try { this.ws.send(JSON.stringify(msg)); } catch (e) { return Promise.reject(e); }
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws && this.ws.close(); } catch {} }
}

// ---------------------------------------------------------------------------
// browserConnection — ref-counted shared Chrome process + one Cdp socket.
// ---------------------------------------------------------------------------
const RETIRED_PROCESS_CONFIG_FIELDS = new Set([
  'chromePath',
  'profileDir',
  'sandbox_profile',
  'capture_stdout',
  'capture_stderr',
  'executionKind',
]);

function requireDirectRuntimeAlias(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
  ) {
    throw new TypeError('browserRuntimeAlias must be a direct registered runtime alias');
  }
  return value;
}

function requirePortableRelativeDirectory(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new TypeError('browserProfileDirectory must be a portable contained relative directory');
  }
  return value;
}

export function buildBrowserProcessSessionStartRequest(config, origin) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('browser process-session config must be an object');
  }
  for (const field of RETIRED_PROCESS_CONFIG_FIELDS) {
    if (Object.hasOwn(config, field)) {
      throw new TypeError(`browser process-session config contains retired field: ${field}`);
    }
  }
  const browserRuntimeAlias = requireDirectRuntimeAlias(config.browserRuntimeAlias);
  const browserPrivateVolume = requireDirectRuntimeAlias(config.browserPrivateVolume);
  const profile = requirePortableRelativeDirectory(config.browserProfileDirectory);
  if (!Number.isSafeInteger(config.sessionTimeoutMs) || config.sessionTimeoutMs <= 0) {
    throw new TypeError('sessionTimeoutMs must be a positive exact integer');
  }
  if (!config.realnessModes || typeof config.realnessModes !== 'object') {
    throw new TypeError('realnessModes must be a mode-to-argv producer map');
  }
  const modeProducer = config.realnessModes[config.realness];
  if (typeof modeProducer !== 'function') {
    throw new TypeError(`realness mode is not registered: ${String(config.realness)}`);
  }
  const mode = modeProducer(config);
  if (
    !Array.isArray(mode)
    || mode.some((argument) => (
      typeof argument !== 'string'
      || argument.length === 0
      || argument.includes('\0')
    ))
  ) {
    throw new TypeError('realness mode must produce nonempty NUL-free argv strings');
  }
  const userDataDirectoryArgumentIndex = 4 + mode.length;
  const diskCacheDirectoryArgumentIndex = userDataDirectoryArgumentIndex + 1;
  return {
    operation: 'start_session',
    descriptor: {
      process: {
        argv: [browserRuntimeAlias, ...mode, `--remote-debugging-address=0.0.0.0`, `--remote-debugging-port=${DEVTOOLS_PROVIDER_PORT}`, `--remote-allow-origins=${origin}`, `--user-data-dir=${profile}`, `--disk-cache-dir=${profile}/cache`, '--no-first-run', '--no-default-browser-check', '--disable-sync', ...(config.muteAudio ? ['--mute-audio'] : []), '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-blink-features=AutomationControlled', '--disable-features=CalculateNativeWinOcclusion', 'about:blank'],
        cwd: null, timeout_ms: config.sessionTimeoutMs, termination_grace_ms: 5_000,
        expected_termination: null, env: {}, inputs: [], input_trees: [], outputs: [],
        private_volume: { name: browserPrivateVolume },
        network_access: 'allowed',
        containment: { kind: 'descendant_effect_contained' },
        capture_fds: [1, 2], collected_files: [],
      },
      workspace_bindings: {
        environment: [
          { key: 'HOME', parts: [{ kind: 'workspace_root' }] },
          { key: 'TMPDIR', parts: [{ kind: 'workspace_root' }] },
        ],
        arguments: [
          { index: userDataDirectoryArgumentIndex, parts: [{ kind: 'literal', value: '--user-data-dir=' }, { kind: 'workspace_path', segments: [profile] }] },
          { index: diskCacheDirectoryArgumentIndex, parts: [{ kind: 'literal', value: '--disk-cache-dir=' }, { kind: 'workspace_path', segments: [profile, 'cache'] }] },
        ],
      },
      session_settings: { text_grid: null },
      surface_isolation_publication: {
        provider_id: 'browsing-surface-provider',
        runtime_alias: browserRuntimeAlias,
        maximum_lifetime_ms: TASK_SURFACE_OBSERVATION_LIFETIME_MS,
      },
    },
  };
}

const browserConnection = {
  transport: null,
  cdp: null,
  sessionId: null,        // process_session id (OS process)
  surfaceObservationPublisherToken: null, // unpersisted native capability, realm memory only
  bootPromise: null,
  cleanupPromise: null,
  cleanupRequired: false,
  refCount: 0,
  disposeTimer: null,
  pagesBySession: new Map(), // CDP target sessionId (string) → SurfacePage

  async _boot() {
    const origin = (globalThis.location && globalThis.location.origin) || 'http://127.0.0.1:3012';
    const startReplyBytes = await this.transport.invoke(
      PROCESS_SESSION_TARGET,
      enc(JSON.stringify(buildBrowserProcessSessionStartRequest(CONFIG, origin))),
    );
    const startReply = JSON.parse(dec(startReplyBytes));
    if (startReply.result !== 'session_started' || !startReply.snapshot) {
      throw new Error('process_session start failed: ' + (startReply.reason || JSON.stringify(startReply).slice(0, 200)));
    }
    this.sessionId = startReply.session_id;
    this.surfaceObservationPublisherToken = typeof startReply.surface_observation_publisher_token === 'string'
      ? startReply.surface_observation_publisher_token
      : null;
    const feedAddress = startReply.snapshot.event_feed_address;
    report({ ev: 'browser_started', sessionId: this.sessionId });
    let wsUrl;
    try {
      wsUrl = await this._acquireDevtoolsWs(feedAddress);
    } catch (e) {
      // ws discovery failed — Chrome's "DevTools listening on ws://" line is read back THROUGH
      // the engine feed, which lags when the engine is saturated. The Chrome process is ALIVE
      // and may hold the profile SingletonLock. If we leave it, the next boot can spawn a 2nd Chrome
      // that collides on --user-data-dir and can NEVER acquire its ws → permanent spiral +
      // orphan pileup. End this session NOW so the lock releases and the next boot is clean.
      // (L055: this orphan-lock spiral is the DEEPEST root of the "permanently blocked" symptom.)
      const sid = this.sessionId; this.sessionId = null;
      this.surfaceObservationPublisherToken = null;
      try { if (sid) await this.transport.invoke(PROCESS_SESSION_TARGET, enc(JSON.stringify({ operation: 'append_session_command', session_id: sid, command: { kind: 'end_session' } }))); } catch {}
      report({ ev: 'browser_boot_failed_session_ended', error: String(e) });
      throw e;
    }
    report({ ev: 'devtools_ws', ws: wsUrl });
    this.cdp = new Cdp(wsUrl);
    this.cdp.eventSink = (method, params, sessionId) => {
      if (!sessionId) {
        // Browser-level events (no per-target session). A surface window the user closed
        // destroys ONLY its target — self-heal that one surface instead of freezing it.
        if (method === 'Target.targetDestroyed' || method === 'Target.targetCrashed') {
          this._onTargetGone(params && params.targetId);
        }
        return;
      }
      const page = this.pagesBySession.get(sessionId);
      if (page) page.handleEvent(method, params);
    };
    this.cdp.onClose = () => {
      void this._onConnectionLost().catch((error) => {
        report({ ev: 'browser_connection_cleanup_refused', error: String(error) });
      });
    };
    await this.cdp.open();
    // Emit Target.targetDestroyed/targetCrashed so a closed/crashed surface window self-heals.
    try { await this.cdp.send('Target.setDiscoverTargets', { discover: true }); } catch {}
    return this.cdp;
  },

  async acquire() {
    if (this.cleanupPromise) await this.cleanupPromise;
    if (this.cleanupRequired) await this._onConnectionLost();
    this.refCount += 1;
    if (this.disposeTimer) { clearTimeout(this.disposeTimer); this.disposeTimer = null; }
    if (this.cdp) return this.cdp;
    if (!this.bootPromise) {
      this.bootPromise = this._boot().catch((e) => { this.bootPromise = null; this.refCount = Math.max(0, this.refCount - 1); throw e; });
    }
    return this.bootPromise;
  },

  release() {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount > 0) return;
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = setTimeout(() => {
      this.disposeTimer = null;
      if (this.refCount === 0) {
        void this._dispose().catch((error) => {
          report({ ev: 'browser_dispose_cleanup_refused', error: String(error) });
        });
      }
    }, CONFIG.browserGraceMs);
  },

  async _dispose() {
    const cdp = this.cdp;
    if (cdp) cdp.onClose = null;
    await this._onConnectionLost({ resetSurfaces: false, event: 'browser_disposed' });
    try { if (cdp) cdp.close(); } catch {}
  },

  // Realm teardown: the browser's lifetime is BOUND to the provider realm (lifecycle =
  // app-state). Dispose NOW — ignore ref-count and grace — so the selected profile's
  // SingletonLock can release before the next realm mount. Without this, Chrome can keep
  // the lock and the next boot collides
  // on the shared --user-data-dir. Handles the boot-in-flight race (dispose once it lands)
  // so the owner receives an end-session request even when boot races teardown. Native
  // descendant reaping is enforced and proven by the process-session owner, not this realm.
  forceDispose() {
    if (this.disposeTimer) { clearTimeout(this.disposeTimer); this.disposeTimer = null; }
    this.refCount = 0;
    if (this.bootPromise && !this.cdp) return this.bootPromise.then(() => this._dispose());
    if (this.cdp || this.sessionId || this.cleanupRequired) return this._dispose();
    return Promise.resolve();
  },

  // The browser died (crash or external kill): drop the stale connection so the
  // NEXT acquire re-boots a fresh browser, and reset surfaces so they re-create.
  _onConnectionLost({ resetSurfaces = true, event = 'browser_connection_lost' } = {}) {
    if (this.cleanupPromise) return this.cleanupPromise;
    if (this.disposeTimer) { clearTimeout(this.disposeTimer); this.disposeTimer = null; }
    const sid = this.sessionId;
    const pages = [...this.pagesBySession.values()];
    this.cleanupRequired = true;
    this.cdp = null; this.bootPromise = null; this.refCount = 0;
    const cleanup = (async () => {
      for (const page of pages) {
        if (page._pendingIsolationPublication) {
          const retryRequest = JSON.parse(page._pendingIsolationPublication.requestIdentity);
          await page.publishTaskSurfaceIsolation(retryRequest, retryRequest.surface_key);
        }
        await page._revokePublishedIsolation();
      }
      if (sid) {
        const endReplyBytes = await this.transport.invoke(
          PROCESS_SESSION_TARGET,
          enc(JSON.stringify({ operation: 'append_session_command', session_id: sid, command: { kind: 'end_session' } })),
        );
        const endReply = JSON.parse(dec(endReplyBytes));
        if (endReply?.result !== 'command_accepted' || endReply.session_id !== sid) {
          throw new Error('process-session did not accept lost-browser termination');
        }
        let terminalConfirmed = false;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const readReplyBytes = await this.transport.invoke(
            PROCESS_SESSION_TARGET,
            enc(JSON.stringify({ operation: 'read_session', session_id: sid })),
          );
          const readReply = JSON.parse(dec(readReplyBytes));
          if (readReply?.result === 'session_read'
            && readReply.session_id === sid
            && readReply.snapshot?.state !== 'running'
            && (readReply.snapshot?.surface_isolation_observations === undefined
              || (Array.isArray(readReply.snapshot.surface_isolation_observations)
                && readReply.snapshot.surface_isolation_observations.length === 0))) {
            terminalConfirmed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!terminalConfirmed) {
          throw new Error('lost browser process did not confirm isolation cleanup');
        }
      }
      this.sessionId = null;
      this.surfaceObservationPublisherToken = null;
      this.pagesBySession.clear();
      for (const page of pages) { try { page.markLost(); } catch {} }
      if (resetSurfaces) surfacePool.reset();
      else { surfacePool.entries.clear(); surfacePool.activeView = null; }
      this.cleanupRequired = false;
      report({ ev: event });
    })();
    this.cleanupPromise = cleanup.then(
      () => { this.cleanupPromise = null; },
      (error) => {
        this.cleanupPromise = null;
        throw error;
      },
    );
    return this.cleanupPromise;
  },

  // ONE surface's window/target closed or crashed while the browser PROCESS stayed alive
  // (so `_onConnectionLost` did NOT fire). Self-heal just that surface so its frame keeps
  // mirroring instead of freezing — the whole point: closing a backing window is a non-event.
  _onTargetGone(targetId) {
    if (!targetId) return;
    for (const page of this.pagesBySession.values()) {
      if (page.targetId === targetId) { void page._recover(); return; }
    }
  },

  _acquireDevtoolsWs(feedAddress) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (url) => { if (!done) { done = true; cleanup(); resolve(url); } };
      const fail = (e) => { if (!done) { done = true; cleanup(); reject(e); } };
      let endpointResolutionPending = false;
      const scan = (text) => {
        // Execution authority is host DATA. The package consumes either exact
        // owner output contract without selecting, guessing, or falling back
        // between native and external execution modes.
        const match = text && text.match(/DevTools listening on (ws:\/\/[^\s"']+)/);
        if (match) { finish(match[1]); return; }
        const endpoint = parseExternalProcessEndpointLine(text);
        if (endpoint && !endpointResolutionPending) {
          endpointResolutionPending = true;
          void resolveDevtoolsWsFromExternalEndpoint(endpoint)
            .then(finish)
            .catch((error) => {
              endpointResolutionPending = false;
              report({ ev: 'external_devtools_endpoint_unavailable', error: String(error) });
            });
        }
      };
      let unsub = null;
      try {
        if (typeof this.transport.onAddressByteSegmentUpdate === 'function') {
          unsub = this.transport.onAddressByteSegmentUpdate(feedAddress, (frameBytes, offset, length) => scan(decodeFeedOutputText(frameBytes.slice(offset, offset + length))));
        }
      } catch {}
      const poll = async () => {
        if (done) return;
        for (const partition of [undefined, 'bitfield-studio']) {
          try {
            const req = { operation_label: READ_CURRENT_OP, address_label: feedAddress };
            if (partition) req.partition_label = partition;
            const replyBytes = await this.transport.invoke(LABEL_ADDRESSED_TARGET, enc(JSON.stringify(req)));
            const reply = JSON.parse(dec(replyBytes));
            if (reply && reply.found && reply.payload_base64) { scan(decodeFeedOutputText(base64ToBytes(reply.payload_base64))); break; }
          } catch {}
        }
      };
      const interval = setInterval(poll, 250);
      const timeout = setTimeout(() => fail(new Error('timed out acquiring DevTools ws')), 20000);
      const cleanup = () => { clearInterval(interval); clearTimeout(timeout); if (typeof unsub === 'function') { try { unsub(); } catch {} } };
      poll();
    });
  },
};

// Generic Fullscreen → fill-the-viewport shim, injected into every document. An off-screen real
// browser that honors a page's HTML5 fullscreen request is forced ONTO a display by the OS (the
// user suddenly sees raw Chrome). For an embedded/screencast browser the correct meaning of
// "fullscreen" is "fill the embedded viewport" (which the screencast captures), NOT "take over a
// physical screen". This remaps requestFullscreen/exitFullscreen to expand the target element to
// the layout viewport and satisfies fullscreenElement + fullscreenchange so standard player UIs
// (YouTube and any spec-compliant player) behave correctly. Site-agnostic (Physics), no OS window
// ever changes state, so the genuine browser stays invisible even during fullscreen video.
const VIEWPORT_FULLSCREEN_SHIM = `(() => {
  if (window.__bfFullscreenShim) return; window.__bfFullscreenShim = 1;
  var doc = document, current = null, STYLE_ID = '__bf_fs_style__';
  function ensureStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    var s = doc.createElement('style'); s.id = STYLE_ID;
    s.textContent = '.__bf_fs_fill__{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;max-width:100vw!important;max-height:100vh!important;margin:0!important;padding:0!important;z-index:2147483647!important;background:#000!important;}';
    (doc.head || doc.documentElement).appendChild(s);
  }
  function emit() {
    try { doc.dispatchEvent(new Event('fullscreenchange', { bubbles: true })); } catch (e) {}
    try { doc.dispatchEvent(new Event('webkitfullscreenchange', { bubbles: true })); } catch (e) {}
  }
  function setFull(el) {
    ensureStyle();
    if (current && current !== el) { try { current.classList.remove('__bf_fs_fill__'); } catch (e) {} }
    current = el || null;
    if (current) { try { current.classList.add('__bf_fs_fill__'); } catch (e) {} }
    emit();
  }
  function def(name, get) { try { Object.defineProperty(doc, name, { configurable: true, get: get }); } catch (e) {} }
  def('fullscreenElement', function () { return current; });
  def('webkitFullscreenElement', function () { return current; });
  def('fullscreenEnabled', function () { return true; });
  def('webkitFullscreenEnabled', function () { return true; });
  try { Element.prototype.requestFullscreen = function () { setFull(this); return Promise.resolve(); }; } catch (e) {}
  try { Element.prototype.webkitRequestFullscreen = function () { setFull(this); }; } catch (e) {}
  try { Element.prototype.webkitRequestFullScreen = function () { setFull(this); }; } catch (e) {}
  try { doc.exitFullscreen = function () { setFull(null); return Promise.resolve(); }; } catch (e) {}
  try { doc.webkitExitFullscreen = function () { setFull(null); }; } catch (e) {}
})();`;

// ---------------------------------------------------------------------------
// SurfacePage — ONE page target inside the shared browser. Owns its own CDP
// session, screencast, viewport, input, navigation. Disposed via closeTarget.
// ---------------------------------------------------------------------------
class SurfacePage {
  constructor(opts = {}) {
    this.onRawFrame = opts.onRawFrame || (() => {});
    this.onNavigated = opts.onNavigated || (() => {});
    this.onLoad = opts.onLoad || (() => {});
    this.onError = opts.onError || (() => {});
    this.cssW = Math.max(1, Math.round(opts.cssW || 1280));
    this.cssH = Math.max(1, Math.round(opts.cssH || 800));
    this.dpr = Math.max(1, opts.dpr || 1);
    this.cdp = null;
    this.targetId = null;
    this.sessionId = null;   // CDP target session (string)
    this.disposed = false;
    this.lastMetadata = null;
    this.currentUrl = '';
    this.lastFrameB64 = null;
    this._screencastFresh = false; // set true on each screencast frame; poll self-suppresses when true
    this._pollTimer = null;  // captureScreenshot poll for when this surface is backgrounded
    this._captureLoop = null; // capture-loop frame source timer (headless: the sole sharp source)
    this.windowId = null;    // CDP browser window id for this surface (off-screen bounds enforcement)
    this._offscreenTimer = null; // re-asserts off-screen window bounds (OS/page can move a real window)
    this._recovering = false;    // guards _recover() re-entrancy (per-target self-heal)
    this._surfaceReady = false;  // true only after the entire exact target setup completes
    this._spatialCaptureTail = Promise.resolve(); // serializes evidence capture on this target
    this._isolationBinding = null; // immutable first task/bootstrap binding for this surface
    this._publishedIsolationBinding = null; // exact current native snapshot binding
    this._pendingIsolationPublication = null; // exact retry bytes after a lost acknowledgement
    this._isolationLifecycle = 0;  // changes whenever the exact target/session changes or ends
  }

  async start() {
    this.cdp = await browserConnection.acquire();
    await this._createTarget();
  }

  // A surface's target died while the browser PROCESS lived — the user closed ITS window
  // (each surface is its own OS window; closing one destroys only that target and does NOT
  // close the CDP socket, so the whole-browser `_onConnectionLost` recovery never fires).
  // Rebuild the target in place: same SurfacePage, same view set, a fresh off-screen window,
  // restored URL — so the frame transparently resumes instead of freezing on a dead target
  // (where every resize/click/scroll silently hits nothing). Reuses the live browser CDP, so
  // it never re-`acquire()`s (no refcount leak).
  async _recover() {
    if (this.disposed || this._recovering) return;
    this._recovering = true;
    try {
      await this._revokePublishedIsolation();
    } catch (e) {
      this._recovering = false;
      report({ ev: 'surface_recovery_refused_before_isolation_revocation', error: String(e) });
      throw e;
    }
    const url = this.currentUrl;
    if (this.sessionId) { try { browserConnection.pagesBySession.delete(this.sessionId); } catch {} }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._offscreenTimer) { clearInterval(this._offscreenTimer); this._offscreenTimer = null; }
    this._surfaceReady = false;
    this.sessionId = null; this.targetId = null; this.windowId = null; this.currentUrl = '';
    this.cdp = browserConnection.cdp;
    if (!this.cdp) { this._recovering = false; return; } // whole browser is gone → _onConnectionLost owns it
    report({ ev: 'surface_recovering', url });
    try {
      await this._createTarget();
      if (url) await this.navigate(url);
      report({ ev: 'surface_recovered', target: this.targetId, url });
    } catch (e) { report({ ev: 'surface_recover_failed', error: String(e) }); }
    this._recovering = false;
  }

  async _createTarget() {
    this._surfaceReady = false;
    // newWindow: each surface gets its OWN browser window. Chrome only PRODUCES
    // continuous screencast frames for a foreground/composited page (true in both
    // realness modes); tabs sharing one window leave all-but-one backgrounded → blank.
    // One window per surface makes every surface independently composited → N live views at once.
    const created = await this.cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    this.targetId = created.targetId;
    const attached = await this.cdp.send('Target.attachToTarget', { targetId: this.targetId, flatten: true });
    this.sessionId = attached.sessionId;
    this._isolationLifecycle += 1;
    browserConnection.pagesBySession.set(this.sessionId, this);
    await this.cdp.send('Page.enable', {}, this.sessionId);
    // Correct the UA's "HeadlessChrome" self-disclosure token to "Chrome" — same Chromium engine,
    // driven by a human in real time (the same honest disclosure-correction class as the
    // --disable-blink-features=AutomationControlled flag, NOT a manufactured fingerprint). REQUIRED
    // for headless mode (no OS window → structurally invisible) to pass browser-security gates such
    // as Google sign-in; a no-op in headful (its UA has no "Headless" token). EMPIRICALLY VERIFIED:
    // headless + this correction renders AND passes Google's gate (prove-headless-google.mjs).
    try {
      const ver = await this.cdp.send('Browser.getVersion');
      const ua = (ver && ver.userAgent ? String(ver.userAgent) : '').replace(/Headless/gi, '');
      if (ua) await this.cdp.send('Emulation.setUserAgentOverride', { userAgent: ua }, this.sessionId);
    } catch {}
    // Force active lifecycle so a never-foregrounded surface still paints+screencasts.
    try { await this.cdp.send('Page.setWebLifecycleState', { state: 'active' }, this.sessionId); } catch {}
    // Map the Fullscreen API to fill the captured VIEWPORT instead of fullscreening the OS
    // window. A real off-screen window that honors HTML5 fullscreen is forced onto a display
    // (the user suddenly sees raw Chrome); the shim keeps the window off-screen and makes the
    // page's fullscreen element fill the surface, so fullscreen video shows IN the surface.
    try { await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: VIEWPORT_FULLSCREEN_SHIM }, this.sessionId); } catch {}
    await this._applyViewport();
    if (CONFIG.frameSource === 'capture-loop') {
      // HEADLESS-correct single source: startScreencast emits a low-res frame in headless (the
      // pulsing blur); the captureScreenshot loop is full device-pixel resolution.
      this._startCaptureLoop();
    } else {
      // HEADFUL: device-pixel screencast (60fps) + captureScreenshot backup for static/background.
      await this._startScreencast();
      this._startBackgroundPoll();
    }
    // New surface windows cascade off-screen from the launch --window-position; the Fullscreen
    // shim keeps them there. This guard is defense-in-depth for any fullscreen path the shim
    // did not intercept (it cannot reposition — macOS clamps runtime bounds on-screen).
    await this._enforceOffscreen();
    this._startOffscreenGuard();
    this._surfaceReady = true;
    report({ ev: 'surface_started', target: this.targetId });
  }

  // Background liveness: when screencast has gone idle (surface not foreground/composited),
  // pull an on-demand frame. captureScreenshot renders ANY target regardless of foreground,
  // so every surface paints. The foreground surface keeps streaming via screencast and this
  // poll self-suppresses (recent _lastFrameAt). clip = CSS box, scale = dpr → device-pixel
  // frame identical to the screencast path (same render invariant: sharp, correct aspect).
  _startBackgroundPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      if (this.disposed || !this.sessionId) return;
      if (this._screencastFresh) { this._screencastFresh = false; return; } // screencast delivered since last tick → skip
      try {
        // No clip: the viewport is already cssW×cssH at deviceScaleFactor=dpr
        // (setDeviceMetricsOverride), so a plain capture yields the device-pixel frame —
        // identical sizing to the screencast path. (Matches the proven CDP capture call.)
        const shot = await this.cdp.send('Page.captureScreenshot', {
          format: 'jpeg', quality: CONFIG.screencastQuality,
        }, this.sessionId);
        if (this.disposed) return;
        if (shot && shot.data) {
          this.lastFrameB64 = shot.data;
          const md = this.lastMetadata || { deviceWidth: this.cssW, deviceHeight: this.cssH };
          try { this.onRawFrame(shot.data, md); } catch {}
        }
      } catch {}
    }, CONFIG.backgroundPollMs);
  }

  // Capture-loop frame source (headless): ONE self-pacing Page.captureScreenshot loop. Each capture
  // honors deviceScaleFactor → device-pixel (retina) frames at the emulated viewport size — the only
  // full-res source in headless (startScreencast there is ~800px → blur). ONE source → no resolution
  // alternation → no pulsing blur. Adaptive: it awaits each capture then schedules the next, fast
  // (captureLoopMs ≈ back-to-back, ~26fps) while the page is CHANGING and slow (backgroundPollMs,
  // ~5fps) while it is STATIC — identical consecutive JPEGs are detected and not re-painted, so a
  // still page costs almost nothing while video/scroll stays smooth and sharp.
  _startCaptureLoop() {
    if (this._captureLoop) return;
    const tick = async () => {
      this._captureLoop = null;
      if (this.disposed || !this.sessionId) return;
      let changed = true;
      try {
        const shot = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: CONFIG.screencastQuality }, this.sessionId);
        if (!this.disposed && shot && shot.data) {
          changed = shot.data !== this.lastFrameB64;
          this.lastFrameB64 = shot.data;
          this.lastMetadata = { deviceWidth: this.cssW, deviceHeight: this.cssH };
          if (changed) { try { this.onRawFrame(shot.data, this.lastMetadata); } catch {} }
        }
      } catch {}
      if (this.disposed || !this.sessionId) return;
      this._captureLoop = setTimeout(tick, changed ? CONFIG.captureLoopMs : CONFIG.backgroundPollMs);
    };
    this._captureLoop = setTimeout(tick, 0);
  }

  _stopCaptureLoop() { if (this._captureLoop) { clearTimeout(this._captureLoop); this._captureLoop = null; } }

  // Off-screen invariant enforcement. A real (non-headless) browser has a real OS window; the
  // launch --window-position only places Chrome's FIRST window. Each surface is its OWN window
  // (Target.createTarget newWindow:true), and the OS or the page can later move it on-screen —
  // most visibly when a page enters HTML5 fullscreen (the window is forced onto a display and does
  // NOT return off-screen on exit), after which new windows cascade on-screen too. This positions
  // the surface's window far off-screen and re-asserts on drift, so the genuine browser is NEVER
  // visible to the user. Headless mode has no window → no-op.
  async _enforceOffscreen() {
    if (CONFIG.realness !== 'headful-offscreen' || !this.targetId || !this.cdp) return;
    try {
      const win = await this.cdp.send('Browser.getWindowForTarget', { targetId: this.targetId });
      this.windowId = win.windowId;
      // EMPIRICAL (prove-offscreen-fix.mjs, real Chrome): a NEW surface window cascades to the
      // launch --window-position (-32000) on its own, and macOS CLAMPS any runtime
      // Browser.setWindowBounds back on-screen (a request for -32000 lands at ~-1240,33 — a
      // visible sliver). So a runtime window CANNOT be pushed fully off-screen; off-screen is held
      // by PREVENTION — the Fullscreen shim stops a page from forcing its window onto a display,
      // which is the only thing that ever moved it. This guard is defense-in-depth ONLY: if a path
      // we did not intercept (e.g. a cross-process iframe) left the window fullscreen/maximized,
      // drop it back to a normal window (better than a visible takeover). It NEVER fights position
      // (futile) and leaves 'minimized' alone (un-minimizing would make the window visible).
      const state = win.bounds && win.bounds.windowState;
      if (state && state !== 'normal' && state !== 'minimized') {
        try { await this.cdp.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { windowState: 'normal' } }); } catch {}
      }
    } catch {}
  }

  _startOffscreenGuard() {
    if (this._offscreenTimer || CONFIG.realness !== 'headful-offscreen') return;
    this._offscreenTimer = setInterval(() => {
      if (this.disposed || !this.sessionId) return;
      void this._enforceOffscreen();
    }, CONFIG.offscreenGuardMs);
  }

  // Routed from browserConnection.cdp.eventSink by sessionId.
  handleEvent(method, params) {
    if (method === 'Page.screencastFrame') {
      this.lastMetadata = params.metadata || this.lastMetadata;
      this._screencastFresh = true;
      try { this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, this.sessionId); } catch {}
      this.lastFrameB64 = params.data;
      try { this.onRawFrame(params.data, params.metadata); } catch {}
    } else if (method === 'Page.frameNavigated') {
      if (params && params.frame && !params.frame.parentId && params.frame.url) { this.currentUrl = params.frame.url; this.onNavigated(params.frame.url); }
    } else if (method === 'Page.navigatedWithinDocument') {
      if (params && params.url) { this.currentUrl = params.url; this.onNavigated(params.url); }
    } else if (method === 'Page.loadEventFired') {
      try { this.onLoad(); } catch {}
    } else if (method === 'Inspector.detached') {
      // This surface's OWN CDP session detached → its target is gone (window closed / renderer
      // crash). Defense-in-depth alongside browser-level Target.targetDestroyed: self-heal unless
      // we deliberately disposed it (dispose() sets disposed before closeTarget, so no false heal).
      if (!this.disposed) void this._recover();
    }
  }

  // RENDER INVARIANT: viewport = CSS box, deviceScaleFactor = dpr → page lays out
  // at cssW×cssH (correct responsive layout) and renders at cssW*dpr×cssH*dpr.
  async _applyViewport() {
    try {
      await this.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: this.cssW, height: this.cssH, deviceScaleFactor: this.dpr, mobile: false,
        screenWidth: this.cssW, screenHeight: this.cssH,
      }, this.sessionId);
    } catch {}
  }

  async _startScreencast() {
    // maxWidth/maxHeight in DEVICE pixels so the frame is captured at full
    // resolution (no downscale → retina sharp). Frame aspect = cssW:cssH = box aspect.
    try {
      await this.cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: CONFIG.screencastQuality,
        maxWidth: Math.round(this.cssW * this.dpr), maxHeight: Math.round(this.cssH * this.dpr), everyNthFrame: 1,
      }, this.sessionId);
    } catch {}
  }

  async navigate(url) {
    if (!this.sessionId || !url || url === this.currentUrl) return;
    this.currentUrl = url;
    report({ ev: 'navigate', target: this.targetId, url });
    try { await this.cdp.send('Page.navigate', { url }, this.sessionId); } catch (e) { this.onError(String(e)); }
  }
  async reload() { if (this.sessionId) { try { await this.cdp.send('Page.reload', {}, this.sessionId); } catch {} } }
  async back() {
    if (!this.sessionId) return;
    try { const h = await this.cdp.send('Page.getNavigationHistory', {}, this.sessionId);
      if (h.currentIndex > 0) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id }, this.sessionId); } catch {}
  }
  async forward() {
    if (!this.sessionId) return;
    try { const h = await this.cdp.send('Page.getNavigationHistory', {}, this.sessionId);
      if (h.currentIndex < h.entries.length - 1) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex + 1].id }, this.sessionId); } catch {}
  }

  // Browser truth capture uses THIS surface's existing CDP target/session. Captures
  // serialize so DOM/layout/style/resource/screenshot evidence from concurrent agent
  // requests cannot interleave on one target. The capture leaf owns CDP shapes; this
  // page only supplies its already-authoritative identity and viewport.
  captureSpatialSource(request) {
    const capture = async () => {
      if (this.disposed || !this.cdp || !this.sessionId) throw new Error('browsing surface is not active');
      const result = await captureDomSnapshot(this.cdp, this.sessionId, request, CONFIG.spatialCapturePolicy, {
        url: this.currentUrl,
        targetId: this.targetId,
        cssW: this.cssW,
        cssH: this.cssH,
        dpr: this.dpr,
      });
      report({
        ev: 'spatial_source_captured',
        target: this.targetId,
        documentCount: result.snapshot.documents.length,
        matchedStyleCount: result.matched_styles.length,
        resourceCount: result.resources.length,
      });
      return result;
    };
    const pending = this._spatialCaptureTail.then(capture, capture);
    this._spatialCaptureTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  // Produce current machine-checkable isolation evidence for THIS exact surface.
  // The first successful caller binds the page to one task/bootstrap identity for
  // its lifetime. Later callers cannot relabel the same authenticated surface.
  // This owner attests only its own headless CDP surface; it never speaks for Aside
  // or any other provider/session.
  async observeTaskSurfaceIsolation(request, surfaceKey) {
    requireExactKeys(request, [
      'bootstrap_identity', 'expected_process_session_id', 'provider_id',
      'runtime_alias', 'surface_key', 'task_ref',
    ], 'task surface observation request');
    const requestedSurfaceKey = requireBoundedIdentity(request.surface_key, 'surface_key', 128);
    if (requestedSurfaceKey !== surfaceKey) throw new Error('task surface identity mismatch');
    const taskRef = requireBoundedIdentity(request.task_ref, 'task_ref');
    if (!SHA256_ID.test(request.bootstrap_identity ?? '')) throw new TypeError('bootstrap_identity must be a sha256 identity');
    if (request.provider_id !== 'browsing-surface-provider') throw new Error('provider identity mismatch');
    if (request.runtime_alias !== CONFIG.browserRuntimeAlias) throw new Error('runtime alias mismatch');
    if (CONFIG.realness !== 'headless-new') throw new Error('task surface is not structurally separate from personal displays');

    const processSessionId = requireBoundedIdentity(browserConnection.sessionId, 'process_session_id', 128);
    if (request.expected_process_session_id !== processSessionId) throw new Error('process session identity mismatch');
    if (this.disposed || this._recovering || !this._surfaceReady || !this.cdp || this.cdp !== browserConnection.cdp) {
      throw new Error('task surface is not active');
    }
    const targetId = requireBoundedIdentity(this.targetId, 'target_id', 128);
    const providerSessionId = requireBoundedIdentity(this.sessionId, 'provider_session_id', 128);
    if (browserConnection.pagesBySession.get(providerSessionId) !== this) throw new Error('task surface session is not current');

    const binding = Object.freeze({
      bootstrap_identity: request.bootstrap_identity,
      task_ref: taskRef,
      process_session_id: processSessionId,
      surface_key: requestedSurfaceKey,
    });
    if (this._isolationBinding) {
      for (const [key, value] of Object.entries(binding)) {
        if (this._isolationBinding[key] !== value) throw new Error('task surface is already bound to a different task');
      }
    }

    const lifecycle = this._isolationLifecycle;
    const [targetReply, frameReply] = await Promise.all([
      this.cdp.send('Target.getTargetInfo', { targetId }),
      this.cdp.send('Page.getFrameTree', {}, providerSessionId),
    ]);
    const targetInfo = targetReply && targetReply.targetInfo;
    const rootFrame = frameReply && frameReply.frameTree && frameReply.frameTree.frame;
    if (!targetInfo || targetInfo.targetId !== targetId || targetInfo.type !== 'page' || targetInfo.attached !== true) {
      throw new Error('task surface target is not current');
    }
    const frameId = requireBoundedIdentity(rootFrame && rootFrame.id, 'page_frame_id', 128);
    if (this.disposed || this._recovering || !this._surfaceReady || lifecycle !== this._isolationLifecycle
      || this.targetId !== targetId || this.sessionId !== providerSessionId
      || this.cdp !== browserConnection.cdp || browserConnection.sessionId !== processSessionId
      || browserConnection.pagesBySession.get(providerSessionId) !== this) {
      throw new Error('task surface changed while it was being observed');
    }
    const observedAtMs = Date.now();
    if (!Number.isSafeInteger(observedAtMs)) throw new Error('task surface observation time is unavailable');
    // Bind only after every live owner read and the owner clock succeed. A
    // failed or forged first request must not poison the surface for its
    // legitimate task. Concurrent first observations converge here; only the
    // first exact binding wins.
    if (this._isolationBinding) {
      for (const [key, value] of Object.entries(binding)) {
        if (this._isolationBinding[key] !== value) throw new Error('task surface is already bound to a different task');
      }
    } else {
      this._isolationBinding = binding;
    }

    const surfaceIdentity = `cdp-surface:${requestedSurfaceKey}:${targetId}`;
    const pageIdentity = `cdp-page:${targetId}:${frameId}`;
    return {
      kind: TASK_SURFACE_OBSERVATION_KIND,
      version: 1,
      bootstrap_identity: binding.bootstrap_identity,
      task_ref: binding.task_ref,
      provider_id: request.provider_id,
      runtime_alias: request.runtime_alias,
      process_session_id: processSessionId,
      provider_session_id: providerSessionId,
      lifecycle_state: 'active',
      lifecycle_revision: `cdp-lifecycle:${processSessionId}:${targetId}:${providerSessionId}:${lifecycle}`,
      revoked: false,
      observed_at_ms: observedAtMs,
      valid_until_ms: observedAtMs + TASK_SURFACE_OBSERVATION_LIFETIME_MS,
      surface_identity: surfaceIdentity,
      page_identity: pageIdentity,
      pointer_identity: `cdp-pointer:${providerSessionId}`,
      keyboard_identity: `cdp-keyboard:${providerSessionId}`,
      input_focus_identity: `cdp-focus:${providerSessionId}:${frameId}`,
      independent_pointer: true,
      independent_keyboard: true,
      visible_on_personal_display: false,
    };
  }

  async publishTaskSurfaceIsolation(request, surfaceKey) {
    const publisherToken = requireBoundedIdentity(
      browserConnection.surfaceObservationPublisherToken,
      'surface_observation_publisher_token',
      128,
    );
    const requestIdentity = JSON.stringify(request);
    if (this._pendingIsolationPublication
      && this._pendingIsolationPublication.requestIdentity !== requestIdentity) {
      throw new Error('a different task surface publication is still unresolved');
    }
    const observation = this._pendingIsolationPublication?.observation
      || await this.observeTaskSurfaceIsolation(request, surfaceKey);
    if (!this._pendingIsolationPublication) {
      this._pendingIsolationPublication = Object.freeze({ requestIdentity, observation });
    }
    const replyBytes = await browserConnection.transport.invoke(
      PROCESS_SESSION_TARGET,
      enc(JSON.stringify({
        operation: 'publish_surface_isolation_observation',
        session_id: observation.process_session_id,
        publisher_token: publisherToken,
        observation,
      })),
    );
    const reply = JSON.parse(dec(replyBytes));
    const binding = reply && reply.binding;
    if (reply?.result !== 'surface_isolation_observation_published'
      || reply.session_id !== observation.process_session_id
      || !binding
      || binding.bootstrap_identity !== observation.bootstrap_identity
      || binding.task_ref !== observation.task_ref
      || binding.provider_session_id !== observation.provider_session_id
      || binding.lifecycle_revision !== observation.lifecycle_revision
      || binding.valid_until_ms !== observation.valid_until_ms
      || typeof binding.observation_ref !== 'string'
      || typeof binding.observation_hash !== 'string'
      || !Array.isArray(reply.snapshot?.surface_isolation_observations)
      || !reply.snapshot.surface_isolation_observations.some((candidate) => (
        candidate.bootstrap_identity === binding.bootstrap_identity
        && candidate.task_ref === binding.task_ref
        && candidate.provider_session_id === binding.provider_session_id
        && candidate.lifecycle_revision === binding.lifecycle_revision
        && candidate.observation_ref === binding.observation_ref
        && candidate.observation_hash === binding.observation_hash
        && candidate.valid_until_ms === binding.valid_until_ms
      ))) {
      throw new Error('process-session returned a mismatched surface isolation publication');
    }
    this._publishedIsolationBinding = Object.freeze({ ...binding });
    this._pendingIsolationPublication = null;
    const acceptedAtMs = Date.now();
    if (!Number.isSafeInteger(acceptedAtMs) || binding.valid_until_ms < acceptedAtMs) {
      await this._revokePublishedIsolation();
      throw new Error('surface isolation publication expired before acknowledgement');
    }
    if (this.disposed || this._recovering || this.sessionId !== observation.provider_session_id
      || browserConnection.sessionId !== observation.process_session_id) {
      await this._revokePublishedIsolation();
      throw new Error('task surface changed before its isolation publication completed');
    }
    return { observation, binding: this._publishedIsolationBinding };
  }

  async _revokePublishedIsolation() {
    const binding = this._publishedIsolationBinding;
    if (!binding && this._pendingIsolationPublication) {
      throw new Error('surface isolation publication outcome is unresolved');
    }
    if (!binding) return;
    const processSessionId = requireBoundedIdentity(browserConnection.sessionId, 'process_session_id', 128);
    const publisherToken = requireBoundedIdentity(
      browserConnection.surfaceObservationPublisherToken,
      'surface_observation_publisher_token',
      128,
    );
    const replyBytes = await browserConnection.transport.invoke(
      PROCESS_SESSION_TARGET,
      enc(JSON.stringify({
        operation: 'revoke_surface_isolation_observation',
        session_id: processSessionId,
        publisher_token: publisherToken,
        bootstrap_identity: binding.bootstrap_identity,
        lifecycle_revision: binding.lifecycle_revision,
      })),
    );
    const reply = JSON.parse(dec(replyBytes));
    if (reply?.result !== 'surface_isolation_observation_revoked'
      || reply.session_id !== processSessionId
      || reply.bootstrap_identity !== binding.bootstrap_identity
      || !Array.isArray(reply.snapshot?.surface_isolation_observations)
      || reply.snapshot.surface_isolation_observations.some(
        (candidate) => candidate.bootstrap_identity === binding.bootstrap_identity,
      )) {
      throw new Error('process-session did not confirm surface isolation revocation');
    }
    this._publishedIsolationBinding = null;
  }

  mouse(type, x, y, button, clickCount) { if (this.sessionId) { try { this.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: button || 'none', clickCount: clickCount || 0 }, this.sessionId); } catch {} } }
  wheel(x, y, deltaX, deltaY) { if (this.sessionId) { try { this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }, this.sessionId); } catch {} } }
  key(type, e) {
    if (!this.sessionId) return;
    const text = (type === 'keyDown' && e.key && e.key.length === 1) ? e.key : undefined;
    try { this.cdp.send('Input.dispatchKeyEvent', { type, key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode || 0, nativeVirtualKeyCode: e.keyCode || 0, text }, this.sessionId); } catch {}
  }

  async resize(cssW, cssH, dpr) {
    const w = Math.max(1, Math.round(cssW)), h = Math.max(1, Math.round(cssH)), d = Math.max(1, dpr || this.dpr);
    if (w === this.cssW && h === this.cssH && d === this.dpr) return; // no-op: size unchanged
    this.cssW = w; this.cssH = h; this.dpr = d;
    if (!this.sessionId) return;
    await this._applyViewport();
    if (CONFIG.frameSource === 'screencast') {
      // Restart the screencast clean so the NEW device-pixel caps take effect — re-issuing
      // startScreencast without stopping does not reliably update maxWidth/maxHeight. (Capture-loop
      // needs no restart: it reads the current viewport on its next tick.)
      try { await this.cdp.send('Page.stopScreencast', {}, this.sessionId); } catch {}
      await this._startScreencast();
    }
    // Force one frame at the new size NOW: the frame source is time-paced, so a STATIC page may
    // emit no frame on a viewport change and the surface would keep the old-size frame until
    // something repaints (the "resize does nothing" symptom). captureScreenshot renders on
    // demand → the surface refits instantly on every drag, even on a frozen/static page.
    try {
      const shot = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: CONFIG.screencastQuality }, this.sessionId);
      if (shot && shot.data && !this.disposed) { this.lastFrameB64 = shot.data; const md = this.lastMetadata || { deviceWidth: this.cssW, deviceHeight: this.cssH }; try { this.onRawFrame(shot.data, md); } catch {} }
    } catch {}
  }

  markLost() { this.disposed = true; this._surfaceReady = false; this._isolationLifecycle += 1; this._publishedIsolationBinding = null; this._pendingIsolationPublication = null; this.sessionId = null; this.targetId = null; if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; } if (this._offscreenTimer) { clearInterval(this._offscreenTimer); this._offscreenTimer = null; } this._stopCaptureLoop(); }

  async dispose() {
    if (this.disposed) return;
    await this._revokePublishedIsolation();
    this.disposed = true;
    this._surfaceReady = false;
    this._isolationLifecycle += 1;
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._offscreenTimer) { clearInterval(this._offscreenTimer); this._offscreenTimer = null; }
    this._stopCaptureLoop();
    if (this.sessionId) browserConnection.pagesBySession.delete(this.sessionId);
    try { if (this.sessionId) await this.cdp.send('Page.stopScreencast', {}, this.sessionId); } catch {}
    try { if (this.targetId) await this.cdp.send('Target.closeTarget', { targetId: this.targetId }); } catch {}
    browserConnection.release();
    report({ ev: 'surface_disposed', target: this.targetId });
  }
}

// ---------------------------------------------------------------------------
// surfacePool — Map<surfaceKey, entry>. N keys → N isolated SurfacePages.
// ---------------------------------------------------------------------------
const surfacePool = {
  entries: new Map(), // surfaceKey → {page, views:Set, disposeTimer}
  activeView: null,   // most-recently-focused element (drives global nav contract)

  async acquire(view, key, transport, src, geom) {
    browserConnection.transport = transport;
    let entry = this.entries.get(key);
    if (entry) {
      if (entry.disposeTimer) { clearTimeout(entry.disposeTimer); entry.disposeTimer = null; }
      entry.views.add(view);
    } else {
      entry = { page: null, views: new Set([view]), disposeTimer: null };
      this.entries.set(key, entry);
      const page = new SurfacePage({
        cssW: geom.cssW, cssH: geom.cssH, dpr: geom.dpr,
        onRawFrame: (b64, md) => { for (const v of entry.views) { try { v._enqueueFrame(b64, md); } catch {} } },
        // Identity-scoped: tag the nav with the surface that produced it (view._surfaceKey),
        // so a consumer only reacts to ITS OWN surface — N panes never couple (L063).
        onNavigated: (url) => { for (const v of entry.views) { try { v._onNavigated(url); } catch {} } notifyNav(url, view); },
        onLoad: () => { for (const v of entry.views) { try { v._signalLoad(); } catch {} } },
        onError: () => { for (const v of entry.views) { try { v.dispatchEvent(new Event('error', { bubbles: true })); } catch {} } },
      });
      entry.page = page;
      try { await page.start(); if (src) await page.navigate(src); }
      catch (e) {
        report({ ev: 'surface_acquire_failed', error: String(e) });
        // Un-poison: a transient acquire failure must NOT leave a dead entry in the map. The
        // reuse path (`if (entry)`) never re-runs start(), so a poisoned entry blocks EVERY
        // future retry for this key. Drop it (and the half-started page) so the next _attach()
        // rebuilds a fresh page. (L063: kill the whole category, not the one instance.)
        try { page.markLost(); } catch {}
        this.entries.delete(key);
        try { view.dispatchEvent(new Event('error', { bubbles: true })); } catch {}
        return null;
      }
    }
    // Reuse path: navigate if needed + replay last frame so the view paints instantly.
    if (entry.page) {
      if (src) { try { await entry.page.navigate(src); } catch {} }
      if (entry.page.lastFrameB64) { try { view._enqueueFrame(entry.page.lastFrameB64, entry.page.lastMetadata); } catch {} }
    }
    return entry.page;
  },

  release(view) {
    for (const [key, entry] of this.entries) {
      if (!entry.views.has(view)) continue;
      entry.views.delete(view);
      if (entry.views.size === 0) {
        if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
        entry.disposeTimer = setTimeout(() => {
          const e = this.entries.get(key);
          if (e && e.views.size === 0) { this.entries.delete(key); if (e.page) void e.page.dispose(); }
        }, CONFIG.surfaceGraceMs);
      }
      break;
    }
    if (this.activeView === view) this.activeView = null;
  },

  pageForView(view) { for (const entry of this.entries.values()) { if (entry.views.has(view)) return entry.page; } return null; },
  activePage() { return (this.activeView && this.pageForView(this.activeView)) || null; },

  // Browser died: forget all surfaces, then re-attach still-mounted views against
  // a fresh browser (each keeps its stable surfaceKey, so it re-creates its page).
  reset() {
    const views = [];
    for (const entry of this.entries.values()) { if (entry.disposeTimer) clearTimeout(entry.disposeTimer); for (const v of entry.views) views.push(v); }
    this.entries.clear();
    for (const v of views) { try { if (v.isConnected) void v._attach(); } catch {} }
  },
};

// Navigation events are IDENTITY-SCOPED: every event carries the surfaceKey of the
// surface that navigated. The listener set is shared (one global surface object), but
// each consumer filters to its own surfaceKey, so a load/navigation on pane B can never
// move pane A. This is the structural elimination of cross-pane URL coupling (L063):
// without identity, N panes all heard every nav and converged on the last url.
const navListeners = new Set();
function notifyNav(url, view) { const surfaceKey = (view && view._surfaceKey) || null; for (const l of navListeners) { try { l({ url, surfaceKey }); } catch {} } }

// ---------------------------------------------------------------------------
// The custom element web-frame instantiates: a per-surface VIEW.
// ---------------------------------------------------------------------------
let surfaceCounter = 0;

// Surface identity ladder (L083 maximally-capable default, stable across remount):
//  1. 'surface-key' attribute — a per-surface id the consumer owns (best; explicit per-tab).
//  2. FRAME-CONTAINER identity — the element's persistent parent (e.g. web-frame's
//     `frame-content` div). The consumer re-keys the embed element on every url change
//     (web-frame: key=`${displayUrl}::${reloadNonce}`), so the element itself is NOT a
//     stable per-frame anchor — but its PARENT container persists for the life of the
//     pane. Anchoring identity there makes each pane its OWN surface (two panes at the
//     SAME url are still two independent surfaces — the property url-origin keying could
//     NOT provide) while in-frame navigation (the element remounts under the same parent)
//     reuses the surface and just navigates — zero reload churn, including cross-origin.
//  3. URL origin — fallback when the element has no element parent (detached mount).
//  4. per-element token — last resort when nothing else is available.
function originKeyOf(url) { try { return url ? ('origin:' + new URL(url).origin) : null; } catch { return null; } }

// frameContainerKeyOf — the L069 per-frame identity primitive. The persistent parent
// container is tagged once with a unique id and reused across the embed element's
// url-change remounts. Distinct panes → distinct containers → distinct surfaces;
// same pane across navigation → same container → one reused surface.
function frameContainerKeyOf(el) {
  try {
    const parent = el && el.parentNode;
    if (!parent || parent.nodeType !== 1) return null;
    if (!parent.__bfFrameSurfaceId) parent.__bfFrameSurfaceId = 'frame#' + (++surfaceCounter);
    return parent.__bfFrameSurfaceId;
  } catch { return null; }
}

function defineSurfaceElement() {
  if (typeof customElements === 'undefined' || customElements.get(SURFACE_TAG)) return;

  class BitfieldBrowsingSurface extends HTMLElement {
    static get observedAttributes() { return ['src']; }
    constructor() {
      super();
      this._booted = false; this._canvas = null; this._ctx = null; this._loadSignaled = false;
      this._domLoadDispatched = false;
      this._surfaceKey = null; this._pendingFrame = null; this._rafPending = false;
    }

    // Load delivery must be CONTINUOUS, not single-shot. _signalLoad runs on every painted
    // frame. A single bridge call left panes stuck "loading": the call fired once, then the
    // web-frame's watchdog effect re-ran setFrameLoadState("loading") and nothing re-asserted
    // "loaded". So call the CURRENTLY-parked React onLoad on every paint — React re-parks the
    // fresh handleFrameLoad closure each render (so browserFrameBlocked is always current),
    // and setFrameLoadState dedupes identical values (no re-render spam). This self-heals any
    // reset and is the true "loaded" proof for a screencast: the surface is visibly painting.
    _signalLoad() {
      this._loadSignaled = true;
      if (this._domLoadDispatched !== true) { this._domLoadDispatched = true; try { this.dispatchEvent(new Event('load', { bubbles: true })); } catch {} }
      try {
        const k = Object.keys(this).find((x) => x.startsWith('__reactProps$'));
        const props = k ? this[k] : null;
        if (props && typeof props.onLoad === 'function') props.onLoad({ type: 'load', target: this, currentTarget: this });
      } catch {}
    }

    // Per-surface navigation → dispatch a DOM event the consumer can listen to
    // per-element (true multi-surface URL bars; web-frame opt-in via MSR-7).
    _onNavigated(url) { try { this.dispatchEvent(new CustomEvent('bitfieldnavigate', { detail: { url }, bubbles: true })); } catch {} }

    connectedCallback() {
      if (this._booted) return;
      this._booted = true;
      // Fill the pane. THE resize bug: the element only had `display:block`, so its WIDTH
      // filled the parent but its HEIGHT was auto (content-driven by the canvas) → dragging
      // the pane never changed the element box → the canvas never rescaled and ResizeObserver
      // never fired → "resize is static, does nothing". Filling the container makes the surface
      // track the pane: the canvas (100% of the element, object-fit:contain) refits on every drag,
      // and ResizeObserver fires to re-capture a crisp frame at the new size.
      this.style.display = 'block';
      this.style.width = '100%'; this.style.height = '100%'; this.style.boxSizing = 'border-box';
      this.tabIndex = 0;
      const canvas = document.createElement('canvas');
      // object-fit: contain makes aspect distortion STRUCTURALLY IMPOSSIBLE. The backing
      // store is the device-pixel frame; its aspect = the viewport (element box) at capture
      // time. When the box matches the frame (steady state) contain fills exactly — no
      // letterbox. If the box drifts from the frame (resize/load lag, or a host that lays out
      // at a different aspect than the capture), contain SCALES TO FIT preserving aspect
      // instead of stretching ("skinny in weird ways"). No environment can distort the page.
      canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.display = 'block'; canvas.style.outline = 'none'; canvas.style.objectFit = 'contain';
      this.appendChild(canvas);
      this._canvas = canvas; this._ctx = canvas.getContext('2d');
      // surfaceKey: an explicit per-frame id from the consumer (web-frame passes a
      // stable per-instance `surface-key`), else a per-ELEMENT token. Because the
      // consumer now keeps the embed element STABLE across navigation (no url-keyed
      // remount), this per-element token is itself stable → each pane is exactly ONE
      // surface for its whole life. NO url-origin keying: that collapsed two panes
      // showing the same site into one shared surface (the independence bug).
      this._surfaceKey = this.getAttribute('surface-key') || this._ownToken || (this._ownToken = 'bf-el-' + (++surfaceCounter));
      this._bindInput(); this._observeResize();
      void this._attach();
    }
    disconnectedCallback() { if (this._attachRetryTimer) { clearTimeout(this._attachRetryTimer); this._attachRetryTimer = null; } surfacePool.release(this); }
    attributeChangedCallback(name, _old, value) { if (name === 'src' && value) { const p = surfacePool.pageForView(this); if (p) void p.navigate(value); } }

    _geom() {
      // Prefer the element box; if it's degenerate (e.g. a parent with auto height collapsed
      // the element), fall back to the parent pane's box so the surface still tracks the real
      // pane size. Take the larger non-zero of each dimension to be safe.
      let rect = this.getBoundingClientRect();
      const parent = this.parentElement;
      const prect = parent && parent.getBoundingClientRect ? parent.getBoundingClientRect() : null;
      const pick = (a, b, dflt) => { const m = Math.max(a || 0, (prect ? b : 0) || 0); return m > 1 ? m : dflt; };
      const cssW = pick(rect.width, prect && prect.width, 1280);
      const cssH = pick(rect.height, prect && prect.height, 800);
      return { cssW, cssH, dpr: (globalThis.devicePixelRatio || 1) };
    }

    async _attach() {
      try {
        const hooks = globalThis.__BITFIELD_BOOT_HOOKS__;
        if (!hooks || typeof hooks.connect !== 'function') throw new Error('no Bitfield boot hooks in realm');
        const { transport } = await hooks.connect();
        const src = this.getAttribute('src') || '';
        report({ ev: 'element_attach', key: this._surfaceKey, src });
        const page = await surfacePool.acquire(this, this._surfaceKey, transport, src, this._geom());
        if (!page) { this._scheduleAttachRetry('acquire-null'); return; }
        this._attachRetryMs = 0; // success → reset backoff
      } catch (e) {
        report({ ev: 'element_attach_failed', error: String(e) });
        try { this.dispatchEvent(new Event('error', { bubbles: true })); } catch {}
        this._scheduleAttachRetry('attach-threw');
      }
    }

    // Self-heal: surface acquisition can fail transiently (Chrome's DevTools ws line is read
    // back THROUGH the engine feed, which lags when the engine is saturated). A single failed
    // attach must not strand the pane on the error overlay — retry with capped backoff so the
    // surface paints itself the moment a calm window appears, with ZERO user action (L083).
    _scheduleAttachRetry(reason) {
      if (!this.isConnected) return;        // element removed → stop retrying
      if (this._attachRetryTimer) return;   // exactly one retry in flight
      const next = Math.min(Math.max(this._attachRetryMs || 0, 1200) * 1.6, 15000);
      this._attachRetryMs = next;
      report({ ev: 'element_attach_retry', key: this._surfaceKey, reason, inMs: Math.round(next) });
      this._attachRetryTimer = setTimeout(() => { this._attachRetryTimer = null; void this._attach(); }, next);
    }

    // rAF coalescing: store latest frame, paint once per animation frame.
    _enqueueFrame(b64, md) {
      this._pendingFrame = { b64, md };
      if (this._rafPending) return;
      this._rafPending = true;
      const raf = globalThis.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
      raf(() => { this._rafPending = false; const f = this._pendingFrame; this._pendingFrame = null; if (f) void this._paint(f.b64); });
    }

    async _paint(b64) {
      try {
        const bytes = base64ToBytes(b64);
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        // Backing store = device-pixel frame (retina sharp). CSS box = element box
        // (canvas style 100%). Frame aspect = box aspect → no stretch.
        if (this._canvas.width !== bmp.width || this._canvas.height !== bmp.height) { this._canvas.width = bmp.width; this._canvas.height = bmp.height; }
        this._ctx.drawImage(bmp, 0, 0, this._canvas.width, this._canvas.height);
        bmp.close();
        this._signalLoad();
      } catch {}
    }

    _pagePoint(e) {
      const page = surfacePool.pageForView(this);
      const md = page && page.lastMetadata;
      const rect = this._canvas.getBoundingClientRect();
      const nx = rect.width ? (e.clientX - rect.left) / rect.width : 0;
      const ny = rect.height ? (e.clientY - rect.top) / rect.height : 0;
      // metadata.deviceWidth/Height are DIP (CSS px) → correct Input coords under DPR>1.
      const w = (md && md.deviceWidth) || (page && page.cssW) || 1280;
      const h = (md && md.deviceHeight) || (page && page.cssH) || 800;
      return { x: nx * w, y: ny * h, page };
    }

    _bindInput() {
      const el = this._canvas;
      const focus = () => { surfacePool.activeView = this; };
      el.addEventListener('mousedown', (e) => { this.focus(); focus(); const p = this._pagePoint(e); p.page && p.page.mouse('mousePressed', p.x, p.y, 'left', 1); e.preventDefault(); });
      el.addEventListener('mouseup', (e) => { const p = this._pagePoint(e); p.page && p.page.mouse('mouseReleased', p.x, p.y, 'left', 1); });
      el.addEventListener('mousemove', (e) => { const p = this._pagePoint(e); p.page && p.page.mouse('mouseMoved', p.x, p.y, 'none', 0); });
      el.addEventListener('wheel', (e) => { const p = this._pagePoint(e); p.page && p.page.wheel(p.x, p.y, e.deltaX, e.deltaY); e.preventDefault(); }, { passive: false });
      this.addEventListener('keydown', (e) => { const p = surfacePool.pageForView(this); p && p.key('keyDown', e); });
      this.addEventListener('keyup', (e) => { const p = surfacePool.pageForView(this); p && p.key('keyUp', e); });
    }

    _observeResize() {
      try {
        if (typeof ResizeObserver === 'undefined') return;
        let t = null;
        const onResize = () => { clearTimeout(t); t = setTimeout(() => { const p = surfacePool.pageForView(this); const g = this._geom(); if (p) { report({ ev: 'surface_resize', key: this._surfaceKey, cssW: g.cssW, cssH: g.cssH }); void p.resize(g.cssW, g.cssH, g.dpr); } }, 80); };
        const ro = new ResizeObserver(onResize);
        ro.observe(this);
        // Also observe the PANE (parent): a pane-drag changes the parent box; observing only
        // the element misses it if the element box doesn't reflow. Either signal triggers resize.
        if (this.parentElement) { try { ro.observe(this.parentElement); } catch {} }
        this._resizeObserver = ro;
      } catch {}
    }
  }

  customElements.define(SURFACE_TAG, BitfieldBrowsingSurface);
}

function installBrowsingSurface() {
  defineSurfaceElement();
  globalThis.__BITFIELD_BROWSING_SURFACE__ = {
    mode: 'native-browsing-surface',
    elementTag: SURFACE_TAG,
    navigation: {
      back: () => { try { const p = surfacePool.activePage(); p && p.back(); } catch {} },
      forward: () => { try { const p = surfacePool.activePage(); p && p.forward(); } catch {} },
      reload: () => { try { const p = surfacePool.activePage(); p && p.reload(); } catch {} },
    },
    capture: {
      spatialSource: async (request) => {
        const key = request && request.surface_key;
        const hasExplicitKey = typeof key === 'string';
        const entry = hasExplicitKey ? surfacePool.entries.get(key) : null;
        if (hasExplicitKey && (!entry || !entry.page)) throw new Error('requested browsing surface is not active');
        const page = (entry && entry.page) || surfacePool.activePage();
        if (!page) throw new Error('no active browsing surface for capture');
        return page.captureSpatialSource(request);
      },
    },
    isolation: {
      observeTaskSurface: async (request) => {
        const key = request && request.surface_key;
        if (typeof key !== 'string') throw new Error('an exact browsing surface is required');
        const entry = surfacePool.entries.get(key);
        if (!entry || !entry.page) throw new Error('requested browsing surface is not active');
        return entry.page.observeTaskSurfaceIsolation(request, key);
      },
    },
    events: { listenNavigation: (l) => { navListeners.add(l); return () => navListeners.delete(l); } },
    __provider: 'bitfield-browsing-surface-provider',
  };
  try { globalThis.dispatchEvent(new Event(READY_EVENT)); } catch {}
}

export default function putOnScreen(context) {
  try { const el = context && (context.el || (context.screenPlace && context.screenPlace.element)); if (el && el.style) el.style.display = 'none'; } catch {}
  installBrowsingSurface();
  report({ ev: 'provider_mounted', surface: globalThis.__BITFIELD_BROWSING_SURFACE__ && globalThis.__BITFIELD_BROWSING_SURFACE__.elementTag });
  // Realm teardown cleanup: lifecycle = app-state. Stop every surface's background
  // activity, drop the global API, and request browser/session disposal. Durable profile
  // identity and descendant reaping remain native-owner contracts.
  return () => {
    try { for (const entry of surfacePool.entries.values()) { if (entry.disposeTimer) clearTimeout(entry.disposeTimer); } } catch {}
    try { navListeners.clear(); } catch {}
    try { delete globalThis.__BITFIELD_BROWSING_SURFACE__; } catch {}
    try {
      void browserConnection.forceDispose().catch((error) => {
        report({ ev: 'browser_dispose_cleanup_refused', error: String(error) });
      });
    } catch {}
    report({ ev: 'provider_unmounted' });
  };
}
