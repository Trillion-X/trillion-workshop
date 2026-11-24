//
// PURPOSE
//   The answers of one question drawn as full-width rows to press, one under the other: pick one (a round mark, Base UI
//   Radio) or pick several (the licensed Coss Checkbox). An "other" row, when the caller names one, opens a text box for
//   the person's own words once it is picked. For a question asked one at a time, where every answer should be read
//   before one is chosen; a short list picked in a form row is pick-field.tsx's ChoiceField.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: the label, the options, the other option and the other box's placeholder are the caller's DATA.
//   2. The value is { picked, other? }: `picked` holds only listed values (and the other option's value), `other` the words
//      typed for the other option. Picking one where one is asked replaces the pick.
//   3. The round mark is Base UI's Radio with the Coss Checkbox's own look (border, size, ring, checked colour), so the two
//      marks read as one kit. It names its slot (data-slot="radio") as the Coss parts do, so Screen Look's rule for bare
//      buttons (padding, a control's corners) leaves it alone, and keeps a round corner shape where Screen Look draws corners
//      as squircles.
//   4. Built from shared parts only (Container, Text, Checkbox, Input, Radio): no element is written by hand here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Container } from '../container/container';
import { Text } from '../text/Text';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';

export type ChoiceRowOption = { value: string; label: string };
export type ChoiceRowsValue = { picked: string[]; other?: string };

const ROWS = 'w-full';
const ROW = 'w-full cursor-pointer rounded-lg border border-input bg-[var(--bg-primary)] px-4 py-3 text-left text-foreground transition-colors hover:bg-accent/40 has-[[data-checked]]:border-foreground';
const MARK = '[corner-shape:round] relative inline-flex size-[var(--check-size,1.125rem)] shrink-0 items-center justify-center rounded-full border border-input bg-background outline-none ring-ring transition-shadow focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:border-primary data-checked:bg-primary';
const DOT = '[corner-shape:round] size-2 rounded-full bg-primary-foreground data-unchecked:hidden';

function Row({ option, children }: { option: ChoiceRowOption; children: React.ReactNode }) {
  return (
    <Container as="label" layout="horizontal" alignItems="center" gap="md" className={ROW}>
      {children}
      <Text as="span" variant="body">{option.label}</Text>
    </Container>
  );
}

export function ChoiceRows({ label, options, multiple = false, other, otherPlaceholder, value, onChange, invalid = false }: {
  label: string;
  options: readonly ChoiceRowOption[];
  multiple?: boolean;
  other?: ChoiceRowOption | null;
  otherPlaceholder?: string;
  value: ChoiceRowsValue | null;
  onChange: (value: ChoiceRowsValue) => void;
  invalid?: boolean;
}) {
  const picked = value?.picked ?? [];
  const words = value?.other ?? '';
  const rows = other ? [...options, other] : [...options];
  const otherPicked = Boolean(other && picked.includes(other.value));
  const emit = (next: string[]) => onChange(other && next.includes(other.value) ? { picked: next, other: words } : { picked: next });
  const toggle = (option: string, on: boolean) => emit(on ? [...picked.filter(item => item !== option), option] : picked.filter(item => item !== option));
  return (
    <Container gap="sm" className={ROWS}>
      {multiple ? (
        <Container role="group" aria-label={label} aria-invalid={invalid || undefined} gap="sm" className={ROWS}>
          {rows.map(option => (
            <Row key={option.value} option={option}>
              <Checkbox checked={picked.includes(option.value)} onCheckedChange={on => toggle(option.value, Boolean(on))} />
            </Row>
          ))}
        </Container>
      ) : (
        <RadioGroup aria-label={label} aria-invalid={invalid || undefined} value={picked[0] ?? ''} onValueChange={next => emit([String(next)])} className="flex w-full flex-col gap-2">
          {rows.map(option => (
            <Row key={option.value} option={option}>
              <Radio.Root value={option.value} className={MARK} data-slot="radio">
                <Radio.Indicator className={DOT} data-slot="radio-indicator" />
              </Radio.Root>
            </Row>
          ))}
        </RadioGroup>
      )}
      {otherPicked ? (
        <Input
          aria-label={other!.label}
          placeholder={otherPlaceholder}
          size="lg"
          className="bg-[var(--bg-primary)]"
          value={words}
          autoFocus
          onChange={event => onChange({ picked, other: event.target.value })}
        />
      ) : null}
    </Container>
  );
}
