// PORTED FROM: bitfield-packages/packages/chat/show/ChatInput.tsx @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/ChatInput.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// THE chat composer primitive (single source of truth). A seamless growing
// message field + an affordance row (caller-supplied controls on the left —
// participant/preset/attach pills — and the send/stop control on the right).
// Enter sends, Shift+Enter inserts a newline.
//
// Both the empty-state hero composer and the active-conversation composer
// (ChatComposer, which overlays a slash-command menu) render THIS one field —
// there is no second composer implementation to drift out of sync.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Enter = send, Shift+Enter = newline.
// 2. Send is disabled when input is empty/whitespace-only, disabled, streaming,
//    or a submit is in flight. While streaming the control becomes Stop.
// 3. The composer is COMPOSED from ui/ primitives only (Container layout +
//    borderless auto-growing Textarea + the ui/-composed SendButton) — no
//    hand-written styling and no raw markup in this feature file (the L065/L066
//    firewall). Styling AND the auto-grow behavior live in ui/, not here.
// 4. Calls onSend with trimmed content, then clears + refocuses.
// 5. Active preset and attached context each show as a dismissible row above
//    the field.
// 6. Value is internal by default; a parent may control it (value +
//    onValueChange) to host overlays such as the slash-command menu. The field
//    element is exposed via fieldRef so those overlays can anchor to it.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState, useCallback, useRef, useEffect, useSyncExternalStore } from 'react';

type Draft = { text: string; revision: number };
type DraftSession = { drafts: Map<string, Draft>; listeners: Set<() => void>; revision: number; authorities: Map<string, string> };
const emptyDraft: Draft = { text: '', revision: 0 };
// Same runtime-realm ownership as local UI inputs. No disk, shared DATA,
// telemetry, or provider transport: private text lives only in this app session.
// A realm key also survives re-evaluation of a package during a tab remount.
function draftSession(): DraftSession {
  const host = globalThis as typeof globalThis & { __bitfieldChatDrafts?: DraftSession };
  return host.__bitfieldChatDrafts ??= { drafts: new Map(), listeners: new Set(), revision: 0, authorities: new Map() };
}

export function useChatDraftAuthority(subject: string, authority: string): void {
  useEffect(() => {
    if (!subject) return;
    const session = draftSession();
    const previous = session.authorities.get(subject);
    session.authorities.set(subject, authority);
    const forget = (revoked: string) => {
      for (const key of session.drafts.keys()) {
        let scope: unknown;
        try { scope = JSON.parse(key); } catch { continue; }
        if (Array.isArray(scope) && scope[0] === 'private' && scope[1] === revoked && scope[2] === subject) {
          session.drafts.delete(key);
        }
      }
      for (const listener of session.listeners) listener();
    };
    if (previous && previous !== authority) forget(previous);
    // This surface has no revocation-generation feed outside its mount. Never
    // retain private text across an interval in which authority cannot be seen.
    return () => {
      forget(authority);
      if (session.authorities.get(subject) === authority) session.authorities.delete(subject);
    };
  }, [subject, authority]);
}

export function useChatDraft(scope?: string): [string, (text: string) => void] {
  const [local, setLocal] = useState('');
  const subscribe = useCallback((listener: () => void) => {
    if (!scope) return () => {};
    const session = draftSession();
    session.listeners.add(listener);
    return () => { session.listeners.delete(listener); };
  }, [scope]);
  const read = useCallback(() => scope ? draftSession().drafts.get(scope) ?? emptyDraft : emptyDraft, [scope]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const setText = useCallback((text: string) => {
    if (!scope) { setLocal(text); return; }
    const session = draftSession();
    // An accepted send from an unmounted composer cannot erase an edit made
    // by its successor, even if the user retyped identical text (ABA).
    if (!text && (session.drafts.get(scope) ?? emptyDraft).revision !== snapshot.revision) return;
    session.drafts.set(scope, { text, revision: ++session.revision });
    for (const listener of session.listeners) listener();
  }, [scope, snapshot.revision]);
  return [scope ? snapshot.text : local, setText];
}
import { X, Sparkles, Paperclip } from 'lucide-react';
import { Button, Icon, Badge, Text, Container, Textarea } from '../../ui';
import { pasteDecision } from '../read-data/paste-policy.mjs';

type PasteDecision =
  | { action: 'insert' }
  | { action: 'attach_text'; name: string; text: string; media_type: string; said: string }
  | { action: 'attach_images'; files: { type: string; name?: string }[]; said: string };
import { SendButton } from './input/send-button';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

/** The field grows with content to this height, then scrolls (ChatGPT/Vibecode
 *  composer anatomy — the input is the hero, but never eats the transcript). */
const MAX_INPUT_HEIGHT_PX = 180;

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ChatInputProps {
  /** Callback when the user sends a message */
  onSend: (content: string) => boolean | void | Promise<boolean | void>;
  /** Whether input is disabled (e.g., not connected) */
  disabled?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Affordance row content rendered left of the send button (participant /
   *  preset / attach pills — supplied by the caller, who owns those capabilities). */
  footer?: React.ReactNode;
  /** External value to prefill into the field. Set to trigger prefill, then clear.
   *  Honored only in uncontrolled mode — a controlled parent owns its own text. */
  prefillValue?: string;
  /** Called after prefill has been consumed (parent should clear prefillValue) */
  onPrefillConsumed?: () => void;
  /** Active preset that will augment the message */
  activePreset?: { label: string; prompt: string; description?: string } | null;
  /** Called when the user dismisses the active preset */
  onPresetDismiss?: () => void;
  /** Context attached to the next message (e.g. selected text). Shown as a chip. */
  selectedContext?: { label: string; excerpt?: string } | null;
  /** Dismiss handler, when the attached context can be cleared. */
  onSelectedContextDismiss?: () => void;
  /** Controlled text. When set, the parent owns the value (e.g. to host a
   *  slash-command menu that reads and rewrites it). Omit for internal state. */
  value?: string;
  /** Opaque conversation/profile + privacy scope. Never a message body. */
  draftScope?: string;
  /** Fires on every edit — the other half of the controlled pair. */
  onValueChange?: (next: string) => void;
  /** When a response is streaming, the right-side control becomes a stop button. */
  isStreaming?: boolean;
  /** Called when the user clicks stop while streaming. */
  onStop?: () => void;
  /** Ref to the field element, for anchoring overlays (slash menu, mentions). */
  fieldRef?: React.Ref<HTMLTextAreaElement>;
  /** A composer that can hold attachments takes the paste policy's answer (parts/chat/read-data/paste-policy.json): a long
   *  paste or an image-only paste arrives here instead of filling the field. Without it every paste is a normal paste. */
  onPasteAttachment?: (decision: Exclude<PasteDecision, { action: 'insert' }>) => void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ChatInput({
  onSend,
  disabled = false,
  placeholder = 'Message…',
  footer,
  prefillValue,
  onPrefillConsumed,
  activePreset,
  onPresetDismiss,
  selectedContext,
  onSelectedContextDismiss,
  value,
  draftScope,
  onValueChange,
  isStreaming = false,
  onStop,
  fieldRef,
  onPasteAttachment,
}: ChatInputProps) {
  const controlled = value !== undefined;
  const [internalValue, setInternalValue] = useChatDraft(draftScope);
  const text = controlled ? value : internalValue;
  const [submitInFlight, setSubmitInFlight] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Single writer for the text, whether the value is internal or parent-owned.
  const setText = useCallback(
    (next: string) => {
      if (!controlled) setInternalValue(next);
      onValueChange?.(next);
    },
    [controlled, onValueChange, setInternalValue],
  );

  // Merge the optional external field ref with our internal one so overlays can
  // anchor to the field while we still measure it for focus.
  const setFieldRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      if (typeof fieldRef === 'function') fieldRef(node);
      else if (fieldRef) (fieldRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    },
    [fieldRef],
  );

  // Apply external prefill value when provided (uncontrolled mode only).
  useEffect(() => {
    if (prefillValue && !controlled) {
      setInternalValue(prefillValue);
      onPrefillConsumed?.();
      textareaRef.current?.focus();
    }
  }, [prefillValue, onPrefillConsumed, controlled]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || isStreaming || submitInFlight) return;
    setSubmitError(null);
    setSubmitInFlight(true);
    try {
      const accepted = await onSend(trimmed);
      if (accepted === false) {
        setSubmitError('Your message could not be sent. Try again.');
        return;
      }
      setText('');
      textareaRef.current?.focus();
    } catch (error) {
      console.error('[chat] send failed:', error instanceof Error ? error.message : String(error));
      setSubmitError('Your message could not be sent. Try again.');
    } finally {
      setSubmitInFlight(false);
    }
  }, [text, disabled, isStreaming, submitInFlight, onSend, setText]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const canSend = text.trim().length > 0 && !disabled && !submitInFlight && !isStreaming;
  const inputDisabled = disabled || submitInFlight;

  return (
    <Container layout="vertical" gap="sm" padding="md">
      {/* Active preset — a dismissible row above the field */}
      {activePreset && (
        <Container layout="horizontal" gap="sm" alignItems="center" padding="xs" border="all" background="overlay">
          <Icon icon={Sparkles} size="sm" color="accent" />
          <Badge variant="accent" size="md">
            {activePreset.label}
          </Badge>
          <Container flex="1" minHeight="0" overflow="hidden">
            <Text variant="caption" color="muted" title={activePreset.description}>
              {activePreset.description || 'Preset active — will augment your message'}
            </Text>
          </Container>
          <Button variant="ghost" size="icon" onClick={onPresetDismiss} aria-label="Dismiss preset">
            <Icon icon={X} size="sm" />
          </Button>
        </Container>
      )}

      {/* Attached context for the next message — a chip so the user can see it. */}
      {selectedContext && (
        <Container layout="horizontal" gap="sm" alignItems="center" padding="xs" border="all" background="overlay">
          <Icon icon={Paperclip} size="sm" color="muted" />
          <Badge variant="muted" size="md">
            {selectedContext.label}
          </Badge>
          {selectedContext.excerpt && (
            <Container flex="1" minHeight="0" overflow="hidden">
              <Text variant="caption" color="faint" title={selectedContext.excerpt}>
                {selectedContext.excerpt}
              </Text>
            </Container>
          )}
          {onSelectedContextDismiss && (
            <Button variant="ghost" size="icon" onClick={onSelectedContextDismiss} aria-label="Remove attached context">
              <Icon icon={X} size="sm" />
            </Button>
          )}
        </Container>
      )}

      {/* The composer field — seamless, growing (auto-grow owned by the primitive). */}
      <Textarea
        ref={setFieldRef}
        borderless
        autoGrow
        maxHeight={MAX_INPUT_HEIGHT_PX}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={onPasteAttachment ? (event) => {
          const board = event.clipboardData;
          const decision = pasteDecision({ text: board.getData('text/plain'), html: board.getData('text/html'), files: Array.from(board.files) }) as PasteDecision;
          if (decision.action === 'insert') return;
          event.preventDefault();
          onPasteAttachment(decision);
        } : undefined}
        placeholder={placeholder}
        disabled={inputDisabled}
        aria-label="Message"
      />

      {/* Affordance row: caller controls left, send/stop right. */}
      <Container layout="horizontal" gap="sm" alignItems="center">
        {footer ? (
          <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap" flex="1" minWidth="0">
            {footer}
          </Container>
        ) : (
          <Container flex="1" minWidth="0" />
        )}
        <Container flex="none">
          <SendButton
            isStreaming={isStreaming}
            disabled={!canSend}
            onSend={handleSend}
            onStop={onStop ?? (() => {})}
          />
        </Container>
      </Container>
      {submitInFlight ? (
        <Text role="status" aria-live="polite" variant="caption" color="muted">Sending…</Text>
      ) : null}
      {submitError ? (
        <Container role="alert" layout="horizontal" gap="sm" alignItems="center" padding="xs" border="all">
          <Text variant="caption" color="error" wrap="preserve">{submitError}</Text>
          <Button variant="ghost" size="sm" onClick={() => handleSend()}>Retry</Button>
        </Container>
      ) : null}
    </Container>
  );
}
