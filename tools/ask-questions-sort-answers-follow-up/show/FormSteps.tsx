// tools/ask-questions-sort-answers-follow-up/show/FormSteps.tsx
//
// PURPOSE
//   What every page that asks a form one question at a time shares (the form page, and a booking page that asks its
//   questions the same way): the types of a step, a labelled field, the control a question's type asks for, and whether an
//   answer has anything in it yet, and the progress as one piece per step (./step-pieces.ts). Every part is a shared part (the licensed Coss kit in tools/ui/show/coss and the shared
//   Text); the look is Screen Look's.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: nothing here fetches or reads the window. The host answers each step and sends each answer; these parts only
//      draw what they are given and report a change through `onChange`.
//   2. The control is the one the question's type declares in data/question-types.json (read-data/step-controls.ts controlFor,
//      the file the server's check reads): picks (one or several, with an optional other), one (a single pick answered as its value),
//      link, number (its step: any number, or whole steps for a rating; bounded by the question's min and max, its placeholder
//      the range when the question gives none), line, long. Nothing here branches on a type's name. A step with no control
//      shows "No control for type <type>." and no box, so an answer the server would refuse is never typed.
//   3. `answered` is the one rule for whether Next may be pressed on a required question.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Container } from '../../ui/show/container/index.ts';
import { Text } from '../../ui/show/text/Text.tsx';
import { Input } from '../../ui/show/coss/ui/input.tsx';
import { Textarea, FieldPrimitive } from '../../ui/show/coss/ui/textarea.tsx';
import { ChoiceRows, type ChoiceRowsValue } from '../../ui/show/coss/choice-rows.tsx';
import { controlFor, noControlWords } from '../read-data/step-controls.ts';
import { piecesOf, type Piece } from './step-pieces.ts';

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

// A scale's range as its placeholder ("1–10"), when the question bounds it at both ends.
const rangeOf = (asked: Asked) => (typeof asked.min === 'number' && typeof asked.max === 'number' ? `${asked.min}–${asked.max}` : undefined);

// The control the question's type declares: answers to pick (one or several, Other opening a box), one answer, a link, a number, a
// line or a longer answer, or the words that there is none. Every control is a shared part with the page's field colour.
export function AnswerControl({ id, label, asked, required, value, onChange, textPlaceholder = '' }: AnswerControlProps) {
  const field = 'bg-[var(--bg-primary)]';
  const text = typeof value === 'string' ? value : '';
  const placeholder = asked.placeholder ?? textPlaceholder;
  const control = controlFor(asked.questionTypeId);
  const none = <Text as="p" role="alert" variant="caption" className="text-destructive-foreground">{noControlWords(asked.questionTypeId)}</Text>;
  if (!control) return none;
  if (control.draw === 'picks') {
    return <ChoiceRows label={label} options={asked.options ?? []} multiple={asked.multiple} other={asked.other} otherPlaceholder={asked.placeholder} value={value && typeof value === 'object' ? value : null} onChange={onChange} />;
  }
  if (control.draw === 'one') return <ChoiceRows label={label} options={asked.options ?? []} value={text ? { picked: [text] } : null} onChange={picked => onChange(picked?.picked[0] ?? '')} />;
  if (control.draw === 'link') return <Input id={id} type="url" inputMode="url" autoComplete="url" placeholder={asked.placeholder ?? 'https://'} required={required} size="lg" className={field} value={text} onChange={event => onChange(event.target.value)} />;
  if (control.draw === 'number') return <Input id={id} type="number" inputMode={control.step === 'any' ? 'decimal' : 'numeric'} step={control.step} min={asked.min} max={asked.max} placeholder={asked.placeholder ?? rangeOf(asked)} required={required} size="lg" className={field} value={text} onChange={event => onChange(event.target.value)} />;
  if (control.draw === 'line') return <Input id={id} placeholder={placeholder} required={required} size="lg" className={field} value={text} onChange={event => onChange(event.target.value)} />;
  if (control.draw === 'long') return <Textarea id={id} placeholder={placeholder} required={required} className={['min-h-32 resize-y', field].join(' ')} value={text} onChange={event => onChange(event.target.value)} />;
  return none;
}

// Whether a question's answer has anything in it yet, so Next waits for a required one.
export function answered(value: Answer): boolean {
  if (value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return value.picked.length > 0;
}

const PIECE_LOOK: Record<Piece, string> = { done: 'bg-foreground', current: 'bg-foreground/45', ahead: 'bg-foreground/12' };

// The progress of a page asked one step at a time: one piece per step across the full width, the steps done solid, the
// current one half, the rest faint (./step-pieces.ts piecesOf). Each piece says what it shows in `data-step-piece`.
export function StepPieces({ at, count, label }: { at: number; count: number; label: string }) {
  return (
    <Container layout="horizontal" gap="xs" width="full" role="progressbar" aria-valuemin={0} aria-valuemax={count} aria-valuenow={Math.min(at, count)} aria-label={label}>
      {piecesOf(at, count).map((piece, index) => <Container key={index} as="span" gap="none" data-step-piece={piece} className={`h-1 flex-1 rounded-full ${PIECE_LOOK[piece]}`} />)}
    </Container>
  );
}
