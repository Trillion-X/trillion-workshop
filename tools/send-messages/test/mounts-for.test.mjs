// tools/send-messages/test/mounts-for.test.mjs
//
// The credential mounts a tool named for its job (not for a vendor) must carry: every adapter provider of that channel in
// read-data/message-providers.json contributes its keys, each mounted only when the run's `provider` input names that
// provider (only_when), on the descriptor the provider's row gives. The rows' mounts are derived from the providers' rows,
// so a row that drifts from them, or names a key no provider row holds, fails the test that compares them.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { providers } from '../do-work/send-a-message.mjs';

const byName = (a, b) => a.secret_name.localeCompare(b.secret_name);

/** The mounts the providers of `channel` call for, in a fixed order. */
export function mountsFor(channel) {
  return providers()
    .filter(provider => provider.channel === channel && provider.kind === 'adapter')
    .flatMap(provider => provider.credentials.map(({ secret_name, fd }) => ({ secret_name, fd, only_when: { input: 'provider', equals: provider.id } })))
    .sort(byName);
}

/** A row's credential mounts in the same fixed order. */
export const mountsOf = row => [...row.invoke.credential_mounts].sort(byName);

it('every adapter provider names its keys, and no two providers of a channel share a key name or an id', () => {
  for (const channel of ['email', 'text']) {
    const adapters = providers().filter(provider => provider.channel === channel && provider.kind === 'adapter');
    assert.ok(adapters.length > 0, channel);
    const mounts = mountsFor(channel);
    assert.equal(new Set(mounts.map(mount => mount.secret_name)).size, mounts.length, `${channel}: a key name is shared`);
    assert.equal(new Set(adapters.map(provider => provider.id)).size, adapters.length, `${channel}: an id is shared`);
  }
});
