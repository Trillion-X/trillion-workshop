// src/ingest-normalization.mjs
//
// PURPOSE
//   The one decision about what happens to a video at ingest: kept as it came when it is already the one playable
//   format, made that format when its type has a `convert` row, or kept as it came with the reason in plain words when
//   it cannot be converted (a type with no row, a file over the size one conversion takes). Every format, argument and
//   word is a row of src/ingest-normalization.json. This file only picks the row and fills it in; it runs nothing, so
//   any runner (a computer's ffmpeg, a container) takes `plan.args` and `plan.output_name` and does the work.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An upload is never refused here: a type that is not converted is kept, and `said` tells the person why.
//   2. Nothing names a format outside the DATA file.
//   3. The decision is pure: the same file facts give the same answer.
import settings from './ingest-normalization.json' with { type: 'json' };

const typeOf = value => String(value ?? '').split(';')[0].trim().toLowerCase();
const extensionOf = name => { const match = /\.([A-Za-z0-9]+)$/.exec(String(name ?? '')); return match ? match[1].toLowerCase() : ''; };
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));

/** The media types ingest converts, as the words a person reads. */
export const convertibleLabels = (data = settings) => Object.values(data.convert).map(row => row.label).join(', ');

/** The row a file's type (else its extension) names: { type, row } or null. */
function rowOf({ name, media_type }, data) {
  const type = typeOf(media_type);
  if (data.convert[type]) return { type, row: data.convert[type] };
  const extension = extensionOf(name);
  const found = type === '' || type === 'application/octet-stream'
    ? Object.entries(data.convert).find(([, row]) => row.extension === extension) : undefined;
  return found ? { type: found[0], row: found[1] } : null;
}

/** The target's output name for a file name: its own name with the target's extension. */
export const outputNameOf = (name, data = settings) => String(name ?? 'video').replace(/\.[A-Za-z0-9]+$/, '') + `.${data.target.extension}`;

/**
 * What ingest does with one file: { action: 'keep' | 'convert', said, plan? }. `plan` is { from, to, output_name, args }
 * for a conversion; `said` is always the plain sentence for the person or the AI.
 */
export function ingestDecision(file, data = settings) {
  const type = typeOf(file?.media_type);
  const supported = convertibleLabels(data);
  if (type === data.target.media_type) return { action: 'keep', said: fill(data.words.kept, { label: data.target.label }) };
  const found = rowOf(file ?? {}, data);
  if (!found) {
    if (!type.startsWith('video/')) return { action: 'keep', said: null };
    return { action: 'keep', said: fill(data.words.not_listed, { type, supported, target: data.target.label }) };
  }
  const bytes = Number(file.byte_length ?? 0);
  if (bytes > data.convert_max_bytes) {
    return { action: 'keep', said: fill(data.words.too_big, { from: found.row.label, size: Math.ceil(bytes / 1048576), limit: Math.floor(data.convert_max_bytes / 1048576), supported }) };
  }
  const args = found.row.silent ? data.ffmpeg_args_silent : data.ffmpeg_args;
  return {
    action: 'convert',
    said: fill(data.words.convert, { from: found.row.label, to: data.target.label }),
    plan: { from: found.type, to: data.target.media_type, output_name: outputNameOf(file.name, data), args: [...args] },
  };
}
