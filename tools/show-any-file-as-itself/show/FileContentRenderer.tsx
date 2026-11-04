// package-set://bitfield-studio/packages/file-content-renderer/show/FileContentRenderer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// L069 generative primitive: unified file content viewer. Routes files to
// correct renderer based on file type. Handles 50+ file types, 6 renderer
// types (code, markdown, diff, image, json, raw), optional line ranges,
// and diff mode. One component, N consumers.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Renderer routing via fileType.renderer field from file-type-registry
// 2. Diff mode always uses DiffRenderer (regardless of file type)
// 3. Line slicing happens in CodeRenderer (not here) — pass startLine/endLine through
// 4. FileHeader shown conditionally (showHeader prop controls)
// 5. All UI through Container/Card/Text from ui/ — zero raw HTML
// 6. Empty state for missing content: Text color="faint" "(no content)"
// 7. maxHeight passed to sub-renderers for scroll constraints
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import type { LucideProps } from 'lucide-react';
import {
  Box,
  Database,
  File,
  FileCode2,
  FileJson,
  FileText,
  GitBranch,
  GitCompare,
  Image,
  Palette,
  Settings,
  Table,
  Terminal,
  Wrench,
} from 'lucide-react';
import { FileHeader } from './FileHeader';
import { CodeRenderer } from './CodeRenderer';
import MarkdownRenderer from './MarkdownRenderer';
import { DiffRenderer } from './DiffRenderer';
import { ImageRenderer } from './ImageRenderer';
import { RawRenderer } from './RawRenderer';
import { Button, Container, SchemaValueView, Text } from '../../ui';
import { DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION, type FileContentRendererClassification } from './classify-file-content';

const NOT_JSON = Symbol('not-json');
function readJson(content: string): unknown {
  try { return JSON.parse(content); } catch { return NOT_JSON; }
}

const FILE_TYPE_ICON_MAP: Record<string, React.ElementType<LucideProps>> = {
  Box,
  Database,
  File,
  FileCode2,
  FileJson,
  FileText,
  GitBranch,
  GitCompare,
  Image,
  Palette,
  Settings,
  Table,
  Terminal,
  Wrench,
};

/** Active content and untyped binary stay downloads; inferred safe text types can render supplied text. */
export function requiresSafeDownload(mediaType: string): boolean {
  return mediaType === 'text/html' || mediaType === 'application/xhtml+xml' || mediaType === 'image/svg+xml'
    || mediaType === 'application/pdf'
    || (!mediaType.startsWith('text/') && !mediaType.startsWith('image/') && mediaType !== 'application/json');
}

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

// The classification shape is owned by the classifier, so a caller that only classifies or installs the classification
// owner does not load every renderer.
export { DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION };
export type { FileContentRendererClassification, FileContentRendererKind } from './classify-file-content';

export interface FileContentRendererProps {
  /** Absolute or relative path — used for icon, label, language detection */
  filePath: string;

  /** Pre-loaded file content (from tool result, API response, etc.) */
  content?: string;

  /** Pre-loaded file bytes for binary renderers such as images */
  bytes?: Uint8Array;

  /** Caller-ready metadata returned by the guarded artifact owner. Retrieval
   * identity is intentionally not used by this renderer. */
  artifactRef?: {
    readonly media_type: string;
    readonly display_name: string;
    readonly byte_length: number;
  };

  /** Caller-owned classification, usually produced by asking file-classification. */
  classification?: FileContentRendererClassification;

  /** Start line for line range (1-indexed). Default: 1 */
  startLine?: number;

  /** End line for line range (1-indexed, inclusive). Default: all lines */
  endLine?: number;

  /** Diff mode: old vs new strings. If provided, always renders DiffRenderer */
  diff?: {
    oldString: string;
    newString: string;
  };

  /** CSS max-height for scrollable container (e.g., "12rem", "24rem") */
  maxHeight?: string;

  /** Show file path header with icon, language badge, actions (default: true) */
  showHeader?: boolean;

  /** Show action toolbar (copy path, reveal in Finder, open in editor) (default: true) */
  showActions?: boolean;

  /** Show line numbers in code blocks (default: true for code, false for markdown) */
  showLineNumbers?: boolean;

  /** Called when file path header is clicked (breadcrumb navigation) */
  onFileSelect?: (path: string) => void;

  /** Optional source-owned reveal action; file-viewer does not own local file work */
  onRevealFile?: (path: string) => Promise<void> | void;

  /** Optional source-owned open action; file-viewer does not own local file work */
  onOpenFileInEditor?: (path: string, editor: string) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Unified file content viewer — routes files to correct renderer.
 *
 * Handles 50+ file types (TS, JS, Python, Rust, Markdown, images, diffs, etc.)
 * and dispatches to 6 specialized renderers based on file type:
 * - 'code' → CodeRenderer (syntax highlighting)
 * - 'markdown' → MarkdownRenderer (rendered markdown)
 * - 'diff' → DiffRenderer (unified diff)
 * - 'image' → ImageRenderer (image preview)
 * - 'json' → the shared value view (SchemaValueView: fields, lists, cards, the
 *   raw text one press away); a line range or text that is not JSON → CodeRenderer
 * - 'raw' → RawRenderer (plain text)
 *
 * File type detection is automatic via file-type-registry. Diff mode takes
 * precedence — if diff prop is provided, DiffRenderer is used regardless of
 * file type.
 *
 * @example
 * ```tsx
 * // Basic code viewing
 * <FileContentViewer
 *   filePath="/src/index.ts"
 *   content="const x = 1;"
 * />
 *
 * // With line range
 * <FileContentViewer
 *   filePath="/src/index.ts"
 *   content={fileContent}
 *   startLine={10}
 *   endLine={50}
 * />
 *
 * // Diff mode
 * <FileContentViewer
 *   filePath="/src/index.ts"
 *   diff={{ oldString: "const x = 1;", newString: "const x = 2;" }}
 * />
 *
 * // Tool result rendering
 * <FileContentViewer
 *   filePath={toolUse.params.file_path}
 *   content={toolUse.result}
 *   maxHeight="12rem"
 *   showActions={!!filePath}
 * />
 * ```
 */
export function FileContentRenderer({
  filePath,
  content = '',
  bytes,
  artifactRef,
  classification = DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION,
  startLine,
  endLine,
  diff,
  maxHeight,
  showHeader = true,
  showActions = true,
  showLineNumbers = true,
  onFileSelect,
  onRevealFile,
  onOpenFileInEditor,
}: FileContentRendererProps) {
  const effectivePath = artifactRef?.display_name ?? filePath;
  const mediaType = artifactRef?.media_type ?? classification.mimeType ?? 'application/octet-stream';
  const forceDownload = requiresSafeDownload(mediaType);
  const fileType = artifactRef
    ? {
      ...classification,
      ...(mediaType === 'text/markdown' ? { renderer: 'markdown' as const, language: 'markdown', label: 'Markdown' } : {}),
      ...(mediaType.startsWith('text/') && mediaType !== 'text/markdown' ? { renderer: 'raw' as const, language: 'text', label: 'Text' } : {}),
      ...(mediaType.startsWith('image/') && mediaType !== 'image/svg+xml' ? { renderer: 'image' as const, language: 'image', label: 'Image' } : {}),
      mimeType: mediaType,
    }
    : classification;
  // Convert file-type icon name to a Lucide component.
  // FileHeader expects a component (not a string tag).
  const iconComponent = FILE_TYPE_ICON_MAP[fileType.icon] ?? FileText;

  // Determine which renderer to use
  // If diff prop is present, ALWAYS use DiffRenderer (regardless of file type)
  const renderContent = () => {
    if (forceDownload) {
      return (
        <Container layout="vertical" gap="xs" padding="sm">
          <Text variant="body-sm">This file is available as a safe download.</Text>
          <Button
            variant="secondary"
            size="sm"
            disabled={!bytes}
            onClick={() => {
              if (!bytes) return;
              const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = effectivePath.replace(/[\\/\u0000-\u001f\u007f]/g, '_') || 'artifact.bin';
              anchor.rel = 'noopener';
              anchor.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download
          </Button>
        </Container>
      );
    }
    // Diff mode takes precedence
    if (diff) {
      const maxHeightPx = maxHeight?.endsWith('rem')
        ? parseFloat(maxHeight) * 16
        : (maxHeight ? parseInt(maxHeight, 10) : 384);
      return <DiffRenderer diff={diff} maxHeight={maxHeightPx || 384} />;
    }

    // No content and no diff = empty state
    if (!content && !(bytes && bytes.byteLength > 0)) {
      return (
        <Container layout="vertical" gap="xs" padding="sm">
          <Text color="faint">(no content)</Text>
        </Container>
      );
    }

    // Route to renderer based on file type
    switch (fileType.renderer) {
      case 'code':
        return (
          <CodeRenderer
            content={content}
            language={fileType.language}
            startLine={startLine}
            endLine={endLine}
            showLineNumbers={showLineNumbers}
            maxHeight={maxHeight}
          />
        );

      case 'markdown':
        return (
          <MarkdownRenderer
            content={content}
            maxHeight={maxHeight}
          />
        );

      case 'image':
        return (
          <ImageRenderer
            filePath={effectivePath}
            bytes={bytes}
            maxHeight={maxHeight}
            mimeType={fileType.mimeType}
          />
        );

      case 'json': {
        // A whole JSON file is read as values, never as code; a range of its lines is code.
        const parsed = startLine === undefined && endLine === undefined ? readJson(content) : NOT_JSON;
        if (parsed !== NOT_JSON) return <SchemaValueView value={parsed} designed={false} />;
        return (
          <CodeRenderer
            content={content}
            language="json"
            startLine={startLine}
            endLine={endLine}
            showLineNumbers={showLineNumbers}
            maxHeight={maxHeight}
          />
        );
      }

      case 'diff':
        // Diff files rendered as code (not as actual diffs)
        return (
          <CodeRenderer
            content={content}
            language="diff"
            startLine={startLine}
            endLine={endLine}
            showLineNumbers={showLineNumbers}
            maxHeight={maxHeight}
          />
        );

      case 'raw':
      default:
        return (
          <RawRenderer
            content={content}
            maxHeight={maxHeight}
          />
        );
    }
  };

  return (
    // minWidth=0 + width=full clamps the renderer to its parent: a wide image
    // or long code line scrolls INSIDE its own sub-renderer instead of growing
    // every flex ancestor past the viewport (flex children default to
    // min-width:auto). Same structural clamp the board surfaces use.
    <Container layout="vertical" gap="none" minWidth="0" width="full">
      {/* Header bar: file icon + name + language badge + actions */}
      {showHeader && (
        <FileHeader
          filePath={effectivePath}
          content={content}
          language={fileType.language}
          icon={iconComponent}
          label={fileType.label}
          showActions={showActions}
          onFileSelect={onFileSelect}
          onRevealFile={onRevealFile}
          onOpenFileInEditor={onOpenFileInEditor}
        />
      )}

      {/* Content area: routed to appropriate renderer */}
      {renderContent()}
    </Container>
  );
}
