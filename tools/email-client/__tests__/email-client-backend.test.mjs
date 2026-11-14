import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url);
const rootPath = fileURLToPath(root);

// This used to shell out to a bare `tsc` and import the emitted JS from a tmpdir. It could never
// have worked here: TypeScript is not installed in this repo and is not a declared dependency, so
// the call died with `spawnSync tsc ENOENT` before a single assertion ran. That mattered more than
// it looks, because this file and its sibling are the ONLY two .mjs suites named in package.json,
// so `npm run test:email` was the whole of this repo's named .mjs coverage and it was failing at
// import time.
//
// The compile step is deleted rather than repaired. Node strips TypeScript types natively and
// unflagged, so a .ts source imports directly, and the test now exercises the SOURCE rather than a
// separate build of it. Deleted with it: the child-process call, the tmpdir, the mkdir/rm dance,
// the emitted-path rewriting, and a dependency on a binary being globally installed on whichever
// machine happens to run this.
async function loadTs(relativePath) {
  return import(pathToFileURL(join(rootPath, relativePath)).href);
}

const workspaceModule = await loadTs('read-data/read-mail-workspace.ts');
const mailActionModule = await loadTs('do-work/request-mail-action.ts');
const taskModule = await loadTs('do-work/request-task-from-mail.ts');
const statusModule = await loadTs('do-work/request-mail-status-notice.ts');

function communicationFixture(prefix, overrides = {}) {
  const account = `${prefix}:account:primary`;
  const message = `${prefix}:message:1`;
  const thread = `${prefix}:thread:1`;
  const mailbox = `${prefix}:view:priority`;
  return {
    accounts: [
      { address: account, name: `${prefix.toUpperCase()} work`, canRead: true, canSend: !overrides.readOnly },
    ],
    mailboxes: [
      { address: mailbox, label: `${prefix.toUpperCase()} priority`, accountAddress: account, messageAddresses: [message] },
    ],
    actions: [
      {
        id: `${prefix}:action:refresh`,
        role: 'refresh',
        label: overrides.refreshLabel ?? 'Refresh',
        target: `${prefix}:owner:communication`,
        operation: 'communication.refresh',
        values: { amount: overrides.amount ?? 24 },
      },
      {
        id: `${prefix}:action:reply`,
        label: 'Reply',
        target: `${prefix}:owner:communication`,
        operation: 'communication.reply',
        disabledReason: overrides.readOnly ? 'Sending needs account settings.' : undefined,
      },
      {
        id: `${prefix}:action:task`,
        label: 'Make task',
        target: 'owner:tasks',
        operation: 'source.task.create',
      },
    ],
    messages: [
      {
        address: message,
        threadAddress: thread,
        accountAddress: account,
        mailboxAddresses: [mailbox],
        sender: `${prefix.toUpperCase()} sender`,
        recipients: [`${prefix}@example.test`],
        subject: `${prefix.toUpperCase()} follow-up`,
        preview: 'Review this communication and decide the next action.',
        body: 'The source owner already translated this item into the shared work-item shape.',
        unread: Boolean(overrides.unread),
        attachmentCount: 0,
        actionIds: [`${prefix}:action:reply`, `${prefix}:action:task`],
        sourceLink: { address: `${prefix}:source:1`, label: `${prefix.toUpperCase()} source` },
      },
    ],
    threads: [
      {
        address: thread,
        messageAddresses: [message],
        actionIds: [`${prefix}:action:reply`, `${prefix}:action:task`],
      },
    ],
    statuses: overrides.statusLabel ? [
      {
        address: `${prefix}:status:attention`,
        accountAddress: account,
        label: overrides.statusLabel,
        actionIds: [`${prefix}:action:refresh`],
      },
    ] : [],
    selectedAddress: message,
    selectedMailboxAddress: mailbox,
  };
}

const empty = workspaceModule.readMailWorkspace();
assert.equal(empty.emptyReason, 'no-accounts');
assert.equal(empty.selectedThread, null);

const providerA = workspaceModule.readMailWorkspace(communicationFixture('a', {
  unread: true,
  statusLabel: 'Source A needs attention.',
}));
const providerB = workspaceModule.readMailWorkspace(communicationFixture('b', {
  readOnly: true,
  refreshLabel: 'Update feed',
  amount: 48,
}));

for (const workspace of [providerA, providerB]) {
  assert.equal(workspace.accounts.length, 1);
  assert.equal(workspace.mailboxes.length, 1);
  assert.equal(workspace.messageRows.length, 1);
  assert.equal(workspace.selectedThread.messages.length, 1);
  assert.equal(workspace.selectedThread.actions.length, 2);
  assert.equal(workspace.emptyReason, null);
}

assert.equal(providerA.messageRows[0].subject, 'A follow-up');
assert.equal(providerB.actionsById['b:action:refresh'].label, 'Update feed');
assert.equal(providerB.actionsById['b:action:reply'].disabledReason, 'Sending needs account settings.');

const refreshRequest = mailActionModule.buildMailActionRequest({
  action: providerB.actionsById['b:action:refresh'],
  workItemAddress: providerB.messageRows[0].address,
  accountAddress: providerB.accounts[0].address,
  threadAddress: providerB.selectedThread.thread.address,
  correlationId: 'correlation:refresh',
});
assert.equal(refreshRequest.target, 'b:owner:communication');
assert.equal(refreshRequest.payload.operation, 'communication.refresh');
assert.deepEqual(refreshRequest.payload.values, { amount: 48 });

const workflowRequest = mailActionModule.buildMailActionRequest({
  action: {
    id: 'a:action:owner',
    label: 'Owner action',
    target: 'slot::workflow',
    definition_id: 'action:email-client.owner-action',
    operation: 'communication.owner-action',
  },
  workItemAddress: providerA.messageRows[0].address,
  accountAddress: providerA.accounts[0].address,
  threadAddress: providerA.selectedThread.thread.address,
  correlationId: 'correlation:workflow',
});
assert.equal(workflowRequest.target, 'slot::workflow');
assert.equal(workflowRequest.payload.operation, 'execute_definition');
assert.equal(workflowRequest.payload.definition_id, 'action:email-client.owner-action');
assert.equal(workflowRequest.payload.input.operation, 'communication.owner-action');

const blocked = mailActionModule.buildMailActionRequest({
  action: providerB.actionsById['b:action:reply'],
  workItemAddress: providerB.messageRows[0].address,
  accountAddress: providerB.accounts[0].address,
  threadAddress: providerB.selectedThread.thread.address,
  correlationId: 'correlation:blocked',
});
assert.deepEqual(blocked, { disabledReason: 'Sending needs account settings.' });

const taskRequest = taskModule.buildTaskFromMailRequest({
  target: 'owner:tasks',
  operation: 'source.task.create',
  selectedWorkItemAddress: providerA.messageRows[0].address,
  sourceLabel: providerA.messageRows[0].sourceLink.label,
  title: 'Follow up on source A',
  body: providerA.messageRows[0].preview,
  correlationId: 'correlation:task',
});
assert.equal(taskRequest.payload.source.address, providerA.messageRows[0].address);
assert.equal(JSON.stringify(taskRequest).includes('published-record'), false);

const status = statusModule.buildMailStatusNotice({
  target: 'owner:notifications',
  operation: 'notice.show',
  statusAddress: 'status:send-failed',
  accountName: 'Team',
  messageAddress: providerB.messageRows[0].address,
  label: 'Retry send from Account settings.',
  actionIds: ['action:repair-team-account'],
  correlationId: 'correlation:notice',
});
assert.equal(status.request.target, 'owner:notifications');
assert.equal(status.visibleStatus.label, 'Team: Retry send from Account settings.');
assert.throws(() => statusModule.assertHumanMailStatus('OAuth token failed'));

const packageContract = JSON.parse(readFileSync(join(rootPath, 'things-to-store-and-run.json'), 'utf8'));
const addresses = packageContract.things.map((thing) => thing.address).filter(Boolean);
assert.ok(addresses.includes('package::email-client::input::communication-work-items'));
assert.ok(addresses.includes('communication-work-items'));
assert.ok(addresses.includes('package::email-client::workflow-action::owner-action'));
assert.ok(addresses.includes('package::email-client::contract::communication-work-items'));
assert.equal(addresses.some((address) => /sync-google-mail|fetch-gmail-message|service-connections/.test(address)), false);

const communicationInput = packageContract.things.find(
  (thing) => thing.address === 'package::email-client::input::communication-work-items',
);
const communicationContract = packageContract.things.find(
  (thing) => thing.address === 'package::email-client::contract::communication-work-items',
);
const ownerAction = packageContract.things.find(
  (thing) => thing.address === 'package::email-client::workflow-action::owner-action',
);
assert.equal(communicationInput.payload.kind, 'bitfield-input-descriptor');
assert.equal(communicationInput.payload.input_name, 'communication-work-items');
assert.equal(communicationInput.payload.value_address_label, 'communication-work-items');
assert.equal(communicationInput.payload.value.source_bytes.bytes_to_value, 'cell_table');
assert.equal(communicationInput.payload.value.projection.op, 'rows');
assert.ok(Array.isArray(communicationInput.payload.value.projection.fields));
assert.ok(communicationInput.payload.value.projection.fields.some((field) => field.key === 'address'));
assert.equal(communicationContract.payload.kind, 'communication-work-item-contract');
assert.ok(communicationContract.payload.owns.includes('communication workspace projection'));
assert.ok(communicationContract.payload.does_not_own.includes('service/provider transport'));
assert.equal(ownerAction.payload.id, 'action:email-client.owner-action');
assert.equal(ownerAction.payload.is_active, true);

function collectFiles(dir, extensionPattern, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      // `data/` holds task deployment proof artifacts (staged write-batch payloads,
      // deployment receipts, run logs) — proof, not shipped source, same reason
      // __tests__/ is skipped above.
      if (name === '__tests__' || name === 'data') continue;
      collectFiles(path, extensionPattern, out);
    } else if (extensionPattern.test(name) && !/\.test\.(ts|tsx|js|mjs)$/.test(name)) {
      // Test files assert the ABSENCE of forbidden vocabulary by quoting it in
      // negative regexes — they are proof, not shipped source, so the scan
      // skips them (same reason __tests__/ dirs are skipped above).
      out.push(path);
    }
  }
  return out;
}

// Compiled/shipped SOURCE (.ts/.tsx/.js) must never name another package's
// vocabulary or do its own backend transport work — that is the god-package
// violation this scan exists to catch (see CLAUDE.md "No God Package").
const forbiddenInSource = /Gmail|gmail|Google|google|OAuth|oauth|refresh_token|oauth_client|gmail\.googleapis|mail\.google|requestGoogleMailSync|GOOGLE_MAIL_SYNC_ACTION|sync-google-mail|fetch-gmail-message|service-connections|SERVICE_CONNECTION_COLUMNS/;
for (const path of collectFiles(rootPath, /\.(ts|tsx|js)$/)) {
  const source = readFileSync(path, 'utf8');
  assert.equal(forbiddenInSource.test(source), false, `forbidden backend vocabulary in ${path}`);
}

// things-to-store-and-run.json (and other package-root JSON) is the DATA/Envelope
// wiring layer, not shipped source — a record may legitimately dispatch an
// Envelope address at another package (e.g. `target: "service-connections.settings"`
// on a "Add account" action) per CLAUDE.md's DATA-wiring exception, and may
// legitimately carry generic product vocabulary a user would type or read (e.g.
// "gmail" in a surface-picker search-vocabulary list — user language, not backend
// implementation). What DATA must never carry is this package doing its own
// Gmail/OAuth transport work: real API domains, credential/token identifiers, or
// hardcoded action names for a sync it has no business owning.
const forbiddenInData = /OAuth|oauth|refresh_token|oauth_client|gmail\.googleapis|mail\.google|requestGoogleMailSync|GOOGLE_MAIL_SYNC_ACTION|sync-google-mail|fetch-gmail-message|SERVICE_CONNECTION_COLUMNS/;
for (const path of collectFiles(rootPath, /\.json$/)) {
  const source = readFileSync(path, 'utf8');
  assert.equal(forbiddenInData.test(source), false, `forbidden backend vocabulary in ${path}`);
}
assert.equal(existsSync(join(rootPath, 'do-work/sync-google-mail.ts')), false);

function countMalformedStepSelects(value) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((count, item) => count + countMalformedStepSelects(item), 0);
  const current = value.$kind === 'binding'
    && value.select
    && value.select.path
    && typeof value.select.path === 'object'
    && !Array.isArray(value.select.path)
    ? 1
    : 0;
  return current + Object.values(value).reduce((count, item) => count + countMalformedStepSelects(item), 0);
}
assert.equal(countMalformedStepSelects(packageContract), 0);

console.log('email-client generic backend proof passed');
