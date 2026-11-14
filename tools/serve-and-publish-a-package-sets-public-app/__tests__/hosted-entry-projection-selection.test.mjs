import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const artifact = async (name) => readFile(new URL(`../read-data/artifacts/${name}`, import.meta.url), 'utf8');

test('entry projection selection is exact, private, and never inferred from root or target order', async () => {
  const [authority, client, page, route] = await Promise.all([
    artifact('hosted-experience-authority.ts.txt'),
    artifact('hosted-surface-client.tsx.txt'),
    artifact('hosted-surface-page.tsx.txt'),
    artifact('app-api-experience-manifest-route.ts.txt'),
  ]);
  assert.match(authority, /entry_projection_target_ref/);
  assert.match(authority, /matches\.length !== 1/);
  assert.match(authority, /subjectSelect\?\.from !== "literal"/);
  assert.match(authority, /resolveSessionAdmittedTargetScope/);
  const publicProjection = authority.slice(authority.indexOf('export function publicExperienceManifest'), authority.indexOf('export async function readAuthorizedBytes'));
  assert.doesNotMatch(publicProjection, /entry_projection_target_ref|admitted_scope|decision_proof|membershipRevision/);
  assert.match(route, /export async function POST/);
  assert.match(route, /invokeEntryProjectionTarget/);
  assert.match(client, /method: "POST"/);
  assert.match(client, /props: privateProps/);
  assert.doesNotMatch(page, /admitted_scope|scoped_group_page_items|decision_proof/);
});

test('selection and materialization callers carry one optional exact selector without minting a public fallback', async () => {
  const [selection, materializer, preparer] = await Promise.all([
    readFile(new URL('../do-work/selected-publication-targets.ts', import.meta.url), 'utf8'),
    readFile(new URL('../processes/materialize-hosted-projection-tree.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../processes/prepare-publication-records.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(selection, /exactTargetMember/);
  assert.match(selection, /matches\.length !== 1/);
  assert.match(materializer, /entry_projection_target_ref must select exactly one target_refs member/);
  assert.match(preparer, /manifest\.entry_projection_target_ref/);
  for (const source of [selection, materializer, preparer]) assert.doesNotMatch(source, /target_refs\s*\[\s*0\s*\]|root_refs\s*\[\s*0\s*\]/);
});
