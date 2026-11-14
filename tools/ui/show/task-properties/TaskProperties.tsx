// parts/ui/show/task-properties/TaskProperties.tsx
//
// PURPOSE
//   Controlled task fields shared by any surface that edits a task's description,
//   priority and labels. Copy, options, values and writes belong to the caller.
//
// BOUNDARY
//   This part does not know task storage, provider semantics, priority names or
//   label creation rules. It reports changed field values and never writes data.

import * as React from 'react';
import { cn } from '../cn';
import { Checkbox } from '../coss/ui/checkbox';
import { Button } from '../coss/ui/button';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../coss/ui/select';
import { Input, Textarea } from '../input';
import { Popover, PopoverTrigger, PopoverPopup } from '../coss/ui/popover';
import { NamedIcon } from '../icon';
import { SelectionFormatBar, type SelectionFormatCommand } from '../selection-format-bar';

export interface TaskPriorityOption {
  /** Caller-owned stable value. */
  value: string;
  /** Caller-supplied visible name. */
  label: string;
}

export interface TaskPropertiesWords {
  parent?: string;
  subtasks?: string;
  description: string;
  descriptionPlaceholder: string;
  priority: string;
  priorityPlaceholder: string;
  noPriority: string;
  labels: string;
  findLabel: string;
  findLabelPlaceholder: string;
  noLabels: string;
  noMatchingLabels: string;
}

export interface TaskPropertiesPiece {
  id: string;
  label: string;
  content: React.ReactNode;
}

export interface TaskPropertiesProps {
  description: string;
  priority: string | null;
  priorityOptions: readonly TaskPriorityOption[];
  /** Currently assigned labels. Unknown current labels remain visible and removable. */
  selectedLabels: readonly string[];
  /** Labels the caller offers for assignment. */
  labelOptions: readonly string[];
  /** Caller-owned transient search text for the offered labels. */
  labelQuery: string;
  words: TaskPropertiesWords;
  onDescriptionChange: (description: string) => void;
  onPriorityChange: (priority: string | null) => void;
  onLabelsChange: (labels: string[]) => void;
  onLabelQueryChange: (query: string) => void;
  /** Values, relationship validation and writes remain caller-owned. */
  parent?: { value: string | null; options: readonly TaskPriorityOption[]; label: string; noneLabel: string; onChange: (value: string | null) => void };
  subtasks?: {
    label: string;
    items: readonly { id: string; title: string; checked: boolean; checkLabel: string; disabled?: boolean }[];
    onOpen: (id: string) => void;
    onCheckedChange: (id: string, checked: boolean) => void;
    addLabel: string;
    addShortLabel?: string;
    onAdd: () => void;
    notice?: string;
    moreLabel?: string;
    loadingMore?: boolean;
    onMore?: () => void;
  };
  /** Caller-owned, already-labelled shared controls to place beside task properties in compact mode. */
  supportingProperties?: React.ReactNode;
  /** Caller-owned leaf controls for surfaces that arrange each property through the shared engine. */
  additionalPieces?: readonly TaskPropertiesPiece[];
  /** When supplied, the caller chooses how the live property pieces are composed. */
  renderPieces?: (pieces: readonly TaskPropertiesPiece[]) => React.ReactNode;
  /** Formatting for selected words of the description: a bar above the field, the commands as DATA rows. The text stays plain; marks are written into it. */
  descriptionFormats?: { label: string; commands: readonly SelectionFormatCommand[] };
  /** Optional compact overflow: built-in properties and caller fields remain fully editable in the anchored panel. */
  moreLabel?: string;
  overflowProperties?: React.ReactNode;
  disabled?: boolean;
  /** A small task card keeps label choices in the existing shared popover. */
  compact?: boolean;
  className?: string;
}

/**
 * A domain-blind, fully controlled editor for a task's supporting properties.
 * Selecting a label emits the full next label list so the caller can persist it
 * with its own task owner and concurrency policy.
 */
export function TaskProperties({
  description,
  priority,
  priorityOptions,
  selectedLabels,
  labelOptions,
  labelQuery,
  words,
  onDescriptionChange,
  onPriorityChange,
  onLabelsChange,
  onLabelQueryChange,
  parent,
  subtasks,
  supportingProperties,
  moreLabel,
  overflowProperties,
  disabled = false,
  compact = false,
  className,
  additionalPieces,
  renderPieces,
  descriptionFormats,
}: TaskPropertiesProps) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [parentSelectOpen, setParentSelectOpen] = React.useState(false);
  const [prioritySelectOpen, setPrioritySelectOpen] = React.useState(false);
  const [labelsOpen, setLabelsOpen] = React.useState(false);
  const [descriptionField, setDescriptionField] = React.useState<HTMLTextAreaElement | null>(null);
  const hasOverflow = compact && Boolean(moreLabel);
  const propertiesVisible = renderPieces ? true : !hasOverflow || moreOpen;
  const availableLabels = [...new Set([...selectedLabels, ...labelOptions])];
  const query = labelQuery.trim().toLocaleLowerCase();
  const visibleLabels = query
    ? availableLabels.filter(label => label.toLocaleLowerCase().includes(query))
    : availableLabels;

  const setLabel = (label: string, checked: boolean) => {
    const next = new Set(selectedLabels);
    if (checked) next.add(label);
    else next.delete(label);
    onLabelsChange([...next]);
  };

  const handleMoreOpenChange = (open: boolean) => {
    setMoreOpen(open);
    if (!open) {
      // The popup keeps its caller-owned fields mounted, but nested floating
      // controls must close with it instead of regaining focus from a hidden
      // portal when the page scrolls.
      setParentSelectOpen(false);
      setPrioritySelectOpen(false);
      setLabelsOpen(false);
    }
  };

  const labelChoices = <div data-task-properties-labels="" className="task-properties-labels grid min-w-0 gap-2">
        <Input data-task-properties-label-search="" label={words.findLabel} placeholder={words.findLabelPlaceholder}
          value={labelQuery} disabled={disabled} onChange={event => onLabelQueryChange(event.currentTarget.value)} />
        {visibleLabels.length ? <div role="group" aria-label={words.labels} className="grid min-w-0 gap-1">
          {visibleLabels.map(label => <label key={label} className="flex min-h-9 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
            <Checkbox data-task-property-label={label} checked={selectedLabels.includes(label)} disabled={disabled}
              onCheckedChange={checked => setLabel(label, checked === true)} />
            <span className="min-w-0 break-words">{label}</span>
          </label>)}
        </div> : <p role="status" className="text-sm text-[var(--text-muted)]">{availableLabels.length ? words.noMatchingLabels : words.noLabels}</p>}
      </div>;

  const parentControl = parent ? <div data-task-properties-parent="" className="grid min-w-0 gap-1.5">
    {compact ? null : <span className="text-sm font-medium text-[var(--text-primary)]">{parent.label}</span>}
    <Select modal={false} open={propertiesVisible && parentSelectOpen} onOpenChange={open => setParentSelectOpen(propertiesVisible && open)} value={parent.value ?? ''} disabled={disabled || !propertiesVisible} onValueChange={value => { if (typeof value === 'string') parent.onChange(value || null); }}>
      <SelectTrigger aria-label={parent.label}><SelectValue>{parent.options.find(option => option.value === parent.value)?.label ?? parent.noneLabel}</SelectValue></SelectTrigger>
      <SelectPopup portalProps={{ className: 'coss-ui' }}>
        <SelectItem value="">{parent.noneLabel}</SelectItem>
        {parent.options.filter(option => option.value !== '').map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectPopup>
    </Select>
  </div> : null;

  const priorityControl = <div data-task-properties-priority="" className="grid min-w-0 gap-1.5">
    {compact ? null : <span className="text-sm font-medium text-[var(--text-primary)]">{words.priority}</span>}
    <Select
      modal={false}
      open={propertiesVisible && prioritySelectOpen}
      onOpenChange={open => setPrioritySelectOpen(propertiesVisible && open)}
      value={priority ?? ''}
      disabled={disabled || !propertiesVisible}
      onValueChange={value => {
        if (typeof value === 'string') onPriorityChange(value === '' ? null : value);
      }}
    >
      <SelectTrigger aria-label={words.priority}><SelectValue placeholder={words.priorityPlaceholder}>
        {priorityOptions.find(option => option.value === priority)?.label ?? words.noPriority}
      </SelectValue></SelectTrigger>
      <SelectPopup portalProps={{ className: 'coss-ui' }}>
        <SelectItem value="">{words.noPriority}</SelectItem>
        {priorityOptions.filter(option => option.value !== '').map(option => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectPopup>
    </Select>
  </div>;

  const subtaskControl = subtasks ? <div className="grid min-w-0 gap-2" data-task-properties-subtasks>
    {compact ? null : <h3 className="text-sm font-medium text-[var(--text-primary)]">{subtasks.label}</h3>}
    {subtasks.items.map(item => <div key={item.id} className="schedule-checklist-row" data-control-row data-task-property-subtask={item.id} data-completed={item.checked || undefined}>
      <Checkbox className="schedule-checklist-check" checked={item.checked} disabled={disabled || item.disabled}
        aria-label={item.checkLabel} onCheckedChange={checked => subtasks.onCheckedChange(item.id, checked === true)} />
      <Button variant="ghost" className="schedule-checklist-open" disabled={disabled} onClick={() => subtasks.onOpen(item.id)}>
        <span className="schedule-checklist-title">{item.title}</span>
      </Button>
    </div>)}
    {compact && moreLabel ? null : <Button size="sm" variant="ghost" disabled={disabled} onClick={subtasks.onAdd}>{subtasks.addLabel}</Button>}
    {subtasks.notice ? <p role="status" className="text-sm text-[var(--text-muted)]">{subtasks.notice}</p> : null}
    {subtasks.onMore && subtasks.moreLabel ? <Button size="sm" variant="outline" disabled={disabled || subtasks.loadingMore} onClick={subtasks.onMore}>{subtasks.moreLabel}</Button> : null}
  </div> : null;

  const labelsControl = compact ? <Popover open={propertiesVisible && labelsOpen} onOpenChange={open => setLabelsOpen(propertiesVisible && open)}><PopoverTrigger render={<Button size="sm" variant="outline" disabled={disabled || !propertiesVisible} />}>
    {words.labels}{selectedLabels.length ? ` · ${selectedLabels.length}` : ''}
  </PopoverTrigger><PopoverPopup align="start" className="task-properties-label-popup" portalProps={{ className: 'coss-ui' }}>{labelChoices}</PopoverPopup></Popover>
    : <div className="grid min-w-0 gap-2"><h3 className="text-sm font-medium text-[var(--text-primary)]">{words.labels}</h3>{labelChoices}</div>;

  const descriptionControl = <div data-task-properties-description-field="" className="task-properties-description grid min-w-0 gap-1">
    {descriptionFormats ? <SelectionFormatBar field={descriptionField} commands={descriptionFormats.commands} label={descriptionFormats.label} onChange={onDescriptionChange} /> : null}
    <Textarea
      ref={setDescriptionField}
      data-task-properties-description=""
      label={compact ? undefined : words.description}
      aria-label={words.description}
      placeholder={words.descriptionPlaceholder}
      value={description}
      rows={compact ? 1 : undefined}
      borderless={compact}
      autoGrow={compact}
      maxHeight={compact ? 112 : undefined}
      disabled={disabled}
      onChange={event => onDescriptionChange(event.currentTarget.value)}
    />
  </div>;

  const pieces: TaskPropertiesPiece[] = [
    { id: 'description', label: words.description, content: descriptionControl },
    { id: 'parent', label: parent?.label ?? words.parent ?? '', content: parentControl },
    { id: 'priority', label: words.priority, content: priorityControl },
    { id: 'labels', label: words.labels, content: labelsControl },
    { id: 'subtasks', label: subtasks?.label ?? words.subtasks ?? '', content: subtaskControl },
    ...(supportingProperties ? [{ id: 'supporting-properties', label: words.priority, content: supportingProperties }] : []),
    ...(overflowProperties ? [{ id: 'additional-properties', label: moreLabel ?? words.priority, content: overflowProperties }] : []),
    ...(additionalPieces ?? []),
  ];

  return (
    <section data-task-properties="" data-compact={compact || undefined} className={cn('task-properties grid min-w-0 gap-4', className)}>
      {renderPieces ? renderPieces(pieces) : <>
      {!compact ? parentControl : null}
      {descriptionControl}
      {compact ? subtaskControl : priorityControl}
      {compact ? <div data-task-properties-actions="" className="task-properties-actions flex min-w-0 flex-wrap items-center gap-1.5">
        {moreLabel && subtasks ? <Button data-task-properties-add-subtask="" size="sm" variant="outline" disabled={disabled} aria-label={subtasks.addLabel} onClick={subtasks.onAdd}><NamedIcon name="CirclePlus" size="xs" />{subtasks.addShortLabel ?? subtasks.addLabel}</Button> : null}
        {moreLabel ? null : parentControl}
        {moreLabel ? null : priorityControl}
        {moreLabel ? null : labelsControl}
        {supportingProperties ? <div data-task-properties-supporting="" className="task-properties-supporting flex min-w-0 flex-wrap items-center gap-1.5">{supportingProperties}</div> : null}
        {moreLabel ? <Popover open={moreOpen} onOpenChange={handleMoreOpenChange}><PopoverTrigger render={<Button size="sm" variant="outline" disabled={disabled} aria-label={moreLabel} />}><NamedIcon name="Ellipsis" size="xs" /></PopoverTrigger>
          <PopoverPopup preserveContent align="start" className="task-properties-more-popup" portalProps={{ className: 'coss-ui', keepMounted: true }}>
            <div data-task-properties-more="" className="grid min-w-0 gap-3">{parentControl}{priorityControl}{labelsControl}{overflowProperties}</div>
          </PopoverPopup></Popover> : null}
      </div> : subtaskControl}
      {!compact ? labelsControl : null}
      </>}
    </section>
  );
}
