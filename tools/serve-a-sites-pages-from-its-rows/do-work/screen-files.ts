// tools/serve-a-sites-pages-from-its-rows/do-work/screen-files.ts
//
// PURPOSE
//   The built files a page's browser loads (its mount script, its stylesheet and the font and picture files the shared looks
//   name) are kept by their BLAKE3 identity and served at /screen-files/<identity>.<kind>. The same bytes are always the same address, so a browser keeps a file for good and a page
//   changed by its rows names new files.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An address is the BLAKE3 of the exact bytes it answers (the content-identity owner's hash), so it cannot answer other bytes.
//   2. Only bytes this program built are answered; any other address under the prefix is 404.
//   3. Nothing is written to disk: the files live as long as the program, and are built again from the same sources after a start.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

export const SCREEN_FILES = '/screen-files/';

const TYPES = {
  js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
} as const;
export type ScreenFileKind = keyof typeof TYPES;

/** The kind a file name's ending names, or null when it is not a kind kept here. */
export function kindOf(name: string): ScreenFileKind | null {
  const ending = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ending in TYPES ? ending as ScreenFileKind : null;
}

export interface Answer {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

export class ScreenFiles {
  #files = new Map<string, { bytes: Buffer; kind: ScreenFileKind }>();

  /** Keeps the bytes and answers the address they are served at. */
  keep(bytes: Buffer | string, kind: ScreenFileKind): string {
    const kept = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    const identity: string = makeHashCodeHexFromBytes(kept);
    this.#files.set(`${identity}.${kind}`, { bytes: kept, kind });
    return `${SCREEN_FILES}${identity}.${kind}`;
  }

  /** The answer for a path under /screen-files/, or null for any other path. */
  answer(pathname: string): Answer | null {
    if (!pathname.startsWith(SCREEN_FILES)) return null;
    const file = this.#files.get(pathname.slice(SCREEN_FILES.length));
    if (!file) return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'No such screen file.\n' };
    return {
      status: 200,
      headers: { 'content-type': TYPES[file.kind], 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' },
      body: file.bytes,
    };
  }
}
