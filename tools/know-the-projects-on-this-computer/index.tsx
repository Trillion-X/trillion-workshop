// packages/projects/index.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Package entry point for the Projects surface.
// Wraps ProjectsPanel with descriptor-bound project data and project do-work requests.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Default export is a CE-compatible function component
// 2. Reads project data through package-local input descriptors
// 3. Writes pin changes through the project-owned do-work request file
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback } from 'react'
import { useBitfieldData } from '@bitfield/runtime-kit/react'
import { ProjectsPanel } from '../see-what-is-being-worked-on/packages/projects/show/ProjectsPanel'
import {
  decodeProjectsFeed,
} from './read-data/read-known-projects'
import {
  decodeCurrentProjectFeed,
} from './read-data/read-current-project'
import { addKnownProject } from './do-work/add-known-project'
import { hideKnownProject } from './do-work/hide-known-project'
import { pinKnownProject } from './do-work/pin-known-project'
import { refreshKnownProjects } from './do-work/refresh-known-projects'
import { selectCurrentProject } from './do-work/select-current-project'

export default function Projects() {
  const projectsEntry = useBitfieldData('projects')
  const currentProjectEntry = useBitfieldData('current-project')
  const projects = decodeProjectsFeed(projectsEntry)
  const currentProjectId = decodeCurrentProjectFeed(currentProjectEntry).activeProject

  const handleTogglePin = useCallback(async (projectId: string) => {
    const project = projects.find(p => p.id === projectId)
    if (!project) return

    await pinKnownProject({
      projectId,
      pinned: !project.pinned,
    })
  }, [projects])

  return (
    <ProjectsPanel
      projects={projects}
      currentProjectId={currentProjectId}
      onAddProject={addKnownProject}
      onHideProject={hideKnownProject}
      onRefreshProjects={(roots) => refreshKnownProjects({ roots })}
      onSelectProject={selectCurrentProject}
      onTogglePin={handleTogglePin}
    />
  )
}
