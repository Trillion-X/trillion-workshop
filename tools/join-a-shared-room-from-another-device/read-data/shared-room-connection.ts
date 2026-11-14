export interface SharedRoomLocation {
  readonly origin: string;
  readonly pathname?: string;
}

export interface SharedRoomOpenLinks {
  readonly browserUrl: string;
  readonly appUrl: string | null;
  readonly browserHostIsLoopback: boolean;
}

export function makeSharedRoomOpenLinks(input: {
  readonly routePath?: string;
  readonly location?: SharedRoomLocation | null;
  readonly browserBaseUrl?: string | null;
  readonly appScene?: unknown;
}): SharedRoomOpenLinks {
  const browserUrl = input.browserBaseUrl
    ? browserUrlForBase(input.routePath, input.browserBaseUrl)
    : browserUrlForRoute(input.routePath, input.location);
  return {
    browserUrl,
    appUrl: input.appScene === undefined ? null : bitfieldOpenUrlForScene(input.appScene),
    browserHostIsLoopback: isLoopbackUrl(browserUrl),
  };
}

export function browserUrlForBase(routePath: string | undefined, baseUrl: string): string {
  const route = normalizeRoutePath(routePath ?? '/');
  return new URL(route, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

export function browserUrlForRoute(
  routePath?: string,
  location: SharedRoomLocation | null = currentLocation(),
): string {
  const route = normalizeRoutePath(routePath ?? location?.pathname ?? '/');
  const origin = normalizeOrigin(location?.origin ?? '');
  return origin ? `${origin}${route}` : route;
}

export function bitfieldOpenUrlForScene(scene: unknown): string {
  return `bitfield://open?screen_scene=${base64UrlEncode(JSON.stringify(scene))}`;
}

export function screenArrangementScene(): Record<string, unknown> {
  return {
    id: 'open-screen-arrangement',
    props: {
      things_to_put_on_screen: [
        {
          source_path: 'packages/screen-arrangement/show-ios-jscore/mount-screen-arrangement-jscore.js',
          required_capabilities: [
            'can-put-thing-on-screen-using-screen-commands',
          ],
          lifecycle_key: 'component:screen-arrangement:jscore',
          props: {
            entry_function: 'bitfieldMount',
          },
        },
      ],
    },
  };
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value, 'http://placeholder.invalid');
    return url.hostname === '127.0.0.1'
      || url.hostname === 'localhost'
      || url.hostname === '::1'
      || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

function currentLocation(): SharedRoomLocation | null {
  if (typeof window === 'undefined') return null;
  return window.location;
}

function normalizeOrigin(value: string): string {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : '';
}

function normalizeRoutePath(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    : bufferBase64(bytes);
  return base64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function bufferBase64(bytes: Uint8Array): string {
  const buffer = (globalThis as unknown as { Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (!buffer) throw new Error('base64 encoder unavailable');
  return buffer.from(bytes).toString('base64');
}
