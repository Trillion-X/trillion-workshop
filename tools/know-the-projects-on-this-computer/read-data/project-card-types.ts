// tools/know-the-projects-on-this-computer/read-data/project-card-types.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The one owner of the project card shapes. read-known-projects.ts decodes
// feed rows into ProjectCardData; ProjectCard.tsx and ProjectsPanel.tsx render
// it. This file was imported by all three and never existed in the source
// package or its history (verify-every-port finding F3), so it is written here
// from how those three files use the types.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Types only. No runtime code, so every consumer can import it without a
//    side effect.
// 2. Field names match what the decoder and the panel read (camelCase, as in
//    the old feed projection). Do not rename one without changing both.
// 3. aheadBehind is null when git has no upstream or the counts are unknown.
//
// =============================================================================

/** Where a project record came from. Matches the decoder's accepted sources. */
export type ProjectCardSource = 'claude_memory' | 'git_scan' | 'user_config' | 'agent_activity';

/** Display mode of the panel: a grid of compact cards or a list of expanded ones. */
export type ProjectCardMode = 'compact' | 'expanded';

/** Git state shown on a card. */
export interface ProjectGitStatusData {
  branch: string;
  dirtyFileCount: number;
  remoteUrl: string | null;
  aheadBehind: { ahead: number; behind: number } | null;
}

/** One project as the panel shows it. */
export interface ProjectCardData {
  id: string;
  path: string;
  name: string;
  source: ProjectCardSource;
  isGitRepo: boolean;
  gitStatus: ProjectGitStatusData | null;
  activeAgentIds: string[];
  activeTeamNames: string[];
  hasClaudeMemory: boolean;
  pinned: boolean;
  hidden: boolean;
  lastActivityAt: string | null;
}
