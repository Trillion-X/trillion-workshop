// packages/group/show/ask-ai-affordance.test.ts
//
// The generic board ships a BUILT-IN one-off "Ask AI" affordance (DATA in
// group/things-to-store-and-run.json). This proves the board's real renderer
// (board-action-affordances) turns that DATA into a working shelf tool that fires
// `run-ai-records-production` through the workflow slot with a FREE prompt — the
// one-off entry a user was previously forced to build as a custom action.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { affordanceShelfTools, producerDescriptorOfTrigger, BOARD_CHANNELS } from './board-action-affordances';
import { triggerForChannel, type ActionAffordance } from '../../ui/show/action-affordance';

const here = dirname(fileURLToPath(import.meta.url));
const things = JSON.parse(readFileSync(join(here, '..', 'things-to-store-and-run.json'), 'utf8')).things as Array<{ address?: string; payload?: unknown }>;
const askAiRecord = things.find((t) => t.address === 'package::group::action-affordance::ask-ai')?.payload as ActionAffordance;

describe('built-in "Ask AI" board affordance (DATA → workflow-slot one-off)', () => {
  it('ships as a real action-affordance on all four board channels', () => {
    expect(askAiRecord).toBeTruthy();
    const channels = (askAiRecord.triggers ?? []).map((t) => t.channel);
    expect(channels).toContain(BOARD_CHANNELS.shelf);
    expect(channels).toContain(BOARD_CHANNELS.palette);
    expect(channels).toContain(BOARD_CHANNELS.contextMenu);
  });

  it('the board renderer offers it as a one-off ONE-FIELD FORM (a real prompt box always opens)', () => {
    const tools = affordanceShelfTools([askAiRecord]);
    const tool = tools.find((t) => t.label === 'Ask AI');
    expect(tool).toBeTruthy();
    expect(tool!.addStrategy).toBe('produce');           // ask → fire → pending → poll
    // The free one-off is the DEGENERATE single-field case of the blind ActionForm — a form
    // ALWAYS opens (never the immediate-fire skip), so the user gets to type their instruction.
    expect(tool!.defaultText).toBeUndefined();           // NOT a single-text ask (which the panel could skip)
    expect(Array.isArray(tool!.formFields)).toBe(true);
    expect(tool!.formFields!.length).toBe(1);
    const field = tool!.formFields![0] as { id?: string; control?: string };
    expect(field.id).toBe('instruction');
    expect(field.control).toBe('text');                  // → ActionForm Textarea (multi-line message box)
    // The output EFFECT rides onto the tool so the board's producer-result poll routes
    // this run through the authoritative reconcile (reorganize/rewrite the board), not append.
    expect((tool as { effect?: string }).effect).toBe('reconcile');
  });

  it('declares effect:"reconcile" so the agent output authoritatively reorganizes the board', () => {
    expect((askAiRecord as { effect?: string }).effect).toBe('reconcile');
    // The prompt tells the agent to return the COMPLETE desired board (so reconcile is correct,
    // not a partial append that would drop everything the model omitted by accident).
    const trigger = triggerForChannel(askAiRecord, BOARD_CHANNELS.shelf)!;
    const parts = ((trigger.input_template.instruction_text as { parts?: unknown[] }).parts ?? []) as unknown[];
    const literals = parts.filter((p): p is string => typeof p === 'string').join(' ');
    expect(literals).toMatch(/COMPLETE desired board/i);
    expect(literals).toMatch(/JSON array/i);
  });

  it('fires run-ai-records-production via the workflow slot; the prompt = user instruction + whole-board content', () => {
    const trigger = triggerForChannel(askAiRecord, BOARD_CHANNELS.shelf)!;
    const producer = producerDescriptorOfTrigger(askAiRecord, trigger)!;
    expect(producer).toBeTruthy();
    expect(producer.definitionId).toBe('action:run-ai-records-production');
    expect(producer.resultAddressTemplate).toBe('package::ai-records-producer::result::{id}');
    expect(producer.resultPartitionLabel).toBe('runtime-partition');
    // instruction_text is a TEMPLATE composing the two separated axes: the user's typed
    // instruction (answers.instruction) AND the board content it acts on (typed.text). The
    // overload is gone — the message and the subject ride different binding lanes.
    const itpl = (producer.inputTemplate as Record<string, unknown>).instruction_text as {
      $kind?: string; parts?: unknown[];
    };
    expect(itpl.$kind).toBe('template');
    const bindings = (itpl.parts ?? []).filter(
      (p): p is { select?: { from?: string; path?: string } } => typeof p === 'object' && p !== null && '$kind' in (p as object),
    );
    expect(bindings.some((b) => b.select?.from === 'answers' && b.select?.path === 'instruction')).toBe(true);
    expect(bindings.some((b) => b.select?.from === 'typed' && b.select?.path === 'text')).toBe(true);
    // Board dispatch target is the workflow engine slot (the board owner's requirement).
    expect(askAiRecord.dispatch.target).toBe('slot::workflow');
  });
});
