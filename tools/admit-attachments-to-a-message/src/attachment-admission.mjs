// src/attachment-admission.mjs
//
// Purpose: the one pure rule for how many of the files offered with a message are admitted, and which limit bound.
// Every entry that takes attachments (the web composer through src/workspace/send-message.ts, and any other surface)
// asks this function, so each admits the same prefix and says the same reason instead of refusing in its own way.
//
// Non-negotiable invariants
//   1. Pure: the limits come in as DATA (src/attachment-admission.json plus the per-call `limits` and `daily`); nothing
//      here reads a clock, a plan or a network. `now` is given.
//   2. A file over the absolute size ceiling (or over the caller's own `max_bytes`) is left out whatever else is true.
//   3. The first files that fit min(per-turn cap, remaining daily count) are admitted, in order; the answer names the
//      limit that bound (size, per_turn or daily), with the words DATA gives it, so a surface never guesses why.
//   4. A limit that is null or absent does not bind: nothing here refuses by default.
import settings from './attachment-admission.json' with { type: 'json' };

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const megabytes = bytes => `${Math.round(bytes / 1048576)} MB`;
const bound = limit => Number.isFinite(limit) && limit >= 0;

/**
 * files: [{ name, size }] in the order offered.
 * limits: { per_turn_cap, absolute_bytes, max_bytes, binding_words } (defaults from attachment-admission.json).
 * daily: { remaining, resets_at } when the plan keeps a daily count, else null.
 * Returns { accepted: [index...], left_out: [{ index, because }], binding: 'size'|'per_turn'|'daily'|null, banner: string|null, blocked: boolean }.
 */
export function admitAttachments({ files, limits = {}, daily = null, now = Date.now() }) {
  const rule = { ...settings, ...limits };
  const words = { ...settings.binding_words, ...(limits.binding_words ?? {}) };
  const ceiling = Math.min(...[rule.absolute_bytes, rule.max_bytes].filter(bound), Infinity);
  const left_out = [];
  const fitting = [];
  files.forEach((file, index) => {
    if (file.size > ceiling) left_out.push({ index, because: 'size' });
    else fitting.push(index);
  });
  const dailyLeft = daily && bound(daily.remaining) ? Math.max(0, daily.remaining) : Infinity;
  const turnLeft = bound(rule.per_turn_cap) ? rule.per_turn_cap : Infinity;
  const room = Math.min(turnLeft, dailyLeft);
  const accepted = fitting.slice(0, room);
  const dropped = fitting.slice(room);
  const binding = dropped.length ? (dailyLeft <= turnLeft ? 'daily' : 'per_turn') : left_out.length ? 'size' : null;
  for (const index of dropped) left_out.push({ index, because: binding });
  const reset = daily?.resets_at && Date.parse(daily.resets_at) > now ? ` until ${new Date(daily.resets_at).toISOString()}` : '';
  const banner = binding === null ? null : fill(words[binding], {
    admitted: accepted.length, offered: files.length, limit: binding === 'size' ? megabytes(ceiling) : rule.per_turn_cap,
    name: files[left_out.find(row => row.because === 'size')?.index]?.name ?? 'A file', reset,
  });
  return { accepted, left_out: left_out.sort((a, b) => a.index - b.index), binding, banner, blocked: files.length > 0 && accepted.length === 0 };
}
