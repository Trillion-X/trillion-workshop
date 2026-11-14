//
// =============================================================================
// PURPOSE — Command palette (Cmd-K quick actions), blind + generic
// =============================================================================
//
// The keyboard-first launcher over a caller-supplied ACTION CATALOG (Raycast /
// Linear / Figma actions menu / Miro command palette). It owns NONE of the
// actions — it renders a list of `{ id, label, icon, hint, section, run }` rows,
// filters them by the typed query, lets the arrow keys walk the results, and
// dispatches `run()` on Enter. It has ZERO domain vocabulary: the board hands it
// its live `BatchActionCapability` catalog (already `{label, icon, run}` data), a
// chat surface could hand it chat commands, a settings surface its settings — the
// palette is the same blind renderer over any catalog (enum-dissolution: the
// palette never enumerates the actions, it reads them as DATA).
//
// Reference-grounded (Mobbin: Fey, Vapi, Linear, Clay, Juicebox): a centred
// elevated panel, a search input at the top with a leading magnifier, sectioned
// result rows (leading icon + label + a trailing shortcut hint), the active row
// highlighted, and a footer hint bar (navigate / select / count).
//
// The FILTER is a pure exported function (`filterCommands`) so the match logic is
// unit-proven with zero DOM; the component only plumbs its result.
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NamedIcon } from '../icon/NamedIcon';
import { FloatingPanel } from '../../../screen-arrangement/show/FloatingPanel';
import { filterCommands, type CommandPaletteItem } from './command-filter';

export { filterCommands };
export type { CommandPaletteItem };

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly items: readonly CommandPaletteItem[];
  readonly placeholder?: string;
  readonly emptyLabel?: string;
  /** The caller searches its own source: every change of the typed words is reported here, and `items` are drawn as
   *  given (the caller has already narrowed them), instead of being filtered in place. */
  readonly onQueryChange?: (query: string) => void;
  /** A source read one page at a time: a last row that asks the caller for the next page. The palette stays open. */
  readonly more?: { readonly label: string; readonly run: () => void };
  /** Hears the row chosen, just before it runs (a row chosen here is a command run the slow way, which a screen may coach). */
  readonly onChoose?: (item: CommandPaletteItem) => void;
}

const INPUT_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderBottom: '1px solid var(--border-primary)',
};
const INPUT: React.CSSProperties = {
  flex: 1,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'var(--text-primary)',
  fontSize: 15,
};
const LIST: React.CSSProperties = { maxHeight: 360, overflowY: 'auto', padding: 6 };
const SECTION: React.CSSProperties = {
  fontSize: 'var(--font-size-caption)',
  color: 'var(--text-tertiary)',
  padding: '8px 10px 4px',
};
const ROW = (active: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 10px',
  borderRadius: 'var(--radius-default, 8px)',
  cursor: 'pointer',
  background: active ? 'var(--surface-hover, rgba(127,127,127,0.14))' : 'transparent',
  color: 'var(--text-primary)',
});
const ROW_TEXT: React.CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0 };
const DETAIL: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-tertiary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const MORE = (active: boolean): React.CSSProperties => ({ ...ROW(active), justifyContent: 'center', color: 'var(--text-secondary)' });
const HINT: React.CSSProperties = {
  marginLeft: 'auto',
  fontSize: 12,
  color: 'var(--text-tertiary)',
  whiteSpace: 'nowrap',
};
const FOOTER: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  padding: '8px 12px',
  borderTop: '1px solid var(--border-primary)',
  fontSize: 12,
  color: 'var(--text-tertiary)',
};
const EMPTY: React.CSSProperties = { padding: '24px 12px', textAlign: 'center', color: 'var(--text-tertiary)' };

export function CommandPalette({
  open,
  onClose,
  items,
  placeholder = 'Type a command…',
  emptyLabel = 'No matching commands',
  onQueryChange,
  more,
  onChoose,
}: CommandPaletteProps): React.ReactElement | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // A fresh launch every time — clear the query + focus the input on open.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // A caller that searches its own source has already narrowed `items`; filtering them again here would hide rows it
  // matched on words the palette cannot see.
  const results = useMemo(() => (onQueryChange ? [...items] : filterCommands(items, query)), [items, query, onQueryChange]);
  // The "more" row, when offered, is one more stop for the arrow keys, after every result.
  const stops = results.length + (more ? 1 : 0);

  // Clamp the active index whenever the result set shrinks.
  useEffect(() => {
    setActive((a) => (stops === 0 ? 0 : Math.min(a, stops - 1)));
  }, [stops]);

  if (!open) return null;

  const runActive = () => {
    if (more && active === results.length) {
      more.run();
      return;
    }
    const item = results[active];
    if (item) {
      onClose();
      onChoose?.(item);
      item.run();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (stops === 0 ? 0 : Math.min(a + 1, stops - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runActive();
    }
  };

  // Group results into their sections, preserving first-seen order.
  const sections: { section: string | undefined; rows: { item: CommandPaletteItem; index: number }[] }[] = [];
  results.forEach((item, index) => {
    const key = item.section;
    let bucket = sections.find((s) => s.section === key);
    if (!bucket) {
      bucket = { section: key, rows: [] };
      sections.push(bucket);
    }
    bucket.rows.push({ item, index });
  });

  return (
    <FloatingPanel open={open} onClose={onClose} label="Command palette" width={576}>
      <div onKeyDown={onKeyDown}>
        <div style={INPUT_ROW}>
          <NamedIcon name="Search" size="sm" />
          <input
            ref={inputRef}
            style={INPUT}
            value={query}
            placeholder={placeholder}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              onQueryChange?.(e.target.value);
            }}
            aria-label="Command palette search"
          />
        </div>
        <div style={LIST} role="listbox" aria-label="Commands">
          {results.length === 0 ? (
            <div style={EMPTY}>{emptyLabel}</div>
          ) : (
            sections.map((s) => (
              <div key={s.section ?? '__none__'}>
                {s.section ? <div style={SECTION}>{s.section}</div> : null}
                {s.rows.map(({ item, index }) => (
                  <div
                    key={item.id}
                    role="option"
                    aria-selected={index === active}
                    style={ROW(index === active)}
                    onMouseEnter={() => setActive(index)}
                    // Run on MOUSEDOWN, not click (house idiom — DragHandleMenu,
                    // MaterialMenu): pressing a row blurs the search input, which
                    // re-renders between mousedown and mouseup, so the native
                    // `click` retargets to the list container and a row onClick
                    // NEVER fires — every mouse pick silently no-opped and the
                    // palette read as frozen. preventDefault keeps focus stable.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onClose();
                      onChoose?.(item);
                      item.run();
                    }}
                  >
                    {item.icon ? <NamedIcon name={item.icon} size="sm" /> : null}
                    {item.detail ? (
                      <span style={ROW_TEXT}>
                        <span>{item.label}</span>
                        <span style={DETAIL}>{item.detail}</span>
                      </span>
                    ) : <span>{item.label}</span>}
                    {item.hint ? <span style={HINT}>{item.hint}</span> : null}
                  </div>
                ))}
              </div>
            ))
          )}
          {more ? (
            <div
              role="option"
              aria-selected={active === results.length}
              style={MORE(active === results.length)}
              onMouseEnter={() => setActive(results.length)}
              // Mousedown for the same reason as the rows above; the palette stays open for the next page.
              onMouseDown={(e) => {
                e.preventDefault();
                more.run();
              }}
            >
              {more.label}
            </div>
          ) : null}
        </div>
        <div style={FOOTER}>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span style={{ marginLeft: 'auto' }}>{results.length} result{results.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </FloatingPanel>
  );
}
