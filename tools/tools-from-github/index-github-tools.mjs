// tools/tools-from-github/index-github-tools.mjs
//
// Purpose
//   Makes tool-rows.json from sources.json (both beside this file): one Workshop tool row per open-source GitHub
//   repository, placed on placement:caller-sandbox, so an AI that asks find_tool_for_job for a job (captions,
//   transcription, a cutout) finds the repository, and run_tool hands it back (for_you_to_run) with how to clone,
//   install and run it on the person's own computer. Trillion runs none of this code and keeps none of it.
//
//     node tools/tools-from-github/index-github-tools.mjs            reads GitHub now and writes the rows
//     node tools/tools-from-github/index-github-tools.mjs --check    reads GitHub now and fails when the kept rows differ
//
// Non-negotiable invariants
//   1. A licence is never typed: it is GitHub's own `license.spdx_id` for the repository, read now, or, when GitHub does
//      not name one, the SPDX id the sources row gives for its licence file, kept only after the file itself is read
//      and found to contain the row's `licence_file_says` words. A repository with neither is refused, not guessed.
//   2. The licence class is the first class in licence-classes.json at the top of this repository that lists that SPDX
//      id and allows placement:caller-sandbox; a licence no class lists is refused.
//   3. Each row keeps where and when its facts were read (provenance), so a stale row can be found and read again.
//   4. Nothing here names a repository or a job: they are the sources rows.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PLACEMENT = 'placement:caller-sandbox';
const OUT = resolve(here, 'tool-rows.json');
const readJson = path => JSON.parse(readFileSync(resolve(here, path), 'utf8'));

/** The row a repository's GitHub facts and its sources row make. `classes` are licence-class payloads. */
export function indexRow(source, github, { classes, licence, read_on }) {
  const cls = classes.find(item => item.licences.includes(licence.spdx) && item.allowed_placements.includes(PLACEMENT));
  if (!cls) throw new Error(`${source.repo}: no licence class lists ${licence.spdx} and lets it run on the person's own computer`);
  const [owner, name] = source.repo.split('/');
  return {
    kind: 'ai-tool-descriptor',
    id: `tool:github:${owner}-${name}`.toLowerCase(),
    label: `${name} (open source, runs on your computer)`,
    job: source.job,
    description: `${github.description ?? source.job} Open source on GitHub under ${licence.spdx}. It runs on the person's own computer: run_tool hands back how to get it and run it.`,
    status: 'active',
    input_schema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The file or web address on the person\'s computer to work on, put where {input} is in the command' },
        output: { type: 'string', description: 'Where the result goes on the person\'s computer, put where {output} is in the command' },
      },
    },
    output_schema: { type: 'object' },
    invoke: {
      kind: 'on-your-computer',
      repository: github.html_url,
      get_it: [`git clone ${github.html_url}.git`, ...source.install],
      run: source.run,
      needs: source.needs ?? [],
      say: 'This runs on the person\'s own computer, never on Trillion. If you can run commands where they are: check whether it is already installed, install it with get_it if not, run `run` with their files in place of {input} and {output}, show them the result, then report_result on this task. If you cannot run commands, give them these steps.',
    },
    licence_class: cls.id,
    placements: [PLACEMENT],
    provenance: {
      repository: github.html_url,
      licence_spdx: licence.spdx,
      licence_read_from: licence.read_from,
      read_on,
      stars: github.stargazers_count,
      last_pushed_at: github.pushed_at,
      default_branch: github.default_branch,
      readme_quote: source.readme_quote,
    },
  };
}

/** The licence of one repository, read from GitHub (see invariant 1). `get(url)` answers a Response. */
export async function licenceOf(source, github, get) {
  const spdx = github.license?.spdx_id;
  if (spdx && spdx !== 'NOASSERTION') return { spdx, read_from: `GitHub's licence field for ${source.repo}` };
  if (!source.licence_file || !source.licence_file_spdx || !source.licence_file_says) throw new Error(`${source.repo}: GitHub names no licence and the sources row names no licence file to read`);
  const url = `https://raw.githubusercontent.com/${source.repo}/${github.default_branch}/${source.licence_file}`;
  const text = await (await get(url)).text();
  if (!text.includes(source.licence_file_says)) throw new Error(`${source.repo}: ${source.licence_file} does not say "${source.licence_file_says}"`);
  return { spdx: source.licence_file_spdx, read_from: url };
}

export async function indexRows({ sources = readJson('sources.json').rows, get = url => fetch(url, { headers: { 'user-agent': 'trillion-index', accept: 'application/vnd.github+json' } }), now = new Date() } = {}) {
  const classes = readJson('../../licence-classes.json').records.map(record => record.payload);
  const read_on = now.toISOString().slice(0, 10);
  const rows = [];
  for (const source of sources) {
    const answer = await get(`https://api.github.com/repos/${source.repo}`);
    if (!answer.ok) throw new Error(`${source.repo}: GitHub answered ${answer.status}`);
    const github = await answer.json();
    if (github.archived) process.stderr.write(`${source.repo} is archived on GitHub; kept, with that noted in its facts\n`);
    const row = indexRow(source, github, { classes, licence: await licenceOf(source, github, get), read_on });
    rows.push(github.archived ? { ...row, provenance: { ...row.provenance, archived: true } } : row);
  }
  return rows;
}

export const asRecords = rows => ({
  kind: 'package-set-records',
  package_set: 'trillion',
  record_set: 'workshop-github-index-records',
  what_this_is: 'Made by tools/tools-from-github/index-github-tools.mjs from sources.json; change the sources and run it again, never this file by hand.',
  records: rows.map(row => ({ id: `package::ai-tool-catalog::github-index::${row.id.slice('tool:github:'.length)}`, address: `package::ai-tool-catalog::github-index::${row.id.slice('tool:github:'.length)}`, path: ['current-item', 'published-record'], payload: row })),
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const made = asRecords(await indexRows());
  const text = `${JSON.stringify(made, null, 1)}\n`;
  if (process.argv.includes('--check')) {
    const kept = readFileSync(OUT, 'utf8');
    const same = JSON.stringify(JSON.parse(kept).records.map(r => ({ ...r.payload, provenance: { ...r.payload.provenance, read_on: null, stars: null, last_pushed_at: null } })))
      === JSON.stringify(made.records.map(r => ({ ...r.payload, provenance: { ...r.payload.provenance, read_on: null, stars: null, last_pushed_at: null } })));
    process.stdout.write(same ? 'the kept rows match GitHub now\n' : 'the kept rows differ from GitHub now; run without --check\n');
    process.exitCode = same ? 0 : 1;
  } else {
    writeFileSync(OUT, text);
    process.stdout.write(`${made.records.length} rows written to tools/tools-from-github/tool-rows.json\n`);
  }
}
