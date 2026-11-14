// src/workspace/workflow-canvas-records.ts
//
// NO PRIOR: searched src/workspace and parts for "workflow-canvas-triggers", "slot::workflow", "execute_definition",
//   "workflow-canvas-run-receipt" and answerTarget; the only seam answers were the arrangement's and the group graph's
//   (src/workspace/targets.ts). This is the records seam for the workflow canvas brought over verbatim from
//   bitfield-packages packages/workflow-canvas (parts/workflow-canvas).
//
// PURPOSE
//   The workflow canvas reads three records by name and sends its work to two targets, exactly as it did on the record
//   engine. This file supplies both from what the Automations screen already reads (/work/api/workflows, the same
//   person-side routes the person's AI calls):
//   - `workflow-canvas-definitions`: each workflow as a published record (its steps as the engine runs them); this
//     person's own are the canvas's to edit, Trillion's own show as made by Trillion, and each Workshop tool something
//     starts is a card too.
//   - `workflow-canvas-triggers`: each trigger and schedule as the fact rows the canvas reads (its name, what sets it
//     off, whether it is on, and what it starts).
//   - `workflow-canvas-layout`: where the person placed each card, one of the person's own saved records, so the map
//     opens the same way on every device.
//   - target `slot::workflow`: keep, remove or place a workflow, and run one (a trigger or schedule runs once now; a
//     workflow starts a run).
//   - target `slot::find-current-items` for the canvas's run history: the workflow's runs, newest first.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The Worker stays the owner: every change goes through a /work/api/workflows press, and the map is read again
//      after it, so the canvas shows what was kept, never what was hoped for.
//   2. A card's id is `action:<Trillion id>` (a new workflow's `action:<words>` becomes `workflow:<words>`), so the
//      canvas's own id rules hold and every id maps back without a lookup table that could go stale.
//   3. A refused press answers with the Worker's own words: a run reports them as a stopped run; a save or removal
//      throws them, so the canvas puts its change back.
//   4. No words shown on screen are written here except a new workflow's name derived from what the person typed.

import { answerTarget, readInputValue, showRecords, writeInputValue } from './records';
import { readJson } from './api';

import { errorWords } from '../../parts/ui/show/safe-error-card/sanitize-error-text';
type Step = Record<string, unknown>;
type Automation = { id: string; kind: string; name: string; topic: string | null; enabled: boolean; then: { workflow_id?: string; tool_id?: string; input?: unknown } };
type Workflow = { id: string; label: string; job: string; made_by: string; yours: boolean; input_schema: Record<string, unknown>; steps: Step[]; edges: unknown[] };
type Tool = { id: string; label: string; description: string };
type Run = { run_id: string; workflow_id: string; state: string; started_at: string; finished_at: string | null; error: string | null };
export type WorkflowMap = { automations: Automation[]; workflows: Workflow[]; tools: Tool[]; runs: Run[] };
type FactRow = { address: string; payload: { subject_id: string; property_id: string; value_json: string } };

const API = '/work/api/workflows';
const CARD = 'action:';
const RUN_RECEIPT_KIND = 'workflow-canvas-run-receipt';
const LAYOUT = 'workflow-canvas-layout';
// How a run's state reads on the canvas: the run pulse and the run report know completed, failed and running.
const RUN_STATUS: Record<string, string> = { finished: 'completed', failed: 'failed', working: 'running' };

function latestRunByWorkflow(runs: readonly Run[]) {
  const latest = new Map<string, Run>();
  for (const run of runs) {
    const previous = latest.get(run.workflow_id);
    if (!previous || Date.parse(run.started_at) >= Date.parse(previous.started_at)) {
      latest.set(run.workflow_id, run);
    }
  }
  return latest;
}

const cardOf = (id: string) => `${CARD}${id}`;
/** A card's Trillion id: `action:workflow:x` → `workflow:x`; a new card's `action:x` → `workflow:x`. */
export const trillionIdOf = (cardId: string) => {
  const rest = cardId.startsWith(CARD) ? cardId.slice(CARD.length) : cardId;
  return rest.includes(':') ? rest : `workflow:${rest}`;
};
const fact = (subject_id: string, property_id: string, value: unknown): FactRow => ({
  address: `workflow-canvas::${subject_id}::${property_id}`, payload: { subject_id, property_id, value_json: JSON.stringify(value) },
});
const post = (action: string, body: unknown) => readJson<Record<string, unknown>>(`${API}/${action}`, { method: 'POST', body: JSON.stringify(body) });
const words = (error: unknown) => errorWords(error);

let latest: WorkflowMap | null = null;

/** The map as the canvas's three records; a read again replaces them. */
export function showWorkflowMap(map: WorkflowMap) {
  latest = map;
  const recentRunByWorkflow = latestRunByWorkflow(map.runs);
  const definition = (id: string, name: string, description: string, steps: unknown[], edges: unknown[], owner: string | null) => ({
    // A record the canvas owns is the person's to edit; any other shows who made it, to copy before changing.
    address: owner ? `package::${owner}::workflow-action::${id}` : `package::workflow-canvas::workflow-action::${id}`,
    ...(owner ? { source_package: owner } : {}),
    payload: {
      id: cardOf(id), name, description, is_active: true, steps, edges,
      ...(recentRunByWorkflow.has(id)
        ? { run_state: RUN_STATUS[recentRunByWorkflow.get(id)!.state] ?? null }
        : {}),
    },
  });
  showRecords({
    'workflow-canvas-definitions': [
      ...map.workflows.map(item => definition(item.id, item.label, item.job, item.steps, item.edges, item.yours ? null : item.made_by)),
      ...map.tools.map(item => definition(item.id, item.label, item.description, [], [], 'the Marketplace')),
    ],
    'workflow-canvas-triggers': map.automations.flatMap(item => {
      const runs = item.then.workflow_id ?? item.then.tool_id;
      return [
        fact(item.id, 'prop:trigger:name', item.name),
        ...(item.topic ? [fact(item.id, 'prop:trigger:topic', item.topic)] : []),
        fact(item.id, 'prop:trigger:is_active', item.enabled),
        ...(runs ? [fact(item.id, 'prop:trigger:output_template', { definition_id: cardOf(runs), input: item.then.input ?? {} })] : []),
      ];
    }),
  });
}

/** Reads the map again and shows it. */
export async function readWorkflowMap() {
  showWorkflowMap(await readJson<WorkflowMap>(`${API}/map`));
}

// A card the canvas asks to keep, as the workflow save_workflow takes: its name from the words typed (or the name it
// had when those words are its own), what it gets done, the input it had, and its steps as the engine's step graph.
type Edit = { id: string; slug: string; description: string; operations: unknown[]; edges: unknown[] };
function workflowOf(edit: Edit) {
  const id = trillionIdOf(edit.id);
  const had = latest?.workflows.find(item => item.id === id);
  const slugOf = (text: string) => text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const typed = edit.slug.replace(/-/g, ' ');
  // Not renamed: the canvas sends the card's own id back as its words, or the words of the name it had.
  const label = had && (edit.slug === id || slugOf(had.label) === edit.slug) ? had.label : typed.charAt(0).toUpperCase() + typed.slice(1);
  return {
    id, label, job: edit.description || had?.job || label,
    input_schema: had?.input_schema ?? { type: 'object' },
    definition: { steps: edit.operations, edges: edit.edges },
  };
}

async function placeCard(subject_id: string, layout: unknown) {
  const kept = (readInputValue<FactRow[] | null>(LAYOUT) ?? []).filter(row => row.payload.subject_id !== subject_id);
  await writeInputValue(LAYOUT, [...kept, fact(subject_id, 'prop:spatial:layout', layout)]);
  return { placed: subject_id };
}

// Runs one card now: a trigger or schedule once (run-now), a workflow as a new run (start-workflow).
async function runCard(definitionId: string) {
  const started = Date.now();
  const automation = latest?.automations.find(item => item.id === definitionId);
  try {
    if (automation) {
      await post('run-now', automation.kind === 'trigger' ? { rule_id: automation.id } : { schedule_id: automation.id });
      return { status: 'started', duration_ms: Date.now() - started, output: null, steps: {} };
    }
    const run = await post('start-workflow', { workflow_id: trillionIdOf(definitionId) }) as { state?: string; run_id?: string; error?: string };
    void readWorkflowMap();
    // A run just started reads "Run started"; one that already ended at once reads as it ended.
    return { status: run.state === 'working' ? 'started' : RUN_STATUS[run.state ?? ''] ?? 'started', duration_ms: Date.now() - started, output: run.run_id ? { run: run.run_id } : null, steps: {}, ...(run.error ? { error: run.error } : {}) };
  } catch (error) {
    return { status: 'failed', duration_ms: Date.now() - started, output: null, steps: {}, error: words(error) };
  }
}

type Execute = { operation?: string; definition_id?: string; input?: Record<string, unknown> };
// What each of the canvas's own work names does; anything else is a card to run.
const WORK: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  'action:save-workflow-canvas-actions': async input => {
    for (const edit of (input.actions as Edit[] | undefined) ?? []) await post('save-workflow', { workflow: workflowOf(edit) });
    await readWorkflowMap();
    return { saved: true };
  },
  'action:delete-workflow-canvas-action': async input => {
    await post('remove-workflow', { workflow_id: trillionIdOf(String(input.action_id ?? '')) });
    await readWorkflowMap();
    return { removed: true };
  },
  'action:save-workflow-canvas-layout': input => placeCard(String(input.subject_id ?? ''), input.layout),
};

answerTarget('slot::workflow', async request => {
  const { operation, definition_id = '', input = {} } = (request ?? {}) as Execute;
  if (operation !== 'execute_definition') throw new Error(`unknown target: slot::workflow ${String(operation)}`);
  const work = WORK[definition_id];
  return work ? work(input) : runCard(definition_id);
});

// The canvas's run history for one card: that workflow's runs, newest first.
answerTarget('slot::find-current-items', request => {
  const query = (request ?? {}) as { in?: string; where?: { all?: { field: string; eq: unknown }[] } };
  if (query.in !== RUN_RECEIPT_KIND) throw new Error(`unknown target: slot::find-current-items ${String(query.in)}`);
  const definitionId = String(query.where?.all?.find(test => test.field === 'definition_id')?.eq ?? '');
  const workflowId = trillionIdOf(definitionId);
  return {
    items: (latest?.runs ?? []).filter(run => run.workflow_id === workflowId).map(run => ({
      definition_id: definitionId,
      status: RUN_STATUS[run.state] ?? run.state,
      duration_ms: run.finished_at ? Date.parse(run.finished_at) - Date.parse(run.started_at) : 0,
      write_count: 0,
      evidence: { started_at_ms: Date.parse(run.started_at) },
    })),
  };
});
