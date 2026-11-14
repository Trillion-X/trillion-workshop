// packages/ui/show/action-affordance/action-preset.ts
//
// THE ACTION-PRESET PRIMITIVE — a preset is a PARTIALLY-APPLIED action-affordance.
//
// A "custom action preset" is not a new record kind, a new store, or a new engine.
// It is the ONE affordance primitive, curried: take a base action-affordance + the
// answers a user filled in its form + a name → emit a NEW action-affordance record
// with those answers BAKED into the input_template as literals and the answered
// fields DROPPED from the form. Saving "Rewrite, tone=formal, length=shorter" as a
// preset yields a more-specialized action that no longer asks tone/length — it just
// runs that configuration (one click), while any UNfilled field (e.g. audience)
// stays on the form. This is the same self-describing producer-descriptor shape
// group's arrangement-artifact uses (a saved artifact resolved generically), but on
// the ENVELOPE-ADDRESSED user-actions published-records feed the affordance engine
// already reads — NOT group's board-coupled collection-store. So both composition
// and the board reuse it with ZERO cross-package import and ZERO new package.
//
// NON-NEGOTIABLE INVARIANTS
//   - GENERIC over fields/actions: the bake never enumerates a field id or an
//     action name; it folds by STRUCTURE (any `{from:'answers'}` binding whose
//     path was filled), so a new field kind or a never-seen action curries with
//     zero change here (L069/L090/enum-dissolution).
//   - PARTIAL, not total: only MEANINGFUL (non-empty) answers are baked; an
//     unfilled field keeps its binding AND stays on the form.
//   - PURE: no Date/random/I/O. `runId` is host-minted (SSOT with the editor).
//   - REUSES the write path: mints the SAME user-actions address + write-item
//     shape as buildActionAffordanceWriteItem (one live-write mechanism).
//
// Deletion test: drop presets entirely → the affordance engine is untouched.

import {
  slugOf,
  USER_ACTIONS_ADDRESS_PREFIX,
  type ActionAffordanceWriteItem,
} from './write-action-affordance';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A meaningful answer is one worth baking — undefined/null/'' are "unset" and
 *  must NOT clobber the binding (the field stays askable). Mirrors the appearance
 *  preset's `isMeaningful` so an empty answer is a no-op, never a stale literal. */
function isMeaningful(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

/** Keep only the meaningful answers — the set actually folded into the preset. */
export function meaningfulAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(answers ?? {})) if (isMeaningful(v)) kept[k] = v;
  return kept;
}

/**
 * Bake filled answers into a binding-template, replacing every
 * `{$kind:'binding', select:{from:'answers', path}}` whose `path` is a filled
 * answer with the LITERAL value, recursing through arrays, `template` parts, and
 * plain objects. Bindings for other sources (`typed`/`run`/`surface`/`selection`)
 * and answers that were NOT filled pass through unchanged. This is the exact
 * inverse of resolveBindingTemplate's answers branch, applied ahead of time.
 */
export function bakeAnswersIntoTemplate(node: unknown, answers: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((n) => bakeAnswersIntoTemplate(n, answers));
  if (isRecord(node)) {
    if (node.$kind === 'binding' && isRecord(node.select) && node.select.from === 'answers') {
      const path = typeof node.select.path === 'string' ? node.select.path : '';
      if (path && Object.prototype.hasOwnProperty.call(answers, path) && isMeaningful(answers[path])) {
        return answers[path];
      }
      return node; // answer not filled → keep the binding so it stays askable
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = bakeAnswersIntoTemplate(value, answers);
    return out;
  }
  return node;
}

/** Prune the fields the preset has baked in from a trigger's `ask`. A field is
 *  dropped iff its `id` is a filled answer. When no fields and no prompt remain,
 *  the ask disappears entirely (a one-click preset). Returns undefined to mean
 *  "no ask" so the caller removes the key. */
function pruneAsk(ask: unknown, answers: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isRecord(ask)) return undefined;
  const rawFields = Array.isArray(ask.fields) ? ask.fields : [];
  const keptFields = rawFields.filter(
    (f) => !(isRecord(f) && typeof f.id === 'string' && Object.prototype.hasOwnProperty.call(answers, f.id)),
  );
  const hasPrompt = typeof ask.prompt === 'string' && ask.prompt.length > 0;
  if (keptFields.length === 0 && !hasPrompt) return undefined;
  const next: Record<string, unknown> = { ...ask };
  if (Array.isArray(ask.fields)) {
    if (keptFields.length > 0) next.fields = keptFields;
    else delete next.fields;
  }
  return next;
}

/** Curry one trigger: bake filled answers into its input_template, drop the
 *  answered fields from its ask. Everything else (channel, event, presentation)
 *  is preserved verbatim. */
function curryTrigger(trigger: unknown, answers: Record<string, unknown>): unknown {
  if (!isRecord(trigger)) return trigger;
  const next: Record<string, unknown> = {
    ...trigger,
    input_template: bakeAnswersIntoTemplate(trigger.input_template, answers),
  };
  const ask = pruneAsk(trigger.ask, answers);
  if (ask === undefined) delete next.ask;
  else next.ask = ask;
  return next;
}

/** What the host supplies to name + address a saved preset. `runId` host-minted. */
export interface ActionPresetOptions {
  readonly name: string;
  readonly runId: string;
  /** Overrides the base action's section in the menu (defaults to the base's). */
  readonly section?: string;
}

/**
 * Derive a specialized action-affordance RECORD from a base record + the answers
 * a user filled. The base is a raw affordance payload (so every field — dispatch,
 * icon, presentation, a bound definition_id — is preserved verbatim); only the
 * identity/label/section and each trigger's input_template + ask change. Pure.
 */
export function deriveActionPresetRecord(
  baseRecord: Record<string, unknown>,
  answers: Record<string, unknown>,
  opts: ActionPresetOptions,
): Record<string, unknown> {
  const filled = meaningfulAnswers(answers);
  const triggers = Array.isArray(baseRecord.triggers)
    ? baseRecord.triggers.map((t) => curryTrigger(t, filled))
    : [];
  const section = opts.section ?? (typeof baseRecord.section === 'string' ? baseRecord.section : undefined);
  return {
    ...baseRecord,
    id: `action-affordance:user:${slugOf(opts.name)}-${opts.runId}`,
    label: opts.name,
    is_active: true,
    ...(section ? { section } : {}),
    triggers,
  };
}

/** The addressed live-write item for a saved preset — the SAME user-actions
 *  namespace + write-item shape the basic editor mints, so a preset and an
 *  authored action publish through one mechanism. */
export function buildActionPresetWriteItem(
  baseRecord: Record<string, unknown>,
  answers: Record<string, unknown>,
  opts: ActionPresetOptions,
): ActionAffordanceWriteItem {
  const record = deriveActionPresetRecord(baseRecord, answers, opts);
  return {
    address: `${USER_ACTIONS_ADDRESS_PREFIX}${slugOf(opts.name)}-${opts.runId}`,
    path: ['current-item', 'published-record'],
    payload: record,
  };
}
