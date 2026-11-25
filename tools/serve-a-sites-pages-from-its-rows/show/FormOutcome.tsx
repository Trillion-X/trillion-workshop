// tools/serve-a-sites-pages-from-its-rows/show/FormOutcome.tsx
//
// PURPOSE
//   A page drawn again after its form's post did not go through: the page itself (children), and, at the form whose address is
//   `action`, the shared FormAlert with the site's words for why, with what the visitor typed put back in that form. The site
//   tool wraps the page's drawn tree in this part when it answers a failed browser form post (serve.ts failedForm), so every
//   form on every site gets the same answer, whichever part drew the form and whichever program the post went to.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure on the server: it draws only its children there; the message is placed in the browser, once the form is drawn.
//   2. The message is the shared FormAlert (tools/ui/show/form-alert), placed through a portal into one host before the form;
//      nothing else is added to the page.
//   3. Typed values are put back by each field's name, through the field's own value setter and an input event, so a part that
//      keeps its fields in state takes them as typed. A value never names a field the form does not have.
//   4. Waiting for a form that is drawn late (a part that loads first) stops after WAIT_MS; the page stays as it is then.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FormAlert } from '../../ui/show/form-alert/FormAlert.tsx';

export interface FormOutcomeProps {
  /** The path the failed form posted to: the form whose action is this path gets the message. */
  action: string;
  title: string;
  message?: string;
  /** What the visitor typed, by field name. */
  values: Record<string, string>;
  children?: ReactNode;
}

const WAIT_MS = 10_000;

/** The form on the page that posts to this path, or null. */
function formFor(action: string): HTMLFormElement | null {
  for (const form of Array.from(document.forms)) {
    if (new URL(form.getAttribute('action') ?? '', window.location.href).pathname === action) return form;
  }
  return null;
}

/** Puts each typed value back in the form's field of that name, as typing it would. */
function putBack(form: HTMLFormElement, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const field = form.elements.namedItem(name);
    if (!field) continue;
    if (field instanceof RadioNodeList) {
      for (const one of Array.from(field)) if (one instanceof HTMLInputElement && one.value === value && !one.checked) one.click();
      continue;
    }
    if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
      const on = value === 'true' || value === 'on' || value === field.value;
      if (field.checked !== on) field.click();
      continue;
    }
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
      if (field instanceof HTMLInputElement && (field.type === 'password' || field.type === 'file' || field.type === 'hidden')) continue;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
      setter?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
}

export function FormOutcome({ action, title, message, values, children }: FormOutcomeProps) {
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    let placedHost: HTMLElement | null = null;
    const place = (): boolean => {
      const form = formFor(action);
      if (!form) return false;
      placedHost = document.createElement('div');
      form.before(placedHost);
      putBack(form, values);
      setHost(placedHost);
      form.scrollIntoView({ block: 'center' });
      return true;
    };
    if (place()) return () => placedHost?.remove();
    const watch = new MutationObserver(() => { if (place()) watch.disconnect(); });
    watch.observe(document.body, { childList: true, subtree: true });
    const stop = window.setTimeout(() => watch.disconnect(), WAIT_MS);
    return () => { watch.disconnect(); window.clearTimeout(stop); placedHost?.remove(); };
  }, [action, values]);
  return (
    <>
      {children}
      {host ? createPortal(<FormAlert title={title} {...(message ? { message } : {})} />, host) : null}
    </>
  );
}
