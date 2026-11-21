// tools/better-auth-official/apple-app-site-association.mjs
//
// Purpose
//   The association file Apple reads at a sign-in's host (GET /.well-known/apple-app-site-association). `webcredentials`
//   names the apps that may use this host's passkeys; `applinks` names the same apps as the ones that open this host's
//   links on their own screens, for the paths `applink_paths` lists (for example /file/*). One list of apps serves both,
//   so an app is never named for one and missing from the other.
//
// Non-negotiable invariants
//   1. The apps come only from settings.apps.webcredentials ("<team id>.<bundle id>" each); nothing here types an app.
//   2. Null when the settings name no app, so the server answers nothing for the path, as before.
//   3. The applinks block is present only when applink_paths names at least one path.

/** The association document for settings.apps, or null when it names no app. */
export function appleAppSiteAssociation(apps) {
  const appIDs = apps?.webcredentials ?? [];
  if (!appIDs.length) return null;
  const paths = apps.applink_paths ?? [];
  const document = { webcredentials: { apps: appIDs } };
  if (paths.length) document.applinks = { details: [{ appIDs, paths }] };
  return document;
}
