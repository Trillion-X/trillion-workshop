// src/private-sites.mjs
//
// PURPOSE
//   An account's private Sites (public_app_installations rows whose context is the account itself) and what their
//   visitors leave (page views, form answers): one set of operations over whichever SQLite holds the account's own
//   records. Before its own-record carry that is its PersonStore; after it, the account's own records book (@own-records),
//   whose Sites mount answers them (src/native-public-apps.mjs).
//
//   const sites = privateSiteOperations({ sql, eeaf, transaction, ownerUserId, bindOwner, ownsUser });
//   sites.installations()   sites.installation(id)   sites.install(input)   sites.updateDefinition(input)
//   sites.setLive(id, live) sites.records(id, options) sites.analytics(id, options)
//   sites.recordAction(input) sites.recordPageView(input)
//
// NON-NEGOTIABLE INVARIANT
//   The rules stay where they are (src/public-app-records.mjs, src/public-app-analytics.mjs,
//   src/public-app-record-bridge.mjs); this module only names the operations, so the store and the book answer alike.
import { installPublicApp, publicAppInstallation, privatePublicAppInstallations, setPublicAppInstallationLive } from '../../shared-code/src/public-app-records.mjs';
import { privatePublicAppRecords, recordPrivatePublicAppAction } from './public-app-record-bridge.mjs';
import { indexPublicAppSubmission, publicAppAnalytics, recordPublicAppPageView, updatePublicAppInstallationDefinition } from '../../shared-code/src/public-app-analytics.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const SUBMISSION_PAGE = 200;

/** The private Sites operations over one account's own-record SQL. `ownerUserId()` reads the account's user id,
 *  `bindOwner(userId)` records it the first time a Site is installed, and `ownsUser(userId)` says whether that user's
 *  account is the one these records belong to. */
export function privateSiteOperations({ sql, eeaf, transaction, ownerUserId, bindOwner, ownsUser }) {
  const installation = id => publicAppInstallation(sql, id);
  return {
    installations() {
      const owner = ownerUserId();
      return owner ? privatePublicAppInstallations(sql, owner) : [];
    },
    installation,
    install({ installation_id, definition, owner_user_id, live = true }) {
      if (!owner_user_id || !ownsUser(owner_user_id)) throw fail('This app cannot be installed in another account.');
      const owner = ownerUserId() ?? owner_user_id;
      if (owner !== owner_user_id) throw fail('This app cannot be installed in another account.');
      if (!ownerUserId()) bindOwner(owner_user_id);
      return installPublicApp(sql, { installation_id, definition, context: { kind: 'private', id: owner }, installed_by: owner, live });
    },
    updateDefinition: input => updatePublicAppInstallationDefinition(sql, input),
    setLive: (id, live) => setPublicAppInstallationLive(sql, id, live),
    records: (id, options) => privatePublicAppRecords({ installation: installation(id), eeaf, ...options }),
    analytics(id, options = {}) {
      const found = installation(id);
      if (!found || found.context.kind !== 'private') throw fail('That app installation was not found.', 404);
      // Only this installation's answers are read: each is kept at record:<kind>:public-app:<installation>:<key>
      // (src/public-app-record-bridge.mjs), so its prefix names them, a page at a time.
      const submissions = [];
      const kinds = new Set(found.definition.actions.map(action => action.record_kind));
      for (const kind of kinds) {
        const prefix = `record:${kind}:public-app:${id}:`;
        for (let before, page; !page || page.length === SUBMISSION_PAGE; before = page.at(-1)) {
          page = eeaf.ids(`record:${kind}`, { prefix, before, limit: SUBMISSION_PAGE });
          for (const recordId of page.filter(recordId => recordId.startsWith(prefix))) {
            const value = eeaf.read(recordId);
            if (value?._public_app?.installation_id === id && value._public_app.received_at) submissions.push({ record_id: value._public_app.record_id, received_at: value._public_app.received_at });
          }
        }
      }
      return publicAppAnalytics(sql, id, { ...options, submissions });
    },
    recordAction(input) {
      const saved = recordPrivatePublicAppAction({ installation: installation(input.installation_id), input, eeaf, transaction });
      indexPublicAppSubmission(sql, { installation_id: input.installation_id, ...saved });
      return saved;
    },
    recordPageView: input => recordPublicAppPageView(sql, input),
  };
}
