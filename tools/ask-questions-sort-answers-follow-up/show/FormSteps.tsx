// tools/ask-questions-sort-answers-follow-up/show/FormSteps.tsx
//
// PURPOSE
//   What every page that asks a form one question at a time shares (the form page, and a booking page that asks its
//   questions the same way): the types of a step, a labelled field, the control a question's type asks for, and whether an
//   answer has anything in it yet. Every part is a shared part (the licensed Coss kit in tools/ui/show/coss and the shared
//   Text); the look is Screen Look's.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: nothing here fetches or reads the window. The host answers each step and sends each answer; these parts only
//      draw what they are given and report a change through `onChange`.
//   2. The control follows the question's type: picks (one or several, with an optional other), link, number, text; any
//      other type is a longer answer.
//   3. `answered` is the one rule for whether Next may be pressed on a required question.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Text } from '../../ui/show/text/Text.tsx';
import { Input } from '../../ui/show/coss/ui/input.tsx';
import { Textarea, FieldPrimitive } from '../../ui/show/coss/ui/textarea.tsx';
import { ChoiceRows, type ChoiceRowsValue } from '../../ui/show/coss/choice-rows.tsx';

export type Option = { value: string; label: string };
// What the program says a question needs drawn: its type, its options and other option, its words and bounds.
export type Asked = { questionId: string; questionTypeId: string; options?: Option[]; multiple?: boolean; other?: Option; placeholder?: string; help?: string; min?: number; max?: number };
export type Next = { key: string; kind: string; position?: number; prompt?: string; required?: boolean; question?: Asked };
export type Answer = string | ChoiceRowsValue | null;

// One labelled field: the label above, the control, then its refusal or its help line.
export function Labelled({ label, help, error, labelStyle, fieldStyle, children }: { label: string; help?: string; error?: string; /** The label's own type, when the page that draws it sets one. */ labelStyle?: React.CSSProperties; /** The field's own spacing (the room between its label and its box), when the page that draws it sets one. */ fieldStyle?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <FieldPrimitive.Root className="flex w-full flex-col items-start gap-2" invalid={Boolean(error)} style={fieldStyle}>
      <FieldPrimitive.Label className="font-medium text-base text-foreground sm:text-sm" style={labelStyle}>{label}</FieldPrimitive.Label>
      {children}
      {error ? <Text as="p" role="alert" variant="caption" className="text-destructive-foreground text-xs">{error}</Text> : help ? <FieldPrimitive.Description className="text-muted-foreground text-xs">{help}</FieldPrimitive.Description> : null}
    </FieldPrimitive.Root>
  );
}

export type AnswerControlProps = {
  id: string;
  label: string;
  asked: Asked;
  required: boolean;
  value: Answer;
  onChange: (value: Answer) => void;
  /** The placeholder of a text answer when the question gives none. */
  textPlaceholder?: string;
};

// The control a question's type asks for: answers to pick (one or several, Other opening a box), a link, a number, a line or a
// longer answer. Every control is a shared part with the page's field colour.
export function AnswerControl({ id, label, asked, required, value, onChange, textPlaceholder = '' }: AnswerControlProps) {
  const field = 'bg-[var(--bg-primary)]';
  const text = typeof value === 'string' ? value : '';
  const placeholder = asked.placeholder ?? textPlaceholder;
  if (asked.questionTypeId === 'picks') {
    return <ChoiceRows label={label} options={asked.options ?? []} multiple={asked.multiple} other={asked.other} otherPlaceholder={asked.placeholder} value={value && typeof value === 'object' ? value : null} onChange={onChange} />;
  }
  if (asked.questionTypeId === 'link') return <Input id={id} type="url" inputMode="url" autoComplete="url" placeholder={asked.placeholder ?? 'https://'} required={required} size="lg" className={field} value={text} onChange={event => onChange(event.target.value)} />;
  if (asked.questionTypeId === 'number') return <Input id={id} type="number" inputMode="numeric" min={asked.min} max={asked.max} placeholder={asked.placeholder} required={required} size="lg" className={field} value={text} onChange={event => onChange(event.target.value)} />;
  if (asked.questionTypeId === 'text') return <Input id={id} placeholder={placeholder} required={required} size="lg" className={field} value={text} onChange={event => onChange(event.target.value)} />;
  return <Textarea id={id} placeholder={placeholder} required={required} className={['min-h-32 resize-y', field].join(' ')} value={text} onChange={event => onChange(event.target.value)} />;
}

// Whether a question's answer has anything in it yet, so Next waits for a required one.
export function answered(value: Answer): boolean {
  if (value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return value.picked.length > 0;
}
