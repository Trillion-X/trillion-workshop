// packages/ui/show/fact-chips/FactChips.tsx
//
// PURPOSE
//   A row of small chips that says what an item is at a glance (its length,
//   language, projects, tags, where it is kept), each chip opening on hover or
//   focus into a popover with the details behind it and the actions that change
//   it. Anatomy from 21st.dev Chip (3259) and shadcn Hover Card (1481); layout
//   checked against Magnific's clip settings chips and Delphi's content facts on
//   Mobbin.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Which chips appear, and in what order, is DATA: a field descriptor with a
//      `chip` entry ({order, details?, actions?, edit?}) becomes a chip. The
//      component never names a field.
//   2. Values are formatted by the field's `kind` (duration, number, bytes,
//      date, choice, tags, text) and its `unit`/`values` DATA only.
//   3. A field with no value draws no chip; nothing reads "unknown".
//   4. Actions are reported to the caller as onAction(actionId, fieldId, value?);
//      the caller's owner changes the record. This part never writes.
//   5. Appearance comes from screen-look/show/fact-chips.css.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

import React from 'react';
import {X, Plus} from 'lucide-react';
import {NamedIcon} from '../icon/NamedIcon';
import {Popover, PopoverTrigger, PopoverPopup} from '../coss/ui/popover';
import {ActionMenu, type ActionMenuItem} from '../action-menu';

export type FactChipAction = {id: string; label: string; icon?: string};
export type FactChipPlacement = {
  order: number;
  /** Other field ids whose values are listed in this chip's popover. */
  details?: string[];
  actions?: FactChipAction[];
  /** 'tags': the popover lists each value with a remove button and takes new ones. */
  edit?: 'tags';
};
export type FactField = {
  id: string;
  label: string;
  kind: string;
  unit?: string;
  icon?: string;
  values?: Record<string, {label: string}>;
  chip?: FactChipPlacement;
};
export type FactChipsProps = {
  fields: FactField[];
  /** Field id -> value, as the Library measured or read it. */
  facts: Record<string, unknown>;
  /** Names for values that are identities (a project id -> its name). */
  valueLabels?: Record<string, string>;
  /** Icon names for individual values, supplied by the record's facts. */
  valueIcons?: Record<string, string>;
  label?: string;
  onAction?: (actionId: string, fieldId: string, value?: string) => void | Promise<void>;
  /** Nested choices behind an action (projects and folders behind "Add to project"). The action opens them as a
   *  menu on hover, rows with their own `items` nest again, and a choice reaches onAction as its `value`. */
  choicesFor?: (actionId: string, fieldId: string) => readonly ActionMenuItem[] | null;
};

const missingText = (value: unknown) => typeof value === 'string' && /^(?:undefined|null|nan)$/i.test(value.trim());
const present = (value: unknown): boolean => Array.isArray(value)
  ? value.some(item => present(item))
  : value !== null && value !== undefined && value !== '' && !missingText(value);

function clock(seconds: number) {
  const whole = Math.round(seconds), h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function bytes(value: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value, unit = 0;
  while (size >= 1000 && unit < units.length - 1) { size /= 1000; unit += 1; }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/** One value of a field as a person reads it. */
export function formatFactValue(field: FactField, value: unknown, valueLabels: Record<string, string> = {}): string {
  const one = (item: unknown) => {
    if (item === null || item === undefined || item === '' || missingText(item)) return '';
    const key = String(item);
    return field.values?.[key]?.label ?? valueLabels[key] ?? key;
  };
  if (Array.isArray(value)) return value.map(one).filter(Boolean).join(', ');
  if (!present(value)) return '';
  const number = Number(value);
  if (field.kind === 'duration') return Number.isFinite(number) && number >= 0 ? clock(number) : '';
  if (field.kind === 'bytes') return Number.isFinite(number) && number >= 0 ? bytes(number) : '';
  if (field.kind === 'date') return Number.isFinite(number) ? new Date(number).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'}) : '';
  if (field.kind === 'number') return Number.isFinite(number) ? `${number.toLocaleString(undefined, {maximumFractionDigits: 2})}${field.unit ? ` ${field.unit}` : ''}` : '';
  return one(value);
}

function chipText(field: FactField, value: unknown, valueLabels: Record<string, string>) {
  if (!present(value)) return field.label;
  if (Array.isArray(value)) {
    const valid = value.filter(present);
    const first = formatFactValue(field, valid[0], valueLabels);
    return valid.length > 1 ? `${first} +${valid.length - 1}` : first;
  }
  return formatFactValue(field, value, valueLabels);
}

function TagEditor({field, values, valueLabels, onAction}: {field: FactField; values: string[]; valueLabels: Record<string, string>; onAction?: FactChipsProps['onAction']}) {
  const [draft, setDraft] = React.useState('');
  const add = () => { const value = draft.trim(); if (!value) return; setDraft(''); void onAction?.('add', field.id, value); };
  return <div className="ui-fact-chip-tags">
    {values.length ? <ul className="ui-fact-chip-tag-list">{values.map(value => <li key={value} className="ui-fact-chip-tag">
      <span>{formatFactValue(field, value, valueLabels)}</span>
      <button type="button" className="ui-fact-chip-tag-remove" aria-label={`Remove ${formatFactValue(field, value, valueLabels)}`} onClick={() => void onAction?.('remove', field.id, value)}><X size={12} aria-hidden /></button>
    </li>)}</ul> : null}
    <form className="ui-fact-chip-tag-form" onSubmit={event => { event.preventDefault(); add(); }}>
      <input className="ui-fact-chip-tag-input" value={draft} onChange={event => setDraft(event.target.value)} placeholder={`Add ${field.label.toLocaleLowerCase()}`} aria-label={`Add ${field.label.toLocaleLowerCase()}`}/>
      <button type="submit" className="ui-fact-chip-tag-add" aria-label={`Add ${field.label.toLocaleLowerCase()}`} disabled={!draft.trim()}><Plus size={14} aria-hidden /></button>
    </form>
  </div>;
}

function FactChip({field, value, fields, facts, valueLabels, valueIcons, onAction, choicesFor}: {field: FactField; value: unknown; fields: FactField[]; facts: Record<string, unknown>; valueLabels: Record<string, string>; valueIcons: Record<string, string>; onAction?: FactChipsProps['onAction']; choicesFor?: FactChipsProps['choicesFor']}) {
  const chip = field.chip!;
  // The card stays open while a choice menu it opened is open, so moving into
  // the menu (which floats outside the card) never dismisses what led there.
  const [open, setOpen] = React.useState(false), [choosing, setChoosing] = React.useState(false);
  const details = (chip.details || []).map(id => fields.find(candidate => candidate.id === id)).filter((detail): detail is FactField => Boolean(detail && present(facts[detail.id])));
  const list = Array.isArray(value) ? value.filter(present).map(String) : [];
  return <Popover open={open || choosing} onOpenChange={next => { if (next || !choosing) setOpen(next); }}>
    <PopoverTrigger openOnHover delay={120} closeDelay={160} className="ui-fact-chip" data-fact-chip={field.id} aria-label={`${field.label}: ${present(value) ? formatFactValue(field, value, valueLabels) : field.label}`}>
      {field.icon ? <NamedIcon name={field.icon} size="sm" aria-hidden /> : null}
      <span className="ui-fact-chip-value">{chipText(field, value, valueLabels)}</span>
    </PopoverTrigger>
    <PopoverPopup side="bottom" align="start" sideOffset={6} className="ui-fact-chip-popover">
      <div className="ui-fact-chip-card">
        <p className="ui-fact-chip-card-label">{field.icon ? <NamedIcon name={field.icon} size="sm" aria-hidden /> : null}{field.label}</p>
        {chip.edit === 'tags' ? <TagEditor field={field} values={list} valueLabels={valueLabels} onAction={onAction}/>
          : Array.isArray(value) ? <ul className="ui-fact-chip-card-list">{value.map(item => <li key={String(item)}>{valueIcons[String(item)] ? <NamedIcon name={valueIcons[String(item)]} size="sm" aria-hidden /> : null}{formatFactValue(field, item, valueLabels)}</li>)}</ul>
          : <p className="ui-fact-chip-card-value">{formatFactValue(field, value, valueLabels)}</p>}
        {details.length ? <dl className="ui-fact-chip-card-details">{details.map(detail => <React.Fragment key={detail.id}><dt>{detail.label}{detail.icon ? <NamedIcon name={detail.icon} size="sm" aria-hidden /> : null}</dt><dd>{formatFactValue(detail, facts[detail.id], valueLabels)}</dd></React.Fragment>)}</dl> : null}
        {chip.actions?.length ? <div className="ui-fact-chip-card-actions">{chip.actions.map(action => {
          const content = <>{action.icon ? <NamedIcon name={action.icon} size="sm" aria-hidden /> : null}{action.label}</>;
          const choices = choicesFor?.(action.id, field.id);
          if (!choices) return <button key={action.id} type="button" className="ui-fact-chip-card-action" onClick={() => void onAction?.(action.id, field.id)}>{content}</button>;
          return <ActionMenu key={action.id} label={action.label} side="right" align="start"
            items={choices.length ? choices : [{id: 'none', label: 'Loading…', icon: 'loader', disabled: true}]}
            trigger={<button type="button" className="ui-fact-chip-card-action"/>} triggerContent={content}
            triggerProps={{openOnHover: true, delay: 120}}
            onOpenChange={setChoosing}
            onAction={choiceId => { setChoosing(false); setOpen(false); void onAction?.(action.id, field.id, choiceId); }}/>;
        })}</div> : null}
      </div>
    </PopoverPopup>
  </Popover>;
}

export function FactChips({fields, facts, valueLabels = {}, valueIcons = {}, label = 'Details', onAction, choicesFor}: FactChipsProps) {
  // A field with actions or a tag editor shows even when empty, so its first value can be added.
  const chips = fields.filter(field => field.chip && (present(facts[field.id]) || field.chip.edit || field.chip.actions?.length))
    .sort((a, b) => a.chip!.order - b.chip!.order);
  if (!chips.length) return null;
  return <div className="ui-fact-chips" role="group" aria-label={label}>
    {chips.map(field => <FactChip key={field.id} field={field} value={present(facts[field.id]) ? facts[field.id] : field.kind === 'tags' ? [] : null} fields={fields} facts={facts} valueLabels={valueLabels} valueIcons={valueIcons} onAction={onAction} choicesFor={choicesFor}/>)}
  </div>;
}
