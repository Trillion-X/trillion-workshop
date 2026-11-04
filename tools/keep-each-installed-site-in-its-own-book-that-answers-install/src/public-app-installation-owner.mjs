// One public app installation as its own owner, addressed { kind: 'public-app-installation', key: <installation id> }
// (src/resource-placement.json). The installation row (public_app_installations) lives in this owner's own SQLite, one
// row per book, and the owner answers the installation's operations: install, read, setLive and importRow. The row's
// rules are the ones src/public-app-records.mjs already checks; this module only places them in the owner's store.
//
//   const owner = publicAppInstallationOwner({ sql, installationId });
//   await owner.handle(operation, input, { claims })     operation: install | read | setLive | importRow
//
// importRow is the operator's one-time import of a retiring PersonStore's row (src/records-import.mjs pattern): only the
// operator-import service actor writes it, the row must be the one the export manifest identifies by BLAKE3, an
// installation this owner already holds is never overwritten (409 unless identical), and the same row again is a no-op.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { installPublicApp, publicAppInstallation, setPublicAppInstallationLive, setUpPublicAppRecords } from '../../shared-code/src/public-app-records.mjs';
import routes from '../../shared-code/src/public-app-installation.json' with { type: 'json' };

const KIND = routes.kind;
const ID = /^[a-f0-9]{32}$/;
const COLUMNS = ['id', 'definition', 'context_kind', 'context_id', 'installed_by', 'status', 'installed_at', 'ended_at'];
const fail = (message, status, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

/** The address of one installation's owner. */
export const publicAppInstallationAddress = installationId => ({ kind: KIND, key: installationId });

/** The BLAKE3 identity of one installation row as the retiring store's export lists it (its columns, in order). */
export const publicAppInstallationRowIdentity = row => bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(
  stable(Object.fromEntries(COLUMNS.map(column => [column, row[column] ?? null])))))));

export function publicAppInstallationOwner({ sql, installationId }) {
  if (typeof installationId !== 'string' || !ID.test(installationId)) throw fail('An installation is addressed by its id.', 400);
  setUpPublicAppRecords(sql);
  const held = () => sql.exec('SELECT * FROM public_app_installations WHERE id = ? LIMIT 1', installationId).toArray()[0] ?? null;
  const importRow = ({ row, identity }, { claims }) => {
    if (claims?.sign_in !== 'service:operator-import') throw fail('Only the operator import writes an installation row.', 403);
    if (!object(row) || row.id !== installationId) throw fail('The row names another installation.', 400);
    if (publicAppInstallationRowIdentity(row) !== identity) throw fail('The row does not match its export identity.', 400, { code: 'row_identity_mismatch' });
    const earlier = held();
    if (earlier) {
      if (publicAppInstallationRowIdentity(earlier) === identity) return { installation_id: installationId, identical: true };
      throw fail('This installation is already held here; an import never overwrites it.', 409, { held: [installationId] });
    }
    sql.exec(`INSERT INTO public_app_installations (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
      ...COLUMNS.map(column => row[column] ?? null));
    return { installation_id: installationId, identical: false };
  };
  const operations = {
    install: input => {
      if (input?.installation_id !== installationId) throw fail('The installation names another id.', 400);
      return installPublicApp(sql, { installation_id: installationId, definition: input.definition, context: input.context, installed_by: input.installed_by, live: input.live });
    },
    read: () => publicAppInstallation(sql, installationId),
    setLive: input => setPublicAppInstallationLive(sql, installationId, input?.live),
    importRow: importRow,
    // The account deletion asks the installation its account installed (src/account-app-state-erasure.mjs): its row goes, once the
    // deletion's own authority names the account that installed it. Erasing a row that is already gone changes nothing.
    eraseInstallation: (input, { authority } = {}) => {
      if (input?.installation_id !== installationId) throw fail('The installation names another id.', 400);
      if (!authority || typeof authority.owner !== 'string' || !authority.owner) throw fail('Erasing an installation needs the account deletion that asks for it.', 403);
      const earlier = held();
      if (earlier && earlier.installed_by !== authority.owner) throw fail('This installation was installed by another account.', 403);
      // A Space's installation serves its other members too: the installer's deletion does not end it. Its Space's owner
      // takes it over, so this row stays and the answer names the Space.
      if (earlier?.context_kind === 'space') return { installation_id: installationId, erased: false, handed_to_space: earlier.context_id };
      sql.exec('DELETE FROM public_app_installations WHERE id = ?', installationId);
      return { installation_id: installationId, erased: true };
    },
  };
  return {
    handle(operation, input = {}, context = {}) {
      if (!Object.hasOwn(operations, operation)) throw fail(`The installation has no operation ${operation}.`, 404);
      return operations[operation](input, context);
    },
  };
}
