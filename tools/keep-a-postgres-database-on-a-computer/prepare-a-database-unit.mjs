// tools/keep-a-postgres-database-on-a-computer/prepare-a-database-unit.mjs
//
// PostgreSQL's own part of a computer row: a database unit's `reach` (who may reach the server, and over what) made into the
// lines and files the server reads. start-a-computer knows no program; a unit that names this file as its `prepare` is handed
// to `prepare` before it renders, and gets back the unit as the computer runs it, the files it reads, and the ports and Caddy
// routes it opens (moved here from start-a-computer's render-what-a-computer-runs.mjs, Nov 18 2026, K2 of the plan that no
// general tool knows a program).
//
// A unit without `reach` keeps PostgreSQL's own defaults: it is handed back as it came, with no access file.

const POSTGRES_WORD = /^[A-Za-z0-9_.:/,@+-]+$/;

/** One `pg_hba.conf` line from a reach entry's `hba` row, in the server's own words: type, database, user, address (none
 * for a local socket) and method. Each word is one token with no space, so a row cannot add a line. */
const hbaLine = (row, where) => {
  const words = [row?.type, row?.database, row?.user, ...(row?.address === undefined ? [] : [row.address]), row?.method];
  if (!words.every(word => typeof word === 'string' && POSTGRES_WORD.test(word))) throw new Error(`${where} hba rows need type, database, user, method and, for a host line, address, each one word`);
  return words.join(' ');
};

/** A database unit as the computer runs it: the address list it listens on (every `reach` entry's `listen`; none is no
 * network listener) and the access file at its `hba_file` (every entry's `hba` rows and nothing else, so who may connect is
 * only what the entries say), written as `settings_lines` and `files`; and the ports and Caddy routes the entries open
 * (`firewall_allow`, `routes`). */
export function prepare(given) {
  const where = `unit ${given.unit}`;
  if (given.reach === undefined) return { unit: given };
  const { reach, hba_file, ...unit } = given;
  if (!Array.isArray(reach) || typeof hba_file !== 'string' || !hba_file.startsWith('/')) throw new Error(`${where} reach is a list of entries, and needs hba_file: the path of the access file the server reads`);
  if ((unit.settings_lines ?? []).some(line => /^\s*(listen_addresses|hba_file)\s*=/.test(line))) throw new Error(`${where} settings_lines must not set listen_addresses or hba_file: its reach renders them`);
  const listen = [...new Set(reach.map(entry => entry.listen).filter(address => address !== undefined))];
  if (!listen.every(address => typeof address === 'string' && POSTGRES_WORD.test(address))) throw new Error(`${where} reach listen must be one address`);
  const lines = reach.flatMap((entry, at) => (entry.hba ?? []).map(row => hbaLine(row, `${where} reach ${at}`)));
  return {
    unit: {
      ...unit,
      settings_lines: [...(unit.settings_lines ?? []), `listen_addresses = '${listen.join(',')}'`, `hba_file = '${hba_file}'`],
      files: [...(unit.files ?? []), { path: hba_file, text: lines.map(line => `${line}\n`).join('') }],
    },
    firewall_allow: reach.flatMap(entry => entry.firewall_allow ?? []),
    routes: reach.flatMap(entry => entry.routes ?? []),
  };
}
