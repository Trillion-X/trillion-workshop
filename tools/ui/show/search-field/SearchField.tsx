// packages/ui/show/search-field/SearchField.tsx
//
// Purpose
//   The one search box for every screen; a screen that adds its own search box repeats it. A magnifier at its start, the words the person types,
//   and nothing else. A view bar's search, a menu's search and a picker's
//   search are the same object, so they share this and its look instead of
//   each drawing a bare text box that reads as an unlabelled square.
//
// Non-negotiable invariants
//   1. Blind: the caller supplies the accessible name, the placeholder and
//      what happens on change; this knows nothing about what is searched.
//   2. The magnifier is decoration (aria-hidden) and never takes a press; the
//      whole box stays the input's hit target.
//   3. Appearance lives in screen-look/show/search-field.css, on the same
//      surface as the toolbar controls beside it (--glass-bg-subtle).
//   4. Every other input prop passes through (autoFocus, onKeyDown, value).

import React from 'react'
import {Input, type InputProps} from '../coss/ui/input'
import {NamedIcon} from '../icon'

export type SearchFieldProps = Omit<InputProps, 'type' | 'aria-label'> & {
  /** What a screen reader calls the box ("Search library"). */
  label: string
}

export function SearchField({label, className, size = 'sm', ...props}: SearchFieldProps) {
  return (
    <span className={['search-field', className].filter(Boolean).join(' ')} data-slot="search-field" data-size={size}>
      <NamedIcon name="search" size="xs" aria-hidden className="search-field-icon"/>
      <Input type="search" size={size} aria-label={label} {...props}/>
    </span>
  )
}
