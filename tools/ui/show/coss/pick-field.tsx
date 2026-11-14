// parts/ui/show/coss/pick-field.tsx
//
// PURPOSE
//   Two controls for choosing among values the caller lists, never typing them: ChoiceField picks one (the licensed
//   Coss Select), and PickList picks several: each picked value is a badge with its own remove button, and a plus
//   button opens the shared ActionMenu listing the values not picked yet (searchable once the list is long). Anatomy
//   after Railway's "Selected workspaces" and Cursor's repository scope picker (Mobbin 9b4a99bd, 86e87045) and the
//   21st.dev Tags Selector (id 63) and Select Multi (id 28315): picked values stay visible as chips, adding is one
//   press on the plus, removing is one press on the chip.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: labels and options are the caller's DATA.
//   2. Values are only ever the listed options' values; a picked value the caller no longer lists still shows (by its
//      value) so it can be removed.
//   3. Appearance lives in screen-look/show/guide.css (.pick-list); no style is authored here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { ActionMenu } from '../action-menu';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select';

export type PickOption = { value: string; label: string };
const SEARCH_FROM = 8;

export function ChoiceField({ label, options, value, onChange }: { label: string; options: PickOption[]; value: string; onChange: (value: string) => void }) {
  return (
    <Select value={value} items={options} onValueChange={next => onChange(String(next))}>
      <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
      <SelectPopup portalProps={{ className: 'coss-ui' }} alignItemWithTrigger={false}>
        {options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectPopup>
    </Select>
  );
}

export function PickList({ label, options, values, addLabel, onChange }: { label: string; options: PickOption[]; values: string[]; addLabel: string; onChange: (values: string[]) => void }) {
  const picked = values.map(value => options.find(option => option.value === value) ?? { value, label: value });
  const rest = options.filter(option => !values.includes(option.value));
  return (
    <div className="pick-list" role="group" aria-label={label}>
      {picked.map(option => (
        <Badge key={option.value} variant="outline" size="lg" className="pick-list-item">
          {option.label}
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${option.label}`} onClick={() => onChange(values.filter(value => value !== option.value))}><X aria-hidden /></Button>
        </Badge>
      ))}
      {rest.length ? (
        <ActionMenu
          label={addLabel}
          items={rest.map(option => ({ id: option.value, label: option.label, icon: 'Plus' }))}
          onAction={id => onChange([...values, id])}
          {...(rest.length >= SEARCH_FROM ? { search: { placeholder: addLabel } } : {})}
          align="start"
          trigger={<Button type="button" variant="outline" size="sm" />}
          triggerContent={<><Plus aria-hidden />{addLabel}</>}
        />
      ) : null}
    </div>
  );
}
