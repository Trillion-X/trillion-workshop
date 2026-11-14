// packages/ui/show/action-affordance/write-action-affordance.ts
//
// Pure builder: an authored action → the live write-batch item that publishes
// it as an action-affordance record. The builder never sends — the host owns
// the sender and the partition (live log only; folder edits are not live truth).

/** What the editor emits. `runId` is host-minted (no Date/random here). */
export interface ActionAffordanceDraft {
  readonly label: string;
  readonly icon?: string;
  readonly section?: string;
  /** The action's FIXED job, stored on the record and composed into every run's
   *  prompt ("Turn this into a blog post"). Applied to the content the action
   *  runs on — the user is NOT re-asked for it. Absent → the content is the
   *  whole prompt. */
  readonly instruction?: string;
  /** When set, the host collects one line of typed text before dispatch (an
   *  opt-in "ask me each time" — NOT the default). Left over for actions that
   *  genuinely need per-run input; the basic editor sets `instruction` instead. */
  readonly askPrompt?: string;
  readonly definitionId: string;
  /** Literal input rows sent with every run (e.g. wrap_instruction_ref, output_kind). */
  readonly literalInput?: Record<string, unknown>;
  readonly channels: readonly string[];
  readonly status?: {
    readonly result_address_template: string;
    readonly error_address_template: string;
    readonly address_mode?: 'label-hash' | 'identity-text';
    readonly result_partition_label?: string;
  };
  readonly runId: string;
}

/** One write-batch item: `{ address, path, payload }` — the same record entry
 *  shape package manifests publish with. */
export interface ActionAffordanceWriteItem {
  readonly address: string;
  readonly path: readonly string[];
  readonly payload: Record<string, unknown>;
}

/** Slugify a label into an address-safe id fragment. Exported so the preset
 *  builder mints the SAME user-actions address shape (SSOT — one slug rule). */
export function slugOf(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'action';
}

/** The binding that reads the content a run works on (the target block's text,
 *  or the ask answer). SSOT so the builder and any live repair agree. */
export const RUN_CONTENT_BINDING = { $kind: 'binding', select: { from: 'typed', path: 'text' } } as const;

/** Compose the AI prompt for an action: a fixed instruction (literal) joined to
 *  the run content, or — with no instruction — the content alone. This is the
 *  ONE place the prompt shape is defined; the repair path imports it so live
 *  records and freshly-authored records are byte-identical. */
export function instructionText(draft: Pick<ActionAffordanceDraft, 'instruction'>): unknown {
  const instruction = draft.instruction?.trim();
  if (!instruction) return { ...RUN_CONTENT_BINDING };
  return { $kind: 'template', parts: [instruction, '\n\n', { ...RUN_CONTENT_BINDING }] };
}

/** Build the publishable record for an authored action. Every trigger row
 *  carries the same input template; the prompt binds as instruction_text
 *  (instruction + content) and the surface's target ref binds as target_group_ref. */
export function buildActionAffordanceRecord(draft: ActionAffordanceDraft): Record<string, unknown> {
  const inputTemplate: Record<string, unknown> = {
    request_id: { $kind: 'binding', select: { from: 'run', path: 'id' } },
    target_group_ref: { $kind: 'binding', select: { from: 'surface', path: 'target_ref' } },
    // instruction_text is the AI prompt the producer runs
    // (make-ai-records-command-request.py: prompt = instruction_text). It is a
    // COMPOSITION of the action's stored instruction (a literal) and the content
    // the run works on (`typed.text` — the invoking surface fills it with the
    // target block's text, or the ask answer when an ask is used). When the
    // action has a fixed instruction, the prompt is `instruction + "\n\n" +
    // content` via the template primitive (resolveBindingTemplate), so the user
    // is NEVER re-asked for the instruction they already gave. No instruction →
    // the content is the whole prompt (an unfilled `typed` resolves to '' via
    // stringifyPart, so nothing crashes and nothing leaks a stale value).
    instruction_text: instructionText(draft),
    ...(draft.literalInput ?? {}),
  };
  return {
    kind: 'action-affordance',
    version: 1,
    id: `action-affordance:user:${slugOf(draft.label)}-${draft.runId}`,
    is_active: true,
    label: draft.label,
    ...(draft.icon ? { icon: draft.icon } : {}),
    ...(draft.section ? { section: draft.section } : {}),
    triggers: draft.channels.map((channel) => ({
      id: channel,
      channel,
      event: 'invoke',
      ...(draft.askPrompt ? { ask: { prompt: draft.askPrompt } } : {}),
      input_template: inputTemplate,
    })),
    dispatch: {
      target: 'slot::workflow',
      payload_template: {
        operation: 'execute_definition',
        definition_id: draft.definitionId,
        include_output: false,
        input: { $kind: 'binding', select: { from: 'trigger', path: 'input' } },
      },
      ...(draft.status ? { status: draft.status } : {}),
    },
  };
}

/** The user-actions namespace prefix that authored actions live at. SSOT so the
 *  create address and the archive/remove address never drift. */
export const USER_ACTIONS_ADDRESS_PREFIX = 'package::user-actions::action-affordance::';

/** The addressed write item for the built record. */
export function buildActionAffordanceWriteItem(draft: ActionAffordanceDraft): ActionAffordanceWriteItem {
  const record = buildActionAffordanceRecord(draft);
  return {
    address: `${USER_ACTIONS_ADDRESS_PREFIX}${slugOf(draft.label)}-${draft.runId}`,
    path: ['current-item', 'published-record'],
    payload: record,
  };
}

/** Resolve the IDENTITY-TEXT log address to (re)write a decoded action to — the
 *  target for archive/remove. This is NOT the feed's recordId: user actions are
 *  surfaced under a CONTENT-HASH recordId ("1f:…"), and writing modified content
 *  there just mints a new orphan hash, leaving the original untouched. So:
 *   • user actions (id "action-affordance:user:<suffix>") → reconstruct the
 *     deterministic user-actions address (the exact one create wrote to);
 *   • package-shipped actions whose source carries a real "package::…" address
 *     (e.g. vision-board's Vision/Break down) → that address is directly writable;
 *   • anything else (only a content-hash / no address) → null (not addressable).
 */
export function resolveActionAffordanceWriteAddress(
  affordance: { readonly id?: string; readonly source_address?: string },
): string | null {
  const id = affordance.id ?? '';
  const userPrefix = 'action-affordance:user:';
  if (id.startsWith(userPrefix)) {
    return `${USER_ACTIONS_ADDRESS_PREFIX}${id.slice(userPrefix.length)}`;
  }
  if (affordance.source_address && affordance.source_address.startsWith('package::')) {
    return affordance.source_address;
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The input_template keys the BUILDER binds itself — everything else in a
 *  trigger's template is the draft's literalInput. SSOT with the builder above. */
const BUILDER_BOUND_KEYS = new Set(['request_id', 'target_group_ref', 'instruction_text']);

/**
 * INVERSE of {@link buildActionAffordanceRecord}: extract the editable draft from
 * a published record so the SAME editor that authors an action can EDIT one —
 * prefilled, no second editor (L069). Round-trip law: build(draftOf(build(d))) ≡
 * build(d) for builder-shaped records. Only builder-shaped instruction templates
 * decode to `instruction` (a literal head + '\n\n' + the run-content binding); a
 * foreign / hand-authored template yields no instruction (the edit keeps everything
 * else — honest partial editability, never a lossy guess). Returns null when the
 * payload is not an action-affordance record at all.
 */
export function draftOfActionAffordanceRecord(
  payload: unknown,
  runId: string,
): ActionAffordanceDraft | null {
  if (!isPlainRecord(payload) || payload.kind !== 'action-affordance') return null;
  const label = typeof payload.label === 'string' ? payload.label : '';
  if (!label) return null;
  const triggers = Array.isArray(payload.triggers) ? payload.triggers.filter(isPlainRecord) : [];
  const dispatch = isPlainRecord(payload.dispatch) ? payload.dispatch : {};
  const payloadTemplate = isPlainRecord(dispatch.payload_template) ? dispatch.payload_template : {};
  const definitionId = typeof payloadTemplate.definition_id === 'string' ? payloadTemplate.definition_id : '';
  if (!definitionId) return null;
  const first = triggers[0];
  // instruction: only the builder's exact shape decodes — a template whose parts are
  // [literal, '\n\n', RUN_CONTENT_BINDING]. Anything else → no instruction extracted.
  let instruction: string | undefined;
  const tpl = first && isPlainRecord(first.input_template) ? first.input_template.instruction_text : undefined;
  if (isPlainRecord(tpl) && tpl.$kind === 'template' && Array.isArray(tpl.parts)
    && tpl.parts.length === 3 && typeof tpl.parts[0] === 'string' && tpl.parts[1] === '\n\n') {
    instruction = tpl.parts[0];
  }
  const literalInput: Record<string, unknown> = {};
  if (first && isPlainRecord(first.input_template)) {
    for (const [key, value] of Object.entries(first.input_template)) {
      if (!BUILDER_BOUND_KEYS.has(key)) literalInput[key] = value;
    }
  }
  const ask = first && isPlainRecord(first.ask) ? first.ask : undefined;
  const status = isPlainRecord(dispatch.status) ? dispatch.status : undefined;
  return {
    label,
    ...(typeof payload.icon === 'string' ? { icon: payload.icon } : {}),
    ...(typeof payload.section === 'string' ? { section: payload.section } : {}),
    ...(instruction ? { instruction } : {}),
    ...(ask && typeof ask.prompt === 'string' ? { askPrompt: ask.prompt } : {}),
    definitionId,
    ...(Object.keys(literalInput).length > 0 ? { literalInput } : {}),
    channels: triggers.map((t) => (typeof t.channel === 'string' ? t.channel : '')).filter(Boolean),
    ...(status ? {
      status: {
        result_address_template: String(status.result_address_template ?? ''),
        error_address_template: String(status.error_address_template ?? ''),
        ...(status.address_mode === 'label-hash' || status.address_mode === 'identity-text' ? { address_mode: status.address_mode } : {}),
        ...(typeof status.result_partition_label === 'string' ? { result_partition_label: status.result_partition_label } : {}),
      },
    } : {}),
    runId,
  };
}

/** True iff an instruction_text template is the BUILDER's exact shape
 *  ([literal, '\n\n', run-content binding]) — the only shape the editor's
 *  Instruction field faithfully round-trips. SSOT with the inverse above. */
function isBuilderInstructionTemplate(tpl: unknown): tpl is { $kind: 'template'; parts: [string, string, unknown] } {
  return isPlainRecord(tpl) && tpl.$kind === 'template' && Array.isArray(tpl.parts)
    && tpl.parts.length === 3 && typeof tpl.parts[0] === 'string' && tpl.parts[1] === '\n\n';
}

/**
 * The addressed write item for an EDIT of an existing action — a FIELD PATCH onto
 * the ORIGINAL payload, never a rebuild (Codex audit 2026-07-10: rebuilding from
 * the simple draft FLATTENED everything the basic editor doesn't model — form
 * actions' ask.fields + answers-bound templates, per-trigger template differences,
 * trigger presentation). Only what the editor actually edits changes:
 *  • label / section / icon — replaced (section/icon removed when cleared);
 *  • instruction — patched ONLY into triggers whose instruction_text is the
 *    builder's own shape (literal + content binding); a complex/answers-bound
 *    template is left byte-untouched (honest partial editability);
 *  • channels — existing triggers for still-selected channels are KEPT VERBATIM
 *    (ask.fields, templates, presentation intact); deselected channels drop;
 *    newly-selected channels gain a builder-generated trigger;
 *  • identity (id) + address — always the ORIGINAL (a rename never mints a
 *    duplicate); dispatch/status/output_contract — untouched.
 * Returns null when the row has no resolvable live write address or no payload.
 */
export function buildActionAffordanceEditWriteItem(
  draft: ActionAffordanceDraft,
  existing: { readonly id?: string; readonly source_address?: string; readonly payload?: unknown },
): ActionAffordanceWriteItem | null {
  const address = resolveActionAffordanceWriteAddress(existing);
  if (!address) return null;
  const base = isPlainRecord(existing.payload) ? existing.payload : null;
  if (!base) return null;
  const baseTriggers = Array.isArray(base.triggers) ? base.triggers.filter(isPlainRecord) : [];
  const keptChannels = new Set(draft.channels);
  // Keep still-selected triggers VERBATIM, then patch ONLY builder-shaped instruction templates.
  const instruction = draft.instruction?.trim();
  const kept = baseTriggers
    .filter((t) => typeof t.channel === 'string' && keptChannels.has(t.channel))
    .map((t) => {
      const template = isPlainRecord(t.input_template) ? t.input_template : null;
      if (!template || !isBuilderInstructionTemplate(template.instruction_text)) return t;
      return {
        ...t,
        input_template: { ...template, instruction_text: instructionText({ instruction }) },
      };
    });
  // Newly-selected channels gain a builder-generated trigger (same shape create mints).
  const existingChannels = new Set(baseTriggers.map((t) => t.channel));
  const addedChannels = draft.channels.filter((c) => !existingChannels.has(c));
  const added = addedChannels.length > 0
    ? ((buildActionAffordanceRecord({ ...draft, channels: addedChannels }).triggers as Array<Record<string, unknown>>) ?? [])
    : [];
  return {
    address,
    path: ['current-item', 'published-record'],
    payload: {
      ...base,
      label: draft.label,
      ...(draft.section ? { section: draft.section } : {}),
      ...(!draft.section && 'section' in base ? { section: undefined } : {}),
      ...(draft.icon ? { icon: draft.icon } : {}),
      triggers: [...kept, ...added],
      ...(existing.id ? { id: existing.id } : {}),
      is_active: true,
    },
  };
}
