// tools/serve-a-sites-pages-from-its-rows/do-work/check-a-sites-act.ts
//
// PURPOSE
//   tool:check-a-sites-act-against-its-rows. A site's act (the tools its own key may run) is made from its rows when its
//   computer's row is applied (tools/start-a-computer apply-a-computer-row.mjs, an act given as { derive_from }). Its rows change
//   between applies. This check derives the act again from the rows as they are now, the same way and at the same Workshop commit
//   (the act's derive_from.pin, unpacked from the granted Workshop folder with git archive, as the apply unpacks it), and says how
//   it differs from the one the row last applied (derive_from's derived.grant):
//     widened   tools, held names, identity or journal the rows now ask for that the applied act does not give. Never applied
//               without a person: anyone who can write a page row could otherwise grant the site a tool.
//     narrowed  what the applied act gives that the rows no longer ask for. Taking it away is safe to queue on its own.
//     refused   calls the rows make that no grant can let the site make as written (rights.ts), which need a person too.
//   It reads the computer's row and the site's rows by running tool:run-sql-in-my-database through the run's door (descriptor
//   3), by the held connection names the row and its act give; it holds no login and writes nothing.
//
//   Input: { computer, uid, store }: the computer row's name, the uid of the vault reader whose act is checked, and the held
//   connection of the database the computer rows are kept in. The command line names the granted Workshop folder (a git
//   checkout holding the pinned commit) and the run's kept folder, where each pinned commit is unpacked once.
//   Answer: { computer, uid, site, pin, same, needs_a_person, narrowed_only, widened, narrowed, refused, asked_by,
//   derived_tools, applied_tools, difference_id } (difference_id: the BLAKE3 identity of what differs, so one difference is one
//   finding however often it is checked).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The derive is the apply's own: the pinned commit's rights.ts over every tool row of that commit, the site's rows read
//      as its program reads them (siteRowsOf). Nothing about any one site is in this file.
//   2. Read only: nothing is written to either database, and the granted folder is only read.
//   3. An act that is not given as { derive_from } is refused by name: a hand list has no rows to be checked against.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DerivedGrant, Grant, GrantDifference, RowsOf, SiteRows, SiteRowsAt } from './rights.ts';

export interface Asked {
  computer: string;
  uid: number;
  store: string;
}

/** The parts of a pinned commit's rights.ts the check runs. */
export interface Rights {
  siteRowsOf(rows: RowsOf, at: SiteRowsAt): Promise<SiteRows>;
  derivedGrantOf(site: SiteRows, heldOf: (tool: string) => unknown): DerivedGrant;
  heldInputsOfTools(tools: string): (tool: string) => unknown;
  grantDifference(applied: Grant | null, derived: Grant): GrantDifference;
  askedBy(site: SiteRows, tools: string[]): Record<string, string[]>;
}

export interface Deps {
  /** Runs one statement through tool:run-sql-in-my-database with the held connection named. */
  runSql(credential: string, sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  /** The rights.ts of a Workshop commit, and its tools folder. */
  rightsAt(pin: string): Promise<{ rights: Rights; tools: string }>;
  /** The BLAKE3 identity of a JSON value (content-identity). */
  identity(value: unknown): string;
}

const NAME = /^[A-Za-z0-9._-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The input, checked; a wrong one throws naming what each field should be. */
export function askedOf(value: unknown): Asked {
  const given = value as Partial<Asked> | null;
  if (!isObject(given) || Object.keys(given).some(key => !['computer', 'uid', 'store'].includes(key)) || typeof given.computer !== 'string' || !given.computer
    || !Number.isInteger(given.uid) || typeof given.store !== 'string' || !NAME.test(given.store)) {
    throw new Error('Give { computer: the computer row\'s name, uid: the vault reader\'s uid, store: the held connection of the database its row is kept in }.');
  }
  return given as Asked;
}

/** How the act a computer row applies for one vault reader differs from the one its site's rows ask for now. */
export async function checkASitesAct(asked: Asked, deps: Deps) {
  const [row] = await deps.runSql(asked.store, 'SELECT runs::text AS runs FROM computer WHERE name = $1', [asked.computer]);
  if (!row) throw new Error(`No computer row is named ${asked.computer}.`);
  const runs = JSON.parse(String(row.runs)) as { units?: { settings?: { vault_readers?: Record<string, unknown>[] } }[] };
  const readers = (runs.units ?? []).flatMap(unit => unit.settings?.vault_readers ?? []).filter(reader => reader.uid === asked.uid);
  if (readers.length !== 1) throw new Error(`${asked.computer} has ${readers.length} vault readers with uid ${asked.uid}; the check needs exactly one.`);
  const act = readers[0].act as { derive_from?: SiteRowsAt & { connection: string; pin: string }; derived?: { grant?: Grant } } | undefined;
  const from = act?.derive_from;
  if (!from) throw new Error(`The act of uid ${asked.uid} on ${asked.computer} is not given as { derive_from }, so there are no rows to check it against.`);
  if (typeof from.connection !== 'string' || !NAME.test(from.connection) || typeof from.pin !== 'string' || !COMMIT.test(from.pin)) {
    throw new Error(`The act of uid ${asked.uid} on ${asked.computer} names no held connection and Workshop commit to derive from.`);
  }
  const applied = act?.derived?.grant ?? null;
  const { rights, tools } = await deps.rightsAt(from.pin);
  const site = await rights.siteRowsOf((sql, params) => deps.runSql(from.connection, sql, params), { database: from.database, use: from.use, site: from.site });
  const { grant, refused } = rights.derivedGrantOf(site, rights.heldInputsOfTools(tools));
  const difference = rights.grantDifference(applied, grant);
  const widened = difference.widened.tools.length > 0 || difference.widened.held.length > 0 || difference.widened.other.length > 0;
  const needsAPerson = widened || refused.length > 0;
  return {
    computer: asked.computer, uid: asked.uid, site: from.site, pin: from.pin,
    same: difference.same && refused.length === 0,
    needs_a_person: needsAPerson,
    narrowed_only: !needsAPerson && !difference.same,
    widened: difference.widened, narrowed: difference.narrowed, refused,
    asked_by: rights.askedBy(site, [...new Set([...difference.widened.tools, ...difference.widened.held.map(item => item.tool)])]),
    derived_tools: grant.tools.length, applied_tools: applied?.tools.length ?? 0,
    difference_id: deps.identity({ computer: asked.computer, uid: asked.uid, pin: from.pin, applied, derived: grant, refused }),
  };
}

/** The pinned commit's tools unpacked once into the kept folder (git archive of the granted Workshop folder), and its rights. */
export function rightsFrom(workshop: string, kept: string) {
  return async (pin: string) => {
    const tree = join(kept, `workshop-${pin}`);
    if (!existsSync(join(tree, 'tools'))) {
      mkdirSync(kept, { recursive: true });
      const making = mkdtempSync(join(kept, 'unpacking-'));
      await new Promise<void>((done, fail) => {
        const archive = spawn('git', ['-C', workshop, 'archive', pin, 'tools'], { stdio: ['ignore', 'pipe', 'pipe'] });
        const tar = spawn('tar', ['-x', '-C', making], { stdio: ['pipe', 'ignore', 'pipe'] });
        let said = '';
        archive.stderr.on('data', chunk => { said += chunk; });
        archive.stdout.pipe(tar.stdin);
        archive.on('error', fail);
        tar.on('error', fail).on('close', code => (code === 0 && archive.exitCode === 0 ? done() : fail(new Error(`The Workshop commit ${pin} could not be unpacked: ${said.trim() || `tar exited ${code}`}`))));
      });
      renameSync(making, tree);
    }
    const rights = await import(pathToFileURL(join(tree, 'tools/serve-a-sites-pages-from-its-rows/do-work/rights.ts')).href) as Partial<Rights>;
    if (typeof rights.siteRowsOf !== 'function' || typeof rights.grantDifference !== 'function' || typeof rights.askedBy !== 'function') {
      throw new Error(`The Workshop commit ${pin} cannot derive a site's act from its settings row; pin the act to a later commit.`);
    }
    return { rights: rights as Rights, tools: join(tree, 'tools') };
  };
}

const started = (() => { try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; } })();
if (started) {
  try {
    const [workshop, kept] = process.argv.slice(2);
    if (!workshop || !kept) throw new Error('usage: node do-work/check-a-sites-act.ts WORKSHOP_FOLDER KEPT_FOLDER (the input on standard input)');
    const asked = askedOf(JSON.parse(readFileSync('/dev/stdin', 'utf8')));
    const { openRecordsDoor } = await import('../../records-door/read-data/records-door.mjs');
    const { makeHashCodeHexFromJson } = await import('../../content-identity/read-data/identity.mjs');
    const door = openRecordsDoor();
    const answer = await checkASitesAct(asked, {
      async runSql(credential, sql, params) {
        const ran = await door.run('tool:run-sql-in-my-database', { credential_name: credential, sql, params }) as { rows?: unknown };
        if (!Array.isArray(ran?.rows)) throw new Error('tool:run-sql-in-my-database answered no rows.');
        return ran.rows as Record<string, unknown>[];
      },
      rightsAt: rightsFrom(workshop, kept),
      identity: makeHashCodeHexFromJson,
    });
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: (error as Error).message })}\n`);
    process.exitCode = 1;
  }
}
