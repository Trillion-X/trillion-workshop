export type CapabilityPermissionState =
  | 'undetermined'
  | 'granted'
  | 'denied-by-system'
  | 'platform-unavailable';

export interface CapabilityPermissionDescriptor {
  readonly kind: 'capability-permission-requirement';
  readonly operation_ref: string;
  readonly capability_ref: string;
  readonly adapter_ref: string;
  readonly adapter_input: Record<string, unknown>;
  readonly consent: {
    readonly title: string;
    readonly explanation: string;
    readonly action_label: string;
  };
  readonly denied: {
    readonly title: string;
    readonly explanation: string;
    readonly recovery_path: string;
    readonly recovery_subject?: string;
    /** The same notice for a page open in a web browser, where the site's own setting blocks it, not the computer. */
    readonly in_browser?: { readonly explanation: string; readonly recovery_path: string };
  };
  readonly unavailable: {
    readonly title: string;
    readonly explanation: string;
  };
}

export interface CapabilityPermissionAdapter {
  probe(input: Record<string, unknown>): Promise<CapabilityPermissionState>;
  request(input: Record<string, unknown>): Promise<unknown>;
}

type StoredThing = { address?: unknown; payload?: unknown; remove?: unknown };

const adapters = new Map<string, CapabilityPermissionAdapter>();
const BROWSER_MEDIA_ADAPTER_REF = 'capability-permission-adapter:browser-media';

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function things(source: unknown): StoredThing[] {
  if (Array.isArray(source)) return source.filter((row): row is StoredThing => Boolean(object(row)));
  const record = object(source);
  return Array.isArray(record?.things)
    ? record.things.filter((row): row is StoredThing => Boolean(object(row)))
    : [];
}

function presentation(value: unknown): CapabilityPermissionDescriptor['consent'] | null {
  const source = object(value);
  const title = text(source?.title);
  const explanation = text(source?.explanation);
  const actionLabel = text(source?.action_label);
  return title && explanation && actionLabel
    ? { title, explanation, action_label: actionLabel }
    : null;
}

function notice(value: unknown): CapabilityPermissionDescriptor['denied'] | null {
  const source = object(value);
  const title = text(source?.title);
  const explanation = text(source?.explanation);
  const recoveryPath = text(source?.recovery_path);
  const recoverySubject = text(source?.recovery_subject);
  const browser = object(source?.in_browser);
  const inBrowser = text(browser?.explanation) && text(browser?.recovery_path)
    ? { explanation: text(browser?.explanation), recovery_path: text(browser?.recovery_path) }
    : undefined;
  return title && explanation
    ? { title, explanation, recovery_path: recoveryPath, recovery_subject: recoverySubject || undefined, ...(inBrowser ? { in_browser: inBrowser } : {}) }
    : null;
}

export function readCapabilityPermissionDescriptor(
  source: unknown,
  operationRef: string,
): CapabilityPermissionDescriptor | null {
  for (const thing of things(source)) {
    if (thing.remove === true) continue;
    const payload = object(thing.payload);
    if (payload?.kind !== 'capability-permission-requirement') continue;
    if (text(payload.operation_ref) !== operationRef) continue;
    const consent = presentation(payload.consent);
    const denied = notice(payload.denied);
    const unavailable = notice(payload.unavailable);
    const capabilityRef = text(payload.capability_ref);
    const adapterRef = text(payload.adapter_ref);
    const adapterInput = object(payload.adapter_input);
    if (!capabilityRef || !adapterRef || !adapterInput || !consent || !denied || !unavailable) return null;
    return {
      kind: 'capability-permission-requirement',
      operation_ref: operationRef,
      capability_ref: capabilityRef,
      adapter_ref: adapterRef,
      adapter_input: adapterInput,
      consent,
      denied,
      unavailable,
    };
  }
  return null;
}

export function registerCapabilityPermissionAdapter(
  adapterRef: string,
  adapter: CapabilityPermissionAdapter,
): () => void {
  if (!adapterRef.trim()) throw new Error('A capability permission adapter reference is required.');
  adapters.set(adapterRef, adapter);
  return () => {
    if (adapters.get(adapterRef) === adapter) adapters.delete(adapterRef);
  };
}

function storageKey(capabilityRef: string): string {
  const origin = typeof window === 'undefined' ? 'no-window' : window.location.origin;
  return `bitfield.capability-permission.granted:${origin}:${capabilityRef}`;
}

function rememberedGrant(capabilityRef: string): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(storageKey(capabilityRef)) === 'true';
  } catch {
    return false;
  }
}

function rememberGrant(capabilityRef: string): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(storageKey(capabilityRef), 'true');
  } catch {
    // The platform grant remains authoritative when storage is unavailable.
  }
}

export async function probeCapabilityPermission(
  descriptor: CapabilityPermissionDescriptor,
): Promise<CapabilityPermissionState> {
  const adapter = adapters.get(descriptor.adapter_ref);
  if (!adapter) return 'platform-unavailable';
  const state = await adapter.probe(descriptor.adapter_input);
  return state === 'undetermined' && rememberedGrant(descriptor.capability_ref) ? 'granted' : state;
}

/** Which devices a media capability opens, when not the browser's defaults: `audio` a microphone's device id (false:
 *  no sound at all, a picture only), `video` a camera's device id, `video_quality` the picture's size and rate as the
 *  browser's own track constraints (width, height, frameRate), laid over the descriptor's. */
export type DevicePick = { audio?: string | false; video?: string; video_quality?: Record<string, unknown> };

/** The descriptor's media constraints with the picked devices laid over them. */
export function pickedConstraints(constraints: Record<string, unknown> | null, pick: DevicePick): Record<string, unknown> {
  if ((pick.audio || pick.audio === false) && !constraints?.audio) throw new Error('This permission does not include a microphone.');
  if ((pick.video || pick.video_quality) && !constraints?.video) throw new Error('This permission does not include a camera.');
  const audio = pick.audio === false ? false
    : pick.audio ? { ...(object(constraints?.audio) ?? {}), deviceId: { exact: pick.audio } }
      : constraints?.audio;
  const video = pick.video || pick.video_quality
    ? { ...(object(constraints?.video) ?? {}), ...(pick.video_quality ?? {}), ...(pick.video ? { deviceId: { exact: pick.video } } : {}) }
    : constraints?.video;
  return { ...constraints, ...(audio === undefined ? {} : { audio }), ...(video === undefined ? {} : { video }) };
}

export async function requireCapabilityPermission<T = unknown>(
  descriptor: CapabilityPermissionDescriptor,
  pick?: DevicePick,
): Promise<T> {
  const adapter = adapters.get(descriptor.adapter_ref);
  if (!adapter) throw new CapabilityPermissionUnavailableError(descriptor.capability_ref);
  const configured = descriptor.adapter_input;
  const input = pick ? { ...configured, constraints: pickedConstraints(object(configured.constraints), pick) } : configured;
  try {
    const result = await adapter.request(input);
    rememberGrant(descriptor.capability_ref);
    return result as T;
  } catch (error) {
    if (isCapabilityPermissionDenied(error)) throw new CapabilityPermissionDeniedError(descriptor.capability_ref, error);
    throw error;
  }
}

export interface CapabilityPermissionRecoveryResult {
  readonly recovered: boolean;
  readonly recovery_unavailable?: string;
  readonly results?: Record<string, string>;
  readonly tcc_client_name?: string;
}

type PermissionBrokerBridge = {
  available: true;
  recoverMediaCapture(mediaTypes: string[]): Promise<Record<string, unknown>>;
};

function permissionBrokerBridge(): PermissionBrokerBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as Record<string, unknown>).__BITFIELD_PERMISSION_BROKER__;
  if (!candidate || typeof candidate !== 'object') return null;
  const bridge = candidate as Record<string, unknown>;
  if (bridge.available !== true || typeof bridge.recoverMediaCapture !== 'function') return null;
  return bridge as PermissionBrokerBridge;
}

export function capabilityPermissionRecoveryAvailable(): boolean {
  return permissionBrokerBridge() !== null;
}

/** Whether the page runs inside an app's own window (a native host registers its message handlers on
 *  window.webkit), where the computer itself grants the camera and microphone, rather than in a web browser, where
 *  each site has its own setting. */
export function runsInAppWindow(): boolean {
  if (typeof window === 'undefined') return false;
  const host = (window as unknown as { webkit?: { messageHandlers?: unknown } }).webkit;
  return Boolean(host?.messageHandlers && typeof host.messageHandlers === 'object');
}

/** The denied notice as it reads where the page runs: the browser's site setting in a browser, the computer's own
 *  setting in an app window or when no browser wording is given. */
export function deniedNoticeHere(descriptor: CapabilityPermissionDescriptor): CapabilityPermissionDescriptor['denied'] {
  const { in_browser: inBrowser, ...denied } = descriptor.denied;
  return inBrowser && !runsInAppWindow() ? { ...denied, ...inBrowser } : denied;
}

function mediaTypesFor(descriptor: CapabilityPermissionDescriptor): string[] {
  const constraints = object(descriptor.adapter_input.constraints);
  const wantsVideo = constraints?.video === true || Boolean(object(constraints?.video));
  const wantsAudio = constraints?.audio === true || Boolean(object(constraints?.audio));
  if (wantsVideo && wantsAudio) return ['audio', 'video'];
  if (wantsVideo) return ['video'];
  if (wantsAudio) return ['audio'];
  return ['audio', 'video'];
}

/**
 * Recovers an OS-level denial without any System Settings walk: the host
 * resets its own TCC entries and raises the NATIVE macOS permission sheet at
 * the point of need. Only exists inside the presenter app; plain browsers
 * report recovery_unavailable and the caller keeps its fallback copy.
 */
export async function recoverCapabilityPermission(
  descriptor: CapabilityPermissionDescriptor,
): Promise<CapabilityPermissionRecoveryResult> {
  const bridge = permissionBrokerBridge();
  if (!bridge) return { recovered: false, recovery_unavailable: 'host-recovery-bridge-not-present' };
  const reply = await bridge.recoverMediaCapture(mediaTypesFor(descriptor));
  const results = object(reply?.results) as Record<string, string> | undefined;
  const wanted = mediaTypesFor(descriptor);
  const recovered = Boolean(results) && wanted.every((key) => results?.[key] === 'granted');
  return {
    recovered,
    recovery_unavailable: text(reply?.recovery_unavailable) || undefined,
    results,
    tcc_client_name: text(reply?.tcc_client_name) || undefined,
  };
}

export class CapabilityPermissionDeniedError extends Error {
  readonly cause: unknown;
  constructor(capabilityRef: string, cause: unknown) {
    super(`Permission denied for ${capabilityRef}.`);
    this.name = 'CapabilityPermissionDeniedError';
    this.cause = cause;
  }
}

export class CapabilityPermissionUnavailableError extends Error {
  constructor(capabilityRef: string) {
    super(`Permission adapter unavailable for ${capabilityRef}.`);
    this.name = 'CapabilityPermissionUnavailableError';
  }
}

export function isCapabilityPermissionDenied(error: unknown): boolean {
  if (error instanceof CapabilityPermissionDeniedError) return true;
  if (typeof error === 'string') return /not allowed|permission denied|user denied/i.test(error);
  const candidate = object(error);
  const name = text(candidate?.name);
  const message = text(candidate?.message);
  return name === 'NotAllowedError'
    || name === 'PermissionDeniedError'
    || name === 'SecurityError'
    || /not allowed|permission denied|user denied/i.test(message);
}

type LegacyGetUserMedia = (
  constraints: MediaStreamConstraints,
  success: (stream: MediaStream) => void,
  failure: (error: unknown) => void,
) => void;

type CaptureNavigator = Navigator & Partial<Record<
  'getUserMedia' | 'webkitGetUserMedia' | 'mozGetUserMedia' | 'msGetUserMedia',
  LegacyGetUserMedia
>>;

function browserNavigator(): CaptureNavigator | null {
  return typeof navigator === 'undefined' ? null : navigator as CaptureNavigator;
}

function legacyGetUserMedia(nav: CaptureNavigator): LegacyGetUserMedia | null {
  for (const name of ['getUserMedia', 'webkitGetUserMedia', 'mozGetUserMedia', 'msGetUserMedia'] as const) {
    if (typeof nav[name] === 'function') return nav[name] as LegacyGetUserMedia;
  }
  return null;
}

async function probeBrowserMedia(input: Record<string, unknown>): Promise<CapabilityPermissionState> {
  const nav = browserNavigator();
  if (!nav || (typeof nav.mediaDevices?.getUserMedia !== 'function' && !legacyGetUserMedia(nav))) {
    return 'platform-unavailable';
  }
  const queryNames = textArray(input.query_names);
  if (!nav.permissions || typeof nav.permissions.query !== 'function' || queryNames.length === 0) return 'undetermined';
  let undetermined = false;
  for (const name of queryNames) {
    try {
      // WebKit's permission-name support is partial, so an unsupported name is unknown, not denied.
      // eslint-disable-next-line no-await-in-loop
      const status = await nav.permissions.query({ name } as PermissionDescriptor);
      if (status.state === 'denied') return 'denied-by-system';
      if (status.state !== 'granted') undetermined = true;
    } catch {
      undetermined = true;
    }
  }
  return undetermined ? 'undetermined' : 'granted';
}

async function requestBrowserMedia(input: Record<string, unknown>): Promise<MediaStream> {
  const nav = browserNavigator();
  if (!nav) {
    throw new CapabilityPermissionUnavailableError('browser-media');
  }
  const constraints = object(input.constraints);
  if (!constraints) throw new Error('Browser media permission constraints are missing.');
  if (typeof nav.mediaDevices?.getUserMedia === 'function') {
    return nav.mediaDevices.getUserMedia(constraints as MediaStreamConstraints);
  }
  const legacy = legacyGetUserMedia(nav);
  if (!legacy) throw new CapabilityPermissionUnavailableError('browser-media');
  return new Promise((resolve, reject) => {
    legacy.call(nav, constraints as MediaStreamConstraints, resolve, reject);
  });
}

registerCapabilityPermissionAdapter(BROWSER_MEDIA_ADAPTER_REF, {
  probe: probeBrowserMedia,
  request: requestBrowserMedia,
});
