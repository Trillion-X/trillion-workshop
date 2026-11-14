// What a list shows when it holds nothing.
//
// Why this exists
//   The shared list components rendered their wrapper and then mapped over an
//   empty array, so a list with no items painted an empty box. Measured across
//   the app that was twenty-seven call sites in four files, every one of them a
//   blank area where the person needed to be told what had happened and what
//   they could do about it.
//
//   Fixing it at the call sites would have meant twenty-seven copies of the
//   same branch, and the twenty-eighth would have been written without one. The
//   list components know when they are empty, so they are the ones that answer
//   for it.
//
// Why the default says so little
//   The component has no idea what it is listing. "Nothing here yet" is true
//   for records, rules, drafts, labels and anything added later, and it does
//   not pretend to knowledge it does not have. A caller that knows better
//   should say better, and passing a title is how.
//
// Why the action is optional
//   An empty list with a way out of it is better than one without, but a made
//   up action is worse than none. A filtered list offers "clear the filters";
//   an unfilled one offers a way to add the first thing. A list that genuinely
//   has nothing for the person to do says so and stops.

import React from 'react'
import {Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent} from './shadcn/empty'
import {Button} from './coss/ui/button'

export type EmptyStateOptions = {
  /** A picture of what is missing, drawn in a small tile above the title (an icon the caller chose). */
  icon?: React.ReactNode
  /** What happened, in the person's words. Defaults to a domain-free line. */
  title?: string
  /** Why, or what the person can do, in their words: an error's own reason goes here, so it is never swallowed. */
  description?: string
  /** Label for the way out. Omitted when there is nothing useful to offer. */
  action?: string
  onAction?: () => void
  /** Failures need alert semantics so assistive technology announces the change. */
  tone?: 'empty' | 'error'
}

export const NOTHING_HERE_YET = 'Nothing here yet'

export function EmptyState({icon, title = NOTHING_HERE_YET, description, action, onAction, tone = 'empty'}: EmptyStateOptions) {
  return (
    <Empty role={tone === 'error' ? 'alert' : undefined} data-empty-state={tone}>
      <EmptyHeader>{icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}<EmptyTitle>{title}</EmptyTitle>{description && <EmptyDescription>{description}</EmptyDescription>}</EmptyHeader>
      {action && onAction && (
        <EmptyContent><Button variant="outline" onClick={onAction}>{action}</Button></EmptyContent>
      )}
    </Empty>
  )
}
