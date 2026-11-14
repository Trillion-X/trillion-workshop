// src/workspace/put-sizes-on-board.ts
//
// PURPOSE
//   A page (a site's draft, an original project's running preview, one of the person's own Trillion screens) put on a
//   space's board at every editor size, as frames the space's members review together: each size is drawn, kept as a
//   picture, and shared into the space with a frame item saying where it was drawn from, so the board shows it as a
//   card at the page's own shape (comments, votes and share links come with every card) and can draw it again.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A frame is DATA in the space: an item of kind FRAME_KIND whose body is { picture, draw, width, height }:
//      `picture` the drawn file's identity, `draw` the /work/api address that draws it again (answering
//      { status, image_base64, height }), `width` and `height` its size in pixels. Nothing here names a kind of page.
//   2. The frame item is added before its picture is shared, so a board placing the picture already knows its frame.
//   3. A draw address is this service's own /work/api address; a frame naming anything else is not a frame.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import breakpoints from '../../parts/ui/show/public-app-editor/breakpoints.json';
import { readJson } from './api';
import { openScreenOn } from './open-screen';
import { uploadFiles } from './upload';

export const FRAME_KIND = 'frame';
export type BoardSpace = { space_id: string; title: string };
export type Frame = { picture: string; draw: string; width: number; height: number };
/** One size as the service drew it. */
export type DrawnSize = { status: string; image_base64?: string; height?: number; reason?: string };

const spaceAt = (spaceId: string, rest: string) => `/work/api/spaces/${encodeURIComponent(spaceId)}${rest}`;
const isSize = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

/** The frame a space item's body describes, or null (invariant 1 and 3). */
export function frameOf(body: unknown): Frame | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { picture, draw, width, height } = body as Record<string, unknown>;
  if (typeof picture !== 'string' || typeof draw !== 'string' || !draw.startsWith('/work/api/') || !isSize(width) || !isSize(height)) return null;
  return { picture, draw, width, height };
}

/** Draws `draw` once and puts it in `spaceId` as a frame named `title` (invariant 2): the frame and its shared item.
 *  `beforeShare(identity)` runs once the picture is kept and before it is shared. */
export async function drawFrame({ spaceId, folder, title, draw, width, beforeShare = async () => {} }: {
  spaceId: string; folder: string; title: string; draw: string; width: number; beforeShare?: (identity: string) => Promise<void>;
}) {
  const drawn = await readJson<DrawnSize>(draw);
  if (drawn.status !== 'ready' || !drawn.image_base64) throw new Error(drawn.reason ?? `${title} could not be drawn.`);
  const bytes = Uint8Array.from(atob(drawn.image_base64), letter => letter.charCodeAt(0));
  const [kept] = await uploadFiles([new File([bytes], `${title}.png`, { type: 'image/png', lastModified: Date.now() })], folder);
  if (!kept) throw new Error(`${title} could not be kept.`);
  const frame: Frame = { picture: kept.identity, draw, width, height: isSize(drawn.height) ? drawn.height : width };
  await readJson(spaceAt(spaceId, '/items'), { method: 'POST', body: JSON.stringify({ items: [{ kind: FRAME_KIND, title, body: frame }] }) });
  await beforeShare(kept.identity);
  const shared = await readJson<{ item_id: string }>(spaceAt(spaceId, '/share'), { method: 'POST', body: JSON.stringify({ file: kept.identity }) });
  return { frame, item_id: shared.item_id };
}

/** Puts `name` at each editor size on `space`'s board (`drawAt(width)` is the address that draws that size), then opens it. */
export async function putSizesOnBoard({ space, name, drawAt, onProgress = () => {} }: {
  space: BoardSpace; name: string; drawAt: (width: number) => string; onProgress?: (said: string) => void;
}) {
  const folder = `/Boards/${space.title.replace(/[\\/]/g, ' ').trim() || space.space_id}`;
  for (const size of breakpoints.frames) {
    onProgress(`Drawing the ${size.label.toLowerCase()} size`);
    await drawFrame({ spaceId: space.space_id, folder, title: `${name} · ${size.label}`, draw: drawAt(size.width), width: size.width });
  }
  openScreenOn('trillion.board', { space_id: space.space_id }, space.title);
}
