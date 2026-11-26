// tools/send-messages/test/mounts-for.test.mjs
//
// The credential mounts a tool named for its job (not for a vendor) must carry: every adapter provider of that channel in
// read-data/message-providers.json contributes its keys, each mounted only when the run's `provider` input names that
// provider (only_when), on the descriptor the provider's row gives. The rows' mounts are derived from the providers' rows,
// so a row that drifts from them, or names a key no provider row holds, fails the test that compares them.
// A key a provider row marks share_by_listing (a key named by an input, which a share's run opens only by the very name its
// grant lists) carries the mark on its mount.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { providers } from '../do-work/send-a-message.mjs';

const nameOf = mount => mount.secret_name ?? mount.secret_name_from_input;
const byName = (a, b) => nameOf(a).localeCompare(nameOf(b));

/** The mount one credential of a provider's row calls for: its key (by name, or named by an input), its descriptor, only when
 * the run names that provider, and a share_by_listing mark when the row gives one. */
export const mountOf = provider => ({ secret_name, secret_name_from_input, share_by_listing, fd }) => ({
  ...(secret_name ? { secret_name } : { secret_name_from_input }), ...(share_by_listing ? { share_by_listing } : {}), fd,
  only_when: { input: 'provider', equals: provider.id },
});

/** The mounts the providers of `channel` call for, in a fixed order. */
export function mountsFor(channel) {
  return providers()
    .filter(provider => provider.channel === channel && provider.kind === 'adapter')
    .flatMap(provider => provider.credentials.map(mountOf(provider)))
    .sort(byName);
}

/** A row's credential mounts in the same fixed order. */
export const mountsOf = row => [...row.invoke.credential_mounts].sort(byName);

it('every adapter provider names its keys, and no two providers of a channel share a key name or an id', () => {
  for (const channel of ['email', 'text']) {
    const adapters = providers().filter(provider => provider.channel === channel && provider.kind === 'adapter');
    assert.ok(adapters.length > 0, channel);
    const mounts = mountsFor(channel);
    assert.equal(new Set(mounts.map(nameOf)).size, mounts.length, `${channel}: a key name is shared`);
    assert.equal(new Set(adapters.map(provider => provider.id)).size, adapters.length, `${channel}: an id is shared`);
  }
});
