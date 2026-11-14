// packages/supabase-sign-in/show/mount-supabase-sign-in-completion.tsx
//
// Headless Supabase magic-link COMPLETION companion (Task #17, Codex-converged Option B).
//
// When a visitor returns from a Supabase magic-link email, the link lands them on a route
// carrying ?supabase_sign_in=complete&token_hash=...&type=.... This companion owns the FULL
// completion lifecycle as a self-contained, decoupled unit so the anon-entry router
// (screen-after-sign-in-check) no longer has to import provider SDK code or hold the session
// flip itself:
//   1. no-op unless ?supabase_sign_in=complete is present (and token_hash + type + a provider
//      descriptor are available) — honest no-op otherwise;
//   2. exchange the token for a canonical browser session via completeSupabaseSignIn (which
//      persists the session server-side under the email-hash account id);
//   3. auto-join any descriptor-authored free subjects before the first signed-in paint;
//   4. strip the supabase_sign_in/token_hash/type query params;
//   5. RELOAD via window.location.assign(cleanedUrl) so the shell re-reads the now-signed-in
//      browser session and renders the signed-in surface. A headless companion cannot flip the
//      router's React session state, so a reload is the correct, decoupled hand-off (Codex
//      Option B refinement: "the companion must own the full callback lifecycle... then force
//      the shell to observe the new session via reload").
//
// Mounted by address as a route-plan companion (same generic CompanionMounts primitive the
// traffic beacons use), so the closed AnonEntrySurface enum + the consumer's inline supabase
// completion effect can be deleted (L101 — finish the half-done dissolution). Renders nothing.
//
// Provider config is DATA: the Supabase descriptor (verify endpoint, credential refs, session
// target) is read from an injected input, never hardcoded. No account/app/project vocabulary
// in this file beyond the supabase provider it owns.

import React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { mountReactSurface } from '@/packages/ui';
import { completeSupabaseSignIn } from '@/packages/supabase-sign-in/do-work/complete-supabase-sign-in';
import { readSupabaseSignInDescriptor } from '@/packages/supabase-sign-in/read-data/read-supabase-sign-in-records';
import { currentLogBrowserSessionBrowserId } from '@/packages/account-session/do-work/browser-session-browser-id';

/** The query param that marks a returning magic-link completion. DATA-stable contract. */
const COMPLETE_PARAM = 'supabase_sign_in';
const COMPLETE_VALUE = 'complete';
const JOIN_TARGET = 'subject-participant.join-subject';

type JsonRecord = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function decodeTargetReply(reply: unknown): JsonRecord {
  const payload = record(reply)?.payload ?? reply;
  if (payload instanceof Uint8Array || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
    const bytes = payload instanceof Uint8Array
      ? payload
      : payload instanceof ArrayBuffer
        ? new Uint8Array(payload)
        : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    return record(JSON.parse(new TextDecoder().decode(bytes))) ?? {};
  }
  return record(payload) ?? {};
}

function currentConflict(reply: JsonRecord): JsonRecord | null {
  const conflicts = Array.isArray(reply.conflicts) ? reply.conflicts : [];
  return record(conflicts[0]);
}

function acceptedMembership(reply: JsonRecord): boolean {
  return reply.status === 'accepted';
}

function alreadyJoinedMembership(reply: JsonRecord): boolean {
  if (reply.conflict !== true) return false;
  const current = record(currentConflict(reply)?.current);
  return Boolean(current && current.removed !== true);
}

function retryRevision(reply: JsonRecord): number | null {
  if (reply.conflict !== true) return null;
  const currentRevision = Number(currentConflict(reply)?.current_revision);
  return Number.isSafeInteger(currentRevision) && currentRevision >= 1 ? currentRevision : null;
}

async function tryJoinSubject(subjectRef: string, expectedRevision?: number): Promise<JsonRecord> {
  return decodeTargetReply(await sendRequestToBitfieldTarget({
    target: JOIN_TARGET,
    payload: {
      subject_ref: subjectRef,
      expected_revision: expectedRevision ?? 0,
      idempotency_ref: `supabase-auto-join:${crypto.randomUUID()}`,
    },
  }));
}

async function ensureSubjectMembership(subjectRef: string): Promise<void> {
  if (!text(subjectRef)) return;
  const first = await tryJoinSubject(subjectRef);
  if (acceptedMembership(first) || alreadyJoinedMembership(first)) return;

  const currentRevision = retryRevision(first);
  if (currentRevision !== null) {
    const retried = await tryJoinSubject(subjectRef, currentRevision);
    if (acceptedMembership(retried) || alreadyJoinedMembership(retried)) return;
  }

  throw new Error(text(first.error) || `Auto-join failed for ${subjectRef}`);
}

export function SupabaseSignInCompletionCompanion({
  providerRecords,
}: {
  /** Test seam: when omitted, the descriptor is read from the injected input. */
  providerRecords?: unknown;
} = {}): null {
  const injected = useBitfieldData('supabase-provider-records');
  const records = providerRecords ?? injected;
  const handledRef = React.useRef(false);

  React.useEffect(() => {
    if (handledRef.current || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(COMPLETE_PARAM) !== COMPLETE_VALUE) return; // not a completion return → no-op
    const descriptor = readSupabaseSignInDescriptor(records as never);
    const tokenHash = params.get('token_hash');
    const type = params.get('type');
    if (!descriptor || !tokenHash || !type) return; // missing inputs → honest no-op (cannot complete)
    handledRef.current = true;

    void (async () => {
      try {
        await completeSupabaseSignIn({
          browser_id: currentLogBrowserSessionBrowserId(),
          kind: 'supabase-sign-in-complete-request',
          provider: descriptor,
          provider_id: descriptor.id,
          token_hash: tokenHash,
          type,
        });
        if (Array.isArray(descriptor.auto_join_subjects) && descriptor.auto_join_subjects.length > 0) {
          try {
            for (const subjectRef of descriptor.auto_join_subjects) {
              await ensureSubjectMembership(subjectRef);
            }
          } catch (error) {
            // Sign-in must stay whole even if a tenant-authored free join
            // needs the signed-in community surface fallback to finish.
            console.warn('[supabase-sign-in] auto-join fell back to signed-in surface repair', error);
          }
        }
        // Clean the one-time return params, then RELOAD so the shell observes the new session.
        const next = new URL(window.location.href);
        next.searchParams.delete(COMPLETE_PARAM);
        next.searchParams.delete('token_hash');
        next.searchParams.delete('type');
        const cleaned = `${next.pathname}${next.search}${next.hash}`;
        console.log('[supabase-sign-in] completion succeeded → reloading signed-in', cleaned);
        window.location.assign(cleaned);
      } catch (error) {
        // Fail-closed: leave the visitor on the same surface (still anon); they can retry.
        console.error('[supabase-sign-in] completion failed', error);
        handledRef.current = false;
      }
    })();
  }, [records]);

  return null;
}

type MountArgs = { el: HTMLElement; props?: { providerRecords?: unknown } };

export default function mount({ el, props }: MountArgs) {
  return mountReactSurface(el, <SupabaseSignInCompletionCompanion providerRecords={props?.providerRecords} />);
}
