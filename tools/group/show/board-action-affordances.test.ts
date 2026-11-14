// packages/group/show/board-action-affordances.test.ts
import { describe, expect, it, vi } from 'vitest';
import { readActionAffordances } from '../../ui/show/action-affordance';
import type { PublishedRecord } from '../../ui/show/placeable-surface-intent/placeable-surface-record';
import {
  affordanceShelfTools,
  boardAffordanceContextActions,
  boardAffordancePaletteItems,
  producerDescriptorOf,
  shelfToolOf,
  actionNeedsMissingSubject,
  ownerSelectionContext,
  templateBindsTypedText,
} from './board-action-affordances';
import { triggerForChannel } from '../../ui/show/action-affordance';

function published(payload: unknown, i = 0): PublishedRecord {
  return { recordId: `r${i}`, path: ['current-item', 'published-record'], payload, row: {} };
}

// The record twin of the old BREAKDOWN_TOOL/BREAKDOWN_PRODUCER source constants
// (mount-vision-board.tsx:73-101) — the golden the mapping must reproduce.
const breakdownRecord = {
  kind: 'action-affordance',
  version: 1,
  id: 'action-affordance:vision-board:breakdown',
  is_active: true,
  label: 'Break down',
  icon: 'ListChecks',
  section: 'Create',
  priority: 20,
  triggers: [
    {
      id: 'board-shelf',
      channel: 'group.add-shelf',
      event: 'invoke',
      ask: { prompt: 'What goal do you want to break into steps?' },
      input_template: {
        request_id: { $kind: 'binding', select: { from: 'run', path: 'id' } },
        target_group_ref: { $kind: 'binding', select: { from: 'surface', path: 'target_ref' } },
        instruction_text: { $kind: 'binding', select: { from: 'typed', path: 'text' } },
        output_kind: 'note',
        wrap_instruction_ref: 'instr:breakdown',
      },
      presentation: { working_label: 'Breaking this down…', total_hint: 6, item_kind: 'pending' },
    },
    { id: 'board-palette', channel: 'group.palette', input_template: {} },
    { id: 'board-menu', channel: 'group.context-menu', input_template: {} },
  ],
  dispatch: {
    target: 'slot::workflow',
    payload_template: {
      operation: 'execute_definition',
      definition_id: 'action:run-ai-records-production',
      include_output: false,
      input: { $kind: 'binding', select: { from: 'trigger', path: 'input' } },
    },
    status: {
      result_address_template: 'package::ai-records-producer::result::{id}',
      error_address_template: 'package::ai-records-producer::error::{id}',
      address_mode: 'label-hash',
      result_partition_label: 'runtime-partition',
    },
  },
  output_contract: { kind: 'action-output.v1', artifacts_path: 'payload.items' },
};

describe('ownerSelectionContext', () => {
  it('passes the actual board root and local member ids without fabricating Engine refs', () => {
    expect(ownerSelectionContext({ family: 'group.board', parts: { board: 'today' } }, new Set(['a', 'b']))).toEqual({
      root_ref: { family: 'group.board', parts: { board: 'today' } }, member_ids: ['a', 'b'],
    });
  });
});

const rows = readActionAffordances([published(breakdownRecord)]);

describe('producerDescriptorOf', () => {
  it('derives the exact ProducerSubmitDescriptor the old source constant carried', () => {
    const descriptor = producerDescriptorOf(rows[0], 'group.add-shelf');
    expect(descriptor).toEqual({
      definitionId: 'action:run-ai-records-production',
      resultAddressTemplate: 'package::ai-records-producer::result::{id}',
      errorAddressTemplate: 'package::ai-records-producer::error::{id}',
      addressMode: 'label-hash',
      resultPartitionLabel: 'runtime-partition',
      baseInput: { output_kind: 'note', wrap_instruction_ref: 'instr:breakdown' },
      // The RAW template (with the `typed.text` subject binding) rides along so the
      // board can resolve it against the selected cards' text — this is what makes the
      // action operate on the selection instead of firing an empty prompt.
      inputTemplate: {
        request_id: { $kind: 'binding', select: { from: 'run', path: 'id' } },
        target_group_ref: { $kind: 'binding', select: { from: 'surface', path: 'target_ref' } },
        instruction_text: { $kind: 'binding', select: { from: 'typed', path: 'text' } },
        output_kind: 'note',
        wrap_instruction_ref: 'instr:breakdown',
      },
    });
  });

  it('carries the typed.text subject binding so the board can inject the selection', () => {
    const descriptor = producerDescriptorOf(rows[0], 'group.add-shelf');
    expect(descriptor?.inputTemplate?.instruction_text).toEqual({
      $kind: 'binding',
      select: { from: 'typed', path: 'text' },
    });
  });

  it('returns null without a status block (cannot poll → not a producer tool)', () => {
    const noStatus = readActionAffordances([
      published({ ...breakdownRecord, id: 'x', dispatch: { ...breakdownRecord.dispatch, status: undefined } }),
    ]);
    expect(producerDescriptorOf(noStatus[0], 'group.add-shelf')).toBeNull();
  });
});

describe('affordanceShelfTools', () => {
  it('maps the record to the shape the old BREAKDOWN_TOOL constant had', () => {
    const [tool] = affordanceShelfTools(rows);
    expect(tool.kind).toBe('pending');
    expect(tool.label).toBe('Break down');
    expect(tool.addStrategy).toBe('produce');
    expect(tool.defaultText).toBe('What goal do you want to break into steps?');
    expect(tool.totalHint).toBe(6);
    expect(tool.workingLabel).toBe('Breaking this down…');
    // Lucide components are forwardRef exotic objects, not plain functions —
    // assert renderability the way resolveNamedIcon does (function OR $$typeof).
    expect(typeof tool.icon === 'function' || (typeof tool.icon === 'object' && tool.icon !== null && '$$typeof' in tool.icon)).toBe(true);
    expect(tool.producer?.definitionId).toBe('action:run-ai-records-production');
  });

  it('keeps status-less rows as direct actions instead of dead producer tools', () => {
    const noStatus = readActionAffordances([
      published({ ...breakdownRecord, dispatch: { ...breakdownRecord.dispatch, status: undefined } }),
    ]);
    const [tool] = affordanceShelfTools(noStatus);
    expect(tool.addStrategy).toBe('empty');
    expect(tool.producer).toBeUndefined();
    expect(tool.directAffordance?.affordance.id).toBe(breakdownRecord.id);
  });

  it('carries the record DATA `section` onto the tool (sectioned popover grouping, 2026-07-10)', () => {
    const [tool] = affordanceShelfTools(rows);
    expect(tool.section).toBe('Create'); // straight from the record DATA — never enumerated
    const noSection = readActionAffordances([published({ ...breakdownRecord, section: undefined })]);
    const [ungrouped] = affordanceShelfTools(noSection);
    expect('section' in ungrouped).toBe(false); // absent stays absent (ungrouped, header-less)
  });

  it('a USER action (removable log identity) carries removalRef; a built-in without one does not (2026-07-10)', () => {
    // The breakdown fixture has a package id + no source_address → NOT removable → no removalRef.
    const [builtin] = affordanceShelfTools(rows);
    expect('removalRef' in builtin).toBe(false);
    // A user-authored record (`action-affordance:user:` id) resolves a live write address → removalRef.
    const user = readActionAffordances([
      published({ ...breakdownRecord, id: 'action-affordance:user:make-it-rhyme-run9', label: 'Make it rhyme' }),
    ]);
    const [tool] = affordanceShelfTools(user);
    expect(tool.removalRef).toMatchObject({ id: 'action-affordance:user:make-it-rhyme-run9' });
    expect(tool.removalRef?.payload).toBeTruthy(); // raw payload rides along for the archive write
  });

  it('renders whatever unseen records exist — zero name branches (deletion test)', () => {
    const alien = readActionAffordances([
      published({
        ...breakdownRecord,
        id: 'a:thumbs', label: 'YouTube thumbnail ×10', icon: 'Image',
        triggers: [{
          id: 't', channel: 'group.add-shelf',
          ask: { prompt: 'Describe the thumbnail' },
          input_template: { variations: 10 },
          presentation: { item_kind: 'pending', total_hint: 10 },
        }],
      }),
    ]);
    const [tool] = affordanceShelfTools(alien);
    expect(tool.label).toBe('YouTube thumbnail ×10');
    expect(tool.totalHint).toBe(10);
    expect(tool.producer?.baseInput).toEqual({ variations: 10 });
  });
});

describe('palette + context-menu mapping — ONE run path (the shelf tool)', () => {
  it('palette rows derive the SAME ShelfEntry the shelf would and hand it to runTool', () => {
    const runTool = vi.fn();
    const items = boardAffordancePaletteItems(rows, runTool);
    expect(items).toHaveLength(1);
    // The palette section is the record's own DATA `section` (b251) — this record
    // declares "Create"; a record without one falls back to the generic "Actions".
    expect(items[0]).toMatchObject({ label: 'Break down', section: 'Create', icon: 'ListChecks' });
    items[0].run();
    expect(runTool).toHaveBeenCalledTimes(1);
    const tool = runTool.mock.calls[0][0];
    expect(tool.addStrategy).toBe('produce');
    expect(tool.producer?.definitionId).toBe('action:run-ai-records-production');
    // Palette-channel trigger carries no ask/literals of its own in this record —
    // the derived baseInput comes from ITS OWN trigger template (empty here).
    expect(tool.label).toBe('Break down');
  });

  it('context-menu capabilities run the same tool', () => {
    const runTool = vi.fn();
    const actions = boardAffordanceContextActions(rows, runTool);
    expect(actions).toHaveLength(1);
    expect(actions[0].accepts({ family: 'group.board-item', parts: { member: 'm1' } })).toBe(true);
    actions[0].run?.({ family: 'group.board-item', parts: { member: 'm1' } });
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0][0].addStrategy).toBe('produce');
  });

  it('context-menu capabilities carry the affordance hint to the NodeActionCapability', () => {
    const withHint = readActionAffordances([
      published({ ...breakdownRecord, hint: 'Break complex goals into actionable steps' }),
    ]);
    const runTool = vi.fn();
    const [action] = boardAffordanceContextActions(withHint, runTool);
    expect(action.hint).toBe('Break complex goals into actionable steps');
  });

  it('context-menu capabilities omit hint when the affordance has none', () => {
    const runTool = vi.fn();
    const [action] = boardAffordanceContextActions(rows, runTool);
    expect('hint' in action).toBe(false);
  });

  it('each door stamps its OWN channel as invokeChannel — palette says palette, shelf says shelf (Codex F4)', () => {
    const [shelfTool] = affordanceShelfTools(rows);
    expect(shelfTool.invokeChannel).toBe('group.add-shelf');
    const paletteRun = vi.fn();
    boardAffordancePaletteItems(rows, paletteRun)[0].run();
    expect(paletteRun.mock.calls[0][0].invokeChannel).toBe('group.palette');
    const menuRun = vi.fn();
    boardAffordanceContextActions(rows, menuRun)[0].run?.({ family: 'group.board-item', parts: { member: 'm1' } });
    expect(menuRun.mock.calls[0][0].invokeChannel).toBe('group.context-menu');
  });

  it('a record with NO section falls back to the generic "Actions" palette bucket (b251)', () => {
    const noSection = readActionAffordances([published({ ...breakdownRecord, section: undefined })]);
    const items = boardAffordancePaletteItems(noSection, vi.fn());
    expect(items[0].section).toBe('Actions');
  });

  it('rows without a pollable dispatch remain available as direct palette/menu actions', () => {
    const noStatus = readActionAffordances([
      published({ ...breakdownRecord, dispatch: { ...breakdownRecord.dispatch, status: undefined } }),
    ]);
    const runPalette = vi.fn();
    const runMenu = vi.fn();
    const palette = boardAffordancePaletteItems(noStatus, runPalette);
    const menu = boardAffordanceContextActions(noStatus, runMenu);
    expect(palette).toHaveLength(1);
    expect(menu).toHaveLength(1);
    palette[0].run();
    menu[0].run?.({ family: 'group.board-item', parts: { member: 'm1' } });
    expect(runPalette.mock.calls[0][0].directAffordance.affordance.id).toBe(breakdownRecord.id);
    expect(runMenu.mock.calls[0][0].directAffordance.trigger.channel).toBe('group.context-menu');
  });
});

// The context-menu channel serves TWO placements: the selection menu (default)
// and the bare-board menu. A trigger declares its placement in `contexts` — a
// board-menu row is ONE published record, zero panel edits (task 1294).
describe('context-menu placement scoping — selection vs board', () => {
  const boardScopedRecord = {
    ...breakdownRecord,
    id: 'action-affordance:user:board-scoped',
    label: 'Fill this board',
    triggers: [{
      id: 'board-menu',
      channel: 'group.context-menu',
      contexts: ['board'],
      ask: { prompt: 'What should fill the board?' },
      input_template: breakdownRecord.triggers[0].input_template,
      presentation: breakdownRecord.triggers[0].presentation,
    }],
  };
  const bothScopedRecord = {
    ...breakdownRecord,
    id: 'action-affordance:user:both-scoped',
    label: 'Everywhere',
    triggers: [{
      id: 'board-menu',
      channel: 'group.context-menu',
      contexts: ['selection', 'board'],
      input_template: {},
    }],
  };
  const mixed = readActionAffordances([
    published(breakdownRecord, 0),          // legacy: no contexts → selection only
    published(boardScopedRecord, 1),        // board only
    published(bothScopedRecord, 2),         // both placements
  ]);

  it("a record scoped 'board' appears in the board-menu composition and NOT the selection menu", () => {
    const board = boardAffordanceContextActions(mixed, vi.fn(), {}, 'board');
    expect(board.map((a) => a.label)).toEqual(['Everywhere', 'Fill this board']);
    const selection = boardAffordanceContextActions(mixed, vi.fn());
    expect(selection.map((a) => a.label)).toEqual(['Break down', 'Everywhere']);
  });

  it('unscoped/legacy records keep selection behavior byte-identical (default placement)', () => {
    const runTool = vi.fn();
    const legacyOnly = readActionAffordances([published(breakdownRecord)]);
    const explicitSelection = boardAffordanceContextActions(legacyOnly, runTool, {}, 'selection');
    const implicitDefault = boardAffordanceContextActions(legacyOnly, runTool);
    // Same rows, same identity, same wiring — the placement parameter defaulted, not re-routed.
    expect(explicitSelection.map((a) => ({ id: a.id, label: a.label, priority: a.priority })))
      .toEqual(implicitDefault.map((a) => ({ id: a.id, label: a.label, priority: a.priority })));
    expect(implicitDefault.map((a) => a.id)).toEqual(['menu-act-action-affordance:vision-board:breakdown']);
  });

  it("a 'board'-scoped record dispatches through the same one run path (produce tool)", () => {
    const runTool = vi.fn();
    const [action] = boardAffordanceContextActions(
      readActionAffordances([published(boardScopedRecord)]), runTool, {}, 'board',
    );
    expect(action.accepts({ family: 'group.board-root', parts: {} })).toBe(true);
    action.run?.({ family: 'group.board-root', parts: {} });
    expect(runTool).toHaveBeenCalledTimes(1);
    const tool = runTool.mock.calls[0][0];
    expect(tool.addStrategy).toBe('produce');
    expect(tool.producer?.definitionId).toBe('action:run-ai-records-production');
    expect(tool.defaultText).toBe('What should fill the board?');
    expect(tool.invokeChannel).toBe('group.context-menu');
  });

  it('a board-scoped record never leaks into shelf/palette (channel filter still governs)', () => {
    const rowsOnlyBoard = readActionAffordances([published(boardScopedRecord)]);
    expect(affordanceShelfTools(rowsOnlyBoard)).toEqual([]);
    expect(boardAffordancePaletteItems(rowsOnlyBoard, vi.fn())).toEqual([]);
  });
});

// A MULTI-FIELD action (ask.fields) — the board must carry the field descriptors +
// the raw record so the panel opens the shared blind ActionForm (and can Save-as-preset)
// instead of the single-text produce ask.
const multiFieldRecord = {
  kind: 'action-affordance', version: 1, id: 'action-affordance:content:rewrite-with-options',
  is_active: true, label: 'Rewrite (with options)', section: 'AI',
  triggers: [{
    id: 'group.add-shelf', channel: 'group.add-shelf', event: 'invoke',
    ask: {
      title: 'Rewrite', submit_label: 'Rewrite',
      fields: [
        { id: 'tone', control: 'select', label: 'Tone', options: [{ value: 'formal', label: 'Formal' }] },
        { id: 'length', control: 'select', label: 'Length', options: [{ value: 'shorter', label: 'Shorter' }] },
      ],
    },
    input_template: {
      instruction_text: { $kind: 'template', parts: ['Tone ', { $kind: 'binding', select: { from: 'answers', path: 'tone' } }, '\n\n', { $kind: 'binding', select: { from: 'typed', path: 'text' } }] },
    },
  }],
  dispatch: breakdownRecord.dispatch,
};

describe('shelfToolOf — multi-field routing', () => {
  const [mfRow] = readActionAffordances([published(multiFieldRecord)]);
  const mfTrigger = triggerForChannel(mfRow, 'group.add-shelf')!;

  it('carries formFields + formTitle + the raw affordanceRecord for a multi-field trigger', () => {
    const tool = shelfToolOf(mfRow, mfTrigger)!;
    expect(tool.formFields?.map((f) => f.id)).toEqual(['tone', 'length']);
    expect(tool.formTitle).toBe('Rewrite');
    expect(tool.formSubmitLabel).toBe('Rewrite');
    // The raw record is the base a preset curries.
    expect((tool.affordanceRecord as { id: string }).id).toBe('action-affordance:content:rewrite-with-options');
    // A multi-field action has no single-text default (it uses the form, not askText).
    expect(tool.defaultText).toBeUndefined();
  });

  it('a single-text trigger (ask.prompt) carries defaultText and NO form', () => {
    const trigger = triggerForChannel(rows[0], 'group.add-shelf')!;
    const tool = shelfToolOf(rows[0], trigger)!;
    expect(tool.defaultText).toBe('What goal do you want to break into steps?');
    expect(tool.formFields).toBeUndefined();
    expect(tool.affordanceRecord).toBeUndefined();
  });
});

describe('templateBindsTypedText — selection-subject detection', () => {
  const A = (path: string) => ({ $kind: 'binding', select: { from: 'answers', path } });
  const typedText = { $kind: 'binding', select: { from: 'typed', path: 'text' } };

  it('true when a template composes typed.text (a content action)', () => {
    expect(templateBindsTypedText({
      instruction_text: { $kind: 'template', parts: ['Translate ', A('language'), '\n\n', typedText] },
    })).toBe(true);
  });

  it('true for a bare typed.text binding', () => {
    expect(templateBindsTypedText({ instruction_text: typedText })).toBe(true);
  });

  it('false when nothing binds typed.text (a from-scratch producer)', () => {
    expect(templateBindsTypedText({
      instruction_text: { $kind: 'template', parts: ['Make an image of ', A('subject')] },
      request_id: { $kind: 'binding', select: { from: 'run', path: 'id' } },
    })).toBe(false);
  });

  it('false / safe on empty or non-object input', () => {
    expect(templateBindsTypedText(undefined)).toBe(false);
    expect(templateBindsTypedText('typed.text')).toBe(false);
    expect(templateBindsTypedText({})).toBe(false);
  });

  it('red-team (cont.98 batch-41): a deeply-nested UNTRUSTED template never stack-overflows (depth cap)', () => {
    // Build the deep template ITERATIVELY (a recursive builder would overflow at CONSTRUCTION before
    // the code under test runs). input_template is untrusted DATA — the walk must fail closed, not crash.
    let deepObj: unknown = { leaf: 1 };
    for (let i = 0; i < 60_000; i++) deepObj = { child: deepObj };
    expect(() => templateBindsTypedText(deepObj)).not.toThrow();
    expect(templateBindsTypedText(deepObj)).toBe(false); // over the cap, no typed.text -> false

    let deepArr: unknown = [1];
    for (let i = 0; i < 60_000; i++) deepArr = [deepArr];
    expect(() => templateBindsTypedText(deepArr)).not.toThrow();

    // a shallow real binding just past the top still resolves true (cap is generous, zero regression)
    const typed = { $kind: 'binding', select: { from: 'typed', path: 'text' } };
    expect(templateBindsTypedText({ a: { b: { c: typed } } })).toBe(true);
  });
});

describe('actionNeedsMissingSubject — fail-closed one-click subject gate (2026-07-09)', () => {
  const TYPED = { $kind: 'binding', select: { from: 'typed', path: 'text' } };
  const subjectBound = { producer: { inputTemplate: { instruction_text: { $kind: 'template', parts: ['Summarize\n\n', TYPED] } } } };

  it('true for a no-ask subject-bound action on an EMPTY subject (the doomed run)', () => {
    expect(actionNeedsMissingSubject(subjectBound, '')).toBe(true);
    expect(actionNeedsMissingSubject(subjectBound, '   \n ')).toBe(true);
  });

  it('false once the board has content — fires normally', () => {
    expect(actionNeedsMissingSubject(subjectBound, 'a real card')).toBe(false);
  });

  it('false for a declared single-text ask (the typed answer IS the content)', () => {
    expect(actionNeedsMissingSubject({ ...subjectBound, defaultText: 'What goal?' }, '')).toBe(false);
  });

  it('false for a multi-field form action (the answers bag IS the content)', () => {
    expect(actionNeedsMissingSubject({ ...subjectBound, formFields: [{ id: 'count' }] }, '')).toBe(false);
  });

  it('false for a self-sufficient template that never binds typed.text (from-scratch producer)', () => {
    const fromScratch = { producer: { inputTemplate: { instruction_text: 'Make 5 startup ideas' } } };
    expect(actionNeedsMissingSubject(fromScratch, '')).toBe(false);
  });

  it('false with no producer/template at all (plain add tools never gate)', () => {
    expect(actionNeedsMissingSubject({}, '')).toBe(false);
  });
});
