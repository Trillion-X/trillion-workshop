// tools/know-the-projects-on-this-computer/index.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Projects panel's entry. Decodes the projects and current-project feed
// values it is handed, and renders ProjectsPanel with the actions it is given.
//
// verify-every-port lane L14: this entry used to read its feeds through
// @bitfield/runtime-kit and send its actions to slot::workflow. Both are the
// retired Bitfield runtime, so this file no longer imports them. The feed
// source and the action routes are not wired yet (see the tool README); until
// they are, a mount that passes no feed shows an empty panel with no add,
// scan, pin or hide controls.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Default export is a function component that takes its data as props.
// 2. Feed values are decoded only by read-data/ (decodeProjectsFeed,
//    decodeCurrentProjectFeed). This file never parses a feed itself.
// 3. A pin change is handed to onSetProjectPinned with the new state; this
//    file never writes it.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback } from 'react'
import { ProjectsPanel } from './show/ProjectsPanel'
import { decodeProjectsFeed } from './read-data/read-known-projects'
import { decodeCurrentProjectFeed } from './read-data/read-current-project'

export interface ProjectsEntryProps {
  /** The projects feed value as its source hands it over (JSON text, rows or a cell table). */
  projectsFeed?: unknown
  /** The current-project feed value as its source hands it over. */
  currentProjectFeed?: unknown
  onAddProject?: (path: string) => Promise<unknown> | void
  onHideProject?: (projectId: string) => Promise<unknown> | void
  onRefreshProjects?: (roots: string[]) => Promise<unknown> | void
  onSelectProject?: (projectId: string | null) => Promise<unknown> | void
  onSetProjectPinned?: (input: { projectId: string; pinned: boolean }) => Promise<unknown> | void
}

export default function Projects({
  projectsFeed,
  currentProjectFeed,
  onAddProject,
  onHideProject,
  onRefreshProjects,
  onSelectProject,
  onSetProjectPinned,
}: ProjectsEntryProps = {}) {
  const projects = React.useMemo(() => decodeProjectsFeed(projectsFeed), [projectsFeed])
  const currentProjectId = decodeCurrentProjectFeed(currentProjectFeed).activeProject

  const handleTogglePin = useCallback(async (projectId: string) => {
    const project = projects.find(p => p.id === projectId)
    if (!project || !onSetProjectPinned) return

    await onSetProjectPinned({
      projectId,
      pinned: !project.pinned,
    })
  }, [projects, onSetProjectPinned])

  return (
    <ProjectsPanel
      projects={projects}
      currentProjectId={currentProjectId}
      onAddProject={onAddProject}
      onHideProject={onHideProject}
      onRefreshProjects={onRefreshProjects}
      onSelectProject={onSelectProject}
      onTogglePin={onSetProjectPinned ? handleTogglePin : undefined}
    />
  )
}
