'use client'

import React from 'react'
import type { TabMeta } from '../read-data/layout-types'
import { InsideArrangement } from './behind-the-panes'

/** A local surface renderer receives the saved tab and its resolved input. */
export type LocalSurfaceContentRenderer = (
  tab: TabMeta,
  input: Record<string, unknown> | undefined,
) => React.ReactNode

/** Registry entries are addressed by the exact placeable-surface catalog id. */
export type LocalSurfaceContentRegistry = Readonly<Record<string, LocalSurfaceContentRenderer>>

/** Returning undefined means the id is not handled and normal package/target resolution continues. */
export type LocalSurfaceContentResolver = (
  surfaceId: string,
  tab: TabMeta,
  input: Record<string, unknown> | undefined,
) => React.ReactNode | undefined

export type LocalSurfaceContent =
  ({ registry: LocalSurfaceContentRegistry; resolve?: never }
  | { resolve: LocalSurfaceContentResolver; registry?: never }) & {
    /** Conditional controls keep their saved placement while absent from the drawn layout. */
    hiddenSurfaceIds?: ReadonlySet<string>
  }

export const LocalSurfaceContentContext = React.createContext<LocalSurfaceContentResolver | null>(null)
export const LocalSurfaceVisibilityContext = React.createContext<ReadonlySet<string> | null>(null)

/** Scope host-owned local React surfaces to one embedded arrangement. */
export function LocalSurfaceContentProvider({
  content,
  children,
}: {
  content?: LocalSurfaceContent
  children: React.ReactNode
}) {
  const resolve = React.useMemo<LocalSurfaceContentResolver | null>(() => {
    if (!content) return null
    if ('resolve' in content && content.resolve) return content.resolve
    const registry = content.registry
    return (surfaceId, tab, input) => {
      const render = registry[surfaceId]
      return render ? render(tab, input) : undefined
    }
  }, [content])

  const scoped = <LocalSurfaceVisibilityContext.Provider value={content?.hiddenSurfaceIds ?? null}>
    <LocalSurfaceContentContext.Provider value={resolve}>{children}</LocalSurfaceContentContext.Provider>
  </LocalSurfaceVisibilityContext.Provider>
  // A caller-owned control arrangement never becomes the page's arrangement,
  // including when the screen mounts in a separate React root.
  return content ? <InsideArrangement.Provider value>{scoped}</InsideArrangement.Provider> : scoped
}
