// tools/put-back-what-runs/do-work/put-back-what-runs.mjs
//
// `tool:put-back-what-runs`: everything that runs is rendered by its owner from DATA rows and is never changed by hand. This
// is the one generic reconciler. It names no owner, no thing, no kind of file and no place: each owner declares, as a DATA
// row (a declarations file, kind `what-runs-owners`), the module that owns its things, the export that answers how what runs
// differs from what its rows render (`differences`), the export that renders its rows again (`put_back`, optional: without
// it the owner is reported only), how often it is asked (`interval_seconds`), and its things, each `{ thing, args }`, the
// arguments both exports take, as JSON (an argument `{ "$file": PATH }` is that JSON file, so a thing's row stays its own row).
//
// Each difference becomes one finding row ({ kind: "what-runs-finding", id, owner, thing, difference, found_at, put_back }),
// after the owner has been asked to put it back and asked again whether it still differs. A thing whose owner cannot read
// what runs is a finding too (`put_back: "not read"`), never taken for "no difference". Findings are the answer, and with
// `--findings FILE` each row is also appended to that file as one JSON line.
//
// usage: put-back-what-runs.mjs once DECLARATIONS_FILE [--findings FILE] [--report-only]
//        put-back-what-runs.mjs watch DECLARATIONS_FILE [--findings FILE] [--report-only]   (asks each owner on its own interval)
import { readFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const FIELDS = ['owner', 'module', 'differences', 'interval_seconds', 'things'];
const refused = message => Object.assign(new Error(message), { exit: 2 });

/** The owner declarations a file holds, each module path and `$file` argument resolved against the file's own folder. */
export function readDeclarations(file) {
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  if (rows?.kind !== 'what-runs-owners' || !Array.isArray(rows.owners)) throw refused(`${file} is no { "kind": "what-runs-owners", "owners": [...] } declarations file.`);
  const here = dirname(resolvePath(file));
  const inFile = value => (Array.isArray(value) ? value.map(inFile)
    : value && typeof value === 'object' ? (typeof value.$file === 'string' && Object.keys(value).length === 1
      ? JSON.parse(readFileSync(resolvePath(here, value.$file), 'utf8'))
      : Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, inFile(inner)])))
      : value);
  return rows.owners.map(row => {
    const missing = FIELDS.filter(field => row[field] === undefined);
    if (missing.length) throw refused(`${row.owner ?? 'An owner row'} needs ${missing.join(', ')}: every owner declares its module, its differences export, its interval and its things.`);
    if (!Array.isArray(row.things) || row.things.some(thing => typeof thing.thing !== 'string' || !Array.isArray(thing.args))) throw refused(`${row.owner} things are each { "thing": id, "args": [...] }.`);
    if (!(Number.isFinite(row.interval_seconds) && row.interval_seconds > 0)) throw refused(`${row.owner} interval_seconds is a number of seconds above 0.`);
    return { ...row, module: isAbsolute(row.module) ? row.module : resolvePath(here, row.module), things: row.things.map(thing => ({ ...thing, args: inFile(thing.args) })) };
  });
}

/** The owners due now: never asked, or asked at least their interval ago. `last` maps owner to the time it was last asked. */
export const dueOwners = (owners, last, now = new Date()) => owners.filter(row => !last[row.owner] || now - new Date(last[row.owner]) >= row.interval_seconds * 1000);

const say = difference => JSON.stringify(difference);
const idOf = (owner, thing, difference, at) => `finding:${createHash('sha256').update(JSON.stringify([owner, thing, difference, at])).digest('hex').slice(0, 24)}`;

/** Ask every declared owner how what runs differs from its rows, have it put each difference back, and answer one finding
 * row per difference with what happened. `load` imports an owner's module (its path); `base` resolves a relative one. */
export async function reconcile(owners, { now = new Date(), load = path => import(pathToFileURL(path).href), base = process.cwd(), reportOnly = false } = {}) {
  const findings = [], summary = [];
  const at = now.toISOString();
  for (const row of owners) {
    const counts = { owner: row.owner, things: row.things.length, differences: 0, put_back: 0, still_different: 0, errors: 0 };
    summary.push(counts);
    let owner;
    try {
      owner = await load(isAbsolute(row.module) ? row.module : resolvePath(base, row.module));
      for (const name of [row.differences, row.put_back].filter(Boolean)) if (typeof owner[name] !== 'function') throw new Error(`${row.module} exports no function ${name}`);
    } catch (error) {
      counts.errors += 1;
      findings.push({ kind: 'what-runs-finding', id: idOf(row.owner, null, null, at), owner: row.owner, thing: null, difference: null, found_at: at, put_back: 'not read', error: error.message });
      continue;
    }
    for (const { thing, args } of row.things) {
      const finding = (difference, put_back, extra = {}) => ({ kind: 'what-runs-finding', id: idOf(row.owner, thing, difference, at), owner: row.owner, thing, difference, found_at: at, put_back, ...extra });
      let found;
      try { found = await owner[row.differences](...structuredClone(args)); }
      catch (error) { counts.errors += 1; findings.push(finding(null, 'not read', { error: error.message })); continue; }
      if (!found.length) continue;
      counts.differences += found.length;
      if (!row.put_back || reportOnly) { findings.push(...found.map(difference => finding(difference, row.put_back ? 'reported only: asked to report only' : 'reported only: the owner declares no put_back'))); continue; }
      let result, after;
      try {
        result = await owner[row.put_back](...structuredClone(args));
        after = new Set((await owner[row.differences](...structuredClone(args))).map(say));
      } catch (error) {
        counts.errors += 1;
        findings.push(...found.map(difference => finding(difference, 'put back failed', { error: error.message })));
        continue;
      }
      for (const difference of found) {
        const still = after.has(say(difference));
        counts[still ? 'still_different' : 'put_back'] += 1;
        findings.push(finding(difference, still ? 'still different after put back' : 'put back', result === undefined ? {} : { owner_answer: result }));
      }
      // A difference the put-back made, not there before, is a finding too: the owner rendered something its rows do not.
      for (const text of after) if (!found.some(difference => say(difference) === text)) { counts.still_different += 1; findings.push(finding(JSON.parse(text), 'appeared after put back')); }
    }
  }
  return { checked_at: at, owners: summary, findings };
}

const pause = ms => new Promise(done => setTimeout(done, ms));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, file, ...rest] = process.argv.slice(2);
  const usage = 'usage: put-back-what-runs.mjs once|watch DECLARATIONS_FILE [--findings FILE] [--report-only]';
  const flag = name => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };
  const findingsFile = flag('--findings'), reportOnly = rest.includes('--report-only');
  const unknown = rest.filter((word, i) => word.startsWith('--') && !['--findings', '--report-only'].includes(word) || (!word.startsWith('--') && rest[i - 1] !== '--findings'));
  const keep = answer => { if (findingsFile) for (const row of answer.findings) appendFileSync(findingsFile, `${JSON.stringify(row)}\n`); };
  try {
    if (!['once', 'watch'].includes(operation) || !file || unknown.length || (rest.includes('--findings') && !findingsFile)) throw refused(usage);
    const owners = readDeclarations(resolvePath(file));
    if (operation === 'once') {
      const answer = await reconcile(owners, { reportOnly });
      keep(answer);
      process.stdout.write(`${JSON.stringify(answer)}\n`);
      if (answer.owners.some(row => row.still_different || row.errors)) process.exitCode = 3;
    } else {
      const last = {};
      for (;;) {
        const due = dueOwners(owners, last);
        if (due.length) {
          const answer = await reconcile(due, { reportOnly });
          for (const row of due) last[row.owner] = answer.checked_at;
          keep(answer);
          process.stdout.write(`${JSON.stringify(answer)}\n`);
        }
        await pause(Math.min(...owners.map(row => row.interval_seconds)) * 1000);
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
