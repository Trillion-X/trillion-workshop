// Calendar setup must request access sufficient for the actual source identity request.
// Authorization requirements verified 2026-10-07 against Google's primary endpoint documentation:
// https://developers.google.com/workspace/calendar/api/v3/reference/calendars/get
// https://developers.google.com/workspace/calendar/api/v3/reference/events/list
// https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordsList, rowsFromList } from '../../ai-tool-catalog/do-work/derive-tool-rows-from-sources.mjs';
import { readServiceConnectionOptions } from '../../connect-a-service-and-seal-its-key/read-data/read-service-connection-options.ts';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
// The rows name old trillion's package service-connections, which is tools/connect-a-service-and-seal-its-key here.
const packageFolder = name => new URL(`../../${name === 'service-connections' ? 'connect-a-service-and-seal-its-key' : name}/`, import.meta.url).pathname;
const services = read('../../connect-a-service-and-seal-its-key/records.json').things;
const sourceRows = read('../../connect-a-service-and-seal-its-key/from-old-trillion/records/workshop-tool-records.json').records.map(row => row.payload)
  .filter(row => ['source:service-connection-descriptors', 'source:how-to-ask-something-else-to-do-things'].includes(row.id));
assert.equal(sourceRows.length, 2);
const derived = sourceRows.map(source => rowsFromList(source, recordsList(source.list.records, packageFolder)
  .filter(entry => /^(google-calendar|google-account)(-|$)/.test(entry.record_name))));
assert.deepEqual(derived.flatMap(result => result.refused), []);
const tool = id => derived.flatMap(result => result.rows).find(row => row.id === id);
const calendar = tool('tool:connect-service-google-calendar');
const acquire = calendar.invoke.connects.acquire;
const metadataScope = 'https://www.googleapis.com/auth/calendar.calendars.readonly';

test('the published Calendar consent authorizes its actual event-source identity proof', () => {
  const eventSource = read('../../start-a-new-account-with-the-rules-and-catalog-items/from-old-trillion/records/workshop-event-source-records.json').records
    .find(row => row.payload.id === 'events:google-calendar').payload;
  const proof = tool(eventSource.route_key_proof.tool_id);
  assert.equal(proof.invoke.connection, calendar.invoke.connects.connection);
  assert.equal(proof.invoke.method, 'GET');
  assert.equal(proof.invoke.url, 'https://www.googleapis.com/calendar/v3/calendars/primary');
  assert.equal(eventSource.route_key_proof.output_selector, '$.id');
  const calendarsGetScopes = new Set([
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.app.created',
    'https://www.googleapis.com/auth/calendar.calendars',
    metadataScope,
  ]);
  assert.ok(acquire.scopes.some(scope => calendarsGetScopes.has(scope)),
    'calendars.get does not accept the event/freebusy-only grant used by the old connect row');
  assert.ok(acquire.scopes.includes(metadataScope), 'calendar identity needs only metadata read access');
  assert.ok(!acquire.scopes.includes('https://www.googleapis.com/auth/calendar'),
    'finding the calendar never needs permission to edit or delete calendars');
  assert.ok(!acquire.scopes.includes('https://www.googleapis.com/auth/calendar.readonly'),
    'the narrower metadata scope is sufficient');
});

test('Calendar keeps event and freebusy access and the same sealed connection', () => {
  const changedEvents = tool('tool:google-calendar-list_changed_events');
  const freebusy = tool('tool:google-calendar-read_busy_times');
  for (const descriptor of [changedEvents, freebusy]) {
    assert.equal(descriptor.invoke.connection, calendar.invoke.connects.connection);
    assert.equal(descriptor.invoke.connection_id, 'service_connection:google-calendar');
    assert.ok(descriptor.invoke.credential_injections.some(item => item.field_id === 'access_token'));
  }
  assert.ok(acquire.scopes.includes('https://www.googleapis.com/auth/calendar.events'));
  assert.ok(acquire.scopes.includes('https://www.googleapis.com/auth/calendar.freebusy'));
  assert.deepEqual(acquire.refresh, { field: 'refresh_token' });
  assert.equal(acquire.auth_params.access_type, 'offline');
  assert.equal(acquire.auth_params.prompt, 'consent');
  assert.equal(acquire.redirect.path, '/connect/callback');
});

test('the connection decoder and published consent share the metadata scope and explain calendar identity', () => {
  const config = readServiceConnectionOptions(services).find(row => row.vendor === 'google-calendar');
  assert.deepEqual(config.acquire.scopes, acquire.scopes);
  assert.ok(config.defaultScopes.includes('calendar:metadata'));
  assert.match(calendar.invoke.connects.connect_guide.join(' '), /identify your primary calendar/);
});

test('both shared Google client setup guides include the required metadata permission without adding it to Gmail consent', () => {
  const google = tool('tool:connect-service-google-account');
  for (const descriptor of [calendar, google]) {
    const hosted = descriptor.invoke.connects.acquire.hosted_client;
    assert.equal(hosted.id_name, 'google-sign-in-client-id');
    assert.equal(hosted.secret_name, 'google-sign-in-client-secret');
    assert.ok(hosted.made_at.steps.some(step => step.includes('calendar.calendars.readonly')),
      'the shared Google client may be configured from either service');
  }
  assert.ok(!google.invoke.connects.acquire.scopes.some(scope => scope.startsWith('https://www.googleapis.com/auth/calendar')),
    'a Gmail connection does not acquire Calendar access');
});

test('actual published event creation templates invite all hosts and preserve a single attendee',async()=>{
 const {buildInvocation}=await import('../src/workshop.mjs');
 const {schemaProblems}=await import('../../shared-code/src/typed-operation-contract.mjs');
 const create=tool('tool:google-calendar-create_an_event');
 const input={calendar_id:'primary',title:'A meeting',start:'2026-10-15T10:00:00Z',end:'2026-10-15T10:30:00Z',time_zone:'UTC',attendees:[{email:'guest@example.test'},{email:'host@example.test'}]};
 assert.deepEqual(schemaProblems(create.input_schema,input),[]);
 const built=await buildInvocation(create.invoke,{input,task:{started_at:'2026-10-14T00:00:00Z'},request:true});
 const body=built.body??built.body_template;
 assert.deepEqual(body.attendees,input.attendees);
 const legacy=await buildInvocation(create.invoke,{input:{...input,attendees:undefined,attendee_email:'legacy@example.test'},task:{started_at:'2026-10-14T00:00:00Z'},request:true});
 assert.deepEqual((legacy.body??legacy.body_template).attendees,[{email:'legacy@example.test'}]);
 assert.equal(body.start.timeZone,'UTC');assert.equal(body.end.timeZone,'UTC');
});
