// parts/receive-a-camera-stream/do-work/capabilities/relay-to-an-address.mjs
//
// Purpose: the destination capability that passes a camera's stream on, unchanged, to another service's ingest
// address (any RTMP or RTMPS server: Cloudflare Stream, YouTube, a friend's server). The destination row's `address`
// is the server address; its `key` names the saved login (Saved logins, Connections) whose value is the stream key.
//
// Non-Negotiable Invariants:
//   1. The service's key is read from the person's Saved logins (read_saved_login, only when they let their AIs read
//      that login) each time a relay starts, held only in memory, and never written to a row or a log.
//   2. A destination whose key cannot be read is not ready, and its row says which login to keep and how.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { programIn, takeAStream } from '../take-a-stream.mjs';

const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
/** The saved login a row's `key` cell names: the words inside quotes, or the whole cell. */
export const loginNamed = cell => (/"([^"]+)"/.exec(String(cell ?? ''))?.[1] ?? String(cell ?? '').replace(/^Saved logins:\s*/i, '')).trim();

/** The stream key kept in the saved login the row names, or null with why. */
export async function keyFor({ ctx, row }) {
  const title = loginNamed(row.values.key);
  if (!title || !row.values.address) return { key: null, why: fill(ctx.settings.words.no_key, { address: row.values.address ?? '', login: title || row.values.name }) };
  try {
    const listed = await ctx.call('list_saved_logins', {});
    const login = (listed.logins ?? listed.saved_logins ?? []).find(item => item.title === title);
    const read = login ? await ctx.call('read_saved_login', { login_id: login.login_id ?? login.id }) : null;
    const fields = read?.fields ?? read?.login?.fields ?? [];
    const key = fields.find(field => /key/i.test(field.label))?.value ?? fields[0]?.value ?? null;
    return key ? { key } : { key: null, why: fill(ctx.settings.words.no_key, { address: row.values.address, login: title }) };
  } catch {
    return { key: null, why: fill(ctx.settings.words.no_key, { address: row.values.address, login: title }) };
  }
}

export const available = ({ settings }) => Boolean(programIn(settings.ffmpeg.search_path, settings.ffmpeg.program));

export async function ready({ ctx, row }) {
  if (!available(ctx)) return { ready: false, why: ctx.settings.words.no_ffmpeg };
  const { key, why } = await keyFor({ ctx, row });
  return key ? { ready: true } : { ready: false, why };
}

/** Start passing `camera`'s stream on `port` (taken with `key`) to the row's address. Returns { stop() }. */
export async function start({ ctx, row, port, key, onState = () => {} }) {
  const { settings, say } = ctx;
  const ffmpeg = programIn(settings.ffmpeg.search_path, settings.ffmpeg.program);
  const service = await keyFor({ ctx, row });
  if (!service.key) { onState({ why: service.why }); return { stop() {} }; }
  const target = `${String(row.values.address).replace(/\/$/, '')}/${service.key}`;
  const state = { since: null };
  const listener = takeAStream({
    ffmpeg, port, app: settings.listen.app, key, say,
    output: ['-c', 'copy', '-f', 'flv', target],
    onStarted: () => { state.since = new Date(); onState({ relaying: true, ...state }); },
    onRefused: async () => { say('cut off a stream sent with another key'); onState({ refused: new Date() }); },
    onEnded: async () => onState({ relaying: false, ...state }),
  });
  return { stop: () => listener.stop() };
}
