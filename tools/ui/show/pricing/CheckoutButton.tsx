// tools/ui/show/pricing/CheckoutButton.tsx
//
// PURPOSE
//   One button that starts a checkout: a plain form that posts to `action` with the values the page row names (`hiddenFields`, such
//   as which plan), and under it an optional link for the other way in (such as choosing one's own amount). A page row places it by
//   file and export (`ui/show/pricing/CheckoutButton.tsx#CheckoutButton`) and gives it these props; the browser posts the form, so
//   nothing runs on the page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no fetch, no window and no state while it renders. Every word and address is a prop.
//   2. The post is a plain form (the shared Form) with a submit button (the shared Button); no raw HTML, no inline styling.
//   3. Nothing is drawn without its words and its action.
//   4. Nothing about price or payment is known here: the action and the hidden fields say what is bought.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Button } from '../button/Button.tsx';
import { Form } from '../form/Form.tsx';
import { Text } from '../text/Text.tsx';

export type CheckoutButtonProps = {
  /** Where the form posts. */
  action: string;
  /** Values the post carries without the person typing them: name -> value. */
  hiddenFields?: Readonly<Record<string, string>>;
  /** The words on the button. */
  label: string;
  /** The other way in, drawn as a plain link under the button. */
  choose?: { label: string; href: string };
};

export function CheckoutButton({ action, hiddenFields, label, choose }: CheckoutButtonProps) {
  if (action === '' || label === '') return null;
  return (
    <Text as="div" className="grid justify-items-center gap-3" data-checkout-button>
      <Form method="post" action={action} hiddenFields={hiddenFields}>
        <Button variant="primary" size="lg" type="submit" data-checkout-submit>{label}</Button>
      </Form>
      {choose === undefined || choose.label === '' || choose.href === '' ? null : <Button variant="plain" href={choose.href}>{choose.label}</Button>}
    </Text>
  );
}

export { CheckoutButton as View };
