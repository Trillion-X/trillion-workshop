// frontends/web/src/packages/ui/form/Form.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical Form wrapper component for AICC. Encapsulates HTML form element
// to enable L065 compliance in feature code. All forms in the application
// use this component instead of raw <form> elements.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Wraps native HTML form element
// 2. Passes through all form props (onSubmit, etc.)
// 3. Exported from ui/index.ts barrel
// 4. `hiddenFields` (name -> value) draws one hidden field per entry, so a form that posts to an
//    `action` carries the values its page row names (which plan, which form) with no callback.
//
// =============================================================================

import React from 'react';

export interface FormProps extends React.FormHTMLAttributes<HTMLFormElement> {
  children: React.ReactNode;
  /** Values the form posts without the person typing them, one hidden field each. */
  hiddenFields?: Readonly<Record<string, string>>;
}

export function Form({ children, hiddenFields, ...props }: FormProps) {
  return (
    <form {...props}>
      {Object.entries(hiddenFields ?? {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      {children}
    </form>
  );
}
