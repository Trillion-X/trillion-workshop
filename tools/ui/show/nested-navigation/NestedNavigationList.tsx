import * as React from 'react';
import { ChevronDown, ChevronRight, LockKeyhole, Play } from 'lucide-react';
import {
  nestedNavigationClasses as styles,
  nestedNavigationStyle,
} from '../../../screen-look/show/nested-navigation-style';

export interface NestedNavigationItem {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface NestedNavigationCollection {
  id: string;
  name: string;
  items: readonly NestedNavigationItem[];
  collections?: readonly NestedNavigationCollection[];
}

export interface NestedNavigationListProps {
  collections: readonly NestedNavigationCollection[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  search?: string;
  emptyLabel?: string;
}

function containsSelection(collection: NestedNavigationCollection, selectedId: string | null | undefined): boolean {
  if (!selectedId) return false;
  return collection.items.some(item => item.id === selectedId)
    || (collection.collections ?? []).some(child => containsSelection(child, selectedId));
}

function matchesCollection(collection: NestedNavigationCollection, query: string): boolean {
  if (!query) return true;
  return collection.name.toLocaleLowerCase().includes(query)
    || collection.items.some(item => item.label.toLocaleLowerCase().includes(query))
    || (collection.collections ?? []).some(child => matchesCollection(child, query));
}

function CollectionBranch({
  collection, selectedId, onSelect, query, depth,
}: {
  collection: NestedNavigationCollection;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  query: string;
  depth: number;
}) {
  const [expanded, setExpanded] = React.useState(() => depth === 0 || containsSelection(collection, selectedId));
  const visible = matchesCollection(collection, query);
  const open = query ? true : expanded;
  if (!visible) return null;
  const nameMatches = collection.name.toLocaleLowerCase().includes(query);
  const children = collection.collections ?? [];
  const visibleItems = !query || nameMatches
    ? collection.items
    : collection.items.filter(item => item.label.toLocaleLowerCase().includes(query));
  return (
    <div className={styles.branch} data-depth={depth}>
      <button
        type="button"
        className={styles.branchButton}
        aria-expanded={open}
        onClick={() => setExpanded(value => !value)}
      >
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <span className={styles.branchName}>{collection.name}</span>
        <span className={styles.count}>{collection.items.length + children.length}</span>
      </button>
      {open && (
        <div className={styles.children}>
          {children.map(child => (
            <CollectionBranch
              key={child.id}
              collection={child}
              selectedId={selectedId}
              onSelect={onSelect}
              query={query}
              depth={depth + 1}
            />
          ))}
          {visibleItems.map(item => (
            <button
              key={item.id}
              type="button"
              className={styles.item}
              aria-current={selectedId === item.id ? 'page' : undefined}
              disabled={item.disabled}
              onClick={() => onSelect(item.id)}
            >
              {item.disabled ? <LockKeyhole size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NestedNavigationList({
  collections, selectedId, onSelect, search = '', emptyLabel = 'No matching items',
}: NestedNavigationListProps) {
  const query = search.trim().toLocaleLowerCase();
  const visible = collections.filter(collection => matchesCollection(collection, query));
  return (
    <>
      <style>{nestedNavigationStyle}</style>
      <nav aria-label="Contents" className={styles.root}>
        {visible.length ? visible.map(collection => (
          <CollectionBranch
            key={collection.id}
            collection={collection}
            selectedId={selectedId}
            onSelect={onSelect}
            query={query}
            depth={0}
          />
        )) : <p className={styles.empty}>{emptyLabel}</p>}
      </nav>
    </>
  );
}
