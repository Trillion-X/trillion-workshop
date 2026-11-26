// tools/site-head-from-its-rows/reads/read-the-site-head.ts
//
// PURPOSE
//   Reads one site's head rows (site_head: its declared purposes and consent; site_head_parts: each head and body-start part in
//   place order) and answers the markup every page of the site carries: `head` (the consent default first, the bar's stylesheet,
//   the declared parts, then the bar) and `body_start`. A site's server places them with withSiteHead (do-work/site-head.ts).
//   It also answers `read_from`, the tables it read, so a server that keeps the markup reads it again only when a change names
//   one of them (serve-a-sites-pages-from-its-rows keeps it until then).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A site with no site_head row, or whose rows break any rule of do-work/site-head.ts, is refused with every problem listed;
//      nothing is half drawn.
//   2. The table and column names are the one block below; nothing else here names a table.
//   3. Nothing here holds a login or a client: the reader is handed `rows` by run-sql-in-my-database/do-work/serve-a-read.ts.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveARead, type Reader } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';
import { siteHeadMarkup, type HeadPart, type SiteHeadData } from '../do-work/site-head.ts';

// The one place the tables and columns are named.
const SOURCE = {
  head: { table: 'site_head', columns: 'purposes, consent' },
  parts: { table: 'site_head_parts', columns: 'area, kind, purpose, text, src', order: 'area, place' },
} as const;

export type SiteHeadAnswer = { head: string; body_start: string; read_from: string[] };
type Given = { database: string; site: string };

export const readSiteHead: Reader<Given, SiteHeadAnswer> = async (input, rows) => {
  if (typeof input.site !== 'string' || input.site === '') throw new Error('Give site: the name of the site whose head to read.');
  const heads = await rows(`select ${SOURCE.head.columns} from ${SOURCE.head.table} where site = $1`, [input.site]);
  if (!heads[0]) throw new Error(`There is no site_head row for ${input.site}.`);
  const parts = await rows(`select ${SOURCE.parts.columns} from ${SOURCE.parts.table} where site = $1 order by ${SOURCE.parts.order}`, [input.site]);
  const part = (row: Record<string, unknown>): HeadPart => ({ kind: String(row.kind), purpose: String(row.purpose), ...(row.text === null || row.text === undefined ? {} : { text: String(row.text) }), ...(row.src === null || row.src === undefined ? {} : { src: String(row.src) }) });
  const of = (area: string): HeadPart[] => parts.filter(row => row.area === area).map(part);
  const data = { purposes: heads[0].purposes, consent: heads[0].consent, head: of('head'), body_start: of('body_start') } as SiteHeadData;
  const markup = siteHeadMarkup(data);
  return { head: markup.head, body_start: markup.bodyStart, read_from: [SOURCE.head.table, SOURCE.parts.table] };
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await serveARead({ readSiteHead });
