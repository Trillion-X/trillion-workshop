// A file a buyer receives from a paid Marketplace tool run, made traceable to its sale (src/sold-copies.json).
//
// A run is a sale when its tool is billed to a seller other than Trillion itself (the row publish_tool writes with a
// usage price). Each file it keeps in the buyer's Files gets the sale's note added where its type has a carrier, so
// every buyer's copy has its own content identity; settling the sale records those identities with an opaque buyer
// tag in the shared pool (src/pool.mjs), and the seller asks tool_sales which sale a leaked file or note came from.
// The note is overt: it names the sale, never the buyer, and anyone may read it.
import SOLD from '../../keep-and-wake-ai-sessions-on-this-computer/src/sold-copies.json' with { type: 'json' };

export const SOLD_COPIES = SOLD;
const encoder = new TextEncoder();
const IDENTITY = /^1f:[0-9a-f]{64}$/;

/** The sale a run is, or null: its task id when the tool is billed to a seller other than Trillion. */
export const saleOf = ({ tool, task }) => (typeof tool?.billing?.seller === 'string' && tool.billing.seller && tool.billing.seller !== 'platform' && typeof task?.task_id === 'string' ? task.task_id : null);

export const soldNote = ({ sale, tool_id }) => SOLD.note.replace('{sale}', sale).replace('{tool}', tool_id);

/** The bytes a file of this type carries at its end for the note, or null when no carrier is listed for it. */
export function carrierBytes(mediaType, note) {
  const type = String(mediaType ?? '').split(';')[0].trim().toLowerCase();
  const carrier = SOLD.carriers.find(row => row.media_types.includes(type));
  if (!carrier) return null;
  const pieces = carrier.parts.map(part => (part.note ? encoder.encode(note) : part.text !== undefined ? encoder.encode(part.text) : new Uint8Array(4)));
  const total = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  carrier.parts.forEach((part, index) => {
    if (part.length === 'u32be') new DataView(bytes.buffer).setUint32(at, total);
    else bytes.set(pieces[index], at);
    at += pieces[index].byteLength;
  });
  return bytes;
}

/** A kept file's opener and size with the sale's note added at its end, when its type has a carrier. */
export function withSoldNote({ open, size, media_type }, note) {
  const tail = carrierBytes(media_type, note);
  if (!tail) return { open, size, noted: false };
  return {
    size: size + tail.byteLength,
    noted: true,
    open: async () => {
      const body = await open();
      const source = body instanceof ReadableStream ? body : new Response(body).body;
      return source.pipeThrough(new TransformStream({ flush: controller => controller.enqueue(tail) }));
    },
  };
}

/** Every content identity a run's output names, so the sale records the files it delivered. */
export function deliveredIdentities(output) {
  const found = new Set();
  const walk = (value, depth) => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (typeof value.identity === 'string' && IDENTITY.test(value.identity)) found.add(value.identity);
    for (const item of Array.isArray(value) ? value : Object.values(value)) walk(item, depth + 1);
  };
  walk(output?.files ?? null, 0);
  return [...found].slice(0, 200);
}

/** What the seller asks: a delivered file's identity, or the sale id its note names. */
export function traceAsk({ file, sale } = {}) {
  if (typeof file === 'string' && IDENTITY.test(file)) return { file };
  if (typeof sale === 'string' && /^[A-Za-z0-9_:.-]{1,120}$/.test(sale)) return { sale };
  return null;
}
