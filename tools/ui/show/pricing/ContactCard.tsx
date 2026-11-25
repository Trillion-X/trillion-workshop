// tools/ui/show/pricing/ContactCard.tsx
//
// PURPOSE
//   The small card beside the price cards for a person whom none of them fits: a heading, a line, a few labelled fields, one
//   button, and a short note under it. A page row names it as `ui/show/pricing/ContactCard.tsx#ContactCard`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no fetch and no window while it renders. The host owns the typed values, the error and whether a send is under way;
//      every change is `onChange(name, value)` and the press is `onSubmit(values)`.
//      A page row that has no callbacks gives `action`: the card is then a plain form (method post) whose fields are
//      named as given here, so the browser posts them itself and nothing runs on the page. `hiddenFields` (name -> value)
//      adds the values the person does not type, such as which form this is. The page that receives the post is the host's.
//   2. Every word (heading, line, labels, button, note) is a prop; none is held here. A field is drawn required only when it is
//      given `required`.
//   3. Built from the shared Form, the licensed Coss Input and Button, and Text; no raw HTML, no inline styling.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Container } from '../container/index.ts';
import { Input } from '../coss/ui/input.tsx';
import { Button } from '../coss/ui/button.tsx';
import { Form } from '../form/Form.tsx';
import { Text } from '../text/Text.tsx';
import { Labelled } from '../../../ask-questions-sort-answers-follow-up/show/FormSteps.tsx';

export type ContactField = { name: string; label: string; type?: 'text' | 'email'; required?: boolean; value?: string };

export type ContactCardProps = {
  title: string;
  /** A line under the heading. */
  lead?: string;
  fields: readonly ContactField[];
  button: string;
  /** A short note under the button. */
  note?: string;
  error?: string;
  sending?: boolean;
  /** Where the card posts when its button is pressed; given, the card needs no callback. */
  action?: string;
  /** Values the post carries besides the typed fields: name -> value. */
  hiddenFields?: Readonly<Record<string, string>>;
  onChange?: (name: string, value: string) => void;
  onSubmit?: (values: Record<string, string>) => void;
};

export function View({ title, lead, fields, button, note, error = '', sending = false, action, hiddenFields, onChange, onSubmit }: ContactCardProps) {
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    onSubmit?.(Object.fromEntries(fields.map(field => [field.name, field.value ?? ''])));
  };
  return (
    <Text as="article" className="coss-ui grid gap-4" data-contact-card>
      <Text as="h3" variant="heading-lg" color="strong">{title}</Text>
      {lead ? <Text as="p" color="muted">{lead}</Text> : null}
      <Form {...(action === undefined ? { onSubmit: submit } : { method: 'post', action, hiddenFields })} className="flex flex-col gap-4">
        {fields.map(field => (
          <Labelled key={field.name} label={field.label}>
            <Input name={field.name} type={field.type ?? 'text'} required={field.required} size="lg" {...(action === undefined ? { value: field.value ?? '', onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange?.(field.name, event.target.value) } : { defaultValue: field.value ?? '' })} />
          </Labelled>
        ))}
        {error === '' ? null : <Text as="p" role="alert" color="error">{error}</Text>}
        <Container layout="horizontal"><Button type="submit" size="lg" disabled={sending}>{button}</Button></Container>
      </Form>
      {note ? <Text as="p" variant="caption" color="muted">{note}</Text> : null}
    </Text>
  );
}

export { View as ContactCard };
