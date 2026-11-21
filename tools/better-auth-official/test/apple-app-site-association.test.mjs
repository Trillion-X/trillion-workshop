// tools/better-auth-official/test/apple-app-site-association.test.mjs
//
// The association file names the same apps for passkeys (webcredentials) and for links (applinks, with the paths the
// settings list), and nothing at all when the settings name no app. The app IDs are fixtures: the real ones come from
// the settings row, never from this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appleAppSiteAssociation } from '../apple-app-site-association.mjs';

const apps = { webcredentials: ['TEAMID0001.app.example.one', 'TEAMID0001.app.example.two'], applink_paths: ['/file/*'] };

test('the same apps open passkeys and links, for the listed paths', () => {
  assert.deepEqual(appleAppSiteAssociation(apps), {
    webcredentials: { apps: ['TEAMID0001.app.example.one', 'TEAMID0001.app.example.two'] },
    applinks: { details: [{ appIDs: ['TEAMID0001.app.example.one', 'TEAMID0001.app.example.two'], paths: ['/file/*'] }] },
  });
});

test('no applinks block without a listed path', () => {
  assert.deepEqual(appleAppSiteAssociation({ webcredentials: ['TEAMID0001.app.example.two'] }), {
    webcredentials: { apps: ['TEAMID0001.app.example.two'] },
  });
});

test('nothing is served when the settings name no app', () => {
  assert.equal(appleAppSiteAssociation(undefined), null);
  assert.equal(appleAppSiteAssociation({ webcredentials: [], applink_paths: ['/file/*'] }), null);
});
