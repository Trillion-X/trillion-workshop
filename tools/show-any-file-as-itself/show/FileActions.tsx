// package-set://bitfield-studio/packages/file-content-renderer/show/FileActions.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Unified file actions toolbar that appears on file viewers. Provides common
// file operations: copy path, copy content, show in Finder, open in editor.
// Uses CVA variants for consistent button styling and dropdown menus.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ALL buttons use Button component with ghost variant
// 2. Copy feedback: icon -> Check for 1500ms on successful copy
// 3. Dropdown for "Open in" editor selection (VS Code, Cursor, Zed)
// 4. Reveal and open-in both go through the local file operations helper
// 5. Compact mode for inline use: smaller icons, no labels, icon buttons only
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState, useCallback } from 'react';
import { Copy, Check, FolderOpen, Code2 } from 'lucide-react';
import { Button, Icon, Dropdown, Container, ExpandableTabs } from '../../ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface FileActionsProps {
  /** Full absolute path to the file */
  filePath: string;
  /** File content (if available, enables "Copy content" button) */
  content?: string;
  /** Show "Show in Finder" button (default: true) */
  showReveal?: boolean;
  /** Show "Open in Editor" dropdown (default: true) */
  showOpenIn?: boolean;
  /** Compact mode: smaller icons, no labels, icon buttons only (default: false) */
  compact?: boolean;
  /** Optional source-owned reveal action */
  onRevealFile?: (path: string) => Promise<void> | void;
  /** Optional source-owned open action */
  onOpenFileInEditor?: (path: string, editor: string) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Unified file actions toolbar with copy, reveal, and open-in actions.
 *
 * Actions:
 * - Copy path: copies filePath to clipboard
 * - Copy content: copies content to clipboard (only if content provided)
 * - Show in Finder: runs the machine reveal command
 * - Open in Editor: launches VS Code, Cursor, or Zed through the local file operations helper
 *
 * @example
 * ```tsx
 * <FileActions filePath="/path/to/file.ts" content="..." />
 * <FileActions filePath="/path/to/file.ts" content="..." compact />
 * ```
 */
export const FileActions: React.FC<FileActionsProps> = ({
  filePath,
  content,
  showReveal = true,
  showOpenIn = true,
  compact = false,
  onRevealFile,
  onOpenFileInEditor,
}) => {
  const [pathCopied, setPathCopied] = useState(false);
  const [contentCopied, setContentCopied] = useState(false);
  const [selectedEditor, setSelectedEditor] = useState('');

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(filePath);
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  }, [filePath]);

  const handleCopyContent = useCallback(async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setContentCopied(true);
      setTimeout(() => setContentCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy content:', err);
    }
  }, [content]);

  const handleReveal = useCallback(async () => {
    try {
      await onRevealFile?.(filePath);
    } catch (err) {
      console.error('Failed to reveal file:', err);
    }
  }, [filePath, onRevealFile]);

  const handleOpenIn = useCallback(
    async (editor: string) => {
      try {
        await onOpenFileInEditor?.(filePath, editor);
        setSelectedEditor(editor);
      } catch (err) {
        console.error('Failed to open file in editor:', err);
      }
    },
    [filePath, onOpenFileInEditor],
  );

  if (compact) {
    // Compact mode: icon buttons only, no labels
    return (
      <Container layout="horizontal" gap="xs">
        <ExpandableTabs
          mode="action"
          size="sm"
          ariaLabel="File actions"
          items={[
            { id: 'copy-path', label: 'Copy path', icon: pathCopied ? 'Check' : 'Copy', detail: pathCopied ? 'Copied' : undefined, pinned: pathCopied },
            ...(content ? [{ id: 'copy-content', label: 'Copy content', icon: contentCopied ? 'Check' : 'Copy', detail: contentCopied ? 'Copied' : undefined, pinned: contentCopied }] : []),
            ...(showReveal && onRevealFile ? [{ id: 'reveal', label: 'Show in Finder', icon: 'FolderOpen' }] : []),
          ]}
          onSelect={(id) => void (id === 'copy-path' ? handleCopyPath() : id === 'copy-content' ? handleCopyContent() : handleReveal())}
        />

        {showOpenIn && onOpenFileInEditor && (
          <Dropdown
            items={[
              { value: 'vscode', label: 'VS Code' },
              { value: 'cursor', label: 'Cursor' },
              { value: 'zed', label: 'Zed' },
            ]}
            value={selectedEditor}
            onValueChange={handleOpenIn}
            placeholder="Open in"
            aria-label="Open in editor"
          />
        )}
      </Container>
    );
  }

  // Full mode: labeled buttons
  return (
    <Container layout="horizontal" gap="sm" alignItems="center">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopyPath}
      >
        <Icon
          icon={pathCopied ? Check : Copy}
          size="sm"
          color={pathCopied ? 'success' : 'muted'}
        />
        {pathCopied ? 'Copied' : 'Copy path'}
      </Button>

      {content && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopyContent}
        >
          <Icon
            icon={contentCopied ? Check : Copy}
            size="sm"
            color={contentCopied ? 'success' : 'muted'}
          />
          {contentCopied ? 'Copied' : 'Copy content'}
        </Button>
      )}

      {showReveal && onRevealFile && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleReveal}
        >
          <Icon icon={FolderOpen} size="sm" color="muted" />
          Show in Finder
        </Button>
      )}

      {showOpenIn && onOpenFileInEditor && (
        <Dropdown
          items={[
            { value: 'vscode', label: 'VS Code' },
            { value: 'cursor', label: 'Cursor' },
            { value: 'zed', label: 'Zed' },
          ]}
          value={selectedEditor}
          onValueChange={handleOpenIn}
          placeholder="Open in..."
          icon={<Icon icon={Code2} size="sm" color="muted" />}
          aria-label="Open in editor"
        />
      )}
    </Container>
  );
};

FileActions.displayName = 'FileActions';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export type { FileActionsProps };
