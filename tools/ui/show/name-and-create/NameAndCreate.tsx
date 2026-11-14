// parts/ui/show/name-and-create/NameAndCreate.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A name field and the one action that creates or saves something under that
// name, side by side across the full width: "Name a folder / Create folder",
// "Name this layout / Save layout". Enter in the field runs the action. It
// stays in place beside the work; it is never a dialog. Too narrow for both
// (a pane in a small window), the action moves under the field instead of
// squeezing the field to a letter.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Domain-blind: the caller hands in the words and what to do.
// 2. The field is labelled by its placeholder text for assistive technology.
// 3. Enter runs the action only when the action is enabled.
//
// =============================================================================

'use client'

import * as React from 'react'
import { Button } from '../button'
import { Container } from '../container'
import { Input } from '../input'

export type NameAndCreateProps = {
  /** What the field asks for; also its accessible name. */
  label: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  actionLabel: string
  disabled: boolean
}

export function NameAndCreate({ label, value, onChange, onSubmit, actionLabel, disabled }: NameAndCreateProps) {
  return (
    <Container layout="horizontal" wrap gap="sm" padding="none" alignItems="center" width="full" data-name-and-create>
      <Container flex={1} padding="none" minWidth="10rem">
        <Input
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !disabled) onSubmit()
          }}
          placeholder={label}
          aria-label={label}
        />
      </Container>
      <Button type="button" variant="secondary" onClick={onSubmit} disabled={disabled}>
        {actionLabel}
      </Button>
    </Container>
  )
}
