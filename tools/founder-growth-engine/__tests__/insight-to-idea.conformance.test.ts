// packages/founder-growth-engine/__tests__/insight-to-idea.conformance.test.ts
//
// D2 — learn→synthesize→idea handler conformance (no live engine).
// Locks the DATA bridge that turns an INSIGHT (an ai-records-producer result, a
// post-session reflection, or an answer-synthesis record) into an IDEA, by
// WRITING idea facts into the `ideas` package's own EEAF namespace
// (type:idea / prop:idea:content) and letting `ideas`'s OWN triggers publish them.
// founder-growth-engine NEVER re-implements idea publishing — it only writes the
// facts (reuse-by-address, no god package).
//
// Also pins the L095 nuance: the trigger match_condition uses `op:core.or` for a
// genuine BOOLEAN OR over 3 source kinds. That op IS wired in the TRIGGER match
// evaluator (trigger-engine match_rules.rs) — unlike workflow binding transforms.
// Do NOT "fix" it to if_null.

import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const things = JSON.parse(readFileSync(path.join(PKG, 'things-to-store-and-run.json'), 'utf8')).things as any[];

const triggerProp = (slug: string, prop: string) => {
  const r = things.find((t) => t.address === `attribute_fact|trigger:${slug}|prop:trigger:${prop}|type:trigger`);
  return r ? JSON.parse(r.payload.value_json) : undefined;
};
const actionById = (id: string) =>
  things.find((t) => t?.payload?.kind === 'action' && t.payload.id === id)?.payload;

const WRITE_IDEA = actionById('action:founder-growth-engine.write-insight-as-idea');

describe('D2 insight→idea handler — DATA bridge into the ideas namespace (reuse-by-address)', () => {
  it('the action exists and requires only the idea identity + content', () => {
    expect(WRITE_IDEA).toBeTruthy();
    expect(WRITE_IDEA.input_schema.required).toEqual(['idea_id', 'content']);
  });

  it('trigger:insight-to-idea fires on ANY of the 3 insight sources via a BOOLEAN OR (op:core.or — valid in TRIGGER context)', () => {
    const mc = triggerProp('insight-to-idea', 'match_condition');
    const bind = mc.conditions[0].$bind;
    const orStep = bind.transform[0];
    expect(orStep.op).toBe('op:core.or'); // boolean OR — wired in the trigger match evaluator, NOT if_null
    const branches = orStep.args.values;
    // branch 1: address starts_with the ai-records-producer result prefix
    const startsWith = branches.find((b: any) => b.transform?.[0]?.op === 'op:core.starts_with');
    expect(startsWith.transform[0].args.prefix).toBe('package::ai-records-producer::result::');
    // branches 2+3: change.kind equals a reflection / synthesis kind
    const kinds = branches
      .filter((b: any) => b.transform?.[0]?.op === 'op:core.equals')
      .map((b: any) => b.transform[0].args.value)
      .sort();
    expect(kinds).toEqual(['answer-synthesis', 'post-session-reflection']);
  });

  it('the trigger dispatches write-insight-as-idea BY ADDRESS with idea_id/content/source_ref from the change+envelope', () => {
    const tpl = triggerProp('insight-to-idea', 'payload_template');
    expect(tpl.operation).toBe('execute_definition');
    expect(tpl.definition_id).toBe('action:founder-growth-engine.write-insight-as-idea');
    // idea_id = concat("idea:", change.id) — derived, not invented
    expect(tpl.input.idea_id.transform[0].op).toBe('op:core.concat');
    expect(tpl.input.idea_id.transform[0].args.values[0]).toBe('idea:');
    // content from the insight record's text; source_ref from the producing address (provenance)
    expect(tpl.input.content.select).toEqual({ from: 'change', path: 'text' });
    expect(tpl.input.source_ref.select).toEqual({ from: 'envelope', path: 'address_text' });
  });

  it('writes the idea into the IDEAS package EEAF namespace (type:idea / prop:idea:content) — reuse-by-address, no god package', () => {
    const items = WRITE_IDEA.steps.find((s: any) => s.kind === 'write').config.items as any[];
    const tables = items.map((it) => it.payload.table);
    // materializes a real idea entity in the shared namespace, not a founder-private record kind:
    expect(tables).toContain('entity');
    expect(tables).toContain('entity_types');
    expect(tables).toContain('attribute_fact');
    const typed = items.find((it) => it.payload.table === 'entity_types');
    expect(typed.payload.type_id).toBe('type:idea'); // the ideas package's type, not a founder one
    const fact = items.find((it) => it.payload.table === 'attribute_fact');
    expect(fact.payload.property_id).toBe('prop:idea:content'); // the ideas package's property
    expect(fact.payload.type_id).toBe('type:idea');
    // content is the insight text, threaded through (json-stringified value_json)
    expect(fact.payload.value_json.select).toEqual({ from: 'input', path: 'content' });
  });

  it('founder-growth-engine does NOT re-own idea publishing — no publish-ideas action lives here', () => {
    // the bridge writes facts; the ideas package publishes via its OWN action/triggers.
    const ownsPublish = things.some(
      (t) => t?.payload?.kind === 'action' && /publish-ideas/.test(t.payload.id ?? ''),
    );
    expect(ownsPublish).toBe(false);
  });
});
