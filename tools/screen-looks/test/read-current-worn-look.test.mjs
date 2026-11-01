import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import { readCurrentWornLook } from '../do-work/read-current-worn-look.mjs';
import { timeZoneName } from '../read-data/look-time-zone.js';
import rows from '../tool-rows.json' with { type: 'json' };

const fixed = () => new Date('2026-10-31T12:00:00.000Z');
const appData = {
  looks: {
    start_with: 'harbor',
    themes: [
      { address: 'look:harbor', payload: { kind: 'screen-look-editable-theme', id: 'harbor', name: 'Harbor', tokens: [{ key: 'accent-primary', kind: 'color', value: '#247b70', css_variable: '--accent-primary' }] } },
      { address: 'look:dusk', payload: { kind: 'screen-look-editable-theme', id: 'dusk', name: 'Dusk', tokens: [{ key: 'accent-primary', kind: 'color', value: '#7b4f92', css_variable: '--accent-primary' }] } },
    ],
  },
  look_over_time: {
    record_key: 'screen-look-over-time', most_points: 24,
    keep_readable: { ground: '--bg-primary', least_contrast: 2.5 },
    anchors: [], presets: [],
  },
  where_looks_apply: {
    record_key: 'where-looks-apply',
    facts: [
      { id: 'host', kind: 'choice' }, { id: 'device', kind: 'choice' },
      { id: 'device_id', kind: 'choice' }, { id: 'place', kind: 'choice' },
      { id: 'hour', kind: 'number', turns: 'hour' },
      { id: 'weekday', kind: 'choice', turns: 'hour' }, { id: 'now', kind: 'date', clock: true },
    ],
  },
};

function doorWith(values, calls = []) {
  return {
    async readWorkspace(labels) {
      calls.push(labels);
      const records = Object.fromEntries(labels.filter(label => values.has(label)).map(label => [label, values.get(label)]));
      return { records };
    },
  };
}

test('reads the four declared record identities and returns the native device token shape', async () => {
  const calls = [];
  const result = await readCurrentWornLook({ time_zone: 'UTC', host: 'mac', device: 'computer', app_data: appData }, {
    door: doorWith(new Map([
      ['screen-look', [{ name: 'dusk' }]],
      ['workspace-preference:screen-look-over-time', { on: false, points: [] }],
      ['workspace-preference:where-looks-apply', { rules: [] }],
    ]), calls),
    now: fixed,
  });
  assert.deepEqual(calls, [['screen-look', 'screen-look-own-themes', 'workspace-preference:screen-look-over-time', 'workspace-preference:where-looks-apply']]);
  assert.equal(result.worn, 'dusk');
  assert.equal(result.worn_record.payload.id, 'dusk');
  assert.equal(result.now.look_id, 'dusk');
  assert.equal(result.read_again_at, null);
  assert.ok(result.looks.some(look => look.look_id === 'harbor'));
  assert.ok(result.now.colors['bg-primary'].every(channel => channel >= 0 && channel <= 1));
  assert.deepEqual(Object.keys(result.now.button).sort(), [
    'border', 'contact', 'fill', 'fill_pressed', 'highlight', 'pressed_highlight', 'pressed_scale', 'radius', 'shadow', 'sheen_bottom', 'sheen_top', 'text',
  ].sort());
});

test('an absent choice uses the caller DATA starting look, while an unavailable workspace remains an error', async () => {
  const result = await readCurrentWornLook({ time_zone: 'UTC', app_data: appData }, { door: doorWith(new Map()), now: fixed });
  assert.equal(result.worn, 'harbor');
  assert.equal(result.now.look_id, 'harbor');

  const unavailable = { readWorkspace: async () => { throw new Error('The selected workspace cannot be reached right now.'); } };
  await assert.rejects(readCurrentWornLook({ time_zone: 'UTC', app_data: appData }, { door: unavailable, now: fixed }), /workspace cannot be reached/);
});

test('missing or inconsistent app DATA is unavailable, never replaced with a shipped default', async () => {
  await assert.rejects(readCurrentWornLook({ time_zone: 'UTC' }, { door: doorWith(new Map()), now: fixed }), /app_data.looks/);
  const badStart = structuredClone(appData);
  badStart.looks.start_with = 'missing-look';
  await assert.rejects(readCurrentWornLook({ time_zone: 'UTC', app_data: badStart }, { door: doorWith(new Map()), now: fixed }), /must name one of its app-owned looks/);
});

test('a malformed workspace result is not mistaken for an empty choice', async () => {
  const door = { readWorkspace: async () => ({ content_type: 'text/html', records: null }) };
  await assert.rejects(readCurrentWornLook({ time_zone: 'UTC', app_data: appData }, { door, now: fixed }), /did not return the exact selected record set/);
});

test('a matching host rule pins its look and a nonmatching earlier rule does not', async () => {
  const record = { rules: [
    { id: 'phone-only', look_id: 'harbor', when: { kind: 'group', combinator: 'and', rules: [{ kind: 'rule', field: 'device', operator: 'is_any_of', params: { values: ['phone'] } }] } },
    { id: 'mac-rule', look_id: 'dusk', when: { kind: 'group', combinator: 'and', rules: [{ kind: 'rule', field: 'host', operator: 'is_any_of', params: { values: ['mac'] } }] } },
  ] };
  const door = doorWith(new Map([['workspace-preference:where-looks-apply', record]]));
  const result = await readCurrentWornLook({ time_zone: 'UTC', host: 'mac', device: 'computer', app_data: appData }, { door, now: fixed });
  assert.equal(result.worn, 'dusk');
  assert.equal(result.now.look_id, 'dusk');
  assert.equal(result.read_again_at, null);
});

test('a time-only rule needs a screen fact before it can override the everywhere look', async () => {
  const record = { rules: [{ id: 'evening', look_id: 'dusk', when: { kind: 'group', combinator: 'and', rules: [{ kind: 'rule', field: 'hour', operator: 'is_between', params: { min: 11, max: 13 } }] } }] };
  const door = doorWith(new Map([['workspace-preference:where-looks-apply', record]]));
  const noFacts = await readCurrentWornLook({ time_zone: 'UTC', app_data: appData }, { door, now: fixed });
  assert.equal(noFacts.worn, 'harbor');
  const withHost = await readCurrentWornLook({ time_zone: 'UTC', host: 'mac', app_data: appData }, { door, now: fixed });
  assert.equal(withHost.worn, 'dusk');
});

test('a current schedule blends look tokens, returns ahead changes and asks again during a blend', async () => {
  const plan = { on: true, points: [
    { at: { clock: '11:00' }, look: 'harbor' },
    { at: { clock: '13:00' }, look: 'dusk' },
  ] };
  const door = doorWith(new Map([['workspace-preference:screen-look-over-time', plan]]));
  const result = await readCurrentWornLook({ time_zone: 'UTC', app_data: appData }, { door, now: fixed });
  assert.equal(result.worn, 'harbor');
  assert.equal(result.now.look_id, 'dusk');
  assert.notDeepEqual(result.now.colors['accent-primary'], result.looks.find(look => look.look_id === 'harbor').colors['accent-primary']);
  assert.equal(result.read_again_at, '2026-10-31T12:15:00.000Z');
  assert.ok(result.ahead.some(item => item.look.look_id === 'dusk'));
});

test('refuses an invalid device time zone', async () => {
  await assert.rejects(readCurrentWornLook({ time_zone: 'not/a-zone', app_data: appData }, { door: doorWith(new Map()), now: fixed }), /not a time zone/);
});

test('screen-look zones use wall-time canonical spelling and rejection rules', () => {
  assert.equal(timeZoneName('Europe/London'), 'Europe/London');
  assert.equal(timeZoneName('UTC'), 'UTC');
  assert.equal(timeZoneName('america/new_york'), 'America/New_York');
  for (const invalid of ['+05:00', '-0800', 'GMT+5', 'Mars/Olympus', 'Not a zone', '', '   ', null, undefined, 5, 'A'.repeat(81), 'Europe/../London']) {
    assert.equal(timeZoneName(invalid), null, String(invalid));
  }
  const packed = rowOf(rows, 'tool:read-current-worn-look').invoke.files.package_files;
  assert.ok(packed.some(item => item.package === 'wall-time' && item.paths.includes('read-data')), 'the native bundle carries the imported shared owner');
});

test('the declared native action reads the same records and returns its full device contract', async () => {
  const row = rowOf(rows, 'tool:read-current-worn-look');
  const answer = await runRow(row, { time_zone: 'UTC', app_data: appData }, { doorOptions: { workspaceRecords: { 'screen-look': [{ name: 'dusk' }] } } });
  assert.equal(answer.status, 0, answer.error);
  assert.equal(answer.result.worn, 'dusk');
  assert.ok(Array.isArray(answer.result.ahead));
  assert.ok(Array.isArray(answer.result.looks));
  assert.equal(Object.hasOwn(answer.result, 'read_again_at'), true);
});
