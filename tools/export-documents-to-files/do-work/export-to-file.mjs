// tools/export-documents-to-files/do-work/export-to-file.mjs
//
// The command of the export tool. The verb is the first argument and one JSON request is on standard input:
//   export   { document, format, file_stem?, format_row?, paper?, locale?, orientation?, now? }
//              -> { format_id, filename, extension, mime, byte_length, base64, text?, finish? }
//   formats  {}  -> { formats: [{ id, label, extension, mime, draws, finished_by? }] }
// and one JSON line out: { result }, or { error } with a non-zero exit when the request cannot be done.
//
// `format` is the id of a row in read-data/export-formats.json; `format_row` is a whole row of the same shape, for a
// person's own format kept in a list of theirs (it wins over `format`). A document is { title?, blocks } (document.mjs).
// The page of a format that draws pages comes from `paper` (read-data/paper-sizes.json), else the region of `locale`, else the
// default paper; `orientation` is portrait or landscape. A format row with options.cells "numbers" keeps money as numbers.
// `finish` is set when the format's last step needs a browser page (PNG): the bytes are then the SVG to draw there.
import { text as readStdin } from 'node:stream/consumers';
import formatsData from '../read-data/export-formats.json' with { type: 'json' };
import paperData from '../read-data/paper-sizes.json' with { type: 'json' };
import { formatTables, lowerBlocks, readDocument } from './document.mjs';
import { renderTemplate } from './render-template.mjs';
import { renderPdf } from './render-pdf.mjs';
import { renderSvg } from './render-svg.mjs';
import { renderDocx } from './render-docx.mjs';
import { renderXlsx } from './render-xlsx.mjs';
import { formatTakes } from './format-takes.mjs';

const RENDERERS = {
  template: (document, options, context) => renderTemplate(document, options, context),
  pdf: (document, options, context) => renderPdf(document, options, context),
  svg: (document, options, context) => renderSvg(document, options, context),
  docx: (document, options, context) => renderDocx(document, options, context),
  xlsx: (document, options, context) => renderXlsx(document, options, context),
  'document-json': document => `${JSON.stringify(document, null, 2)}\n`,
};

const fail = message => { throw new Error(message); };

/** The paper the request means: `paper` by id; else the paper that lists the region of `locale`, or the one marked elsewhere; else the default. */
function paperOf(request) {
  const { papers } = paperData;
  let id = request.paper;
  if (id === undefined && typeof request.locale === 'string') {
    const region = request.locale.split(/[-_]/)[1]?.toUpperCase();
    if (region) id = Object.keys(papers).find(name => papers[name].regions.includes(region)) ?? Object.keys(papers).find(name => papers[name].elsewhere);
  }
  id ??= paperData.default;
  if (!Object.hasOwn(papers, id)) fail(`There is no paper ${JSON.stringify(id)}. The papers are: ${Object.keys(papers).join(', ')}.`);
  const { width, height } = papers[id];
  const orientation = request.orientation ?? 'portrait';
  if (orientation !== 'portrait' && orientation !== 'landscape') fail('orientation must be portrait or landscape.');
  return { paper: id, size: orientation === 'landscape' ? { width: height, height: width } : { width, height } };
}

function readFormat(request) {
  const row = request.format_row ?? formatsData.formats.find(format => format.id === request.format);
  if (!row) fail(`There is no format ${JSON.stringify(request.format)}. The formats are: ${formatsData.formats.map(format => format.id).join(', ')}.`);
  for (const key of ['id', 'extension', 'mime', 'renderer']) if (typeof row[key] !== 'string' || row[key] === '') fail(`The format row needs ${key} as words.`);
  if (!/^[a-z0-9]+$/.test(row.extension)) fail('The format row extension must be letters and digits only, with no dot.');
  if (!Object.hasOwn(RENDERERS, row.renderer)) fail(`The format ${row.id} names the renderer ${JSON.stringify(row.renderer)}; the renderers are ${Object.keys(RENDERERS).join(', ')}.`);
  if (!Array.isArray(row.draws)) fail(`The format ${row.id} needs draws, the block kinds it writes.`);
  return row;
}

/** A name for the file from the title when none is given: letters and digits joined by hyphens. */
function stemOf(request, document, format) {
  const given = request.file_stem;
  if (given !== undefined) {
    if (typeof given !== 'string' || given === '' || /[\\/\u0000-\u001f]/.test(given) || given.startsWith('.')) fail('file_stem must be a plain file name: no folder, no leading dot.');
    return given;
  }
  const slug = document.title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return slug || format.id;
}

function exportFile(request) {
  const format = readFormat(request);
  const document = readDocument(request.document);
  if (!formatTakes(format, document.blocks.map(block => block.kind))) {
    const refused = document.blocks.find(block => !formatTakes(format, [block.kind]));
    fail(`The ${format.id} format cannot write a ${refused.kind} block${refused.kind === 'picture' ? '; choose a format that can, such as svg or html' : ''}.`);
  }
  const locale = request.locale ?? 'en-US';
  const lowered = { ...document, blocks: lowerBlocks(document.blocks, format.draws) };
  // A format that writes words shows money as money; a format that keeps numbers (CSV, Excel) is given the numbers.
  const shown = format.options?.cells === 'numbers' ? lowered : { ...lowered, blocks: formatTables(lowered.blocks, locale) };
  const now = request.now ?? new Date().toISOString();
  const { size } = paperOf(request);
  const made = RENDERERS[format.renderer](shown, format.options ?? {}, { now, size, locale });
  const bytes = Buffer.isBuffer(made) ? made : Buffer.from(made, 'utf8');
  const textual = !Buffer.isBuffer(made);
  return {
    format_id: format.id,
    filename: `${stemOf(request, document, format)}.${format.extension}`,
    extension: format.extension,
    mime: format.mime,
    byte_length: bytes.length,
    base64: bytes.toString('base64'),
    ...(textual ? { text: made } : {}),
    ...(format.finished_by ? { finish: format.finish, finished_by: format.finished_by } : {}),
  };
}

const verbs = {
  export: exportFile,
  formats: () => ({
    formats: formatsData.formats.map(({ id, label, extension, mime, draws, finished_by: finishedBy }) => ({ id, label, extension, mime, draws, ...(finishedBy ? { finished_by: finishedBy } : {}) })),
  }),
};

export const runVerb = (verb, input) => {
  if (!Object.hasOwn(verbs, verb)) fail(`unknown export command ${verb}: use export or formats.`);
  return verbs[verb](input ?? {});
};

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify({ result: runVerb(process.argv[2], JSON.parse((await readStdin(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
