import * as React from 'react';
import { BookOpen, ChevronDown, Search } from 'lucide-react';
import { Button } from '../button';
import { Input } from '../input';
import {
  NestedNavigationList,
  type NestedNavigationCollection,
} from './NestedNavigationList';
import {
  nestedNavigationClasses as styles,
  nestedNavigationStyle,
} from '../../../screen-look/show/nested-navigation-style';
import { FloatingPanel } from '../../../screen-arrangement/show/FloatingPanel';

export interface NestedNavigationPickerProps {
  collections: readonly NestedNavigationCollection[];
  selectedId?: string | null;
  selectedLabel?: string;
  title: string;
  searchPlaceholder: string;
  onSelect: (id: string) => void;
}

export function NestedNavigationPicker({
  collections, selectedId, selectedLabel, title, searchPlaceholder, onSelect,
}: NestedNavigationPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  return (
    <>
      <style>{nestedNavigationStyle}</style>
      <Button
        className={styles.picker}
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <BookOpen size={17} aria-hidden="true" />
        <span className={styles.pickerText}>
          <span className={styles.pickerHint}>{title}</span>
          <span className={styles.pickerTitle}>{selectedLabel ?? 'Choose an item'}</span>
        </span>
        <ChevronDown size={17} aria-hidden="true" />
      </Button>
      <FloatingPanel open={open} onClose={() => setOpen(false)} title={title}>
        <Input
          aria-label={searchPlaceholder}
          placeholder={searchPlaceholder}
          icon={<Search size={16} aria-hidden="true" />}
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <NestedNavigationList
          collections={collections}
          selectedId={selectedId}
          search={search}
          onSelect={id => {
            onSelect(id);
            setOpen(false);
          }}
        />
      </FloatingPanel>
    </>
  );
}
