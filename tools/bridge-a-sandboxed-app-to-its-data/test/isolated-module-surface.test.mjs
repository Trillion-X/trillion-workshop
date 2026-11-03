import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkedLook, moduleSurfaceDocument, MOST_PENDING_REQUESTS } from '../parts/ui/show/isolated-module-surface/module-surface-document.mjs';
import { lessonPracticeLabel, lessonPracticeRequests, moduleSurfaceImportMap, moduleSurfaceMediaAddress, moduleSurfaceMediaIdentities, moduleSurfaceRequest, moduleSurfaceRequestCanRetry, moduleSurfaceScopeKey, savedScreenModuleAddress, validateModuleSurfaceRequests } from '../parts/ui/show/isolated-module-surface/module-surface-requests.mjs';

const ORIGIN = 'https://app.gettrillion.ai';
const shipped = JSON.parse(await readFile(new URL('../parts/ui/show/isolated-module-surface/sandboxed-screen-routes.json', import.meta.url), 'utf8'));
// A list the tests name, wider than the shipped one, so the generic mechanics (fixed paths, schemas, bindings, scope)
// are exercised on routes a real saved screen may not name.
const MECHANICS = { routes: [
  { method: 'GET', path: '/work/api/controls/workflow%3Acontrols-request-choices' },
  { method: 'POST', path: '/work/api/controls/keep' },
  { method: 'POST', path: '/work/api/controls/select' },
  { method: 'POST', path: '/work/api/records/save' },
  { method: 'GET', path: '/work/api/spaces/:space_id/workshop/describe' },
], resource_operations: ['record:update'] };
const request = (requests, name, input, scope = {}) => moduleSurfaceRequest(requests, name, input, scope, MECHANICS);
const validate = requests => validateModuleSurfaceRequests(requests, MECHANICS);
const requests = {
  read: { method: 'GET', path: '/work/api/controls/workflow%3Acontrols-request-choices' },
  select: {
    method: 'POST', path: '/work/api/controls/keep', bind: { id: 'workflow:controls-request-choices' },
    input_schema: { type: 'object', required: ['selection'], additionalProperties: false, properties: { selection: { type: 'string', minLength: 1 } } },
    body: { values: { selection: { from: 'selection' } } },
  },
};

test('saved module URLs accept only a BLAKE3 bundle identity and safe archive paths', () => {
  const bundle = `1f:${'a'.repeat(64)}`;
  assert.equal(savedScreenModuleAddress(bundle, 'work/screen.js', ORIGIN), `${ORIGIN}/workshop/modules/${encodeURIComponent(bundle)}/work/screen.js`);
  assert.throws(() => savedScreenModuleAddress('1f:bad', 'work/screen.js', ORIGIN));
  assert.throws(() => savedScreenModuleAddress(bundle, '../screen.js', ORIGIN));
});

test('named requests keep path and method fixed and send only schema fields', () => {
  assert.deepEqual(request(requests, 'read', {}, {}), { path: requests.read.path, init: { method: 'GET' } });
  const action = request(requests, 'select', { selection: 'Choice' }, {});
  assert.equal(action.path, '/work/api/controls/keep');
  assert.equal(action.init.method, 'POST');
  assert.deepEqual(JSON.parse(action.init.body), { values: { selection: 'Choice' }, id: 'workflow:controls-request-choices' });
  assert.throws(() => request(requests, 'unlisted', {}, {}));
  assert.throws(() => request(requests, 'select', { selection: 'Choice', path: 'https://evil.test' }, {}));
  assert.throws(() => request({ evil: { method: 'POST', path: 'https://evil.test/' } }, 'evil', {}, {}));
  assert.throws(() => request({ evil: { method: 'GET', path: '/work/api/records/../erase' } }, 'evil', {}, {}));
});

test('automatic request retries are limited to GET declarations', () => {
  assert.equal(moduleSurfaceRequestCanRetry({ method: 'GET' }), true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(moduleSurfaceRequestCanRetry({ method }), false, method);
  assert.equal(moduleSurfaceRequestCanRetry(null), false);
});

test('lesson practice requests are fixed to one lesson record and preserve conditional write semantics', () => {
  const scope = { space_id: 'school-1', course_id: 'course-1', lesson_id: 'lesson-2' };
  const label = lessonPracticeLabel(scope.space_id, scope.course_id, scope.lesson_id);
  const declarations = lessonPracticeRequests(scope.space_id, scope.course_id, scope.lesson_id);
  assert.equal(validateModuleSurfaceRequests(declarations), true);
  const read = moduleSurfaceRequest(declarations, 'read_practice', {}, scope);
  assert.equal(read.path, `/work/api/records?label=${encodeURIComponent(label)}`);
  assert.deepEqual(read.init, { method: 'GET' });
  const write = moduleSurfaceRequest(declarations, 'keep_practice', {
    attempt: { step: 'Try it', prediction: 'It works' }, expected_identity: null, request_key: 'attempt-1',
  }, scope);
  assert.equal(write.path, '/work/api/records');
  assert.equal(write.init.headers['idempotency-key'], 'attempt-1');
  assert.deepEqual(JSON.parse(write.init.body), { writes: [{ address_label: label,
    payload: { step: 'Try it', prediction: 'It works' }, expected_identity: null }], conflict_policy: 'preserve' });
  assert.throws(() => lessonPracticeRequests('', 'course-1', 'lesson-2'));
  assert.throws(() => moduleSurfaceRequest(declarations, 'keep_practice', { attempt: {}, expected_identity: null }, scope));
  assert.throws(() => moduleSurfaceRequest(declarations, 'keep_practice', { attempt: {}, expected_identity: 3, request_key: 'x' }, scope));
  assert.throws(() => moduleSurfaceRequest(declarations, 'read_practice', {}, {}), 'missing host scope is refused');
  for (const key of ['space_id', 'course_id', 'lesson_id']) {
    const other = { ...scope, [key]: 'other' };
    assert.throws(() => moduleSurfaceRequest(declarations, 'read_practice', {}, other), key);
    assert.throws(() => moduleSurfaceRequest(declarations, 'keep_practice', { attempt: {}, expected_identity: null, request_key: 'x' }, other), key);
    assert.notEqual(moduleSurfaceScopeKey(scope), moduleSurfaceScopeKey(other));
  }
  assert.notEqual(label, lessonPracticeLabel('school-2', scope.course_id, scope.lesson_id));
  const contentId = `1f:${'a'.repeat(64)}`;
  assert.equal(validateModuleSurfaceRequests(lessonPracticeRequests('school-1', 'first-principles', contentId)), true);
});

test('lesson practice reads admit only a canonical fixed label, never a broader or injected query', () => {
  const scope = { space_id: 'school-1', course_id: 'course-1', lesson_id: 'lesson-2' };
  const declarations = lessonPracticeRequests(scope.space_id, scope.course_id, scope.lesson_id);
  const path = declarations.read_practice.path;
  const malformedPaths = [
    `${path}&limit=100`, `${path}&label=another`, `${path}#ignored`,
    '/work/api/records?label=', '/work/api/records?label=%ZZ',
    `/work/api/records?label=${encodeURIComponent('unrelated-record')}`,
    `/work/api/records?label=${encodeURIComponent('lesson-practice:["school-1","course-1"]')}`,
    `/work/api/records?label=${encodeURIComponent('lesson-practice:[ "school-1", "course-1", "lesson-2" ]')}`,
    path.replace('%3A', '%3a'),
  ];
  for (const malformed of malformedPaths) {
    const forged = { read_practice: { method: 'GET', path: malformed } };
    assert.throws(() => validateModuleSurfaceRequests(forged), malformed);
    assert.throws(() => moduleSurfaceRequest(forged, 'read_practice', {}, scope), malformed);
  }
  assert.throws(() => validateModuleSurfaceRequests({ read_practice: { method: 'POST', path } }));
  assert.throws(() => moduleSurfaceRequest({ read_practice: { method: 'GET', path: '/work/api/records' } }, 'read_practice', {}, scope));

  const punctuation = { space_id: 'school:1', course_id: 'course,"one"', lesson_id: 'lesson?two&three' };
  const punctuated = lessonPracticeRequests(punctuation.space_id, punctuation.course_id, punctuation.lesson_id);
  assert.equal(validateModuleSurfaceRequests(punctuated), true);
  assert.equal(moduleSurfaceRequest(punctuated, 'read_practice', {}, punctuation).path, punctuated.read_practice.path);
  assert.notEqual(lessonPracticeLabel('a,b', 'c', 'd'), lessonPracticeLabel('a', 'b,c', 'd'));
});

test('lesson practice updates preserve the prior content identity and refuse widened write envelopes', () => {
  const scope = { space_id: 'school-1', course_id: 'course-1', lesson_id: 'lesson-2' };
  const declarations = lessonPracticeRequests(scope.space_id, scope.course_id, scope.lesson_id);
  const attempt = { observation: 'The result changed.', revision: '' };
  for (const expected_identity of [`1f:${'a'.repeat(64)}`, `12:${'b'.repeat(64)}`]) {
    const input = { attempt, expected_identity, request_key: 'keep-revision-1' };
    const original = structuredClone(input);
    const request = moduleSurfaceRequest(declarations, 'keep_practice', input, scope);
    assert.equal(JSON.parse(request.init.body).writes[0].expected_identity, expected_identity);
    assert.equal(request.init.headers['idempotency-key'], input.request_key);
    assert.equal(moduleSurfaceRequestCanRetry(declarations.keep_practice), false);
    assert.deepEqual(input, original);
  }
  const input = { attempt, expected_identity: null, request_key: 'keep-revision-1' };
  const validBody = JSON.parse(moduleSurfaceRequest(declarations, 'keep_practice', input, scope).init.body);
  const widenedBodies = [
    { ...validBody, conflict_policy: 'overwrite' },
    { ...validBody, writes: [...validBody.writes, ...validBody.writes] },
    { ...validBody, writes: [{ ...validBody.writes[0], address_label: lessonPracticeLabel('school-2', 'course-1', 'lesson-2') }] },
    { ...validBody, writes: [{ ...validBody.writes[0], expected_identity: 'not-a-content-identity' }] },
    { ...validBody, writes: [{ address_label: validBody.writes[0].address_label, payload: attempt }] },
    { ...validBody, writes: [{ address_label: validBody.writes[0].address_label, expected_identity: null }] },
    { ...validBody, account_id: 'another-account' },
  ];
  for (const body of widenedBodies) {
    const forged = { keep_practice: { ...declarations.keep_practice, body } };
    assert.throws(() => moduleSurfaceRequest(forged, 'keep_practice', input, scope), JSON.stringify(body));
  }
  assert.throws(() => moduleSurfaceRequest(declarations, 'keep_practice', input, {}));
});

test('lesson practice payloads accept bounded learner text and refuse extra fields and malformed identities', () => {
  const scope = { space_id: 'school-1', course_id: 'course-1', lesson_id: 'lesson-2' };
  const declarations = lessonPracticeRequests(scope.space_id, scope.course_id, scope.lesson_id);
  const input = { attempt: { prediction: 'x'.repeat(2000) }, expected_identity: null, request_key: 'keep-attempt-1' };
  const request = moduleSurfaceRequest(declarations, 'keep_practice', input, scope);
  assert.deepEqual(JSON.parse(request.init.body).writes[0].payload, input.attempt);
  for (const attempt of [null, [], { prediction: 'x'.repeat(2001) }, { prediction: 1 }, { account_id: 'another-account' }]) {
    assert.throws(() => moduleSurfaceRequest(declarations, 'keep_practice', { ...input, attempt }, scope));
  }
  for (const expected_identity of ['', '1f:short', `1f:${'A'.repeat(64)}`, `99:${'a'.repeat(64)}`]) {
    assert.throws(() => moduleSurfaceRequest(declarations, 'keep_practice', { ...input, expected_identity }, scope));
  }
  for (const request_key of ['', 'x'.repeat(201)]) {
    assert.throws(() => moduleSurfaceRequest(declarations, 'keep_practice', { ...input, request_key }, scope));
  }
  assert.throws(() => moduleSurfaceRequest(declarations, 'keep_practice', { ...input, address_label: 'forged' }, scope));
});

test('typed resource requests retain the host binding and stable effect identity', () => {
  const declarations = { change: { resource_operation: 'record:update',
    input_schema: { type: 'object', required: ['request_key', 'value'], additionalProperties: false,
      properties: { request_key: { type: 'string', minLength: 1, maxLength: 200 }, value: { type: 'string', maxLength: 100 } } },
    body: { title: { from: 'value' } }, bind: { row_id: 'current-row' },
  } };
  assert.equal(validate(declarations), true);
  for (const generation of [1, 'current-generation']) {
    const call = request(declarations, 'change', { request_key: 'same-action', value: 'New title' }, { address: 'project:opaque', generation });
    assert.equal(call.path, '/work/api/resources/invoke');
    assert.deepEqual(JSON.parse(call.init.body), { address: 'project:opaque', generation, operation: 'record:update', request_key: 'same-action', input: { title: 'New title', row_id: 'current-row' } });
    assert.equal(moduleSurfaceRequestCanRetry(declarations.change), false);
  }
  assert.throws(() => request(declarations, 'change', { request_key: 'same-action', value: 'New title', address: 'another:resource' }, { address: 'project:opaque', generation: 1 }));
  assert.throws(() => request(declarations, 'change', { value: 'New title' }, { address: 'project:opaque', generation: 1 }));
  assert.throws(() => request(declarations, 'change', { request_key: 'same-action', value: 'New title' }, { address: 'project:opaque', generation: {} }));
  assert.throws(() => validate({ change: { ...declarations.change, path: '/work/api/records/save' } }));
});

test('typed resource default input preserves literal nested fields and omits the effect key', () => {
  const declarations = { change: { resource_operation: 'record:update',
    input_schema: { type: 'object', required: ['request_key', 'payload'], additionalProperties: false,
      properties: {
        request_key: { type: 'string', minLength: 1, maxLength: 200 },
        payload: { type: 'object', required: ['from'], additionalProperties: false,
          properties: { from: { type: 'string', maxLength: 100 } } },
      } },
  } };
  const input = { request_key: 'same-action', payload: { from: 'customer entered this' } };
  const call = request(declarations, 'change', input, { address: 'project:opaque', generation: 1 });
  assert.deepEqual(JSON.parse(call.init.body), {
    address: 'project:opaque', generation: 1, operation: 'record:update', request_key: 'same-action',
    input: { payload: { from: 'customer entered this' } },
  });
  assert.deepEqual(input, { request_key: 'same-action', payload: { from: 'customer entered this' } });
});

test('named requests accept bounded recursive JSON inputs and reject unsafe nested values', () => {
  const structured = {
    save: {
      method: 'POST', path: '/work/api/records/save',
      input_schema: { type: 'object', additionalProperties: false, required: ['payload'], properties: {
        payload: { type: 'object', additionalProperties: false, required: ['items'], properties: {
          items: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false,
            required: ['id', 'rank'], properties: { id: { type: 'string' }, rank: { type: 'integer', minimum: 0 } } } },
        } },
      } },
      body: { data: { from: 'payload' } },
    },
  };
  assert.equal(validate(structured), true);
  const input = { payload: { items: [{ id: 'row-1', rank: 2 }] } };
  assert.deepEqual(JSON.parse(request(structured, 'save', input).init.body), { data: input.payload });
  assert.throws(() => request(structured, 'save', { payload: { items: [
    { id: 'row-1', rank: 0, ['__proto__']: 'blocked' },
  ] } }));
  assert.throws(() => request(structured, 'save', { payload: { items: [
    { id: '1', rank: 0 }, { id: '2', rank: 0 }, { id: '3', rank: 0 }, { id: '4', rank: 0 },
  ] } }));
  const sparse = []; sparse.length = 1;
  assert.throws(() => request({ save: {
    method: 'POST', path: '/work/api/records/save',
    input_schema: { type: 'object', additionalProperties: false, required: ['items'], properties: {
      items: { type: 'array', maxItems: 2, items: { type: 'string' } },
    } },
  } }, 'save', { items: sparse }));
  assert.throws(() => validate({ save: {
    method: 'POST', path: '/work/api/records/save',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      items: { type: 'array', items: { type: 'string' } },
    } },
  } }), 'arrays must declare a finite maximum');
  const oversized = { payload: { items: [{ id: 'x'.repeat(33000), rank: 1 }] } };
  assert.throws(() => request(structured, 'save', oversized));
});

test('scope keys remount when account, place or resource binding changes', () => {
  assert.equal(moduleSurfaceScopeKey({ space_id: 'space:one', label: 'Before' }), moduleSurfaceScopeKey({ space_id: 'space:one', label: 'After' }));
  assert.notEqual(moduleSurfaceScopeKey({ space_id: 'space:one' }), moduleSurfaceScopeKey({ space_id: 'space:two' }));
  assert.notEqual(moduleSurfaceScopeKey({ account_id: 'account:one' }), moduleSurfaceScopeKey({ account_id: 'account:two' }));
  assert.notEqual(moduleSurfaceScopeKey({ address: 'project:one', generation: '1' }), moduleSurfaceScopeKey({ address: 'project:two', generation: '1' }));
  assert.notEqual(moduleSurfaceScopeKey({ address: 'project:one', generation: '1' }), moduleSurfaceScopeKey({ address: 'project:one', generation: '2' }));
});

test('saved modules get one-file media leases only for identities in their current input', () => {
  const video = `1f:${'a'.repeat(64)}`;
  const audio = `12:${'b'.repeat(64)}`;
  const allowed = moduleSurfaceMediaIdentities({ file: { identity: video }, clips: [audio, 'not-an-identity'] });
  assert.deepEqual([...allowed].sort(), [audio, video].sort());
  assert.equal(moduleSurfaceMediaIdentities({ file: video }).has(video), true);
  assert.equal(moduleSurfaceMediaAddress(video, `${'c'.repeat(32)}.${'d'.repeat(64)}`, ORIGIN), `${ORIGIN}/namespace/bytes/${encodeURIComponent(video)}?lease=${'c'.repeat(32)}.${'d'.repeat(64)}`);
  assert.throws(() => moduleSurfaceMediaAddress('1f:invalid', `${'c'.repeat(32)}.${'d'.repeat(64)}`, ORIGIN));
});

test('fixed bindings override filled input and space context cannot fall back to personal paths', () => {
  const conflict = {
    set: { method: 'POST', path: '/work/api/controls/keep', bind: { id: 'owner-choice' },
      input_schema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' } } },
      body: { id: { from: 'id' } } },
  };
  const action = request(conflict, 'set', { id: 'forged-choice' }, {});
  assert.deepEqual(JSON.parse(action.init.body), { id: 'owner-choice' });
  assert.throws(() => request(requests, 'read', {}, { space_id: 'space:one' }));
  assert.throws(() => request(requests, 'read', {}, { space_id: '' }));
  const scoped = { read: { method: 'GET', path: '/work/api/spaces/:space_id/workshop/describe' } };
  assert.equal(request(scoped, 'read', {}, { space_id: 'space:one' }).path, '/work/api/spaces/space%3Aone/workshop/describe');
  assert.throws(() => request(scoped, 'read', {}, {}));
  assert.throws(() => request({ read: { method: 'GET', path: '/work/api/logins/list' } }, 'read', {}, {}));
});

test('saved-screen request declarations are validated before admission', () => {
  assert.equal(validate(requests), true);
  assert.equal(validate({ read: { method: 'GET', path: '/work/api/spaces/:space_id/workshop/describe' } }), true);
  assert.throws(() => validate({ ['__proto__']: { method: 'GET', path: '/work/api/controls/workflow%3Acontrols-request-choices' } }));
  assert.throws(() => validate({ constructor: { method: 'GET', path: '/work/api/controls/workflow%3Acontrols-request-choices' } }));
  assert.throws(() => validate({ read: {
    method: 'POST', path: '/work/api/controls/select',
    input_schema: { type: 'object', additionalProperties: false, properties: { selection: { type: 'string', minLength: -1 } } },
  } }));
  assert.throws(() => validate({ read: {
    method: 'POST', path: '/work/api/controls/select',
    input_schema: { type: 'object', additionalProperties: false, properties: { selection: { type: 'string', format: 'email' } } },
  } }));
  assert.throws(() => validate({ read: {
    method: 'POST', path: '/work/api/controls/select',
    input_schema: { type: 'object', additionalProperties: false, properties: { selection: { type: 'string' } } },
    body: { values: { selection: { from: 'unknown' } } },
  } }));
  assert.throws(() => validate({ read: {
    method: 'POST', path: '/work/api/controls/select',
    input_schema: { type: 'object', additionalProperties: false, properties: { selection: { type: 'string' } } },
    body: { values: { ['constructor']: { from: 'selection' } } },
  } }));
});

test('a saved screen may name only the shipped allowed requests: never the door, the account, logins or devices, nothing unlisted, and no write but its own', () => {
  const never = /^\/work\/api\/(door|account|accounts|logins|devices)(\/|$)/;
  assert.ok(shipped.routes.every(route => !never.test(route.path)), 'the allowed list names none of them');
  assert.ok(shipped.routes.every(route => route.method === 'GET' || typeof route.write === 'string'), 'a route is read-only unless it names its one write');
  for (const path of [
    '/work/api/door/records:read', '/work/api/door/records:list', '/work/api/door/tools:list', '/work/api/spaces/:space_id/door',
    '/work/api/account', '/work/api/account/profile', '/work/api/logins', '/work/api/logins/refresh',
    '/work/api/devices', '/work/api/devices/list', '/work/api/spaces/:space_id/account', '/work/api/spaces/:space_id/logins/refresh',
    '/work/api/controls/workflow%3Acontrols-request-choices', '/work/api/spaces/:space_id/workshop/describe', '/work/api/decisions',
  ]) {
    assert.throws(() => validateModuleSurfaceRequests({ read: { method: 'GET', path } }), path);
  }
  assert.throws(() => validateModuleSurfaceRequests({ run: { method: 'POST', path: '/work/api/door/tools:run' } }), 'no tool runs with the person\'s power');
  // The save is told why in the list's own words; the running screen only that the request is unavailable.
  assert.throws(() => validateModuleSurfaceRequests({ items: { method: 'GET', path: '/work/api/lists/groceries' } }), error =>
    error.message === 'This screen request is unavailable.'
    && error.reason === shipped.unlisted_words.replace('{name}', 'items').replace('{method}', 'GET').replace('{path}', '/work/api/lists/groceries'));
  // A write to a kind the row is not granted: the one write the list allows is the lesson's own practice record, so a
  // generic records write, another label or another route is refused before anything is sent.
  assert.throws(() => validateModuleSurfaceRequests({ save: { method: 'POST', path: '/work/api/records/save' } }));
  const generic = { write: { method: 'POST', path: '/work/api/records', body: { records: [{ id: 'note:x', type: 'note', value: {} }] } } };
  assert.throws(() => moduleSurfaceRequest(generic, 'write', {}, {}), 'a records:write of another kind is refused');
  assert.throws(() => moduleSurfaceRequest({ write: { method: 'POST', path: '/work/api/records', body: { writes: [{ address_label: 'layout-state', payload: {}, expected_identity: null }], conflict_policy: 'preserve' } } }, 'write', {}, { space_id: 's', course_id: 'c', lesson_id: 'l' }), 'a label other than the lesson\'s own is refused');
  assert.throws(() => validateModuleSurfaceRequests({ change: { resource_operation: 'record:update',
    input_schema: { type: 'object', required: ['request_key'], additionalProperties: false, properties: { request_key: { type: 'string', minLength: 1, maxLength: 200 } } } } }), 'no addressed operation is listed');
});

test('the child import map keeps only same-origin public workspace/module files', () => {
  const kept = moduleSurfaceImportMap({ import_map: { imports: {
    '@trillion/ui': '/workspace/named/ui.js', '@other': '/workshop/modules/1f:abc/file.js',
    external: 'https://elsewhere.test/module.js', private: '/work/api/records/list',
  } } }, ORIGIN);
  assert.deepEqual(Object.keys(kept.imports), ['@trillion/ui', '@other']);
  assert.equal(kept.imports['@trillion/ui'], `${ORIGIN}/workspace/named/ui.js`);
});

test('the isolated document constrains imports, connections, and frame messaging', async () => {
  const html = moduleSurfaceDocument({
    moduleUrl: `${ORIGIN}/workshop/modules/1f:${'a'.repeat(64)}/work/screen.js`,
    importMap: { imports: { '@trillion/ui': `${ORIGIN}/workspace/named/ui.js` } },
    nonce: 'abcdefghijklmnop', serviceOrigin: ORIGIN, stylesheetUrl: '/workspace/named/workspace.css',
  });
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /img-src data: blob:/);
  assert.match(html, /e\.source!==parent/);
  assert.match(html, /frame-src about:/);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.match(html, /updateQueue=updateQueue\.catch/);
  assert.match(html, /await mountedReady/);
  assert.doesNotMatch(html, /enqueueUpdate\(surfaceInput,inputVersion,'initial'\)/);
  assert.match(html, /await update\(\{surfaceInput:input\}\)/);
  assert.match(html, /workspace\/named\/workspace.css/);
  assert.match(html, new RegExp(`media-src ${ORIGIN.replaceAll('.', '\\.')}\\/namespace\\/bytes\\/`));
  assert.match(html, new RegExp(`img-src data: blob: ${ORIGIN.replaceAll('.', '\\.')}\\/namespace\\/bytes\\/`));
  assert.match(html, /connect-src 'none'/);
  assert.throws(() => moduleSurfaceDocument({ moduleUrl: `${ORIGIN}/workspace/module.js`, importMap: { imports: {} }, nonce: 'abcdefghijklmnop', serviceOrigin: ORIGIN, stylesheetUrl: 'https://elsewhere.test/style.css' }));
  assert.throws(() => moduleSurfaceDocument({ moduleUrl: 'https://elsewhere.test/screen.js', importMap: { imports: {} }, nonce: 'abcdefghijklmnop', serviceOrigin: ORIGIN }));
  const host = await readFile(new URL('../parts/ui/show/isolated-module-surface/IsolatedModuleSurface.tsx', import.meta.url), 'utf8');
  const documentSource = await readFile(new URL('../parts/ui/show/isolated-module-surface/module-surface-document.mjs', import.meta.url), 'utf8');
  assert.match(host, /sandbox="allow-scripts"/);
  assert.doesNotMatch(host, /allow-same-origin|allow-forms|allow-popups|allow-top-navigation/);
  assert.match(host, /\.close\(\)/);
  assert.match(host, /type: 'update'/);
  assert.match(host, /update-accepted.*update-refused/s);
  assert.match(host, /onInputUpdateResult/);
  assert.match(host, /moduleSurfaceMediaIdentities\(surfaceInputRef\.current\)\.has\(message\.identity\)/);
  assert.match(host, /onMediaLeaseRef\.current/);
  assert.doesNotMatch(host, /fetch\(`\$\{serviceOrigin\}\/work\/api\/namespace\/leases/);
  assert.match(host, /const bytePaths = \[/);
  assert.match(host, /cached\.expiresAt <= Date\.now\(\)/);
  assert.match(host, /url\.searchParams\.getAll\('lease'\)\.length !== 1/);
  assert.doesNotMatch(host, /savedScreenModuleAddress\(bundle, file, location\.origin\)/);
  assert.match(host, /new URL\(import\.meta\.url\)\.origin/);
  assert.match(documentSource, /mediaUrl:identity=>new Promise/);
  assert.match(documentSource, /media-response/);
  assert.match(host, /const call = onCallRef\.current/);
  assert.match(documentSource, /typeof update!=='function'.*update-refused/s);
  assert.match(documentSource, /update-accepted/);
});

test('a saved screen cannot queue more than the most pending requests (calls and media leases share one cap)', () => {
  const html = moduleSurfaceDocument({
    moduleUrl: `${ORIGIN}/workshop/modules/1f:${'a'.repeat(64)}/work/screen.js`,
    importMap: { imports: {} }, nonce: 'abcdefghijklmnop', serviceOrigin: ORIGIN,
  });
  assert.equal(MOST_PENDING_REQUESTS, 32);
  assert.equal(html.split(`if(pending.size>=${MOST_PENDING_REQUESTS})return reject(new Error('This screen has too many requests waiting.'))`).length - 1, 2);
});

test('a saved screen wears the person\'s Screen Look: plain look attributes and custom properties only, kept to bounds', async () => {
  const look = checkedLook({
    attributes: { 'data-look-scheme': 'dark', 'data-theme': 'night-glass', 'data-screen-look-theme': 'x" onload="y', onclick: 'z' },
    variables: { '--button-primary-bg': '#5b5bd6', '--font-size-body': '15px', '--bad': 'red;} body{display:none', color: 'red', '--x': 'a'.repeat(401) },
  });
  assert.deepEqual(look, { attributes: { 'data-look-scheme': 'dark', 'data-theme': 'night-glass' }, variables: { '--button-primary-bg': '#5b5bd6', '--font-size-body': '15px' } });
  assert.equal(checkedLook(null), null);
  const many = checkedLook({ variables: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`--v${index}`, '1px'])) });
  assert.equal(Object.keys(many.variables).length, 400);
  const html = moduleSurfaceDocument({ moduleUrl: `${ORIGIN}/workspace/a.js`, importMap: { imports: {} }, nonce: 'abcdefghijklmnop', serviceOrigin: ORIGIN });
  assert.match(html, /applyLook\(e\.data\.look\)/, 'the look arrives with the screen');
  assert.match(html, /m\.type===&#39;look&#39;|m\.type==='look'|m\.type===&quot;look&quot;/);
  assert.match(html, /pending\.size>=32/, 'the call and media methods share the pending map cap');
  const host = await readFile(new URL('../parts/ui/show/isolated-module-surface/IsolatedModuleSurface.tsx', import.meta.url), 'utf8');
  assert.match(host, /look: wornLook\(\)/);
  assert.match(host, /new MutationObserver/, 'a look the person changes reaches the open screen');
});
