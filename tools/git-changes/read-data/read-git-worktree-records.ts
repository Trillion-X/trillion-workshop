// packages/git-worktree/read-data/read-git-worktree-records.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Git worktree reader over current-item discovery. The current-item owner
// assembles the rows; this package owns the git-worktree-specific projection.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Readers ask slot::find-current-items, never local git subprocess state
// 2. Canonical ownership remains on workflow actions plus owner-written records
// 3. This module has no React and no writes
//
// =============================================================================

import {
  readGitChangeCurrentItems,
  readGitWorktreeCurrentItems,
  type GitChangeCurrentItem,
  type GitWorktreeCurrentItem,
} from './read-git-worktree-saved-records.ts';

export const REFRESH_GIT_WORKTREE_ACTION = 'action:refresh-git-worktree';
export const STAGE_GIT_FILES_ACTION = 'action:stage-git-files';
export const UNSTAGE_GIT_FILES_ACTION = 'action:unstage-git-files';
export const COMMIT_GIT_CHANGES_ACTION = 'action:commit-git-changes';
export const FETCH_GIT_DIFF_ACTION = 'action:fetch-git-diff';

export interface KnowledgeGitWorktree {
  recordId: string;
  projectId: string;
  projectName: string;
  latestScanId: string;
  branch: string;
  ahead: number;
  behind: number;
  refreshedAt: string | null;
}

export interface KnowledgeGitChange {
  recordId: string;
  scanId: string;
  projectId: string;
  projectName: string;
  filePath: string;
  bucket: 'staged' | 'unstaged' | 'untracked';
  status: string;
}

export function projectKnowledgeGitWorktrees(records: GitWorktreeCurrentItem[]): KnowledgeGitWorktree[] {
  return records.map((record) => ({
    recordId: record.recordId,
    projectId: record.projectId,
    projectName: record.projectName,
    latestScanId: record.latestScanId,
    branch: record.branch,
    ahead: record.ahead,
    behind: record.behind,
    refreshedAt: record.refreshedAt,
  }));
}

export function projectKnowledgeGitChanges(records: GitChangeCurrentItem[]): KnowledgeGitChange[] {
  return records.map((record) => ({
    recordId: record.recordId,
    scanId: record.scanId,
    projectId: record.projectId,
    projectName: record.projectName,
    filePath: record.filePath,
    bucket: record.bucket === 'staged' || record.bucket === 'unstaged' || record.bucket === 'untracked'
      ? record.bucket
      : 'unstaged',
    status: record.status || '?',
  }));
}

export async function readKnowledgeGitWorktrees(signal?: AbortSignal): Promise<KnowledgeGitWorktree[]> {
  return projectKnowledgeGitWorktrees(await readGitWorktreeCurrentItems(signal));
}

export async function readKnowledgeGitChanges(signal?: AbortSignal): Promise<KnowledgeGitChange[]> {
  return projectKnowledgeGitChanges(await readGitChangeCurrentItems(signal));
}
