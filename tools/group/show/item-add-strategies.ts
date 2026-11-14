// packages/group/show/item-add-strategies.ts
//
// How a new board item is PRODUCED, as a DATA registry (L069/L090). A shelf
// entry names its `addStrategy` (a raw key); the canvas runs ADD_STRATEGIES[key]
// blind to make the item draft. Adding a new way to produce an item (empty,
// pick-a-file, produce, pull-from-a-source, text-source) = ONE registry row
// + ONE shelf row — ZERO canvas/panel edits, ZERO switch(kind). The canvas never
// knows what "image" or "producer" means; it asks the strategy for a draft.
//
// The strategy is handed a `ctx` of injected capabilities (pick files, store
// bytes) so it stays I/O-blind and testable; it never imports the engine.

import type { ProducerSubmitDescriptor } from '../do-work/submit-producer-request';
import { imageFootprint } from 'trillion-workshop/tools/organize-the-sidebar/show/image-footprint.ts';
import { finiteCoord } from '../read-data/finite-coord';

/** The most items a text-source paste will materialize. A crafted/huge paste (a million lines) would
 *  allocate a million drafts and freeze the placement loop; a real paste is a handful of lines. */
const MAX_TEXT_SOURCE_ITEMS = 5000;
/** Char cap on the pasted text before it is split, so `split('\n')` can't allocate a million-line array. */
const MAX_TEXT_SOURCE_CHARS = 500_000;

/** What a strategy returns: the fields placeItem needs (position is added by the canvas). */
export interface BoardItemDraft {
  readonly kind: string;
  readonly text?: string;
  readonly src?: string;
  /** Real MIME for media items so the renderer plays the right element (L090). */
  readonly contentType?: string;
  readonly w?: number;
  readonly h?: number;
  /** Opaque extra carried into the item presentation (e.g. requestId + status). */
  readonly extra?: Record<string, unknown>;
}

/** What a producer submission reports back so the board can track it — including
 *  the DATA addresses where the producer will write its result/error, so the
 *  board reads status without knowing the producer (L098). */
export interface ProducerSubmission {
  readonly requestId: string;
  /** true → a producer was fired (poll for the result); false → resolved now (unconfigured). */
  readonly submitted: boolean;
  /** Producer-supplied status addresses (opaque to the board — carried into extra). */
  readonly statusAddresses?: {
    readonly resultAddress: string;
    readonly errorAddress: string;
    readonly addressMode?: 'label-hash' | 'identity-text';
    /** The partition to poll for result/error. Absent → board's own partition. */
    readonly resultPartitionLabel?: string;
  };
}

/** A file the user chose or dropped — bytes + real MIME + name. */
export interface PickedBytes {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly name: string;
}

/** Injected capabilities a strategy may use — kept I/O-blind + testable. */
export interface AddStrategyContext {
  /** The shelf entry that triggered the add (carries its DATA: kind, accept, defaults). */
  readonly tool: AddShelfEntry;
  /** Open the native OS picker filtered to the given content prefixes. */
  readonly pickFiles: (acceptPrefixes: readonly string[]) => Promise<PickedBytes[]>;
  /** Store bytes content-addressed; returns the `/cas/<hash>` URL. */
  readonly storeBytes: (bytes: Uint8Array, contentType: string) => Promise<string>;
  /** Fire the tool's producer (DATA descriptor) with opaque owner input — blind to which producer.
   *  The panel injects the requestId + target group; this stays producer-agnostic. */
  readonly submitProducer?: (producer: ProducerSubmitDescriptor, input: Record<string, unknown>) => Promise<ProducerSubmission | undefined>;
  /** Ask the user for free text (a paste / instruction). Returns null if cancelled. */
  readonly askText?: (label: string) => Promise<string | null>;
  /** Measure an image's natural pixel size (injected DOM I/O — `createImageBitmap`).
   *  Absent (tests / non-DOM) → no measuring, the draft carries no footprint and the
   *  item lands at its default size (back-compat). Returns null for non-images or a
   *  decode failure. The strategy stays I/O-blind + testable; the panel supplies the
   *  real decoder. #215 uses this to place an image at its true aspect ratio. */
  readonly measureImage?: (bytes: Uint8Array, contentType: string) => Promise<{ w: number; h: number } | null>;
  /** Read the current wall-clock (epoch ms) — injected so the leaf stays PURE (no `Date.now`
   *  inside strategy code). The panel supplies `() => Date.now()`. Absent (tests / non-DOM) →
   *  a fired-producer draft simply carries no `started_at`, so the card shows no elapsed timer
   *  (graceful, same injected-I/O pattern as `measureImage`). Never a faked clock (L117). */
  readonly now?: () => number;
}

/** A strategy may produce ONE draft or MANY (a paste / source / producer fills the
 *  board with N items at once). One-vs-many is emergent from the input DATA, not
 *  a closed code path — the board fills whatever the producer returns. */
export type AddStrategyResult = BoardItemDraft | readonly BoardItemDraft[] | null;

export type AddStrategy = (ctx: AddStrategyContext) => Promise<AddStrategyResult>;

/** A shelf "Add" action — DATA. `addStrategy` selects HOW the item is produced. */
export interface AddShelfEntry {
  readonly kind: string;
  readonly label: string;
  readonly addStrategy: string;
  /** Content prefixes the native picker filters to (for file-backed strategies). */
  readonly acceptPrefixes?: readonly string[];
  /** Initial text for a freshly-placed item of this kind (absent = no text). */
  readonly defaultText?: string;
  /** Initial presentation DATA carried into the placed item's opaque `extra` bag
   *  (e.g. `{ shape:'ellipse' }` for a one-click Shape tool, `{ tags:[…] }` for a
   *  pre-tagged preset). Spread blind by {@link placeEmpty}; the canvas/decoder never
   *  enumerate its keys (L090) — it round-trips through the decoder's `extra: p`. This
   *  is the generic seam that lets a shelf row seed ANY initial facet, ZERO code per preset. */
  readonly defaultExtra?: Record<string, unknown>;
  /** Preferred placed footprint in world units (DATA). A tool whose item is only
   *  useful at a larger size — e.g. a live embedded surface (a dashboard/chat) that
   *  is unreadable at the default note size — declares its footprint here; the
   *  {@link placeEmpty} strategy copies it onto the draft's `w`/`h`, which
   *  `placeItem` honours (falling back to `DEFAULTS` when absent). Generic: ANY
   *  shelf tool can size its placement via DATA, ZERO code per sized tool. */
  readonly defaultW?: number;
  readonly defaultH?: number;
  /** For producer-backed tools (produce / source-pull): the DATA descriptor
   *  naming which workflow def to fire + where it publishes. Opaque to the board. */
  readonly producer?: ProducerSubmitDescriptor;
  /** Live-production hints (owner DATA). `totalHint` = how many items this producer
   *  is expected to yield, so the board renders that many skeleton-ahead slots (1 for a
   *  single artifact, N for a multi-item producer). `workingLabel` = the live in-flight
   *  copy shown while producing (e.g. "Breaking this down…"). `timeoutMs` = how long a
   *  pending run may go unanswered before the board fail-closes it to a removable error
   *  card (a slow AI breakdown wants longer than a fast image-gen); absent → the default.
   *  The board stays blind — it reads these from the item's opaque `extra`, never here. */
  readonly totalHint?: number;
  readonly workingLabel?: string;
  readonly timeoutMs?: number;
  /** How this tool's producer output lands (DATA, from the action record's `effect`).
   *  Absent/"add" → append; "reconcile" → the board's consume seam treats the result
   *  as the COMPLETE desired board (edit echoed members in place, add new, drop
   *  omitted). Carried OPAQUE onto the pending item's `extra` so the poll can branch;
   *  the strategy never enumerates the value (L090). */
  readonly effect?: string;
}

/** Place an empty item carrying its default text and any seeded presentation DATA
 *  (`defaultExtra` — e.g. a one-click shape). Blind: spreads `defaultExtra` into the
 *  draft's `extra` without inspecting its keys; absent → no `extra` (back-compat). */
const placeEmpty: AddStrategy = async ({ tool }) => ({
  kind: tool.kind,
  text: tool.defaultText,
  // finiteCoord the DATA-supplied defaults: a persisted Number.MAX_VALUE defaultW/H (valid JSON) would
  // otherwise flow into the caller's centering math and overflow later geometry to Infinity. No-op for real sizes.
  ...(typeof tool.defaultW === 'number' ? { w: finiteCoord(tool.defaultW) } : {}),
  ...(typeof tool.defaultH === 'number' ? { h: finiteCoord(tool.defaultH) } : {}),
  ...(tool.defaultExtra ? { extra: { ...tool.defaultExtra } } : {}),
});

/**
 * Pick a real file from the native OS picker, store its bytes content-addressed,
 * and place an item that references the CAS URL. Blind to the media kind — the
 * renderer dispatches on `contentType` (image/video/audio all flow through here).
 */
const pickAndStore: AddStrategy = async ({ tool, pickFiles, storeBytes, measureImage }) => {
  const picked = await pickFiles(tool.acceptPrefixes ?? []);
  const file = picked.find((f) => f.bytes && f.bytes.byteLength > 0);
  if (!file) return null;
  const src = await storeBytes(file.bytes, file.contentType);
  // #215: size an image to its true aspect ratio (else it squishes into the default
  // note box). Non-images / no decoder / decode failure → no footprint (item default).
  const footprint = file.contentType.startsWith('image/') && measureImage
    ? await measureImage(file.bytes, file.contentType).then((d) => (d ? imageFootprint(d.w, d.h) : null)).catch(() => null)
    : null;
  return {
    kind: tool.kind,
    src,
    contentType: file.contentType,
    text: file.name,
    ...(footprint ? { w: footprint.w, h: footprint.h } : {}),
  };
};

/**
 * Fire a producer from owner-supplied input. The ask is DATA-declared: a tool whose
 * record declares a prompt (`defaultText` — carried from the trigger's `ask.prompt`)
 * asks the user for the instruction text first; a tool with NO declared ask is
 * self-contained and fires IMMEDIATELY (the owner's 2026-07-09 report: every custom
 * action opened a generic "What do you want to create?" modal even though the
 * action's DATA declares no ask — the strategy was treating "askText injected" as
 * "ask wanted"). The strategy fires the tool's DATA producer with the text as
 * opaque `input.instruction_text`. The board never inspects what the producer does
 * with it — it places a pending item; the producer owner fills `src` (single
 * artifact) OR returns many items (multi-item source) when the job completes.
 * This strategy is the producer-blind seam.
 */
const requestProduction: AddStrategy = async ({ tool, submitProducer, askText, now }) => {
  // Ask ONLY when the tool DECLARES a prompt (DATA). No declared prompt → no ask —
  // the action runs on its surface-supplied subject (the panel resolves the tool's
  // input_template against the selection / board content at submit time).
  let instructionText = tool.defaultText ?? '';
  if (askText && tool.defaultText) {
    const entered = (await askText(tool.defaultText))?.trim();
    if (!entered) return null; // user canceled / empty → place nothing
    instructionText = entered;
  }
  // The producer is DATA on the tool; the panel injects how to fire it. No producer
  // wired (or no submit capability) → place a plain item with the instruction text.
  // A no-ask tool has no typed instruction — its pending card shows the action's
  // label (the producer's REAL instruction is the record's input_template, resolved
  // by the panel at submit time against the board subject).
  const cardText = instructionText || tool.label;
  const ownerInput: Record<string, unknown> = { instruction_text: instructionText };
  const submission = tool.producer && submitProducer ? await submitProducer(tool.producer, ownerInput) : undefined;
  if (!submission) return { kind: tool.kind, text: cardText };
  return {
    kind: tool.kind,
    text: cardText,
    extra: {
      requestId: submission.requestId,
      status: submission.submitted ? 'pending' : 'unconfigured',
      // Honest dispatch timestamp (epoch ms) so the card can show a REAL elapsed
      // timer while the job runs — never faked progress (L117), just wall-clock.
      // `now` is INJECTED (the leaf stays pure); absent → no timestamp, no timer.
      ...(submission.submitted && now ? { started_at: now() } : {}),
      // The producer's status addresses ride along as opaque DATA — the board
      // reads status from these, never by knowing the producer (L098).
      ...(submission.statusAddresses ? { statusAddresses: submission.statusAddresses } : {}),
      // Live-production DATA (owner-supplied): how many slots are coming (so the
      // board renders skeleton-ahead of the right shape) + the live working copy.
      ...(typeof tool.totalHint === 'number' ? { total_hint: tool.totalHint } : {}),
      ...(typeof tool.workingLabel === 'string' ? { message: tool.workingLabel } : {}),
      // Owner's fail-closed limit rides along as opaque DATA so the board's poll
      // can honor a per-producer timeout (else it falls back to the default). The
      // poll reads `extra.timeoutMs`; without this write that read was a phantom.
      ...(typeof tool.timeoutMs === 'number' ? { timeoutMs: tool.timeoutMs } : {}),
      // The owner's output EFFECT rides along opaquely so the board's producer-result
      // poll can route this run's output (append vs authoritative reconcile). The
      // board reads `extra.effect`; the strategy never enumerates the value (L090).
      ...(typeof tool.effect === 'string' ? { effect: tool.effect } : {}),
    },
  };
};

/**
 * A local PRODUCER — the simplest non-gated source: the user's own pasted text.
 * Each non-empty line becomes one item of the shelf's kind. Returns MANY drafts;
 * the board fills them all through the producer→group bridge. The same shape a
 * remote source-pull producer returns — this is its local, credential-free
 * instance (a remote source pull is the same code with an external data source).
 */
const textSource: AddStrategy = async ({ tool, askText }) => {
  const raw = (await askText?.(tool.defaultText ?? 'Paste text — one line becomes one item')) ?? '';
  // Cap chars before split (so a million-line paste can't allocate a million-element array) then cap the
  // draft count — a real paste is a handful of lines; the caps only defuse a pathological/hostile paste.
  const text = raw.length > MAX_TEXT_SOURCE_CHARS ? raw.slice(0, MAX_TEXT_SOURCE_CHARS) : raw;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, MAX_TEXT_SOURCE_ITEMS);
  if (lines.length === 0) return null;
  return lines.map((line) => ({ kind: tool.kind, text: line }));
};

/**
 * Save a link/bookmark — the credential-free, manual instance of a source pull
 * (a Pinterest/X/IG pull is the same item produced by a remote source instead of
 * a typed URL). Prompts for a URL, normalizes it to an absolute href so it opens,
 * and places a `link` item carrying the href as `src` and the typed text for display.
 */
const linkSource: AddStrategy = async ({ tool, askText }) => {
  const raw = (await askText?.(tool.defaultText ?? 'Paste a link URL')) ?? '';
  const url = raw.trim();
  if (!url) return null;
  const href = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  return { kind: tool.kind, text: url, src: href };
};

/** The DATA registry: addStrategy key → strategy fn. Owner-extensible (L069/L090). */
export const ADD_STRATEGIES: Readonly<Record<string, AddStrategy>> = {
  empty: placeEmpty,
  pick: pickAndStore,
  produce: requestProduction,
  'text-source': textSource,
  link: linkSource,
};

/** Resolve a strategy by raw key; unknown → empty placement (never a crash). Own-property lookup so a
 *  prototype-named `addStrategy` key ('__proto__'/'constructor', from persisted/imported shelf DATA)
 *  falls back to placeEmpty instead of returning Object.prototype / the Object constructor (which would
 *  then throw or produce a nonsensical strategy when invoked). */
export function addStrategyFor(key: string): AddStrategy {
  return (Object.prototype.hasOwnProperty.call(ADD_STRATEGIES, key) ? ADD_STRATEGIES[key] : undefined) ?? placeEmpty;
}
