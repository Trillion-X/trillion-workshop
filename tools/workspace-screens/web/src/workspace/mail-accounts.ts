// src/workspace/mail-accounts.ts
//
// PURPOSE
//   The mail accounts that can open mail: connected, allowed to send, with the connection they were made by and the
//   mail provider (a row of tools/read-and-write-mail/read-data/mail-providers.json) each is on. Mail and Email settings
//   read them through this one road and call the mail tools as the chosen one.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An account is named by its connection and when it was connected (`mailAccountKey`), so a reconnected account is a new one.
//   2. A tool run is always bound to that connection, never to "the first account": the run's input carries it as
//      `connection` ({connection_id, connected_at}), the only place a run takes it on the engine road, and carries the
//      provider the account is on as `provider`.
//   3. No provider is named here: the providers, their connection kinds, labels and web links are the provider rows.

import { readJson } from './api';
import { runWorkshopTool } from './workshop-tool-api';
import providerFile from 'trillion-workshop/tools/read-and-write-mail/read-data/mail-providers.json' with { type: 'json' };

export type MailProvider = (typeof providerFile)['providers'][number];
export const mailProviders: readonly MailProvider[] = providerFile.providers;
export type MailAccount = { connection_id: string; connected_at: string; account_label: string; status: string; can_send?: boolean; provider: string };
export const mailAccountKey = (account: MailAccount) => JSON.stringify([account.connection_id, account.connected_at]);

/** The provider row of an account (or the first row, for words shown before an account is chosen). */
export const providerOf = (account?: Pick<MailAccount, 'provider'> | null): MailProvider => mailProviders.find(row => row.id === account?.provider) ?? mailProviders[0];
/** Words that name the provider, filled from its row: `{provider}` is its label. */
export const providerWords = (words: string, account?: Pick<MailAccount, 'provider'> | null): string => words.replace(/\{provider\}/g, providerOf(account).label);
/** Whether the engine's error words say the connection is the trouble (they name no provider). */
export const connectionTrouble = (message: string, withPermission = false): boolean => (withPermission ? /connect|credential|service_connection|authorization|403|permission/i : /connect|credential|service_connection|authorization/i).test(message);

/** The accounts that can open mail here, on every provider that has a row. A provider whose accounts cannot be read is left out unless none can. */
export async function readMailAccounts(): Promise<MailAccount[]> {
  const reads = await Promise.allSettled(mailProviders.map(async provider => {
    const answer = await readJson<{ accounts: Omit<MailAccount, 'provider'>[] }>(`/work/api/workshop/accounts?vendor=${encodeURIComponent(provider.connection_vendor)}&check=${crypto.randomUUID()}`);
    return answer.accounts.map(row => ({ ...row, provider: provider.id }));
  }));
  const read = reads.filter((row): row is PromiseFulfilledResult<MailAccount[]> => row.status === 'fulfilled');
  if (!read.length) throw (reads[0] as PromiseRejectedResult).reason;
  return read.flatMap(row => row.value).filter(row => row.status === 'connected' && row.can_send !== false && row.connected_at);
}

/** Runs one mail tool as this account, on its provider. */
export const runAsAccount = (account: MailAccount, toolId: string, input: Record<string, unknown>, requestKey?: string) =>
  runWorkshopTool(toolId, { ...input, provider: account.provider, connection: { connection_id: account.connection_id, connected_at: account.connected_at } }, requestKey);
