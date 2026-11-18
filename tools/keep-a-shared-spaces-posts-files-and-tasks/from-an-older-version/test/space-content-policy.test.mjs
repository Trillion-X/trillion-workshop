import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  acceptPolicyPage, captureContentPolicyEpoch, contentFence, contentPolicyStatus, contentPolicyStatusPage, contentPublish,
  policyManifest, policyPage, policyRows, policyTablesToStage, publishPolicy, setupContentPolicy,
  withContentInvocation, withFencedContentInvocation, ensureContentPolicyCurrentIfActive,
} from '../src/space-content-policy.mjs';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...bindings) {
    const statement = db.prepare(query);
    const rows = /^\s*(select|pragma)/i.test(query) ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => rows.map(row => ({ ...row })) };
  } };
  return { sql, close: () => db.close() };
}

function sourceSchema(sql) {
  for (const statement of [
    'CREATE TABLE space_tool_grants (grant_id TEXT PRIMARY KEY, space_id TEXT)',
    'CREATE TABLE match_settings (community_id TEXT, relay TEXT, PRIMARY KEY(community_id,relay))',
    'CREATE TABLE match_rounds (id TEXT PRIMARY KEY, community_id TEXT)',
    'CREATE TABLE matches (id TEXT PRIMARY KEY, community_id TEXT)',
    'CREATE TABLE match_asks (round_id TEXT, relay TEXT, PRIMARY KEY(round_id,relay))',
    'CREATE TABLE memberships (id TEXT PRIMARY KEY, label TEXT NOT NULL, title TEXT, created_by TEXT, created_at TEXT, parent_id TEXT)',
    'CREATE TABLE members (membership_id TEXT NOT NULL, relay TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL, changed_at TEXT NOT NULL, PRIMARY KEY (membership_id, relay))',
    'CREATE TABLE communities (id TEXT PRIMARY KEY, config TEXT NOT NULL)',
    'CREATE TABLE space_rules (space_id TEXT PRIMARY KEY, rules TEXT NOT NULL, changed_at TEXT NOT NULL)',
    'CREATE TABLE space_member_types (space_id TEXT NOT NULL, type_id TEXT NOT NULL, label TEXT NOT NULL, added_by TEXT NOT NULL, added_at TEXT NOT NULL, inherits TEXT NOT NULL, PRIMARY KEY (space_id, type_id))',
    'CREATE TABLE space_show_rule_types (space_id TEXT PRIMARY KEY, types TEXT NOT NULL)',
    'CREATE TABLE relays (relay TEXT PRIMARY KEY, person_ref TEXT NOT NULL, account_name TEXT)',
    'CREATE TABLE relay_holds (relay TEXT PRIMARY KEY, holds TEXT NOT NULL)',
    'CREATE TABLE space_state (space_id TEXT PRIMARY KEY, last_activity_at TEXT NOT NULL, joins_as TEXT, share_generation INTEGER NOT NULL DEFAULT 0)',
  ]) sql.exec(statement);
  sql.exec("INSERT INTO memberships VALUES ('root','community','Root','owner','t0',NULL),('child','project','Child','owner','t1','root'),('unrelated','project','Other','owner','t2',NULL)");
  sql.exec("INSERT INTO members VALUES ('root','r1','member','member','t0'),('child','r1','member','member','t1'),('unrelated','r2','member','member','t2')");
  sql.exec("INSERT INTO communities VALUES ('root','{}'),('unrelated','{}')");
  sql.exec("INSERT INTO space_rules VALUES ('root','[]','t0'),('child','[]','t1'),('unrelated','[]','t2')");
  sql.exec("INSERT INTO space_member_types VALUES ('root','root-type','Root type','r1','t0','[]'),('child','child-type','Child type','r1','t1','[]'),('unrelated','other-type','Other type','r2','t2','[]')");
  sql.exec("INSERT INTO space_show_rule_types VALUES ('root','[]'),('child','[]'),('unrelated','[]')");
  sql.exec("INSERT INTO relays VALUES ('r1','person-1','One'),('r2','person-2','Two')");
  sql.exec("INSERT INTO relay_holds VALUES ('r1','[]'),('r2','[]')");
  sql.exec("INSERT INTO space_state VALUES ('root','t0','join-root',8),('child','t1','join-child',9)");
}

function transferAll(source, target, spaceId, revision) {
  const manifest = policyManifest(source, spaceId);
  for (const table of policyTablesToStage(manifest)) {
    let cursor = 0;
    do {
      const page = policyPage(source, spaceId, table, cursor, 1);
      acceptPolicyPage(target, { spaceId, revision, manifest, table, ...page });
      cursor = page.nextCursor ?? cursor;
      if (page.done) break;
    } while (true);
  }
  return manifest;
}

test('explicit zero policy counts clear previously published grants without an empty page', () => {
  const source = sqlite(), target = sqlite();
  try {
    sourceSchema(source.sql); sourceSchema(target.sql); setupContentPolicy(target.sql);
    source.sql.exec("INSERT INTO space_tool_grants VALUES ('grant-1','child')");
    const original = transferAll(source.sql, target.sql, 'child', 'with-grant');
    publishPolicy(target.sql, { spaceId: 'child', revision: 'with-grant', manifest: original });
    assert.equal(target.sql.exec('SELECT COUNT(*) AS n FROM space_tool_grants').toArray()[0].n, 1);
    source.sql.exec('DELETE FROM space_tool_grants');
    const next = transferAll(source.sql, target.sql, 'child', 'without-grant');
    assert.equal(next.tables.space_tool_grants, 0);
    assert.ok(!policyTablesToStage(next).includes('space_tool_grants'));
    assert.equal(target.sql.exec("SELECT COUNT(*) AS n FROM content_policy_page_receipts WHERE revision='without-grant' AND table_name='space_tool_grants'").toArray()[0].n, 0);
    publishPolicy(target.sql, { spaceId: 'child', revision: 'without-grant', manifest: next });
    assert.deepEqual(policyRows(target.sql, 'child', 'space_tool_grants'), []);
    assert.equal(target.sql.exec('SELECT COUNT(*) AS n FROM space_tool_grants').toArray()[0].n, 0);
    assert.equal(policyRows(target.sql, 'child', 'members').length, 2);
  } finally { source.close(); target.close(); }
});

test('a page of the revision already published is a replay and keeps the active rows', () => {
  const source = sqlite(), target = sqlite();
  try {
    sourceSchema(source.sql); sourceSchema(target.sql); setupContentPolicy(target.sql);
    const manifest = transferAll(source.sql, target.sql, 'child', 'published');
    publishPolicy(target.sql, { spaceId: 'child', revision: 'published', manifest });
    const before = policyRows(target.sql, 'child', 'members');
    const page = policyPage(source.sql, 'child', 'members', 0);
    assert.equal(acceptPolicyPage(target.sql, { spaceId: 'child', revision: 'published', manifest, table: 'members', ...page }).replay, true);
    assert.deepEqual(policyRows(target.sql, 'child', 'members'), before);
    assert.equal(publishPolicy(target.sql, { spaceId: 'child', revision: 'published', manifest }).replay, true);
  } finally { source.close(); target.close(); }
});

test('an entirely empty policy snapshot stages one page and removes the previous chain', () => {
  const source = sqlite(), target = sqlite();
  try {
    sourceSchema(source.sql); sourceSchema(target.sql); setupContentPolicy(target.sql);
    const original = transferAll(source.sql, target.sql, 'child', 'populated');
    publishPolicy(target.sql, { spaceId: 'child', revision: 'populated', manifest: original });
    source.sql.exec('DELETE FROM memberships');
    const empty = transferAll(source.sql, target.sql, 'child', 'empty');
    assert.ok(Object.values(empty.tables).every(count => count === 0));
    assert.equal(target.sql.exec("SELECT COUNT(*) AS n FROM content_policy_page_receipts WHERE revision='empty'").toArray()[0].n, 1);
    publishPolicy(target.sql, { spaceId: 'child', revision: 'empty', manifest: empty });
    for (const table of Object.keys(empty.tables)) assert.deepEqual(policyRows(target.sql, 'child', table), []);
    assert.equal(target.sql.exec("SELECT COUNT(*) AS n FROM memberships WHERE id IN ('root','child')").toArray()[0].n, 0);
    assert.equal(target.sql.exec("SELECT COUNT(*) AS n FROM members WHERE membership_id IN ('root','child')").toArray()[0].n, 0);
  } finally { source.close(); target.close(); }
});

test('policy pages stay bounded and scope rows to the exact Space and its ancestor chain', () => {
  const source = sqlite();
  try {
    sourceSchema(source.sql);
    const manifest = policyManifest(source.sql, 'child');
    assert.equal(manifest.tables.memberships, 2);
    assert.equal(manifest.tables.members, 2);
    assert.equal(manifest.tables.communities, 1);
    assert.equal(manifest.tables.relays, 1);
    const first = policyPage(source.sql, 'child', 'memberships', 0, 1);
    assert.deepEqual(first.rows, [{ id: 'child', label: 'project', title: 'Child', created_by: 'owner', created_at: 't1', parent_id: 'root' }]);
    assert.equal(first.cursor, 0);
    assert.equal(first.done, false);
    assert.equal(typeof first.nextCursor, 'string');
    assert.deepEqual(policyPage(source.sql, 'child', 'memberships', first.nextCursor, 1).rows.map(row => row.id), ['root']);
    assert.throws(() => policyPage(source.sql, 'root', 'memberships', first.nextCursor, 1), /does not match/);
    assert.throws(() => policyPage(source.sql, 'child', 'memberships', 0, 101), /1 to 100/);
  } finally { source.close(); }
});

test('policy page keyset does not repeat an earlier row after a source deletion', () => {
  const source = sqlite();
  try {
    sourceSchema(source.sql);
    const first = policyPage(source.sql, 'child', 'members', 0, 1);
    source.sql.exec("DELETE FROM members WHERE membership_id = 'child' AND relay = 'r1'");
    const second = policyPage(source.sql, 'child', 'members', first.nextCursor, 1);
    assert.deepEqual(second.rows.map(row => row.membership_id), ['root']);
    assert.equal(second.cursor, 1);
    assert.equal(second.done, true);
  } finally { source.close(); }
});

test('status pages bound each query while full status keeps every Space', () => {
  const target = sqlite();
  try {
    setupContentPolicy(target.sql);
    for (const spaceId of ['a', 'b', 'c']) target.sql.exec('INSERT INTO content_policy_meta (space_id, active_revision) VALUES (?, ?)', spaceId, 'rev-1');
    const first = contentPolicyStatusPage(target.sql, '', 2);
    assert.deepEqual(first.rows.map(row => row.space_id), ['a', 'b']);
    assert.equal(first.nextCursor, 'b');
    assert.deepEqual(contentPolicyStatusPage(target.sql, first.nextCursor, 2).rows.map(row => row.space_id), ['c']);
    assert.deepEqual(contentPolicyStatus(target.sql).map(row => row.space_id), ['a', 'b', 'c']);
    assert.throws(() => captureContentPolicyEpoch({ sql: target.sql }), /Space id is required/);
    assert.equal(captureContentPolicyEpoch({ sql: target.sql }, 'c'), 0);
  } finally { target.close(); }
});

test('a snapshot becomes visible only after every manifest table is staged', () => {
  const source = sqlite(), target = sqlite();
  try {
    sourceSchema(source.sql);
    sourceSchema(target.sql);
    setupContentPolicy(target.sql);
    const manifest = transferAll(source.sql, target.sql, 'child', 'rev-1');
    // An incomplete alternate revision cannot replace the previously published one.
    publishPolicy(target.sql, { spaceId: 'child', revision: 'rev-1', manifest });
    assert.equal(policyRows(target.sql, 'child', 'memberships').length, 2);
    assert.deepEqual(policyRows(target.sql, 'child', 'space_state'), [
      { space_id: 'child', joins_as: 'join-child' }, { space_id: 'root', joins_as: 'join-root' },
    ]);
    assert.equal(contentPolicyStatus(target.sql, 'child').active_revision, 'rev-1');
    source.sql.exec("UPDATE memberships SET title = 'Refreshed' WHERE id = 'child'");
    const nextManifest = policyManifest(source.sql, 'child');
    const firstPage = policyPage(source.sql, 'child', 'memberships', 0, 1);
    acceptPolicyPage(target.sql, { spaceId: 'child', revision: 'rev-2', manifest: nextManifest, table: 'memberships', ...firstPage });
    assert.throws(() => publishPolicy(target.sql, { spaceId: 'child', revision: 'rev-2', manifest: nextManifest }), /incomplete/);
    assert.equal(policyRows(target.sql, 'child', 'memberships').find(row => row.id === 'child').title, 'Child');
    const rest = policyPage(source.sql, 'child', 'memberships', firstPage.nextCursor, 1);
    acceptPolicyPage(target.sql, { spaceId: 'child', revision: 'rev-2', manifest: nextManifest, table: 'memberships', ...rest });
    for (const table of Object.keys(nextManifest.tables).filter(name => name !== 'memberships')) {
      const page = policyPage(source.sql, 'child', table, 0, 100);
      acceptPolicyPage(target.sql, { spaceId: 'child', revision: 'rev-2', manifest: nextManifest, table, ...page });
    }
    publishPolicy(target.sql, { spaceId: 'child', revision: 'rev-2', manifest: nextManifest });
    assert.equal(policyRows(target.sql, 'child', 'memberships').find(row => row.id === 'child').title, 'Refreshed');
  } finally { source.close(); target.close(); }
});

test('a durable fence blocks new invocations and waits for old effects before acknowledgement', async () => {
  const source = sqlite(), target = sqlite();
  try {
    sourceSchema(source.sql); sourceSchema(target.sql); setupContentPolicy(target.sql);
    const manifest = transferAll(source.sql, target.sql, 'child', 'rev-1');
    publishPolicy(target.sql, { spaceId: 'child', revision: 'rev-1', manifest });
    const owner = { sql: target.sql };
    let finish;
    let settled = false;
    const invocation = withContentInvocation(owner, 'child', async ({ assertCurrent }) => {
      await new Promise(resolve => { finish = resolve; });
      assertCurrent();
      settled = true;
    });
    await Promise.resolve();
    const fencing = contentFence(owner, { id: 'fence-1', spaceId: 'child', manifest });
    await assert.rejects(withContentInvocation(owner, 'child', async () => {}), /fenced/);
    await Promise.resolve();
    assert.equal(settled, false);
    finish();
    await assert.rejects(invocation, /policy changed during this invocation/);
    const fence = await fencing;
    assert.equal(fence.fenced, true);
    assert.equal(settled, false);
    assert.deepEqual(contentPolicyStatus(target.sql, 'child').fenced, 1);
    // Re-stage the matching snapshot under a new revision, then publish the exact fence.
    const refresh = transferAll(source.sql, target.sql, 'child', 'rev-2');
    assert.equal(contentPublish(owner, { id: 'fence-1', epoch: fence.epoch, manifest: refresh, fence }).published, true);
    assert.equal(contentPolicyStatus(target.sql, 'child').fenced, 0);
  } finally { source.close(); target.close(); }
});


test('the SQL policy guard admits only its exact coordinated fence and rejects replacement during an await',async()=>{
 const source=sqlite(),target=sqlite();
 try{
  sourceSchema(source.sql);sourceSchema(target.sql);setupContentPolicy(target.sql);
  const manifest=transferAll(source.sql,target.sql,'child','rev-1');publishPolicy(target.sql,{spaceId:'child',revision:'rev-1',manifest});
  const owner={sql:target.sql};
  const fence=await contentFence(owner,{id:'coordinated',spaceId:'child',manifest});
  await withFencedContentInvocation(owner,'child',fence,()=>{
   assert.equal(ensureContentPolicyCurrentIfActive(owner),true);
   owner.sql.exec("UPDATE space_state SET last_activity_at='coordinated' WHERE space_id='child'");
  });
  await assert.rejects(withContentInvocation(owner,'child',()=>ensureContentPolicyCurrentIfActive(owner)),/fenced/);
  await assert.rejects(withFencedContentInvocation(owner,'child',{...fence,id:'other'},()=>{}),/lost its policy fence/);
  await withFencedContentInvocation(owner,'child',fence,async()=>{
   await Promise.resolve();
   target.sql.exec("UPDATE content_policy_meta SET next_epoch=next_epoch+1 WHERE space_id='child'");
   assert.throws(()=>ensureContentPolicyCurrentIfActive(owner),/changed during this invocation/);
  });
 }finally{source.close();target.close();}
});
