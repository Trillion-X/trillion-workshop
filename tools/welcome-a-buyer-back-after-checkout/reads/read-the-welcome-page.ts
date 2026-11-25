// tools/welcome-a-buyer-back-after-checkout/reads/read-the-welcome-page.ts
//
// PURPOSE
//   Reads the words of the page a buyer comes back to after checkout: the page's title and addresses, and for each state of the
//   checkout (paid, waiting, none) its heading, its body and its actions. The answer is the props of show/Welcome.tsx, so a page
//   and an AI app's screen get the same answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The words are the pursuit's rows (welcome_page and welcome_states); none is held here. States come back in their place
//      order, each with only plain words and actions that have both a label and an address.
//   2. No page row is an error the caller can read: a pursuit with no welcome page row is refused by name.
//   3. The row and column names are the one block below; nothing else here names a table.
//   4. Nothing here holds a login or a client: the reader is handed `rows` by run-sql-in-my-database/do-work/serve-a-read.ts.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveARead, type Reader } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';

// The one place the tables and columns are named.
const SOURCE = {
  page: { table: 'welcome_page', columns: 'name, address, tours_address, title, keep_seconds' },
  states: { table: 'welcome_states', columns: 'state, heading, body, actions', order: 'place, state' },
} as const;

export type WelcomeAction = { label: string; href: string };
export type WelcomeState = { heading: string; body: string; actions: WelcomeAction[] };
export type WelcomePageAnswer = { name: string; title: string; address: string; tours_address: string; keep_seconds: number; states: Record<string, WelcomeState> };
type Given = { database: string; name?: string };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function actionsOf(value: unknown): WelcomeAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => ({ label: text((item as { label?: unknown })?.label), href: text((item as { href?: unknown })?.href) }))
    .filter(action => action.label !== '' && action.href !== '');
}

export const readWelcomePage: Reader<Given, WelcomePageAnswer> = async (input, rows) => {
  const named = typeof input.name === 'string' && input.name !== '';
  const pages = await rows(`select ${SOURCE.page.columns} from ${SOURCE.page.table}${named ? ' where name = $1' : ''} order by name limit 1`, named ? [input.name] : []);
  const page = pages[0];
  if (!page) throw new Error(named ? `There is no welcome page named ${input.name}.` : 'This pursuit has no welcome page row.');
  const found = await rows(`select ${SOURCE.states.columns} from ${SOURCE.states.table} order by ${SOURCE.states.order}`);
  const states: Record<string, WelcomeState> = {};
  for (const row of found) states[text(row.state)] = { heading: text(row.heading), body: text(row.body), actions: actionsOf(row.actions) };
  return { name: text(page.name), title: text(page.title), address: text(page.address), tours_address: text(page.tours_address), keep_seconds: Number(page.keep_seconds ?? 0), states };
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await serveARead({ readWelcomePage });
