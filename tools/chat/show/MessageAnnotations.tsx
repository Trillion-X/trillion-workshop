// PORTED FROM: bitfield-packages/packages/chat/show/MessageAnnotations.tsx @ e99ac5976
// bitfield-studio/packages/chat/show/MessageAnnotations.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The SINGLE annotation stack rendered beneath EVERY message bubble — human
// (outbound) and agent/incoming (the other person) alike. It is the SSOT for the
// three message-envelope surfaces that hang off any AgentMessage:
//
//   1. ReactionCluster   — the folded set of CURRENT reactions on the message.
//   2. MessageActionBar   — the hover-revealed AUTHORING affordance (tapback bar):
//                           the write half of "I wasn't able to even do it myself".
//   3. MessageStatusRow   — the fail-closed lifecycle caption (Sending… / Delivered).
//
// Before this component existed, only ChatMessage carried the affordance, so the
// PRIMARY iMessage react target — the OTHER person's incoming bubble, which
// renders through AgentActivityRenderer, not ChatMessage — had no way to be
// reacted to. This is the L063/L100 category fix: extract the stack ONCE, let
// both leaves compose it, and gate the affordance on `message.atomRef` so blocks
// with no durable subject (tool/thinking rows) are naturally excluded.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Enumerates NOTHING: no reaction symbol, no lifecycle key, no action kind is
//    named in code. It renders exactly the reactionPalette + messageActions DATA
//    rows and DISPLAYS the opaque strings the decoder emitted (L090 / enum-
//    dissolution). A new reaction/lifecycle/annotation kind is one data row.
// 2. Provenance is a NUMBER (Physics: 0 optimistic .. 10 authoritative). Tone and
//    the "may show the real state" gate key on the number, never on a key string.
// 3. Fail-closed egress: below the authoritative floor the status row shows ONE
//    vocabulary-free in-flight caption and never echoes an unproven key (which
//    could read "Delivered" and lie).
// 4. Fail-closed authoring: with no onMessageIntent OR no atomRef, the action bar
//    does not render — there is nothing to author onto.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import type {
  AgentMessage,
  MessageStateEvent,
  MessageReaction,
  ReactionPaletteEntry,
  MessageActionDescriptor,
  MessageIntent,
  MessagePerformHandler,
  MessagePerformResult,
} from '../read-data/chat-message-types';
import { plainChatError } from './ChatErrorBanner';
import { Badge, Button, Container, HoverRevealItem, Text } from '../../ui';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
// ---------------------------------------------------------------------------
// MESSAGE-STATE ENVELOPE HELPERS (generic — no key/symbol enumeration)
// ---------------------------------------------------------------------------
//
// The surface never enumerates lifecycle keys ("delivered") or reaction symbols
// ("love"). It DISPLAYS the opaque strings the source decoder emitted as blind
// data, and derives tone from `provenance` — a NUMBER (Physics: 0 optimistic ..
// 10 authoritative), never from the key's identity.

/** Humanize an opaque key/symbol for display: "delivered" -> "Delivered",
 *  "reaction:love" -> "Love". Pure string transform — zero vocabulary. */
export function humanizeKey(raw: string | undefined | null): string {
  if (!raw) return '';
  const tail = raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw;
  const words = tail.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Certainty rank -> Text color. Physics: the boundary is the number, not the
 *  string. Authoritative (>=10) reads confirmed (success); provisional (>=5)
 *  informational; optimistic (<5) stays faint so an un-echoed local send never
 *  looks delivered — the fail-closed guarantee is visible in the color itself. */
export function provenanceColor(provenance: number | undefined): 'success' | 'info' | 'faint' {
  const p = typeof provenance === 'number' ? provenance : 0;
  if (p >= 10) return 'success';
  if (p >= 5) return 'info';
  return 'faint';
}

/** Pick the single lifecycle event to surface: highest provenance wins, then the
 *  latest `at`. Monotonic by construction — the newest confirmed state shows. */
export function latestLifecycle(events: MessageStateEvent[] | undefined): MessageStateEvent | null {
  if (!events || events.length === 0) return null;
  let best: MessageStateEvent | null = null;
  for (const ev of events) {
    if (best === null) { best = ev; continue; }
    const bp = typeof best.provenance === 'number' ? best.provenance : 0;
    const ep = typeof ev.provenance === 'number' ? ev.provenance : 0;
    if (ep > bp) { best = ev; continue; }
    if (ep === bp && (ev.at ?? '') > (best.at ?? '')) best = ev;
  }
  return best;
}

/** The certainty floor at which a lifecycle KEY may be shown verbatim. Physics:
 *  the gate is the NUMBER, not a whitelist of "safe" keys. A source only reaches
 *  this rank when it has PROVEN the state natively (an inbound echo), so only then
 *  may the surface print the state the key names (Delivered / Read / Failed). */
export const AUTHORITATIVE = 10;

/** A single neutral caption for any not-yet-proven (sub-authoritative) state. It
 *  names NO lifecycle — an optimistic local echo has not been confirmed sent, so
 *  the surface must not echo its key (which could read "Delivered" and lie). This
 *  is the fail-closed egress guarantee rendered structurally: below the floor,
 *  ONE vocabulary-free in-flight caption; the real state appears only once the
 *  authoritative echo arrives. Constant, not derived from any event key. */
export const IN_FLIGHT_CAPTION = 'Sending…';

/** Whether the viewer ("me") already authored `symbol` on this message. Drives
 *  toggle semantics: a second tap removes (un-reacts) instead of stacking. */
export function viewerHasReacted(reactions: MessageReaction[] | undefined, symbol: string): boolean {
  if (!reactions) return false;
  return reactions.some(
    (r) => r.symbol === symbol && (r.speaker === 'me' || r.speaker == null),
  );
}

// ---------------------------------------------------------------------------
// STATUS ROW (fail-closed lifecycle caption)
// ---------------------------------------------------------------------------

/** Sent/delivered/read-style status line under a message. At/above the
 *  authoritative floor it renders the decoder-proved key; below it, one fixed
 *  neutral caption that never echoes the (unproven) key. Tone stays provenance. */
function MessageStatusRow({ stateEvents }: { stateEvents: MessageStateEvent[] | undefined }) {
  const ev = latestLifecycle(stateEvents);
  if (!ev) return null;
  const provenance = typeof ev.provenance === 'number' ? ev.provenance : 0;
  const label = provenance >= AUTHORITATIVE ? humanizeKey(ev.key) : IN_FLIGHT_CAPTION;
  if (!label) return null;
  return (
    <Container layout="horizontal" alignItems="center" justifyContent="end" gap="xs" padding="none">
      <Text variant="caption" color={provenanceColor(provenance)}>
        {label}
      </Text>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// REACTION CLUSTER (folded current reactions)
// ---------------------------------------------------------------------------

/** Reactions folded onto a message. Each distinct symbol becomes one badge with a
 *  count; the badge text is the opaque symbol humanized (blind data display). */
function ReactionCluster({
  reactions,
  alignEnd,
}: {
  reactions: MessageReaction[] | undefined;
  alignEnd: boolean;
}) {
  if (!reactions || reactions.length === 0) return null;
  // Group by opaque symbol, count reactors. No symbol is named in code.
  const bySymbol = new Map<string, number>();
  for (const r of reactions) {
    const sym = r.symbol ?? '';
    if (!sym) continue;
    bySymbol.set(sym, (bySymbol.get(sym) ?? 0) + 1);
  }
  if (bySymbol.size === 0) return null;
  return (
    <Container
      layout="horizontal"
      alignItems="center"
      justifyContent={alignEnd ? 'end' : 'start'}
      gap="xs"
      padding="none"
    >
      {Array.from(bySymbol.entries()).map(([sym, count]) => (
        <Badge key={sym} variant="neutral" size="sm">
          {humanizeKey(sym)}{count > 1 ? ` ${count}` : ''}
        </Badge>
      ))}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// ACTION BAR (hover-revealed reaction/annotation authoring affordance)
// ---------------------------------------------------------------------------
//
// The bar answers "I wasn't able to even do it myself": hovering a message
// reveals tappable reaction glyphs (iMessage tapback bar). One tap = one
// viewer-authored intent handed up via onMessageIntent. It enumerates NOTHING —
// it renders exactly the reactionPalette + messageActions DATA rows, and the
// glyph it prints is the opaque `glyph` string each row carries. A new reaction
// symbol or a whole new annotation kind (pin/star/bookmark) is one data row and
// zero code here (L090 / enum-dissolution). Fail-closed: with no onMessageIntent
// or no atomRef to anchor to, the bar does not render (nothing to author onto).

function MessageActionBar({
  message,
  alignEnd,
  reactionPalette,
  messageActions,
  onMessageIntent,
}: {
  message: AgentMessage;
  alignEnd: boolean;
  reactionPalette: ReactionPaletteEntry[] | undefined;
  messageActions: MessageActionDescriptor[] | undefined;
  onMessageIntent: ((intent: MessageIntent) => void) | undefined;
}) {
  const atomRef = message.atomRef;
  // An action that names `confirm` asks first, in place: which one is asking.
  const [asking, setAsking] = React.useState<string | null>(null);
  // Fail-closed: cannot author without a callback or a durable subject to anchor.
  if (!onMessageIntent || !atomRef) return null;
  const palette = reactionPalette ?? [];
  const actions = (messageActions ?? []).filter((action) => !action.forRefs || atomRef.startsWith(action.forRefs));
  if (palette.length === 0 && actions.length === 0) return null;
  const question = actions.find((action) => action.intentKind === asking && action.confirm);
  // An action that must not wait for a hover (a message not sent yet) keeps its row shown.
  const alwaysShown = actions.some((action) => action.always);

  return (
    <Reveal always={alwaysShown}>
      <Container
        layout="horizontal"
        alignItems="center"
        justifyContent={alignEnd ? 'end' : 'start'}
        gap="xs"
        padding="none"
      >
        {palette.map((entry) => {
          const reacted = viewerHasReacted(message.reactions, entry.symbol);
          return (
            <Button
              key={`react:${entry.symbol}`}
              variant={reacted ? 'accent' : 'ghost'}
              size="icon"
              active={reacted}
              title={entry.label ?? entry.symbol}
              aria-label={`React ${entry.label ?? entry.symbol}`}
              onClick={() =>
                onMessageIntent({
                  targetAtomRef: atomRef,
                  intentKind: 'reaction',
                  symbol: entry.symbol,
                  reactionKind: reacted ? 'removed' : 'added',
                })
              }
            >
              <Text variant="body" color={reacted ? 'accent' : 'secondary'}>
                {entry.glyph}
              </Text>
            </Button>
          );
        })}
        {alwaysShown && actions.find((action) => action.note) ? (
          <Text variant="caption" color="secondary">{actions.find((action) => action.note)?.note}</Text>
        ) : null}
        {actions.map((action) => action.always ? (
          <Button
            key={`action:${action.intentKind}`}
            variant="ghost"
            size="sm"
            onClick={() => {
              if (action.confirm && asking !== action.intentKind) { setAsking(action.intentKind); return; }
              setAsking(null);
              onMessageIntent({ targetAtomRef: atomRef, intentKind: action.intentKind });
            }}
          >
            {action.label}
          </Button>
        ) : (
          <Button
            key={`action:${action.intentKind}`}
            variant="ghost"
            size="icon"
            title={action.label}
            aria-label={action.label}
            onClick={() => {
              if (action.confirm && asking !== action.intentKind) { setAsking(action.intentKind); return; }
              setAsking(null);
              onMessageIntent({ targetAtomRef: atomRef, intentKind: action.intentKind });
            }}
          >
            <Text variant="body" color="secondary">
              {action.glyph}
            </Text>
          </Button>
        ))}
      </Container>
      {question ? (
        <Container layout="horizontal" alignItems="center" justifyContent={alignEnd ? 'end' : 'start'} gap="xs" padding="none" role="status">
          <Text variant="caption" color="secondary">{question.confirm}</Text>
          <Button variant="danger" size="sm" onClick={() => { setAsking(null); onMessageIntent({ targetAtomRef: atomRef, intentKind: question.intentKind }); }}>
            {`Yes, ${question.label.charAt(0).toLowerCase()}${question.label.slice(1)}`}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAsking(null)}>Keep it</Button>
        </Container>
      ) : null}
    </Reveal>
  );
}

/** The annotation row: shown on hover, or always when one of its actions asks to be (`always`). */
function Reveal({ always, children }: { always: boolean; children: React.ReactNode }) {
  return always ? <Container layout="vertical" gap="xs" padding="none">{children}</Container> : <HoverRevealItem>{children}</HoverRevealItem>;
}

function MessagePerformControls({
  message,
  onMessagePerform,
}: {
  message: AgentMessage;
  onMessagePerform: MessagePerformHandler | undefined;
}) {
  const [states, setStates] = React.useState<Record<string, MessagePerformResult | { status: 'pending'; message: string; evidenceRefs: string[] }>>({});
  const controls = message.performControls ?? [];
  if (!onMessagePerform || controls.length === 0) return null;

  return (
    <Container layout="vertical" alignItems="start" gap="xs" padding="none" data-reach-role="message-perform-controls">
      {controls.map((control) => {
        const state = states[control.id];
        const pending = state?.status === 'pending';
        const settled = state?.status === 'started' || state?.status === 'unknown_outcome';
        const label = pending
          ? control.pendingLabel ?? 'Starting work'
          : state?.status === 'started'
            ? control.successLabel ?? state.message
            : control.label;
        return (
          <Container key={control.id} layout="vertical" alignItems="start" gap="xs" padding="none">
            <Button
              variant="primary"
              size="sm"
              loading={pending}
              disabled={pending || settled}
              aria-label={control.label}
              data-message-control-id={control.id}
              onClick={() => {
                setStates((current) => ({
                  ...current,
                  [control.id]: { status: 'pending', message: control.pendingLabel ?? 'Starting work', evidenceRefs: [] },
                }));
                void onMessagePerform(message, control)
                  .then((result) => setStates((current) => ({ ...current, [control.id]: result })))
                  .catch((error) => setStates((current) => ({
                    ...current,
                    [control.id]: {
                      status: 'failed',
                      message: plainChatError(errorWords(error, 'Work did not start.')),
                      evidenceRefs: [],
                    },
                  })));
              }}
            >
              {label}
            </Button>
            {state && state.status !== 'pending' ? (
              <Text
                variant="body"
                color={state.status === 'started' ? 'success' : state.status === 'failed' ? 'error' : 'warning'}
                role="status"
              >
                {state.message}
              </Text>
            ) : null}
          </Container>
        );
      })}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// PUBLIC: the composed annotation stack (SSOT for BOTH message leaves)
// ---------------------------------------------------------------------------

export interface MessageAnnotationsProps {
  /** The message whose envelope surfaces (reactions, lifecycle, subject) render. */
  message: AgentMessage;
  /** Right-align the cluster/bar/status (true for outbound human bubbles). */
  alignEnd: boolean;
  /** DATA-driven reaction symbols the viewer may author. Absent -> no affordance. */
  reactionPalette?: ReactionPaletteEntry[];
  /** DATA-driven non-reaction annotations (pin/star/...) on the SAME intent path. */
  messageActions?: MessageActionDescriptor[];
  /** Viewer-intent sink. Absent -> read-only (no affordance) — fail-closed. */
  onMessageIntent?: (intent: MessageIntent) => void;
  /** Executes one exact owner-verified workflow capability selected by the human. */
  onMessagePerform?: MessagePerformHandler;
}

/**
 * The full annotation stack: folded reactions, the hover-revealed authoring bar,
 * and the fail-closed lifecycle caption — in that vertical order. Composed
 * identically by ChatMessage (human bubble) and AgentActivityRenderer (incoming
 * text bubble), so EVERY reactable message carries the same affordance. The
 * action bar self-suppresses when the message has no atomRef, so passing this
 * into a tool/thinking row is harmless.
 */
export function MessageAnnotations({
  message,
  alignEnd,
  reactionPalette,
  messageActions,
  onMessageIntent,
  onMessagePerform,
}: MessageAnnotationsProps) {
  return (
    <>
      <MessagePerformControls message={message} onMessagePerform={onMessagePerform} />
      <ReactionCluster reactions={message.reactions} alignEnd={alignEnd} />
      <MessageActionBar
        message={message}
        alignEnd={alignEnd}
        reactionPalette={reactionPalette}
        messageActions={messageActions}
        onMessageIntent={onMessageIntent}
      />
      <MessageStatusRow stateEvents={message.stateEvents} />
    </>
  );
}

export default MessageAnnotations;
