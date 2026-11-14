import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parsed = JSON.parse(readFileSync(path.join(PKG, 'things-to-store-and-run.json'), 'utf8'));
const things = parsed.things as any[];

const TRIGGER_ID = 'trigger:score-and-rank-next-moves-on-input-change';
const watchedPropertyIds = [
  'prop:business-event:revenue_delta',
  'prop:lever:effort',
  'prop:hypothesis:expected_lift',
  'prop:hypothesis:confidence',
  'prop:hypothesis:effort',
  'prop:content-analytics.observation:metrics',
  'prop:revenue:net_cents',
  'prop:revenue:by_cohort',
  'prop:business-event:visitor',
  'prop:business-event:attributed_revenue',
  'prop:spend:cents',
  'prop:unit-economics:ltv_to_cac',
  'prop:unit-economics:payback_periods',
  'prop:unit-economics:ltv_cents',
  'prop:unit-economics:cac_cents',
  'prop:idea:demand_signal',
  'prop:unit-economics:gross_margin',
  'prop:business-event:attributed_value',
  'prop:traffic-attribution:source',
  'prop:business-event:type',
  'prop:business-event:revenue_delta_sum',
  'prop:business-event:event_count',
  'prop:business-event:retained_revenue',
  'prop:action:cost',
  'prop:market:demand',
  'prop:market:margin',
  'prop:learning-progress:*',
];

const byAddress = (address: string) => things.find((thing) => thing.address === address);

const decodeRecord = (record: any) => (
  record.payload_base64
    ? JSON.parse(Buffer.from(record.payload_base64, 'base64').toString('utf8'))
    : record.payload
);

const triggerFact = (prop: string) => {
  const record = byAddress(`attribute_fact|${TRIGGER_ID}|prop:trigger:${prop}|type:trigger`);
  if (!record) return undefined;
  return { record, decoded: decodeRecord(record), value: JSON.parse(decodeRecord(record).value_json) };
};

describe('D2 next-move watch-and-redecide trigger admit contract', () => {
  it('registers the trigger trio using the roi-verbatim path grammar (no trigger-rule segment in package source; admission adds loader registration)', () => {
    expect(byAddress(`entity|${TRIGGER_ID}`)).toBeTruthy();
    expect(decodeRecord(byAddress(`entity|${TRIGGER_ID}`))).toEqual({ id: TRIGGER_ID, table: 'entity' });
    expect(byAddress(`entity|${TRIGGER_ID}`).path).toEqual([]);

    expect(byAddress(`entity_types|${TRIGGER_ID}|type:trigger`)).toBeTruthy();
    expect(decodeRecord(byAddress(`entity_types|${TRIGGER_ID}|type:trigger`))).toEqual({
      entity_id: TRIGGER_ID,
      table: 'entity_types',
      type_id: 'type:trigger',
    });
    expect(byAddress(`entity_types|${TRIGGER_ID}|type:trigger`).path).toEqual(['type:trigger']);
  });

  it('declares the four trigger facts with decodable value_json payloads', () => {
    for (const prop of ['topic', 'match_condition', 'dispatch_target', 'output_template']) {
      const fact = triggerFact(prop);
      expect(fact?.record.path).toEqual([`prop:trigger:${prop}`]);
      expect(fact?.decoded).toMatchObject({
        table: 'attribute_fact',
        subject_id: TRIGGER_ID,
        property_id: `prop:trigger:${prop}`,
        type_id: 'type:trigger',
      });
      expect(fact?.value).toBeDefined();
    }
  });

  it('fires on attribute_changed for the §10 watched property_id union and dispatches the existing score action', () => {
    expect(triggerFact('topic')?.value).toBe('attribute_changed');
    expect(triggerFact('dispatch_target')?.value).toBe('slot::workflow');

    const condition = triggerFact('match_condition')?.value;
    const transform = condition.conditions[0].$bind.transform[0];
    expect(condition.conditions[0].$bind.select).toEqual({ from: 'change', path: 'property_id' });
    expect(transform.op).toBe('op:core.in_list');
    expect(transform.args.values).toEqual(watchedPropertyIds);

    const template = triggerFact('output_template')?.value;
    expect(template).toMatchObject({
      operation: 'execute_definition',
      definition_id: 'action:score-and-rank-next-moves',
      include_steps: false,
      include_output: false,
    });
    expect(template.input.change).toEqual({ $kind: 'binding', select: { from: 'change', path: '' } });
    expect(template.input.envelope).toEqual({ $kind: 'binding', select: { from: 'envelope', path: '' } });
  });
});
