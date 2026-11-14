// parts/ui/show/collection-header/CollectionHeader.tsx
//
// PURPOSE
//   The top of a page that holds a collection of things shared by a group of people: what kind of place it is, its
//   title and one line about it, the people in it as an overlapping avatar group (pressing it opens who is there), the
//   few actions that matter most as buttons (one of them primary), and every other action in a `…` menu. Laid out
//   after Basecamp's project home, HoneyBook's project header and Tana's team hub, with the avatar-group-plus-action
//   anatomy of 21st.dev 28524 "project item card" and 25107 "team invitation alert". On a narrow pane (under 480 px,
//   a 390 px phone) the action buttons move into the menu as its first rows. The picture and words stay together;
//   people and actions wrap beneath them when their combined intrinsic widths do not fit, so they never squeeze
//   the title or its description into a few characters even just above the narrow threshold.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: the kind, title, lead, labels and icons all come from the caller; every press (a button or a
//      menu row) is reported as its id through `onAction`, and the people through `onPeople`.
//   2. A kind nobody named still draws: the kind goes through the shared RecordKindMark, whose fallback reads any key.
//   3. The narrow layout is decided by the header's own measured width, not the window's, so a narrow pane beside a
//      wide one reflows the same way a phone does.
//   4. Controls are the shared Button, ActionMenu and AvatarGroup; appearance is screen-look/show/collection-header.css
//      (`.collection-header*`).

import React from 'react';
import { ActionMenu, type ActionMenuItem } from '../action-menu/ActionMenu';
import { AvatarGroup, type AvatarGroupItem } from '../avatar-group/AvatarGroup';
import { Button } from '../button/Button';
import { NamedIcon } from '../icon/NamedIcon';
import { RecordKindMark } from '../record-kind/RecordKindMark';
import { Text } from '../text/Text';
import { InfoHint, type InfoHintProps } from '../info-hint/InfoHint';

/** One action drawn as a button while the header is wide, and as a menu row while it is narrow. */
export interface CollectionHeaderAction {
  id: string;
  label: string;
  /** Lucide icon NAME (data, resolved by NamedIcon). */
  icon: string;
  /** The one action most people come here for: drawn filled. */
  primary?: boolean;
}

export interface CollectionHeaderProps {
  /** The kind of place (a record kind key), drawn by the shared kind mark above the title. */
  kind?: string;
  title: string;
  lead?: string;
  /** The place's own picture beside its title, or its letters while it has none; `colour` is a palette id the
   *  letters' tile wears (`data-colour`, painted by screen-look). */
  mark?: { picture?: string | null; letters: string; colour?: string | null };
  /** The words that explain the place, behind an info icon beside the title rather than as a line under it. */
  info?: Pick<InfoHintProps, 'label' | 'text' | 'title'>;
  people?: AvatarGroupItem[];
  /** Pressing the people opens who is there. */
  onPeople?: () => void;
  /** Words a screen reader says for the people ("3 people"); the caller's, since it knows who they are. */
  peopleLabel?: string;
  actions?: CollectionHeaderAction[];
  menu?: ActionMenuItem[];
  /** Words a screen reader says for the `…` menu button. */
  menuLabel?: string;
  onAction: (id: string) => void;
  /** 'list' when the header sits straight on a pane above a list's view bar (a pursuit over its Messages): its
   *  picture and title start on the same line as the list's title under it. */
  inset?: 'none' | 'list';
}

/** Under this many pixels wide the action buttons move into the menu. */
const NARROW_BELOW = 480;

/** True while `node` is narrower than `below` px, measured by a ResizeObserver where the page has one. */
function useNarrow(node: React.RefObject<HTMLElement | null>, below: number): boolean {
  const [narrow, setNarrow] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = node.current;
    if (!element || typeof ResizeObserver !== 'function') return undefined;
    const measure = (width: number) => setNarrow(width > 0 && width < below);
    measure(element.getBoundingClientRect().width);
    const watch = new ResizeObserver(entries => { for (const entry of entries) measure(entry.contentRect.width); });
    watch.observe(element);
    return () => watch.disconnect();
  }, [node, below]);
  return narrow;
}

/** The place's picture, falling back to its letters when there is none or it does not load. */
function HeaderMark({ picture, letters, colour }: { picture: string | null; letters: string; colour: string | null }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [picture]);
  return (
    <span className="collection-header-mark" data-colour={colour ?? undefined} aria-hidden="true">
      {picture && !failed ? <img src={picture} alt="" decoding="async" onError={() => setFailed(true)} /> : <span className="collection-header-letters">{letters}</span>}
    </span>
  );
}

/** The menu's rows: while narrow, the actions first (their own group), then the caller's rows. */
export function collectionHeaderMenuRows(actions: readonly CollectionHeaderAction[], menu: readonly ActionMenuItem[], narrow: boolean): ActionMenuItem[] {
  if (!narrow || actions.length === 0) return [...menu];
  return [...actions.map(action => ({ id: action.id, label: action.label, icon: action.icon, group: 'collection-header-actions' })), ...menu];
}

export function CollectionHeader({ kind, title, lead, mark, info, people = [], onPeople, peopleLabel, actions = [], menu = [], menuLabel = 'More', onAction, inset = 'none' }: CollectionHeaderProps) {
  const root = React.useRef<HTMLElement>(null);
  const narrow = useNarrow(root, NARROW_BELOW);
  const rows = collectionHeaderMenuRows(actions, menu, narrow);
  return (
    <header ref={root} className="collection-header" data-narrow={narrow || undefined} data-inset={inset === 'none' ? undefined : inset}>
      <div className="collection-header-identity">
        {mark ? <HeaderMark picture={mark.picture ?? null} letters={mark.letters} colour={mark.colour ?? null} /> : null}
        <div className="collection-header-text">
          {kind ? <RecordKindMark kind={kind} /> : null}
          <span className="collection-header-heading">
            <Text as="h1" variant="heading-lg" className="collection-header-title">{title}</Text>
            {info ? <InfoHint {...info} /> : null}
          </span>
          {lead ? <Text variant="body" color="muted" className="collection-header-lead">{lead}</Text> : null}
        </div>
      </div>
      <div className="collection-header-side">
        {people.length ? (
          <span className="collection-header-people">
            <AvatarGroup items={people} size="sm" max={4} ariaLabel={peopleLabel} onClick={onPeople} />
          </span>
        ) : null}
        {!narrow && actions.length ? (
          <span className="collection-header-actions">
            {actions.map(action => (
              <Button key={action.id} type="button" size="sm" variant={action.primary ? 'primary' : 'outline'} onClick={() => onAction(action.id)}>
                <NamedIcon name={action.icon} size="sm" aria-hidden="true" />
                {action.label}
              </Button>
            ))}
          </span>
        ) : null}
        {rows.length ? <ActionMenu label={menuLabel} items={rows} onAction={onAction} align="end" /> : null}
      </div>
    </header>
  );
}
