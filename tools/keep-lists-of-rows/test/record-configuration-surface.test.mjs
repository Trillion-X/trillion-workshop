import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarBucket, calendarBucketSpan, normalizeSavedView, projectSavedView} from '../read-data/saved-view-engine.mjs';
import {captureConfigurationSettings, applyConfigurationSettings} from '../read-data/configuration-values.mjs';

const ids = ['title', 'owner', 'when'];
const rules = {kind: 'group', combinator: 'and', negate: false, rules: []};
const current = {search: 'Avery', rules, sort: [{field: 'title', direction: 'asc'}], groups: [], columns: {order: ids, hidden: ['when']},
  time: null, time_zone: 'America/Los_Angeles', display: {as: 'chart', settings: {measure: 'count', legend: false}, surface: {
    columnWidths: {title: 320, owner: 180}, compact: true, align: {owner: 'right'}, frozen: 2, detail: 'comfortable', timeline: 'months',
  }}};

test('calendar buckets and their filter ranges follow the saved zone at midnight and DST changes', () => {
  const zone = 'America/Los_Angeles';
  const now = Date.parse('2026-10-12T00:30:00Z');
  assert.equal(calendarBucket(now, 'day', zone, now), '2026-10-11');
  assert.equal(calendarBucket('2026-10-12', 'day', zone, now), '2026-10-12', 'a calendar date is not an instant');
  assert.equal(calendarBucket(now, 'relative', zone, now), 'today');
  const day = calendarBucketSpan('2026-10-11', 'day', zone, now);
  assert.equal(new Date(day.min).toISOString(), '2026-10-11T07:00:00.000Z');
  assert.equal(new Date(day.max).toISOString(), '2026-10-12T06:59:59.999Z');
  assert.ok(day.min <= now && day.max >= now, 'the group filter includes its own record');
  for (const [key, hours] of [['2026-03-08', 23], ['2026-11-01', 25]]) {
    const span = calendarBucketSpan(key, 'day', zone, now);
    assert.equal(span.max - span.min + 1, hours * 3600000);
  }
  const week = calendarBucketSpan('2026-03-02', 'week', zone, now);
  assert.equal(week.max - week.min + 1, 167 * 3600000);
  const month = calendarBucketSpan('2026-11', 'month', zone, now);
  assert.equal(month.max - month.min + 1, 721 * 3600000);
});

test('a full configuration round-trips the current layout, custom settings and shared surface choices', () => {
  const saved = captureConfigurationSettings(current, undefined, ids);
  assert.deepEqual(saved, current);
  assert.deepEqual(normalizeSavedView({...saved, label: 'Current work'}, ids).display, current.display);
  assert.deepEqual(captureConfigurationSettings({...current, display: {as: 'board'}}, undefined, ids).display, {as: 'board'});
  assert.equal(normalizeSavedView({label: 'Legacy search', search: 'Avery'}, ids).display, undefined);
  const designed = 'feed:75a53625-51f9-45f5-a2a5-a4ecaee7e768';
  assert.equal(captureConfigurationSettings({...current, display: {as: designed}}, ['display'], ids).display.as, designed);
});

test('a grouping-only configuration retains current search, filters, columns and layout', () => {
  const next = applyConfigurationSettings(current, {aspects: ['groups'], settings: {groups: [{field: 'owner'}]}}, ids);
  assert.deepEqual(next, {...current, groups: [{field: 'owner'}]});
  const cleared = applyConfigurationSettings(next, {aspects: ['groups'], settings: {groups: []}}, ids);
  assert.deepEqual(cleared, current);
});

test('a display-only configuration applies current surface choices without resetting the query', () => {
  const display = {as: 'board', settings: {card: 'small'}, surface: {columnWidths: {}, compact: false, align: {}, frozen: 0, detail: null, timeline: null}};
  const next = applyConfigurationSettings(current, {aspects: ['display'], settings: {display}}, ids);
  assert.deepEqual(next, {...current, display});
});

test('surface maps name actual receiving fields and obey UI bounds', () => {
  const wrong = [
    {columnWidths: {secret: 180}}, {align: {secret: 'left'}}, {columnWidths: {title: 63}},
    {columnWidths: {title: 721}}, {columnWidths: {title: 120.5}}, {align: {title: 'diagonal'}},
    {compact: 'yes'}, {frozen: -1}, {frozen: 4}, {frozen: 1.5}, {detail: ''}, {timeline: 'prototype'},
    {script: 'run()'}, {detail: 'x'.repeat(101)},
  ];
  for (const surface of wrong) assert.throws(() => captureConfigurationSettings({...current, display: {as: 'table', surface}}, ['display'], ids));
  assert.deepEqual(captureConfigurationSettings({...current, display: {as: 'table', surface: {columnWidths: {title: 64, owner: 720}, frozen: 3}}}, ['display'], ids),
    {display: {as: 'table', surface: {columnWidths: {title: 64, owner: 720}, frozen: 3}}});
  assert.throws(() => applyConfigurationSettings(current, {aspects: ['display'], settings: {display: current.display}}, ['title', 'when']));
});

test('legacy undefined aspects means full, while empty or unknown aspect selections are rejected', () => {
  const next = applyConfigurationSettings(current, {settings: {search: 'Rowan'}}, ids);
  assert.equal(next.search, 'Rowan');
  assert.deepEqual(next.sort, []);
  assert.deepEqual(next.groups, []);
  assert.equal(next.display, null);
  assert.throws(() => captureConfigurationSettings(current, [], ids));
  assert.throws(() => captureConfigurationSettings(current, ['unknown'], ids));
});

test('a rolling time configuration accepts the shared clock binding without treating it as a cycle', () => {
  const clock = {$kind: 'binding', select: {from: 'self', path: ['now']}};
  const time = {field: 'when', after: {binding: {...clock, transform: [{op: 'op:core.sub', args: {value: 604800000}}]}}, before: {binding: clock}};
  assert.deepEqual(captureConfigurationSettings({...current, time}, ['time'], ids), {time, time_zone: current.time_zone});
});

test('the shared projection applies time bounds and every sort key to the rendered rows', async () => {
  const rows = [
    {id:'c',values:{title:'Work',owner:'Avery',when:'2026-10-15T12:00:00Z'}},
    {id:'a',values:{title:'Work',owner:'Avery',when:'2026-10-14T12:00:00Z'}},
    {id:'b',values:{title:'Work',owner:'Rowan',when:'2026-10-15T09:00:00Z'}},
    {id:'old',values:{title:'Work',owner:'Avery',when:'2026-10-01T12:00:00Z'}},
  ];
  const result = await projectSavedView({view:{label:'Recent work',time:{field:'when',after:{value:'2026-10-14T00:00:00Z'}},
    sort:[{field:'owner',direction:'asc'},{field:'when',direction:'asc'}]}, fields:ids.map(id=>({id})),rows,
    resolveTimeBound:async()=>{throw new Error('A plain timestamp needs no server read.')}});
  assert.deepEqual(result.rows.map(row=>row.id),['a','c','b']);
});

test('formula bounds resolve through the authorized seam and failed or invalid results never reveal unfiltered rows', async () => {
  const point = {binding:{$kind:'binding',select:{from:'self',path:['now']}}};
  const input={view:{label:'After clock',time:{field:'when',after:point}},fields:ids.map(id=>({id})),rows:[{id:'old',values:{when:1}},{id:'new',values:{when:11}}],now:10};
  const seen=[];
  const result=await projectSavedView({...input,resolveTimeBound:async(given,now)=>{seen.push([given,now]);return 10;}});
  assert.deepEqual(result.rows.map(row=>row.id),['new']);
  assert.deepEqual(seen,[[point,10]]);
  await assert.rejects(projectSavedView(input),/formula evaluator/);
  for(const value of [null,NaN,'10']) await assert.rejects(projectSavedView({...input,resolveTimeBound:async()=>value}),/valid timestamp/);
  await assert.rejects(projectSavedView({...input,resolveTimeBound:async()=>{throw new Error('Access expired.')}}),/Access expired/);
});
