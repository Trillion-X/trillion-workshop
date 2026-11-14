// packages/git-worktree/show/GitChangesPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Interactive git UI panel for knowledge records. Displays staged, unstaged,
// and untracked files with inline diff viewing and commit functionality.
// Users can stage/unstage files, view diffs, and commit directly from this panel.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Three collapsible sections: Staged (green), Unstaged (yellow), Untracked (white/40)
// 2. Branch display with ahead/behind counts at top
// 3. File rows are expandable to show inline diffs
// 4. Commit form at bottom — disabled when no staged files or empty message
// 5. All async operations show loading state and error feedback
// 6. Diff content is fetched on-demand when file is expanded
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState, useCallback } from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ChevronDown, GitBranch, RefreshCw } from 'lucide-react';
import { Card, Button, Badge, Text, Icon, Textarea } from '@/packages/ui';
import { commitGitChanges } from '@/packages/git-worktree/do-work/commit-git-changes';
import { fetchGitDiff } from '@/packages/git-worktree/do-work/fetch-git-diff';
import { refreshGitWorktree } from '@/packages/git-worktree/do-work/refresh-git-worktree';
import { stageGitFiles } from '@/packages/git-worktree/do-work/stage-git-files';
import { unstageGitFiles } from '@/packages/git-worktree/do-work/unstage-git-files';
import {
  readKnowledgeGitChanges,
  readKnowledgeGitWorktrees,
  type KnowledgeGitChange,
  type KnowledgeGitWorktree,
} from '@/packages/git-worktree/read-data/read-git-worktree-records';
import { useGitWorktreeRead } from '@/packages/git-worktree/read-data/use-git-worktree-read';
import type { GitFileEntry } from '@/packages/git-worktree/read-data/git-worktree-types';
import {
  decodeGitCurrentProjectFeed,
} from '@/packages/git-worktree/read-data/read-git-current-project';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

/** Status badge configuration: status code → variant + label */
const STATUS_BADGE_MAP: Record<string, { variant: 'default' | 'secondary' | 'outline'; label: string; colorClass: string }> = {
  M: { variant: 'secondary', label: 'Modified', colorClass: 'text-yellow-400' },
  A: { variant: 'outline', label: 'Added', colorClass: 'text-green-400' },
  D: { variant: 'secondary', label: 'Deleted', colorClass: 'text-red-400' },
  '?': { variant: 'outline', label: 'Untracked', colorClass: 'text-gray-400' },
};

/** Module-level empty arrays for stable references */
const EMPTY_WORKTREES: KnowledgeGitWorktree[] = [];
const EMPTY_CHANGES: KnowledgeGitChange[] = [];
const GIT_WORKTREE_POLL_INTERVAL_MS = 10_000;

function decodeWorkflowReply(reply: unknown): unknown {
  if (!reply || typeof reply !== 'object') return reply;
  const payload = (reply as { payload?: unknown }).payload;
  if (payload instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(payload));
  }
  return reply;
}

function decodeJsonBytes(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  try {
    const binary = globalThis.atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function extractOutputText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const output = (value as { output?: unknown }).output;
  if (output && typeof output === 'object') {
    const directDiff = (output as { diff?: unknown }).diff;
    if (typeof directDiff === 'string') return directDiff;
    const outputs = (output as { outputs?: Array<{ bytes?: unknown }> }).outputs;
    if (Array.isArray(outputs)) {
      return decodeJsonBytes(outputs[0]?.bytes);
    }
  }
  const outputs = (value as { outputs?: Array<{ bytes?: unknown }> }).outputs;
  if (Array.isArray(outputs)) {
    return decodeJsonBytes(outputs[0]?.bytes);
  }
  return '';
}

function parseDiffReply(reply: unknown): string {
  const decoded = decodeWorkflowReply(reply);
  if (!decoded || typeof decoded !== 'object') return '';
  const directDiff = (decoded as { diff?: unknown }).diff;
  if (typeof directDiff === 'string') return directDiff;
  const directOutput = extractOutputText(decoded);
  if (!directOutput) return '';
  try {
    const parsed = JSON.parse(directOutput) as { diff?: unknown };
    return typeof parsed.diff === 'string' ? parsed.diff : directOutput;
  } catch {
    return directOutput;
  }
}

// ---------------------------------------------------------------------------
// COMPONENTS
// ---------------------------------------------------------------------------

/**
 * Collapsible section showing a category of files (staged, unstaged, or untracked)
 * with expand-to-diff functionality.
 */
function FileSection({
  title,
  files,
  headerColor,
  onStageFiles,
  onUnstageFiles,
  expandedFile,
  onExpandFile,
  diffContent,
  diffLoading,
  diffError,
}: {
  title: string;
  files: GitFileEntry[];
  headerColor: 'green' | 'yellow' | 'white';
  onStageFiles?: (paths: string[]) => Promise<void>;
  onUnstageFiles?: (paths: string[]) => Promise<void>;
  expandedFile: string | null;
  onExpandFile: (path: string | null) => void;
  diffContent: string | null;
  diffLoading: boolean;
  diffError: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const headerColorMap = {
    green: 'border-green-500/30 bg-green-500/5',
    yellow: 'border-yellow-500/30 bg-yellow-500/5',
    white: 'border-[var(--border-primary)] bg-[var(--glass-bg-subtle)]',
  };

  const headerBorderMap = {
    green: 'border-l-green-500',
    yellow: 'border-l-yellow-500',
    white: 'border-l-white',
  };

  const toggleFileSelection = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleStageSelected = useCallback(async () => {
    if (onStageFiles && selectedPaths.size > 0) {
      await onStageFiles(Array.from(selectedPaths));
      setSelectedPaths(new Set());
    }
  }, [onStageFiles, selectedPaths]);

  const handleUnstageSelected = useCallback(async () => {
    if (onUnstageFiles && selectedPaths.size > 0) {
      await onUnstageFiles(Array.from(selectedPaths));
      setSelectedPaths(new Set());
    }
  }, [onUnstageFiles, selectedPaths]);

  if (files.length === 0) return null;

  return (
    <Card variant="nested" className={`border-l-4 ${headerBorderMap[headerColor]}`}>
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${headerColorMap[headerColor]}`}>
        <Button
          variant="ghost"
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 flex-1 text-left hover:opacity-75 transition-opacity px-0 h-auto"
        >
          <Icon icon={ChevronDown} size="sm" className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
          <Text variant="label" weight="semibold">{title}</Text>
          <Badge variant="muted" size="sm">{files.length}</Badge>
        </Button>
        {selectedPaths.size > 0 && (
          <div className="flex gap-1">
            {onStageFiles && <Button size="sm" variant="ghost" onClick={handleStageSelected}>Stage</Button>}
            {onUnstageFiles && <Button size="sm" variant="ghost" onClick={handleUnstageSelected}>Unstage</Button>}
          </div>
        )}
      </div>

      {/* File list */}
      {!collapsed && (
        <div className="divide-y divide-white/5">
          {files.map((file) => {
            const isExpanded = expandedFile === file.path;
            const statusInfo = STATUS_BADGE_MAP[file.status] || { variant: 'default' as const, label: file.status };
            return (
              <div key={file.path} className="hover:bg-[var(--glass-bg-subtle)] transition-colors">
                {/* File row */}
                <div className="flex items-center gap-3 px-4 py-2">
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={selectedPaths.has(file.path)}
                    onChange={() => toggleFileSelection(file.path)}
                    className="w-4 h-4 rounded border-[var(--border-secondary)]"
                  />
                  {/* Status badge */}
                  <Badge variant="neutral" size="sm">
                    {statusInfo.label}
                  </Badge>
                  {/* File path */}
                  <Text variant="body-xs" className="flex-1 font-mono text-gray-300">
                    {file.path}
                  </Text>
                  {/* Expand button */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onExpandFile(isExpanded ? null : file.path)}
                    className="h-6 px-2 min-h-0 min-w-0"
                  >
                    <Icon icon={ChevronDown} size="xs" className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                  </Button>
                </div>

                {/* Expanded diff view */}
                {isExpanded && (
                  <div className="px-4 py-3 bg-[var(--glass-bg-active)] border-t border-[var(--border-primary)]">
                    {diffLoading && <Text variant="body-xs" color="muted">Loading diff...</Text>}
                    {diffError && <Text variant="body-xs" color="muted" className="text-red-400">{diffError}</Text>}
                    {diffContent && (
                      <Card variant="nested" className="p-2 overflow-x-auto max-h-60 overflow-y-auto">
                        <pre className="text-xs leading-tight font-mono text-gray-300">
                          {diffContent}
                        </pre>
                      </Card>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// MAIN COMPONENT
// ---------------------------------------------------------------------------

/**
 * Git Changes Panel — displays staged/unstaged/untracked files with inline diffs
 * and commit functionality. Part of knowledge records tab bar.
 */
export function GitChangesPanel() {
  const currentProjectEntry = useBitfieldData('current-project');
  const worktreesEntry = useGitWorktreeRead(readKnowledgeGitWorktrees, EMPTY_WORKTREES);
  const changesEntry = useGitWorktreeRead(readKnowledgeGitChanges, EMPTY_CHANGES);
  const reloadWorktrees = worktreesEntry.reload;
  const reloadChanges = changesEntry.reload;

  const activeProject = decodeGitCurrentProjectFeed(currentProjectEntry).activeProject;
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hasRequested, setHasRequested] = useState(false);

  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);

  const activeWorktree = (worktreesEntry.data ?? []).find(
    (record) => record.projectId === activeProject,
  ) ?? null;

  const activeChanges = (changesEntry.data ?? []).filter(
    (record) => record.projectId === activeProject && record.scanId === activeWorktree?.latestScanId,
  );

  const status = activeWorktree ? {
    branch: activeWorktree.branch,
    ahead: activeWorktree.ahead,
    behind: activeWorktree.behind,
    staged: activeChanges
      .filter((entry) => entry.bucket === 'staged')
      .map((entry) => ({ path: entry.filePath, status: entry.status })),
    unstaged: activeChanges
      .filter((entry) => entry.bucket === 'unstaged')
      .map((entry) => ({ path: entry.filePath, status: entry.status })),
    untracked: activeChanges
      .filter((entry) => entry.bucket === 'untracked')
      .map((entry) => ({ path: entry.filePath, status: entry.status })),
  } : null;

  const refresh = useCallback(async () => {
    if (!activeProject) {
      setHasRequested(true);
      setMutationError('No project selected');
      return;
    }
    try {
      setRefreshing(true);
      setHasRequested(true);
      setMutationError(null);
      await refreshGitWorktree(activeProject);
      await Promise.all([
        reloadWorktrees(),
        reloadChanges(),
      ]);
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Failed to refresh git worktree');
    } finally {
      setRefreshing(false);
    }
  }, [activeProject, reloadChanges, reloadWorktrees]);

  const stageFiles = useCallback(async (paths: string[]) => {
    if (!activeProject) {
      setMutationError('No project selected');
      return;
    }
    try {
      setMutationError(null);
      await stageGitFiles({ projectId: activeProject, paths });
      await refresh();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Failed to stage files');
    }
  }, [activeProject, refresh]);

  const unstageFiles = useCallback(async (paths: string[]) => {
    if (!activeProject) {
      setMutationError('No project selected');
      return;
    }
    try {
      setMutationError(null);
      await unstageGitFiles({ projectId: activeProject, paths });
      await refresh();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Failed to unstage files');
    }
  }, [activeProject, refresh]);

  const commit = useCallback(async (message: string) => {
    if (!activeProject) {
      setMutationError('No project selected');
      return;
    }
    try {
      setMutationError(null);
      await commitGitChanges({
        projectId: activeProject,
        message,
      });
      setCommitMessage('');
      await refresh();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Failed to commit changes');
    }
  }, [activeProject, refresh]);

  const getDiff = useCallback(async (filePath: string): Promise<string> => {
    if (!activeProject) {
      setMutationError('No project selected');
      return '';
    }
    try {
      setMutationError(null);
      const reply = await fetchGitDiff({ projectId: activeProject, filePath });
      return parseDiffReply(reply);
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Failed to fetch diff');
      return '';
    }
  }, [activeProject]);

  React.useEffect(() => {
    setHasRequested(false);
  }, [activeProject]);

  React.useEffect(() => {
    if (!activeProject) {
      setHasRequested(true);
      return;
    }
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, GIT_WORKTREE_POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [activeProject, refresh]);

  const loading = currentProjectEntry === null
    || worktreesEntry.loading
    || changesEntry.loading
    || refreshing
    || (!!activeProject && !hasRequested);

  const error = !activeProject
    ? 'No project selected'
    : mutationError
      ? mutationError
      : worktreesEntry.error
          ? worktreesEntry.error.message
          : changesEntry.error
            ? changesEntry.error.message
            : null;

  /** Fetch and display diff for expanded file */
  const handleExpandFile = useCallback(
    async (path: string | null) => {
      setExpandedFile(path);
      if (!path) {
        setDiffContent(null);
        return;
      }
      try {
        setDiffLoading(true);
        setDiffError(null);
        const diff = await getDiff(path);
        setDiffContent(diff);
      } catch (err) {
        setDiffError(err instanceof Error ? err.message : 'Failed to load diff');
      } finally {
        setDiffLoading(false);
      }
    },
    [getDiff],
  );

  /** Handle commit button — validates and commits */
  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim() || !status || status.staged.length === 0) return;
    try {
      setCommitting(true);
      await commit(commitMessage);
      setCommitMessage('');
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, status, commit]);

  // -------------------------------------------------------------------------
  // RENDER
  // -------------------------------------------------------------------------

  if (loading && !status) {
    return (
      <div className="p-6 flex items-center justify-center">
        <Text variant="body-xs" color="muted">Loading git status...</Text>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="p-6 flex items-center justify-center">
        <Text variant="body-xs" color="muted">{error || 'Failed to load git status'}</Text>
      </div>
    );
  }

  const hasStagedFiles = status.staged.length > 0;
  const hasUnstagedFiles = status.unstaged.length > 0;
  const hasUntrackedFiles = status.untracked.length > 0;
  const hasAnyChanges = hasStagedFiles || hasUnstagedFiles || hasUntrackedFiles;

  return (
    <div className="p-4 space-y-4 max-h-[360px] overflow-y-auto">
      {/* Branch header */}
      <div className="flex items-center gap-2 flex-wrap">
        <Icon icon={GitBranch} size="sm" color="muted" />
        <Badge variant="muted-outline">{status.branch}</Badge>
        {status.ahead > 0 && (
          <Badge variant="accent" size="sm">
            ↑ {status.ahead}
          </Badge>
        )}
        {status.behind > 0 && (
          <Badge variant="accent" size="sm">
            ↓ {status.behind}
          </Badge>
        )}
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading} className="ml-auto h-6 px-2 min-h-0 min-w-0">
          <Icon icon={RefreshCw} size="sm" className={loading ? 'animate-spin' : ''} />
        </Button>
      </div>

      {/* Error message */}
      {error && (
        <Card variant="error" className="p-2">
          <Text variant="body-xs" className="text-red-400">{error}</Text>
        </Card>
      )}

      {/* No changes state */}
      {!hasAnyChanges && (
        <div className="p-4 text-center">
          <Text color="muted" variant="body-xs">
            No changes
          </Text>
        </div>
      )}

      {/* File sections */}
      <FileSection
        title="Staged"
        files={status.staged ?? EMPTY_CHANGES}
        headerColor="green"
        onUnstageFiles={unstageFiles}
        expandedFile={expandedFile}
        onExpandFile={handleExpandFile}
        diffContent={diffContent}
        diffLoading={diffLoading}
        diffError={diffError}
      />

      <FileSection
        title="Unstaged"
        files={status.unstaged ?? EMPTY_CHANGES}
        headerColor="yellow"
        onStageFiles={stageFiles}
        expandedFile={expandedFile}
        onExpandFile={handleExpandFile}
        diffContent={diffContent}
        diffLoading={diffLoading}
        diffError={diffError}
      />

      <FileSection
        title="Untracked"
        files={status.untracked ?? EMPTY_CHANGES}
        headerColor="white"
        onStageFiles={stageFiles}
        expandedFile={expandedFile}
        onExpandFile={handleExpandFile}
        diffContent={diffContent}
        diffLoading={diffLoading}
        diffError={diffError}
      />

      {/* Commit form */}
      {hasStagedFiles && (
        <Card variant="nested" className="bg-green-500/5 border-green-500/30">
          <div className="p-4 space-y-3">
            <Text variant="label" weight="semibold">
              Commit
            </Text>
            <Textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Enter commit message..."
              rows={3}
              className="bg-[var(--glass-bg-tertiary)]"
            />
            <Button
              variant="secondary"
              onClick={handleCommit}
              disabled={!commitMessage.trim() || committing}
              className="w-full"
            >
              {committing ? 'Committing...' : 'Commit'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
