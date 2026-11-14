// package-set://bitfield-studio/packages/file-content-renderer/show/FileHeader.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Header bar for file viewers showing file name, language badge, and actions.
// Displays file icon, clickable path (breadcrumb-style), language badge, and
// actions toolbar. Composed of CopyablePath, Badge, and FileActions components.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Left: file icon + filename via CopyablePath (last 2 segments)
// 2. Center: language Badge with semantic variant
// 3. Right: FileActions toolbar
// 4. ALL components from ui/ barrel — no raw HTML elements
// 5. Layout via Container with horizontal layout
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Container, Badge, Icon, CopyablePath } from '../../ui';
import { FileActions } from './FileActions';
import type { LucideProps } from 'lucide-react';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface FileHeaderProps {
  /** Full absolute path to the file */
  filePath: string;
  /** File content (passed to FileActions) */
  content?: string;
  /** Programming language identifier (for syntax highlighting) */
  language?: string;
  /** Lucide icon name as React component (from FileTypeRegistry) */
  icon?: React.ElementType<LucideProps>;
  /** Language label to display in badge ("TypeScript", "Markdown", etc.) */
  label?: string;
  /** Show FileActions toolbar (default: true) */
  showActions?: boolean;
  /** Called when path segments are clicked (breadcrumb navigation) */
  onFileSelect?: (path: string) => void;
  /** Optional source-owned reveal action */
  onRevealFile?: (path: string) => Promise<void> | void;
  /** Optional source-owned open action */
  onOpenFileInEditor?: (path: string, editor: string) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Header bar for file viewers.
 *
 * Layout: [Icon + Filename] [Language Badge] [FileActions]
 *
 * The filename is a CopyablePath component showing last 2 segments (directory/file).
 * Language badge uses semantic variant (success/info/warning) based on language.
 * FileActions toolbar provides copy/reveal/open-in operations.
 *
 * @example
 * ```tsx
 * <FileHeader
 *   filePath="/srv/project/src/index.ts"
 *   language="typescript"
 *   label="TypeScript"
 *   icon={Code2}
 *   content="..."
 * />
 * ```
 */
export const FileHeader: React.FC<FileHeaderProps> = ({
  filePath,
  content,
  language,
  icon: IconComponent,
  label,
  showActions = true,
  onFileSelect,
  onRevealFile,
  onOpenFileInEditor,
}) => {
  // Get the language badge variant based on language identifier
  const getBadgeVariant = (lang?: string) => {
    if (!lang) return 'neutral' as const;

    const variantMap: Record<string, 'success' | 'info' | 'warning' | 'accent' | 'neutral'> = {
      typescript: 'info',
      javascript: 'warning',
      jsx: 'warning',
      tsx: 'info',
      python: 'accent',
      rust: 'warning',
      json: 'neutral',
      markdown: 'success',
      yaml: 'neutral',
      xml: 'neutral',
      html: 'warning',
      css: 'info',
      sql: 'info',
      bash: 'neutral',
      shell: 'neutral',
    };

    return variantMap[lang.toLowerCase()] || 'neutral';
  };

  const handlePathClick = () => {
    if (onFileSelect) {
      onFileSelect(filePath);
    }
  };

  return (
    <Container
      layout="horizontal"
      gap="md"
      alignItems="center"
      justifyContent="between"
      padding="sm"
      border="bottom"
    >
      {/* Left: Icon + Filename */}
      <Container layout="horizontal" gap="sm" alignItems="center" flex="1" minHeight="0">
        {IconComponent && (
          <Icon icon={IconComponent} size="md" color="muted" />
        )}
        <CopyablePath
          path={filePath}
          displaySegments={2}
          showFullOnHover
          onClick={handlePathClick}
        />
      </Container>

      {/* Center: Language Badge */}
      {label && (
        <Badge
          variant={getBadgeVariant(language)}
          size="sm"
        >
          {label}
        </Badge>
      )}

      {/* Right: FileActions */}
      {showActions && (
        <FileActions
          filePath={filePath}
          content={content}
          onRevealFile={onRevealFile}
          onOpenFileInEditor={onOpenFileInEditor}
          compact
        />
      )}
    </Container>
  );
};

FileHeader.displayName = 'FileHeader';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export type { FileHeaderProps };
