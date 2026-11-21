// tools/take-payments/web/src/workspace/seller-account.ts
//
// PURPOSE
//   Which of the seller's accounts the connection a payment screen names means, asked before the screen starts a run
//   (seller-account.json). The engine chose it inside every run until Nov 21 2026; the choice is the connections
//   owner's (tools/connections tool:find-the-account-of-a-service), so a screen asks it here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Names only: the vault's held names are read, never a value, and only by the account's owner; when they cannot be
//      read the connection is used as named.
//   2. Several accounts held: nothing starts, and the tool's words name them.
//   3. No page here: the run and the names read are handed in, so a test runs it as it is.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { heldConnectionsOfNames } from '../../../../connections/read-data/held-connections-of-names.mjs';
import settings from './seller-account.json' with { type: 'json' };

export type RunTool = (tool: string, input: Record<string, unknown>) => Promise<{ result?: unknown }>;
/** The vault's held names, or null when this caller cannot read them (a buyer is not the account's owner). */
export type ReadNames = () => Promise<string[] | null>;

export const SELLER_ACCOUNT = settings;

/** The connection to run with: the one account of the named service the vault holds, else the connection as named. */
export async function sellerAccountOf(named: string, run: RunTool, readNames: ReadNames): Promise<string> {
  const names = await readNames().catch(() => null);
  if (!Array.isArray(names)) return named;
  const { result } = await run(settings.tool, { service: named, held_connections: heldConnectionsOfNames(names) });
  const found = (result ?? {}) as { connection_id?: unknown; which?: unknown };
  if (typeof found.which === 'string') throw new Error(found.which);
  return typeof found.connection_id === 'string' ? found.connection_id : named;
}
