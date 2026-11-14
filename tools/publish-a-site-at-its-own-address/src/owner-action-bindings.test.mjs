import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildOwnerActionInvocation, assertNoOwnerInternals } from './owner-action-bindings.mjs';

const root = new URL('..', import.meta.url);
const rootPath = new URL('..', import.meta.url).pathname;
const contract = JSON.parse(readFileSync(new URL('../things-to-store-and-run.json', import.meta.url), 'utf8'));
const config = contract.things.find((thing) => thing.address === 'public-site-publisher.configured-record-action-projection').payload;

const subject = {
  subject_ref: 'record/public-site-publisher/site/1',
  fields: {
    selected_content_ref: 'content:docs:1',
    last_render_ref: 'render:1',
    external_address: 'https://example.test/site',
  },
};

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(mjs|js|ts|tsx|json)$/.test(name) ? [path] : [];
  });
}

function runUnit() {
  const request = buildOwnerActionInvocation({
    config,
    actionRef: 'action:public-site-publisher.request-content-update',
    subject,
    context: { correlation_ref: 'correlation:update' },
  });
  assert.equal(request.errors.length, 0);
  assert.equal(request.targetRequests[0].target, 'slot::workflow');
  assert.equal(request.targetRequests[0].payload.method, 'execute_definition');
  assert.equal(request.targetRequests[0].payload.definition_id, 'package::public-document-site::workflow-action::render-on-publish');
  assert.deepEqual(request.targetRequests[0].payload.input, {
    site_ref: 'record/public-site-publisher/site/1',
    content_ref: 'content:docs:1',
    correlation_ref: 'correlation:update',
  });
  assert.equal(request.effectReceiptSeed.effect_role, 'package-data/public-site-publisher/effect-roles/update-result');
  assertNoOwnerInternals(request);
  console.log('[public-site-publisher] owner action binding ok');
}

function runOwnerActions() {
  const ownerAddresses = new Set([
    'package::public-document-renderer::workflow-action::render-and-publish',
    'package::hosted-public-app::workflow-action::publish-live-site',
    'package::public-document-site::workflow-action::render-on-publish',
    'package::service-connections::workflow-action::verify-service-credential',
  ]);
  const actionDefinitions = config.action_bindings.map((action) => action.definition_id);
  assert.deepEqual(new Set(actionDefinitions), ownerAddresses);
  for (const action of config.action_bindings) {
    const request = buildOwnerActionInvocation({
      config,
      actionRef: action.id,
      subject,
      context: { correlation_ref: `correlation:${action.id}` },
    });
    assert.equal(request.errors.length, 0);
    assert.equal(request.targetRequests[0].target, 'slot::workflow');
    assertNoOwnerInternals(request);
  }
  console.log('[public-site-publisher] workflow/process primitive reuse ok');
}

function runNoImports() {
  const forbiddenImport = /from\s+['"][^'"]*(hosted-public-app|public-document-renderer|public-document-site|http-client|credentials-vault|service-connections|workflow|process-session)[^'"]*['"]/;
  const offenders = sourceFiles(rootPath)
    .filter((file) => !file.endsWith('owner-action-bindings.test.mjs'))
    .flatMap((file) => (forbiddenImport.test(readFileSync(file, 'utf8')) ? [relative(rootPath, file)] : []));
  assert.deepEqual(offenders, []);
  console.log('[public-site-publisher] no direct owner imports ok');
}

const mode = process.argv.slice(2).find((arg) => arg.startsWith('--')) ?? '--unit';
if (mode === '--unit') runUnit();
else if (mode === '--owner-actions') runOwnerActions();
else if (mode === '--imports') runNoImports();
else throw new Error(`unknown mode ${mode}`);
