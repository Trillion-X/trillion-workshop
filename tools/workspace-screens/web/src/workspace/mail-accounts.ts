// src/workspace/mail-accounts.ts
//
// PURPOSE
//   The Google accounts that can open mail: connected, allowed to send, with the connection they were made by. Mail and
//   Email settings read them through this one road and call Gmail's tools as the chosen one.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An account is named by its connection and when it was connected (`mailAccountKey`), so a reconnected account is a new one.
//   2. A tool run is always bound to that connection, never to "the first Google account": the run's input carries it as
//      `connection` ({connection_id, connected_at}), the only place a run takes it on the engine road.

import { readJson } from './api';
import { runWorkshopTool } from './workshop-tool-api';

export type MailAccount = { connection_id: string; connected_at: string; account_label: string; status: string; can_send?: boolean };
export const mailAccountKey = (account: MailAccount) => JSON.stringify([account.connection_id, account.connected_at]);

/** The Google accounts that can open mail here. */
export async function readMailAccounts(): Promise<MailAccount[]> {
  const answer = await readJson<{ accounts: MailAccount[] }>(`/work/api/workshop/accounts?vendor=google-account&check=${crypto.randomUUID()}`);
  return answer.accounts.filter(row => row.status === 'connected' && row.can_send !== false && row.connected_at);
}

/** Runs one Gmail tool as this account. */
export const runAsAccount = (account: MailAccount, toolId: string, input: Record<string, unknown>, requestKey?: string) =>
  runWorkshopTool(toolId, { ...input, connection: { connection_id: account.connection_id, connected_at: account.connected_at } }, requestKey);
