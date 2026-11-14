// packages/ui/show/action-affordance/EntityPickerField.tsx
//
// A searchable entity picker — the shared `entity-picker` control renderer for
// ActionForm. It is the generic form-field version of "search a live list and
// pick one row": a search box over resolved options, a scrollable result list
// capped for large feeds, an empty state, and a selected highlight. The picked
// answer is the FULL option object ({value,label,record}) so consumers that need
// the whole backing entity (e.g. append a note onto a task's payload) get it,
// while consumers that only need the id read `.value`.
//
// Any package with "pick one live record" (attach-to-task, assign-to-contact,
// choose-a-channel) reuses this by giving a field `control: 'entity-picker'` and
// an options source — zero new picker per package (L093/L069). The host stays
// blind; this renderer knows nothing about tasks or any domain.

import React from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { Text } from '../text';
import { Input } from '../input';
import type { FieldRenderContext } from './ActionForm';
import type { AskFieldOption } from './action-affordance-types';

const RESULT_CAP = 50;

function selectedValue(value: unknown): string | null {
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    const v = (value as { value?: unknown }).value;
    return typeof v === 'string' ? v : null;
  }
  return typeof value === 'string' ? value : null;
}

export function EntityPickerField({ field, value, options, setValue }: FieldRenderContext): React.ReactElement {
  const [query, setQuery] = React.useState('');
  const q = query.trim().toLowerCase();
  const filtered = (q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options).slice(0, RESULT_CAP);
  const chosen = selectedValue(value);

  if (options.length === 0) {
    return <Text variant="body" color="muted">{field.placeholder ?? 'Nothing to choose yet.'}</Text>;
  }
  return (
    <Container layout="vertical" gap="xs">
      <Input
        aria-label={`Search ${field.label}`}
        value={query}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
        placeholder={field.placeholder ?? 'Search…'}
      />
      <Container layout="vertical" gap="xs" className="max-h-72 overflow-y-auto">
        {filtered.map((option: AskFieldOption) => (
          <Button
            key={option.value}
            variant={option.value === chosen ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setValue(option)}
          >
            {option.label}
          </Button>
        ))}
        {filtered.length === 0 ? (
          <Text variant="body" color="muted">No matches.</Text>
        ) : null}
      </Container>
    </Container>
  );
}
