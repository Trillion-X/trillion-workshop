import { Button } from '../button';
import { Tooltip } from '../tooltip';

export interface SelectablePillBarItem {
  id: string;
  label: string;
}

export interface SelectablePillBarProps {
  items: readonly SelectablePillBarItem[];
  selectedIds: readonly string[];
  allLabel?: string;
  ariaLabel?: string;
  onSelectAll(): void;
  onToggle(id: string): void;
}

export function SelectablePillBar({
  items,
  selectedIds,
  allLabel = 'All',
  ariaLabel = 'Filter',
  onSelectAll,
  onToggle,
}: SelectablePillBarProps) {
  if (items.length <= 1) return null;

  const selected = new Set(selectedIds);
  const allSelected = selectedIds.length === items.length;

  return (
    <div className="flex items-center gap-1 flex-wrap" role="toolbar" aria-label={ariaLabel}>
      <Tooltip label={allLabel}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSelectAll}
          active={allSelected}
        >
          {allLabel}
        </Button>
      </Tooltip>

      {items.map((item) => {
        const isSelected = selected.has(item.id);
        return (
          <Tooltip
            key={item.id}
            label={`${isSelected ? 'Hide' : 'Show'} ${item.label}`}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onToggle(item.id)}
              active={isSelected}
            >
              {item.label}
            </Button>
          </Tooltip>
        );
      })}
    </div>
  );
}
