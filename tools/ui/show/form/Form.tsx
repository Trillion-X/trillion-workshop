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
//
// =============================================================================

import React from 'react';

export interface FormProps extends React.FormHTMLAttributes<HTMLFormElement> {
  children: React.ReactNode;
}

export function Form({ children, ...props }: FormProps) {
  return <form {...props}>{children}</form>;
}
