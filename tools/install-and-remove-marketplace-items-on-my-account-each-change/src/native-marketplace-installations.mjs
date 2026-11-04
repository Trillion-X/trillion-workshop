// src/native-marketplace-installations.mjs
//
// The account's own Marketplace installations, written in its own records (the workshop facts the native installation
// reads page over: src/native-marketplace-installation-pages.mjs, prefix `marketplace-install:`). Three operations of the
// account's own records resource (src/standalone-resource-behavior.mjs), each one synchronous write receipted with its
// reply (src/behavior-command-readbacks.json receipted_here):
//   marketplace-configurations:install  { installation }                         -> { installation, repeated }
//   marketplace-configurations:remove   { id }                                   -> { removed, repeated }
//   marketplace-configurations:exclude  { installation_id, component_id, expected } -> { removed, repeated, installation? }
//
// Non-negotiable invariants
//   1. An installation is one reference to a published version in this private account. Its context, configuration and
//      pursuit are its identity: the same install again answers the kept row (repeated), never a second row.
//   2. Removal keeps the row with removed_at, so the sequence the reads page over only grows.
//   3. Excluding a component writes only over the exact row the caller checked (expected: the configurationIdentity of its current row, currentInstallRow): a
//      row that changed since is refused (409), so a check made on an older set never removes from a newer one.
import { configurationIdentity } from './marketplace-configurations.mjs';
import { currentInstallRow } from '../../shared-code/src/renamed-tools.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const entityOf = row => row.pursuit_id
  ? `marketplace-install:pursuit:${row.pursuit_id}:${row.configuration_id}`
  : `marketplace-install:${row.configuration_id}`;
const idOf = row => row.pursuit_id
  ? `marketplace-install:pursuit:${row.pursuit_id}:${row.configuration_id}`
  : `marketplace-install:private:${row.configuration_id}`;
const entityFromId = id => {
  if (typeof id !== 'string') return null;
  if (id.startsWith('marketplace-install:private:') && id.length > 'marketplace-install:private:'.length) return `marketplace-install:${id.slice('marketplace-install:private:'.length)}`;
  if (id.startsWith('marketplace-install:pursuit:') && id.length > 'marketplace-install:pursuit:'.length) return id;
  return null;
};

/** value(entity) reads the current fact, put(entity, row) appends one (both synchronous, in the caller's transaction). */
export function nativeMarketplaceInstallations({ value, put, now = () => new Date().toISOString() }) {
  const kept = id => { const entity = entityFromId(id); return entity ? value(entity) : null; };
  return {
    'marketplace-configurations:install': ({ installation } = {}) => {
      if (installation?.context !== 'private' || typeof installation.configuration_id !== 'string' || !installation.configuration_id
          || typeof installation.version !== 'string' || !Array.isArray(installation.components))
        throw fail('Choose a published configuration for your Trillion.');
      if (installation.pursuit_id !== undefined && (typeof installation.pursuit_id !== 'string' || !installation.pursuit_id.startsWith('pursuit:')))
        throw fail('Choose one of your pursuits.');
      if (installation.id !== idOf(installation)) throw fail('This installation does not match its destination.');
      const entity = entityOf(installation), earlier = value(entity);
      if (earlier && !earlier.removed_at) return { installation: earlier, repeated: true };
      put(entity, installation);
      return { installation, repeated: false };
    },
    'marketplace-configurations:remove': ({ id } = {}) => {
      if (!entityFromId(id)) throw fail('Choose one of your private Marketplace installations.');
      const earlier = kept(id);
      if (!earlier || earlier.removed_at || earlier.context !== 'private' || earlier.id !== id) return { removed: false, repeated: true };
      put(entityOf(earlier), { ...earlier, removed_at: now() });
      return { removed: true, repeated: false };
    },
    'marketplace-configurations:exclude': ({ installation_id, component_id, expected } = {}) => {
      if (!entityFromId(installation_id) || typeof component_id !== 'string' || !component_id || typeof expected !== 'string')
        throw fail('Choose an installation, the component to take out, and the installation as you checked it.');
      const row = kept(installation_id);
      if (!row || row.removed_at || row.context !== 'private' || row.id !== installation_id) return { removed: false, repeated: true };
      if ((row.without ?? []).includes(component_id)) return { removed: false, repeated: true, installation: row };
      if (configurationIdentity(currentInstallRow(row)) !== expected) throw fail('This installation changed since it was checked. Check it again.', 409);
      const installation = { ...row, without: [...(row.without ?? []), component_id] };
      put(entityOf(row), installation);
      return { removed: true, repeated: false, installation };
    },
  };
}
