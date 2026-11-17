// packages/file-editor/show/FileEditorSearchPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The file editor's find / replace widget — an editor-native search bar built
// ENTIRELY from tools/ui primitives + screen-look CSS-var tokens. It is
// mounted into CodeMirror's search-panel slot via the official `createPanel`
// hook (see create-file-editor-search-panel.ts) so CodeMirror NEVER renders its
// own native `.cm-search` DOM. Every control here maps to a stable
// @codemirror/search command/effect; the widget owns no search logic of its own
// beyond translating user intent into those commands.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO raw HTML elements and ZERO className — every visible control and all
//    layout is expressed through Button, Input, Container, Text, Icon, Tooltip
//    from tools/ui and their variant props.
// 2. ZERO search logic duplicated — query is set via `setSearchQuery` and all
//    navigation/replacement goes through CodeMirror commands. The match count is
//    derived from the SAME SearchQuery via `getCursor`, never re-implemented.
// 3. Modifier toggles (match case / regex / whole word) render from the
//    SEARCH_MODIFIERS data array — adding a modifier is one data row, zero JSX.
//    The set is closed by CodeMirror's SearchQuery Physics (fixed query fields).
// 4. The query persists across open/close because CodeMirror keeps it in editor
//    state — we seed local state from `getSearchQuery(view.state)` on mount.
// 5. Keyboard parity: Enter = next, Shift+Enter = previous, Escape = close.
//
// =============================================================================
// KEY CONCEPTS
// =============================================================================
//
// - Query mirror: local React state (search/replace/flags) is the edit surface;
//   a useEffect dispatches `setSearchQuery` whenever it changes so CodeMirror's
//   highlight + commands always operate on the current query.
// - Live "n of N": `computeMatchCount` walks `query.getCursor(doc)` and marks the
//   match whose range equals the current selection. Recomputed on every
//   CodeMirror update (doc/selection change) via the panel update subscription.
// - Surface chrome (background, top-docked border) is supplied by the kept
//   `.cm-panels` theme rule in FileEditor.tsx; this widget owns only layout.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
  SearchQuery,
} from '@codemirror/search';
import { Button, Container, ExpandableTabs, Icon, Input, Text, Tooltip } from '../../ui/index.ts';
import {
  Replace,
  ReplaceAll,
  Search,
  X,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// MODIFIER DESCRIPTORS — data-driven (Invariant 3). Each maps 1:1 to a
// SearchQuery boolean field. Rendering iterates this array.
// ---------------------------------------------------------------------------

type ModifierId = 'caseSensitive' | 'regexp' | 'wholeWord';

interface SearchModifier {
  id: ModifierId;
  label: string;
  /** NamedIcon name. */
  icon: string;
}

const SEARCH_MODIFIERS: readonly SearchModifier[] = [
  { id: 'caseSensitive', label: 'Match case', icon: 'CaseSensitive' },
  { id: 'regexp', label: 'Regex', icon: 'Regex' },
  { id: 'wholeWord', label: 'Whole word', icon: 'WholeWord' },
];

interface MatchCount {
  /** 1-based index of the match at the current selection, or 0 if none. */
  current: number;
  /** Total matches in the document for the active query. */
  total: number;
}

/**
 * Walk the query's cursor over the whole document, counting matches and
 * locating the one whose range equals the current selection. O(matches), only
 * runs while the panel is open.
 */
function computeMatchCount(view: EditorView, query: SearchQuery): MatchCount {
  if (!query.search || !query.valid) return { current: 0, total: 0 };
  const selection = view.state.selection.main;
  const cursor = query.getCursor(view.state);
  let total = 0;
  let exact = 0; // 1-based index of the match currently selected, if any
  let nextAfter = 0; // 1-based index of the first match at/after the caret
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1;
    const { from, to } = next.value;
    if (from === selection.from && to === selection.to) exact = total;
    if (!nextAfter && from >= selection.from) nextAfter = total;
  }
  // Always report a meaningful 1-based position: the selected match, else the
  // match the next-press would land on, else (caret past the last match) 1 —
  // navigation wraps, so 1 is where "next" goes. Prevents a confusing "0/N".
  const current = exact || nextAfter || (total > 0 ? 1 : 0);
  return { current, total };
}

export interface FileEditorSearchPanelProps {
  /** The CodeMirror view this panel controls. */
  view: EditorView;
  /**
   * Registers a callback fired on every CodeMirror ViewUpdate (supplied by the
   * panel factory). Used to keep the live match count in sync as commands move
   * the selection or edit the document. Returns an unsubscribe function.
   */
  subscribeToUpdates: (listener: (update: ViewUpdate) => void) => () => void;
}

/**
 * Editor-native find/replace widget. See file header for the full contract.
 */
export function FileEditorSearchPanel({ view, subscribeToUpdates }: FileEditorSearchPanelProps) {
  const initial = getSearchQuery(view.state);
  const [search, setSearch] = useState(initial.search);
  const [replace, setReplace] = useState(initial.replace);
  const [flags, setFlags] = useState({
    caseSensitive: initial.caseSensitive,
    regexp: initial.regexp,
    wholeWord: initial.wholeWord,
  });
  // Bumped on every CodeMirror update so the match count recomputes.
  const [updateTick, setUpdateTick] = useState(0);

  const findInputRef = useRef<HTMLInputElement>(null);

  const query = useMemo(
    () =>
      new SearchQuery({
        search,
        replace,
        caseSensitive: flags.caseSensitive,
        regexp: flags.regexp,
        wholeWord: flags.wholeWord,
      }),
    [search, replace, flags.caseSensitive, flags.regexp, flags.wholeWord],
  );

  // Push the query into CodeMirror so highlighting + commands stay in sync.
  useEffect(() => {
    view.dispatch({ effects: setSearchQuery.of(query) });
  }, [view, query]);

  // Keep the live count fresh as the document/selection changes.
  useEffect(() => subscribeToUpdates(() => setUpdateTick((t) => t + 1)), [subscribeToUpdates]);

  // Focus the find field as soon as the panel appears.
  useEffect(() => {
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, []);

  const count = useMemo(
    () => computeMatchCount(view, query),
    // updateTick intentionally participates: selection/doc moved.
    [view, query, updateTick],
  );

  const hasQuery = query.search.length > 0;
  const invalid = hasQuery && !query.valid;
  const hasMatches = count.total > 0;

  // Toolbar buttons must NOT take focus on click — if focus left the find input
  // and we re-focused it afterward, the browser would scroll the input back into
  // view and undo `findNext`'s scroll-to-match. Preventing mousedown default keeps
  // focus in the input, so the editor's scroll-to-match sticks (matches the
  // native CodeMirror / VS Code find-widget behavior).
  const keepFindFocus = useCallback((event: React.MouseEvent) => event.preventDefault(), []);

  // Guarantee the editor's search query reflects the current inputs before any
  // command runs. The render effect already dispatches this, but doing it here
  // too removes any dependence on effect timing — findNext can never see a stale
  // or empty query.
  const ensureQuery = useCallback(() => {
    view.dispatch({ effects: setSearchQuery.of(query) });
  }, [view, query]);

  const runNext = useCallback(() => {
    ensureQuery();
    findNext(view);
  }, [view, ensureQuery]);

  const runPrevious = useCallback(() => {
    ensureQuery();
    findPrevious(view);
  }, [view, ensureQuery]);

  const runReplace = useCallback(() => {
    ensureQuery();
    replaceNext(view);
  }, [view, ensureQuery]);

  const runReplaceAll = useCallback(() => {
    ensureQuery();
    replaceAll(view);
  }, [view, ensureQuery]);

  const runClose = useCallback(() => {
    closeSearchPanel(view);
    view.focus();
  }, [view]);

  const toggleModifier = useCallback((id: ModifierId) => {
    setFlags((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const onFindKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Cmd/Ctrl+G is an editor-scoped keymap; while focus is in this input it
      // never reaches the editor, so handle it here for parity.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        // Cmd/Ctrl+F toggles search closed while it's open and focused here.
        event.preventDefault();
        runClose();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (event.shiftKey) runPrevious();
        else runNext();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) runPrevious();
        else runNext();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        runClose();
      }
    },
    [runNext, runPrevious, runClose],
  );

  const onReplaceKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runReplace();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        runClose();
      }
    },
    [runReplace, runClose],
  );

  const countLabel = invalid
    ? 'Invalid regex'
    : hasMatches
      ? `${count.current}/${count.total}`
      : 'No results';

  return (
    <Container layout="vertical" gap="sm" padding="md">
      {/* Find row: query field, live count, modifier toggles, match navigation, close. */}
      <Container layout="horizontal" gap="xs" alignItems="center" wrap="wrap">
        <Container flex="1">
          <Input
            ref={findInputRef}
            aria-label="Find"
            placeholder="Find"
            icon={<Icon icon={Search} size="sm" />}
            value={search}
            error={invalid ? 'Invalid regular expression' : undefined}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={onFindKeyDown}
          />
        </Container>

        {hasQuery && (
          <Text variant="caption" color={invalid || !hasMatches ? 'error' : 'muted'}>
            {countLabel}
          </Text>
        )}

        {/* Presses never take focus from the find field: the wrapper keeps it. */}
        <ExpandableTabs
          mode="action"
          size="sm"
          ariaLabel="Search options"
          items={SEARCH_MODIFIERS.map((modifier) => ({
            id: modifier.id, label: modifier.label, icon: modifier.icon, pinned: flags[modifier.id],
            wrap: (button: React.ReactElement) => <span className="inline-flex" onMouseDown={keepFindFocus}>{button}</span>,
          }))}
          onSelect={(id) => toggleModifier(id as ModifierId)}
        />

        <ExpandableTabs
          mode="action"
          size="sm"
          ariaLabel="Matches"
          items={[
            { id: 'previous', label: 'Previous match', icon: 'ChevronUp', disabled: !hasMatches, wrap: (button: React.ReactElement) => <span className="inline-flex" onMouseDown={keepFindFocus}>{button}</span> },
            { id: 'next', label: 'Next match', icon: 'ChevronDown', disabled: !hasMatches, wrap: (button: React.ReactElement) => <span className="inline-flex" onMouseDown={keepFindFocus}>{button}</span> },
          ]}
          onSelect={(id) => (id === 'previous' ? runPrevious() : runNext())}
        />

        <Tooltip label="Close" shortcut="Esc">
          <Button aria-label="Close search" variant="ghost" size="icon" onClick={runClose}>
            <Icon icon={X} size="sm" />
          </Button>
        </Tooltip>
      </Container>

      {/* Replace row: replacement field + replace one / replace all. */}
      <Container layout="horizontal" gap="xs" alignItems="center" wrap="wrap">
        <Container flex="1">
          <Input
            aria-label="Replace"
            placeholder="Replace"
            icon={<Icon icon={Replace} size="sm" />}
            value={replace}
            onChange={(event) => setReplace(event.target.value)}
            onKeyDown={onReplaceKeyDown}
          />
        </Container>
        <Container layout="horizontal" gap="xs" alignItems="center">
          <Button variant="secondary" size="sm" disabled={!hasMatches} onMouseDown={keepFindFocus} onClick={runReplace}>
            Replace
          </Button>
          <Button variant="primary" size="sm" disabled={!hasMatches} onMouseDown={keepFindFocus} onClick={runReplaceAll}>
            <Icon icon={ReplaceAll} size="sm" />
            Replace all
          </Button>
        </Container>
      </Container>
    </Container>
  );
}
