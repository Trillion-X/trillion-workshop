// parts/ui/show/record-chip/RecordChip.tsx
//
// PURPOSE
//   The one live chip for a mentioned thing of any kind (a person, an AI, a space, a file, a decision, a workflow, a
//   kind of record nobody has named yet): its kind's icon in its kind's colour, then its name. Pressing it opens the
//   thing. It is drawn wherever a mention shows: inside message bubbles (`MentionWords`), in lists, and by the
//   document editor for its inline tokens. After 21st.dev 28303 "AI Input" (entity pills inside words) and the
//   Dropbox Dash and Notion @-mention chips on Mobbin (icon + name pill, underline-free, opens the page on click).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind: a chip's icon and colour are its props, or the caller's kind DATA handed down once
//      through `RecordChipProvider` ({ kinds }), and an unknown kind still draws (the at-sign mark, the neutral tone).
//   2. Where a chip goes is the caller's: `onOpen` runs in place; `href` is a real address (a new tab or a copied link
//      work as for any link), which the provider's `open` may take in place instead of leaving the page. A chip with
//      neither is drawn still, never as a control that does nothing.
//   3. Appearance belongs to screen-look (`record-chip*` classes, `[data-colour]`), the same colour ids the chips in
//      the words being written carry, so a chip reads the same while writing and once sent.

import React from 'react';

import { NamedIcon } from '../icon';
import { safeLinkedIdentityUrl } from '../linked-identity';
import { parseInlineRuns } from 'trillion-workshop/tools/edit-a-document-together/read-data/inline-tokens.ts';
import { mentionRuns, type KeptMention } from './mention-runs';

/** How one kind of thing looks: its name, a named icon and a screen-look colour id. */
export type RecordChipKind = { label: string; icon: string; colour: string };
export type RecordChipKinds = Readonly<Record<string, RecordChipKind>>;

export type RecordChipProps = {
  /** The thing's kind: a key of the caller's kind DATA. */
  kind: string;
  /** The thing's own id. */
  value: string;
  /** What the thing is called. */
  label: string;
  /** A named icon; the kind's icon when left out. */
  icon?: string;
  /** A screen-look colour id; the kind's colour when left out. */
  colour?: string;
  /** Opens the thing in place. */
  onOpen?: () => void;
  /** The thing's address; the provider's `hrefOf` answers it when left out. */
  href?: string;
  /** A generic external destination carried by an inline reference token. */
  destination?: string;
  /** Drawn still, opening nothing (a chip inside words being written, where a click places the caret). */
  still?: boolean;
};

export type RecordChipSetting = {
  /** How each kind looks. */
  kinds?: RecordChipKinds;
  /** The address of one thing, or null when nothing opens it. */
  hrefOf?: (kind: string, value: string) => string | null;
  /** Opens an address in place; answers false to let the browser follow it. */
  open?: (href: string) => boolean;
};

const Setting = React.createContext<RecordChipSetting>({});

/** Hands every chip beneath it the kinds' looks and where things open. */
export function RecordChipProvider({ children, ...setting }: RecordChipSetting & { children?: React.ReactNode }) {
  const { kinds, hrefOf, open } = setting;
  const value = React.useMemo(() => ({ kinds, hrefOf, open }), [kinds, hrefOf, open]);
  return <Setting.Provider value={value}>{children}</Setting.Provider>;
}

/** Whether a click asked for a new tab or window, which the browser answers itself. */
const elsewhere = (event: React.MouseEvent) => event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

export function RecordChip({ kind, value, label, icon, colour, onOpen, href, destination, still = false }: RecordChipProps) {
  const setting = React.useContext(Setting);
  const look = setting.kinds?.[kind];
  // Explicit generic destinations are untrusted document data. Validate those as
  // HTTP(S) only; provider-owned hrefs can be internal app routes and keep their
  // existing routing contract.
  const address = still ? null : destination !== undefined
    ? (safeLinkedIdentityUrl(destination) || null)
    : href ?? setting.hrefOf?.(kind, value) ?? (safeLinkedIdentityUrl(value) || null);
  const shared = {
    className: 'record-chip',
    'data-colour': colour ?? look?.colour,
    'data-record-kind': kind,
    'data-record-value': value,
    title: look ? `${look.label}: ${label}` : label,
  };
  const body = (
    <>
      <NamedIcon name={icon ?? look?.icon ?? 'AtSign'} size="xs" className="record-chip-icon" aria-hidden="true" />
      <span className="record-chip-label">{label}</span>
    </>
  );
  if (onOpen && !still) return <button type="button" {...shared} onClick={onOpen}>{body}</button>;
  if (address) {
    return (
      <a {...shared} href={address} onClick={event => { if (!elsewhere(event) && setting.open?.(address)) event.preventDefault(); }}>
        {body}
      </a>
    );
  }
  return <span {...shared} data-still="true">{body}</span>;
}

/**
 * Words with their mentions drawn as live chips: plain words with the mentions kept beside them (`mentions`, found by
 * `mentionRuns`), or words holding mention tokens (parts/documents/read-data/inline-tokens.ts) when none are given.
 */
export function MentionWords({ text, mentions }: { text: string; mentions?: readonly KeptMention[] }) {
  const runs = mentions ? mentionRuns(text, mentions) : parseInlineRuns(text).map(run => (run.type === 'text' ? run : { ...run, type: 'mention' as const }));
  return <>{runs.map((run, index) => (run.type === 'text'
    ? <React.Fragment key={index}>{run.text}</React.Fragment>
    : <RecordChip key={index} kind={run.kind} value={run.value} label={run.label} icon={'icon' in run ? run.icon : undefined} destination={'destination' in run ? run.destination : undefined} />))}</>;
}
