import React from 'react';

/** An action within readable words. Its appearance comes from Screen Look;
 * unlike a toolbar button it inherits the passage's type and line height. */
export function InlineTextAction({ onSelect, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onPointerDown' | 'onSelect'> & { onSelect: () => void }) {
  return <button {...props} type="button"
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.preventDefault(); event.stopPropagation(); onSelect(); }}
  />;
}
