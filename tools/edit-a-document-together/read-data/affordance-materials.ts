// packages/documents/read-data/affordance-materials.ts
//
// The doc's translation boundary for action-affordance records. Two pure maps:
//   1. affordance rows on this surface's slash channel → slash-menu rows the
//      existing MaterialMenu renders alongside insertable materials
//   2. a completed run's artifact items → INSERT_NODE scene patches (one Text
//      node per item) — the doc's own placement seam, engine owns layout.
// Zero I/O; the surface owns dispatch, polling, and node-id minting.

import {
  affordancesForChannel,
  buildDispatchPayload,
  getPath,
  resolveStatusAddresses,
  triggerForChannel,
  type ActionAffordance,
  type ActionAffordanceTrigger,
  type AffordanceInvokeContext,
  type AskField,
} from '../../ui/show/action-affordance';
import type { ResolvedStatusAddresses } from '../../ui/show/action-affordance';
import type { SceneNode, ScenePatch } from './documents';

/** This surface's slash render-context address (its own vocabulary, DATA to authors). */
export const COMPOSITION_SLASH_CHANNEL = 'composition.slash-menu';

/** Translate the editor's current selection into the owner-local context
 * consumed by action-affordance bindings. The invoking node is the honest
 * single-node fallback when the user has no explicit multi-selection. */
export function ownerSelectionContext(
  sceneAddress: string,
  selectedNodeIds: Iterable<string>,
  invokingNodeId: string,
): { scene_address: string; node_ids: string[] } {
  const explicitSelection = [...selectedNodeIds];
  return {
    scene_address: sceneAddress,
    node_ids: explicitSelection.length > 0
      ? explicitSelection
      : invokingNodeId ? [invokingNodeId] : [],
  };
}

/** One slash row for an affordance — shaped like the material rows the menu
 *  already filters (label + match_terms), plus the affordance it invokes. */
export interface AffordanceSlashRow {
  readonly id: string;
  readonly label: string;
  readonly match_terms: string[];
  readonly affordance: ActionAffordance;
  readonly trigger: ActionAffordanceTrigger;
  /** Source-insertion marker: when present, this affordance renders a two-level
   *  source picker instead of a normal form. The field says so itself, by naming
   *  the control it wants; which POOL it reads is none of this panel's business. */
  readonly sourceInsertionField?: AskField;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The one control name this surface renders as a two-level source picker.
 *
 * This is a RENDER CONTRACT, not a pool name. The panel either has this renderer
 * or it does not, which makes the set closed by what this surface can draw, so a
 * literal is the honest form (Physics). The set of record kinds a field may READ
 * is open, because any package can publish a new offer kind tomorrow, so naming
 * one here would be Society hardcoded into a panel (L090, enum dissolution).
 *
 * The offer records already speak this exact word: every `source.offer` payload
 * carries `selection_schema.control: "source-item-picker"`. Nothing is invented.
 */
const SOURCE_PICKER_CONTROL = 'source-item-picker';

/**
 * Detect a source-insertion affordance: a trigger whose ask is exactly ONE field
 * that asks for the source picker by name. The panel stays blind to WHERE the
 * options come from; the field declares WHAT IT IS and the generic options
 * grammar resolves the pool (`resolve-field-options.ts` `kindOptions`, which
 * filters on `payload.kind` with no allow-list).
 *
 * ⛔ This previously tested `options_source.kind === 'connection.offers'`, a pool
 * kind NO manifest declares, so the detector could never fire and the picker was
 * unreachable. It also contradicted its own docstring, which claimed the field
 * carried the discriminant while the panel hardcoded it. No DATA migrated with
 * this change because no field ever declared the old kind.
 */
function sourceInsertionFieldOf(trigger: ActionAffordanceTrigger): AskField | undefined {
  const fields = trigger.ask?.fields;
  if (!Array.isArray(fields) || fields.length !== 1) return undefined;

  const field = fields[0];
  if (!isRecord(field)) return undefined;
  if ((field as { control?: unknown }).control !== SOURCE_PICKER_CONTROL) return undefined;

  return field as AskField;
}

/** Affordance rows for the doc's slash menu (channel + accepts filtered). */
export function affordanceSlashRows(
  rows: readonly ActionAffordance[],
  context: Record<string, unknown> = {},
): AffordanceSlashRow[] {
  const out: AffordanceSlashRow[] = [];
  for (const affordance of affordancesForChannel(rows, COMPOSITION_SLASH_CHANNEL, context)) {
    const trigger = triggerForChannel(affordance, COMPOSITION_SLASH_CHANNEL);
    if (!trigger) continue;

    // T4: Detect source-insertion affordance.
    const sourceInsertionField = sourceInsertionFieldOf(trigger);

    out.push({
      id: `affordance:${affordance.id}`,
      label: affordance.label,
      match_terms: [affordance.label, ...affordance.label.toLowerCase().split(/\s+/)],
      affordance,
      trigger,
      ...(sourceInsertionField ? { sourceInsertionField } : {}),
    });
  }
  return out;
}

/** Whether a slash row matches the typed query — the same startsWith-any-term
 *  contract materialMatchesQuery applies to insertables. */
export function affordanceRowMatchesQuery(row: AffordanceSlashRow, query: string): boolean {
  const normalized = query.replace(/^\//, '').trim().toLowerCase();
  if (!normalized) return false;
  return row.match_terms.some((term) => term.toLowerCase().startsWith(normalized));
}

/** The dispatch envelope + status addresses for one run of a slash affordance.
 *  Status addresses fill their `{id}` template with the run id — the same
 *  contract the board's producer poller consumes. Null status → fire-and-forget. */
export function buildAffordanceRun(
  row: AffordanceSlashRow,
  ctx: AffordanceInvokeContext,
): { target: string; payload: unknown; statusAddresses: ResolvedStatusAddresses | null } {
  const { target, payload } = buildDispatchPayload(row.affordance, row.trigger.id, ctx);
  const runId = typeof ctx.run.id === 'string' ? ctx.run.id : '';
  return { target, payload, statusAddresses: resolveStatusAddresses(row.affordance, runId) };
}

/** A produced artifact item (opaque producer fields; `text` is what a doc shows). */
interface ArtifactItem {
  readonly text?: string;
  readonly output_contract?: string;
  readonly render_descriptor_ref?: string;
  readonly [key: string]: unknown;
}

/**
 * Select a composition scene node kind based on artifact output_contract.
 * DATA-driven node selection (L090) — no per-source vendor branches.
 *
 * If the output_contract and available node kinds don't match, this returns
 * null; the caller skips that artifact (L117 — no fake placement).
 *
 * Current mappings:
 * - "text" or unset → Text node (regression-safe default)
 * - "image" → Container (T6/screen-look will render via render_descriptor_ref)
 * - "embed" or "link" → Container (T6/screen-look will render)
 * - "thread" or "message" → Container (T6/screen-look renders thread UI)
 *
 * If a node kind like Image/Embed/ThreadRender is added to the composition
 * engine in the future, this dispatch can be updated. For now, all non-text
 * content uses Container with source data in props for T6 to consume.
 */
function selectNodeKindForArtifact(
  item: unknown,
): 'Text' | 'Container' | null {
  if (!isRecord(item)) return null;

  const outputContract = typeof (item as ArtifactItem).output_contract === 'string'
    ? ((item as ArtifactItem).output_contract as string).toLowerCase()
    : 'text';

  // Text atoms → Text node (regression-safe)
  if (outputContract === 'text' || !outputContract) {
    return 'Text';
  }

  // Image/embed/link/thread → Container (T6 renders via render_descriptor_ref)
  // Valid contracts: "image", "embed", "link", "thread", "message", etc.
  // Generic: any non-text contract uses Container
  return 'Container';
}

/**
 * A completed run's result payload → INSERT_NODE patches placing nodes
 * of appropriate types per artifact output_contract under `parentId` starting
 * at `index`. Node ids are caller-minted (`mintId`) so this stays pure.
 *
 * TEXT artifacts → Text node (regression-safe, existing behavior).
 *
 * Non-text artifacts (image/embed/thread) → Container node with source data in
 * props, carrying render_descriptor_ref for T6 (screen-look) to consume and render
 * the native look. L090 DATA-driven: no per-source branches, no vendor checks.
 *
 * Items without usable content are skipped — nothing fake is placed (L117).
 */
export function artifactsToInsertPatches(
  resultPayload: unknown,
  artifactsPath: string,
  parentId: string,
  index: number,
  mintId: () => string,
): ScenePatch[] {
  const raw = getPath(resultPayload, artifactsPath);
  if (!Array.isArray(raw)) return [];
  const patches: ScenePatch[] = [];
  let at = index;

  for (const item of raw) {
    if (!isRecord(item)) continue;

    const nodeKind = selectNodeKindForArtifact(item);
    if (!nodeKind) continue;

    const artifact = item as ArtifactItem;

    if (nodeKind === 'Text') {
      // Text node: existing regression-safe path.
      const text = typeof artifact.text === 'string'
        ? artifact.text.trim()
        : '';
      if (!text) continue; // Skip empty text (L117)

      const node: SceneNode = {
        id: mintId(),
        kind: 'Text',
        props: { text },
        visible: true,
        children: [],
      };
      patches.push({ type: 'INSERT_NODE', parent_id: parentId, index: at, node });
      at += 1;
    } else if (nodeKind === 'Container') {
      // Container node: carries source artifact + render_descriptor_ref.
      // T6 (screen-look) will consume render_descriptor_ref to render the native look.
      // The whole artifact becomes sourceData so T6 has access to all fields
      // (output_contract, confidence, decoded fields, etc.)

      // Skip if no meaningful content (L117)
      if (!artifact.text && !artifact.render_descriptor_ref) {
        continue;
      }

      const node: SceneNode = {
        id: mintId(),
        kind: 'Container',
        props: {
          // T10 source-insertion marker: T6/screen-look uses this to know
          // how to render the container as a source item (not a layout container).
          // DATA-driven: render_descriptor_ref is the discriminant, no code branches.
          sourceInsertion: {
            sourceData: artifact,
            renderDescriptorRef: artifact.render_descriptor_ref,
          },
        },
        visible: true,
        children: [],
      };
      patches.push({ type: 'INSERT_NODE', parent_id: parentId, index: at, node });
      at += 1;
    }
  }

  return patches;
}
