// packages/process-session/show/use-process-session-live-output.ts
//
// The ONE blind consumer primitive for a process-session's live output. A caller
// (documents, chat, group, …) passes a `ProcessSessionStreamHandle`
// and gets back growing text + terminal state + a `complete` gate — knowing NOTHING
// about event feeds, HEAD snapshots, delta wire formats, or stream-address
// discovery. All of that lives here, in process-session's own domain (no-god-
// package / L069: one primitive, N blind consumers).
//
// LOSSLESSNESS (why this is not a plain useBitfieldData two-hop): per-event V3
// deltas are APPEND-folded, so every delta MUST reach the fold. `useBitfieldData`
// exposes only the LATEST store snapshot (useSyncExternalStore) — under a fast
// delta burst, intermediate deltas are overwritten before a React commit reads
// them, permanently dropping text (observed: ~62% of an answer lost). So the
// delta STREAM is consumed with `useBitfieldFold`, which folds every exact-push
// delivery into a ref accumulator. The HEAD/feed (small, constant-size, only the
// FINAL value matters) stays on `useBitfieldData` for terminal state + the
// authoritative `bytesWritten` total. The stream address is subscribed IMMEDIATELY
// from the handle (no HEAD-discovery delay → no cold-start loss); it falls back to
// discovering the stream from the HEAD when a producer didn't supply it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import filterBytesAddress from 'trillion-workshop/tools/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm';
import { useBitfieldData, useBitfieldFold } from '#workspace-records';
import { readProcessSessionEventHead, type ProcessSessionState } from '../read-data/read-process-session-events';
import {
  foldProcessSessionOutput,
  foldSessionProgressGuard,
  createEmptyProcessSessionOutputSnapshot,
  type ProcessSessionOutputSnapshot,
  type ProcessSessionStreamHandle,
} from '../read-data/accumulate-process-session-output';
import operators from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from 'trillion-workshop/tools/formula-engine/rules/filter-rows-by-rules.mjs';
import { extractStreamText, streamConditionsLoaded, setStreamConditionEngine } from '../read-data/stream-output-text';

/** Exact-address input owned by this hook's package. Importing entries declare
 * process-session in their dependency read scope; they do not rebind this hook. */
const LIVE_EVENTS_INPUT = 'liveProcessSessionEvents';

let conditionEngine: Promise<void> | null = null;

/** True once the formula engine that decides a stream spec's conditions is loaded (from the bytes the page fetches for
 * its filters); loads it the first time a hook asks. */
function useStreamConditionsReady(): boolean {
  const [ready, setReady] = useState(streamConditionsLoaded());
  useEffect(() => {
    if (ready) return undefined;
    let live = true;
    if (!conditionEngine) {
      const filter = makeRowFilter({ operators, wasm: async () => new Uint8Array(await (await fetch(filterBytesAddress)).arrayBuffer()) });
      conditionEngine = filter.load().then(() => setStreamConditionEngine(filter.holdsNow));
    }
    conditionEngine.then(() => { if (live) setReady(true); }, () => { conditionEngine = null; });
    return () => { live = false; };
  }, [ready]);
  return ready;
}

const OUTPUT_TEXT_ENCODER = new TextEncoder();
const OUTPUT_TEXT_DECODER = new TextDecoder();

export interface ProcessSessionLiveOutput {
  /** The accumulated output text so far — grows as deltas arrive. */
  readonly text: string;
  readonly state: ProcessSessionState;
  /** True once the session has exited or failed. */
  readonly done: boolean;
  /** True once the session is terminal AND every engine-written output byte has
   *  been folded — the deterministic signal a consumer must gate FINALIZE on so
   *  it never places a truncated answer. (`done` can precede `complete` while the
   *  last deltas are still folding.) */
  readonly complete: boolean;
  readonly exitCode: number | null;
  readonly failureReason: string | null;
}

const isTerminal = (state: ProcessSessionState): boolean => state === 'exited' || state === 'failed';

/** Subscribe to a live session's output. `handle: null` means "no active session"
 *  → empty output, no subscriptions. Returns growing text + terminal state +
 *  completeness. Lossless: every delta reaches the fold. */
export function useProcessSessionLiveOutput(handle: ProcessSessionStreamHandle | null): ProcessSessionLiveOutput {
  const sessionId = handle?.sessionId ?? null;

  // hop1: the HEAD/feed. Only its FINAL value matters (terminal state + final
  // bytesWritten), which is always the latest — so latest-value is correct here.
  const headEntry = useBitfieldData({ input: LIVE_EVENTS_INPUT, params: { eventsAddress: handle?.liveFeedAddress ?? null } });
  const headBytes = headEntry instanceof Uint8Array ? headEntry : undefined;
  const head = useMemo(() => (headBytes ? readProcessSessionEventHead(headBytes) : null), [headBytes]);

  // The per-event delta STREAM: prefer the address handed at session start
  // (immediate subscription); else discover it from the HEAD.
  const streamAddress = handle?.streamAddress ?? head?.eventStreamAddress ?? null;

  // hop2: LOSSLESS fold of every delta. sessionId scopes the fold; a null/foreign
  // value is a no-op that keeps the accumulator unchanged.
  const foldFn = useCallback(
    (acc: ProcessSessionOutputSnapshot, value: Uint8Array | null): ProcessSessionOutputSnapshot =>
      (sessionId && value instanceof Uint8Array ? foldProcessSessionOutput(acc, value, sessionId) : acc),
    [sessionId],
  );
  const stream = useBitfieldFold(
    { input: LIVE_EVENTS_INPUT, params: { eventsAddress: streamAddress } },
    foldFn,
    createEmptyProcessSessionOutputSnapshot,
  );

  const textSpec = handle?.textSpec;
  // The spec's conditions are decided by the formula engine, so spec-read text waits until its bytes are loaded.
  const conditionsReady = useStreamConditionsReady();
  const text = useMemo(
    () => (textSpec ? (conditionsReady ? extractStreamText(stream.outputText, textSpec) : '') : stream.outputText),
    [textSpec, stream.outputText, conditionsReady],
  );

  const streamTerminal = isTerminal(stream.state);
  const headTerminal = head ? isTerminal(head.state) : false;
  const done = streamTerminal || headTerminal;

  // Completeness. The lossless stream folds the terminal state-change delta LAST
  // (highest event number) — so `streamTerminal` already implies every preceding
  // output delta is folded. As a secondary safety (e.g. the stream discovered late
  // from the HEAD), also accept: HEAD terminal AND folded output bytes have reached
  // the HEAD's authoritative `bytesWritten` total.
  const foldedBytes = useMemo(() => OUTPUT_TEXT_ENCODER.encode(stream.outputText).length, [stream.outputText]);
  const foldComplete = streamTerminal || (headTerminal && foldedBytes >= (head?.bytesWritten ?? 0));

  // AUTHORITATIVE TERMINAL SNAPSHOT (Option B — the correctness boundary).
  // The producer writes the COMPLETE final output to `terminalOutputAddress` once the
  // session is terminal (held until output EOF AND child exit), so it is immune to the
  // live-delta loss the fold can suffer (bounded subscriber queues, ring-buffer falloff).
  // Subscribe ONLY once `done` — no wasted subscription while running. When these bytes
  // are present they ARE the finalize truth: a lossy fold can never beat them, and they
  // can never be a truncated partial (the producer holds publication until EOF). Feeding
  // this as the guard's text (when available) means finalize persists the full answer even
  // when the delta stream genuinely dropped bytes — the case Option A alone cannot recover.
  const terminalOutputAddress = handle?.terminalOutputAddress ?? null;
  const terminalEntry = useBitfieldData({
    input: LIVE_EVENTS_INPUT,
    params: { eventsAddress: done && terminalOutputAddress ? terminalOutputAddress : null },
  });
  const terminalBytes = terminalEntry instanceof Uint8Array ? terminalEntry : undefined;
  const terminalText = useMemo(() => {
    if (!terminalBytes || terminalBytes.length === 0) return null;
    const raw = OUTPUT_TEXT_DECODER.decode(terminalBytes);
    if (textSpec && !conditionsReady) return null;
    return textSpec ? extractStreamText(raw, textSpec) : raw;
  }, [terminalBytes, textSpec, conditionsReady]);

  // The authoritative snapshot, when present, supersedes the live fold for both text and
  // completeness — its very existence proves the producer reached EOF+exit with the full
  // output, so it is always safe (and complete) to finalize from it.
  const authoritativeText = terminalText ?? text;
  const rawComplete = foldComplete || terminalText !== null;

  // MAX-PROGRESS RETAIN + COMPLETE LATCH (per-session monotonic guards).
  // The delta fold can RESET mid-session — `useBitfieldFold` re-inits its accumulator
  // when the stream-param identity changes, and a store cell tears down when the exited
  // session stops being written. That reset blanks `text` to '' and drops `foldedBytes`
  // below `bytesWritten`, so a naive consumer sees the streamed answer VANISH and
  // `complete` fall back to false BEFORE its finalize effect runs — the answer is lost.
  // Session output is APPEND-ONLY, so the LONGEST text seen is always the most-complete;
  // retaining it (never regressing to a shorter reset artifact) keeps the answer on screen
  // and hands finalize the full text. Latching `complete` (once true, stays true for this
  // session) prevents a post-completion reset from un-firing the finalize gate. Both are
  // idempotent max/OR folds — safe for every blind consumer. This is the client-reset
  // guard; genuine in-transit delta loss still needs the producer's authoritative terminal
  // snapshot (Option B) — this never SAVES truncated text, it only refuses to blank it.
  const retainRef = useRef<{ sessionId: string | null; text: string; complete: boolean }>({
    sessionId: null,
    text: '',
    complete: false,
  });
  retainRef.current = foldSessionProgressGuard(retainRef.current, { sessionId, text: authoritativeText, rawComplete });
  const retainedText = retainRef.current.text;
  const complete = retainRef.current.complete;

  return {
    text: retainedText,
    state: streamTerminal ? stream.state : (head?.state ?? stream.state),
    done,
    complete,
    exitCode: stream.exitCode ?? head?.exitCode ?? null,
    failureReason: stream.failureReason ?? head?.failureReason ?? null,
  };
}
