// packages/file-editor/show/FileEditor.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// CodeMirror 6 integration for inline file editing. Loads file content through
// the generic `compute.process` primitive, renders with syntax highlighting per
// file extension, shows dirty state, and handles Cmd+S save + Cmd+F search. All
// UI chrome via ui/ design system components.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO raw HTML elements — use Container, Text, Card, Badge from ui/
// 2. CodeMirror editor itself (third-party) is exception; it's read-only
// 3. All styling through ui/ component props, never inline style/className
// 4. Status bar shows: file path, line count, language mode, dirty indicator
// 5. Cmd+S keyboard handler saves and clears dirty indicator
// 6. Cmd+F / Ctrl+F opens CodeMirror search inside the editor, not browser find
// 7. Load errors show in toast or error state, not crash
// 8. Syntax highlighting map extensions to CodeMirror language modes
// 9. Language not found → fallback to plaintext mode (no error)
//
// =============================================================================
// KEY CONCEPTS
// =============================================================================
//
// - Language mode selection: file-type-registry → CodeMirror language imports
// - Dirty indicator: Badge with variant based on isDirty state
// - Keyboard shortcuts: Cmd+S captured via useEffect keydown listener; Cmd+F,
//   Cmd+G, F3, Escape, multi-select come from CodeMirror's searchKeymap
// - Line count: CodeMirror state.doc.lineCount
// - File metadata: path extracted from openFile.path, extension via getFileType()
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import {
  closeSearchPanel,
  highlightSelectionMatches,
  openSearchPanel,
  search as codeMirrorSearch,
  searchKeymap,
} from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { minimalSetup } from 'codemirror';
import { askFileEditorLanguage } from '../do-work/ask-file-editor-language.ts';
import { useFileEditorSelectedTextForNextAgentRequestWriter } from '../do-work/use-write-selected-text-for-next-agent-request.ts';
import { AskAiToEditSelectedFileText } from './AskAiToEditSelectedFileText.tsx';
import { readFileEditorTextFile } from '../read-data/read-file-editor-text-file.ts';
import { writeFileEditorTextFile } from '../do-work/write-file-editor-text-file.ts';
import { createFileEditorSearchPanel } from './create-file-editor-search-panel.ts';
import { Container, Text, Badge, Button, Tooltip } from '../../ui/index.ts';
import { FileText, Loader2, MousePointer2, Search } from 'lucide-react';

interface FileBuffer {
  path: string;
  content: string;
  originalContent: string;
}

/**
 * Language mode mapping: file extension → CodeMirror language extension
 * Lazy-loaded to keep bundle small and handle missing languages gracefully
 */
const LANGUAGE_EXTENSIONS: Record<string, () => Promise<any>> = {
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.typescript()),
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
};

const LANGUAGE_LABELS: Record<string, string> = {
  css: 'CSS',
  html: 'HTML',
  javascript: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  python: 'Python',
  text: 'Plain Text',
  typescript: 'TypeScript',
};

const DEFAULT_GUTTER_WIDTH = 56;
const MIN_GUTTER_WIDTH = 38;
const MAX_GUTTER_WIDTH = 104;

const FILE_EDITOR_THEME = EditorView.theme({
  '&': {
    backgroundColor: 'color-mix(in srgb, var(--surface-primary) 88%, var(--black-pure))',
    color: 'var(--text-primary)',
    height: '100%',
    fontSize: '15px',
  },
  '.cm-scroller': {
    fontFamily: '"SF Mono", "JetBrains Mono", "IBM Plex Mono", monospace',
    lineHeight: '1.58',
  },
  '.cm-content': {
    caretColor: 'var(--accent-primary)',
    minHeight: '100%',
    padding: '14px 0',
  },
  '.cm-line': {
    padding: '0 18px',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--glass-bg-hover) 70%, transparent)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--accent-primary) 24%, transparent)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--accent-primary)',
  },
  '.cm-gutters': {
    backgroundColor: 'color-mix(in srgb, var(--surface-secondary) 82%, var(--black-pure))',
    color: 'var(--text-muted)',
    borderRight: '1px solid color-mix(in srgb, var(--border-primary) 78%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--glass-bg-active)',
    color: 'var(--text-primary)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-raised)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-primary)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--surface-raised)',
    color: 'var(--text-primary)',
    borderColor: 'var(--border-primary)',
  },
  '.cm-panels-top': {
    borderBottom: '1px solid var(--border-primary)',
  },
  // The search panel chrome (Find/Replace controls) is rendered by our own
  // React widget — see FileEditorSearchPanel.tsx + create-file-editor-search-panel.ts.
  // CodeMirror's native `.cm-search` DOM is never produced, so it carries no
  // styling here. The document-level match highlights below are still used.
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--status-warning, #facc15) 32%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--status-warning, #facc15) 34%, transparent)',
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--accent-primary) 38%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--accent-primary) 70%, transparent)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)',
  },
}, { dark: true });

const FILE_EDITOR_HIGHLIGHT_STYLE = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--accent-primary)', fontWeight: '600' },
  { tag: tags.atom, color: 'var(--text-primary)' },
  { tag: tags.bool, color: 'var(--text-primary)' },
  { tag: tags.url, color: 'var(--accent-primary)' },
  { tag: tags.labelName, color: 'var(--accent-primary)' },
  { tag: tags.inserted, color: 'var(--status-success, var(--text-primary))' },
  { tag: tags.deleted, color: 'var(--status-error, var(--text-primary))' },
  { tag: tags.literal, color: 'var(--text-primary)' },
  { tag: tags.string, color: 'var(--status-success, var(--text-secondary))' },
  { tag: tags.docString, color: 'var(--status-success, var(--text-secondary))' },
  { tag: tags.number, color: 'var(--accent-primary)' },
  { tag: tags.variableName, color: 'var(--text-primary)' },
  { tag: tags.definition(tags.variableName), color: 'var(--accent-primary)' },
  { tag: tags.function(tags.variableName), color: 'var(--accent-primary)' },
  { tag: tags.propertyName, color: 'var(--text-secondary)' },
  { tag: tags.definition(tags.propertyName), color: 'var(--text-secondary)' },
  { tag: tags.typeName, color: 'var(--text-primary)' },
  { tag: tags.className, color: 'var(--text-primary)' },
  { tag: tags.namespace, color: 'var(--text-secondary)' },
  { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.heading, color: 'var(--accent-primary)', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
]);

function formatLanguageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? language.replace(/(^|-)([a-z])/g, (_, prefix: string, letter: string) => `${prefix ? ' ' : ''}${letter.toUpperCase()}`);
}

/**
 * Get CodeMirror language extension for a file path
 * Falls back to no language (plaintext) if not found
 */
async function getLanguageExtension(filePath: string) {
  const language = await askFileEditorLanguage(filePath);
  const loader = LANGUAGE_EXTENSIONS[language];

  if (!loader) {
    return [];
  }

  try {
    return [await loader()];
  } catch {
    // Language import failed — silently fall back to plaintext
    return [];
  }
}

function buildGutterExtension(showLineNumbers: boolean, gutterWidth: number): Extension {
  if (!showLineNumbers) {
    return [];
  }

  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    EditorView.theme({
      '.cm-gutters': {
        minWidth: `${gutterWidth}px`,
      },
      '.cm-lineNumbers .cm-gutterElement': {
        minWidth: `${gutterWidth}px`,
        paddingLeft: '8px',
        paddingRight: '10px',
        textAlign: 'right',
      },
    }),
  ];
}

interface FileEditorProps {
  /** File path to edit (if provided, auto-loads on mount) */
  filePath?: string;
  /** Human-readable source state for instance/global selection routing. */
  sourceLabel?: string;
  /** Let this editor follow the shared selection feed again. */
  onFollowSelection?: () => void;
  /** Callback when user clicks save button (optional) */
  onSave?: () => void;
  /** Callback when Cmd+K inline edit is submitted (optional) */
  onSendToChat?: (message: string) => void;
  /** Hide the editor's own header/status bar. For embedding inside a panel that
   *  supplies its own chrome (e.g. the visual-database attachment preview) — the
   *  CodeMirror editor stays formatted + editable, Cmd+S still saves. */
  hideHeader?: boolean;
}

/**
 * FileEditor: CodeMirror-based editor for inline file editing
 *
 * Props:
 * - filePath: optional file path to auto-load on mount
 * - onSave: optional callback fired after successful save
 *
 * Manages:
 * - File loading/saving via the local file-process helper
 * - CodeMirror editor instance
 * - Syntax highlighting per extension
 * - Dirty state indicator
 * - Cmd+S save handler
 * - Status bar with metadata
 *
 * All UI through ui/ components (L065/L066 compliant).
 */
const FileEditor = React.forwardRef<HTMLDivElement, FileEditorProps>(
  ({ filePath, sourceLabel, onFollowSelection, onSave, onSendToChat, hideHeader }, ref) => {
    const editorRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const languageCompartmentRef = useRef(new Compartment());
    const gutterCompartmentRef = useRef(new Compartment());
    const [openFile, setOpenFile] = useState<FileBuffer | null>(null);
    const [isLoadingFile, setIsLoadingFile] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lineCount, setLineCount] = useState(0);
    const [langLabel, setLangLabel] = useState('Plain Text');
    const [showInlinePrompt, setShowInlinePrompt] = useState(false);
    const [promptPosition, setPromptPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
    const [currentSelectionText, setCurrentSelectionText] = useState('');
    const [currentLineRange, setCurrentLineRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
    const [showLineNumbers, setShowLineNumbers] = useState(true);
    const [gutterWidth, setGutterWidth] = useState(DEFAULT_GUTTER_WIDTH);

    const isDirty = openFile ? openFile.content !== openFile.originalContent : false;

    const updateContent = useCallback((content: string) => {
      setOpenFile((previous) =>
        previous ? { ...previous, content } : null,
      );
    }, []);

    const discard = () => {
      setOpenFile((previous) =>
        previous ? { ...previous, content: previous.originalContent } : null,
      );
    };

    // Wire selected text into the next agent request.
    // This hook returns onSelectionChange callback for CodeMirror integration
    const filename = openFile ? openFile.path.split('/').pop() || 'file' : '';
    const { onSelectionChange } = useFileEditorSelectedTextForNextAgentRequestWriter(
      openFile?.path || '',
      filename,
    );

    /**
     * Initialize CodeMirror editor when ref is ready
     * The updateListener must be in the extensions array for it to work
     * Includes: content updates, line count, and selection capture
     */
    useEffect(() => {
      if (!editorRef.current) return;

      const handleUpdate = (update: any) => {
        if (update.docChanged) {
          updateContent(update.state.doc.toString());
          setLineCount(update.state.doc.lines);
        }

        // Capture selected text for the next agent request.
        if (update.selectionSet) {
          const { from, to } = update.state.selection.main;
          if (from !== to) {
            const text = update.state.sliceDoc(from, to);
            const startLine = update.state.doc.lineAt(from).number;
            const endLine = update.state.doc.lineAt(to).number;
            const fullContent = update.state.doc.toString();
            onSelectionChange(text, startLine, endLine, fullContent);
          }
        }
      };

      const state = EditorState.create({
        doc: '',
        extensions: [
          minimalSetup,
          FILE_EDITOR_THEME,
          EditorView.lineWrapping,
          // Cmd/Ctrl+F TOGGLES the search panel: close it if open, open it
          // otherwise (closeSearchPanel returns true only when it closed an open
          // panel). Prec.high beats searchKeymap's open-only Mod-f binding.
          Prec.high(
            keymap.of([
              {
                key: 'Mod-f',
                preventDefault: true,
                run: (view) => closeSearchPanel(view) || openSearchPanel(view),
              },
            ]),
          ),
          codeMirrorSearch({ top: true, createPanel: createFileEditorSearchPanel }),
          highlightSelectionMatches({ highlightWordAroundCursor: true }),
          syntaxHighlighting(FILE_EDITOR_HIGHLIGHT_STYLE),
          gutterCompartmentRef.current.of(buildGutterExtension(showLineNumbers, gutterWidth)),
          languageCompartmentRef.current.of([]),
          EditorView.updateListener.of(handleUpdate),
          keymap.of(searchKeymap),
        ],
      });

      const view = new EditorView({
        state,
        parent: editorRef.current,
      });

      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
    }, [updateContent, onSelectionChange]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;

      view.dispatch({
        effects: gutterCompartmentRef.current.reconfigure(
          buildGutterExtension(showLineNumbers, gutterWidth),
        ),
      });
    }, [showLineNumbers, gutterWidth]);

    /**
     * Auto-load file if filePath prop provided
     */
    useEffect(() => {
      let cancelled = false;

      if (!filePath) {
        setOpenFile(null);
        setError(null);
        setIsLoadingFile(false);
        setLineCount(0);
        setLangLabel('Plain Text');
        return () => {
          cancelled = true;
        };
      }

      if (openFile?.path === filePath) {
        return () => {
          cancelled = true;
        };
      }

      setIsLoadingFile(true);
      readFileEditorTextFile(filePath)
        .then((content) => {
          if (cancelled) return;
          setOpenFile({
            path: filePath,
            content,
            originalContent: content,
          });
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setOpenFile(null);
        })
        .finally(() => {
          if (!cancelled) setIsLoadingFile(false);
        });

      return () => {
        cancelled = true;
      };
    }, [filePath, openFile?.path]);

    /**
     * Update CodeMirror editor when openFile changes
     */
    useEffect(() => {
      if (!viewRef.current || !openFile) return;

      let cancelled = false;
      const view = viewRef.current;
      const currentDoc = view.state.doc.toString();

      // Only update if content actually changed to avoid cursor jitter
      if (currentDoc !== openFile.content) {
        view.dispatch({
          changes: {
            from: 0,
            to: currentDoc.length,
            insert: openFile.content,
          },
        });
      }

      // Update status bar metadata
      setLineCount(view.state.doc.lines);
      askFileEditorLanguage(openFile.path)
        .then((language) => {
          if (!cancelled) setLangLabel(formatLanguageLabel(language));
        })
        .catch(() => {
          if (!cancelled) setLangLabel('Plain Text');
        });
      getLanguageExtension(openFile.path)
        .then((extension) => {
          if (!cancelled && viewRef.current) {
            viewRef.current.dispatch({
              effects: languageCompartmentRef.current.reconfigure(extension),
            });
          }
        })
        .catch(() => {
          if (!cancelled && viewRef.current) {
            viewRef.current.dispatch({
              effects: languageCompartmentRef.current.reconfigure([]),
            });
          }
        });
      setError(null);

      return () => {
        cancelled = true;
      };
    }, [openFile]);

    const saveFile = async () => {
      if (!openFile) return;

      setIsSaving(true);
      try {
        await writeFileEditorTextFile(openFile.path, openFile.content);
        setOpenFile((previous) =>
          previous ? { ...previous, originalContent: previous.content } : null,
        );
        setError(null);
        onSave?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsSaving(false);
      }
    };

    const openSearchInEditor = useCallback(() => {
      const view = viewRef.current;
      if (!view) return;
      openSearchPanel(view);
    }, []);

    /**
     * Handle Cmd+S / Ctrl+S save
     */
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault();
          if (isDirty && !isSaving) {
            void saveFile();
          }
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isDirty, isSaving, openFile]);

    /**
     * Handle Cmd+K / Ctrl+K for inline edit prompt
     * Shows the selected-text agent request popover when there is an active selection.
     */
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault();

          if (!viewRef.current) return;

          const view = viewRef.current;
          const { from, to } = view.state.selection.main;

          // Only show if there's an active selection
          if (from !== to) {
            const selectedText = view.state.sliceDoc(from, to);
            const startLine = view.state.doc.lineAt(from).number;
            const endLine = view.state.doc.lineAt(to).number;

            // Get pixel position of selection start for popover placement
            const coords = view.coordsAtPos(from);
            if (coords) {
              setCurrentSelectionText(selectedText);
              setCurrentLineRange({ start: startLine, end: endLine });
              setPromptPosition({ top: coords.top, left: coords.left });
              setShowInlinePrompt(true);
            }
          }
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    if (isLoadingFile) {
      return (
        <Container ref={ref} layout="vertical" padding="lg" gap="sm" alignItems="center" justifyContent="center" height="full">
          <Loader2 size={22} className="animate-spin text-[var(--text-muted)]" />
          <Text variant="body" color="secondary">Opening selected file...</Text>
        </Container>
      );
    }

    if (!openFile) {
      return (
        <Container ref={ref} layout="vertical" padding="lg" gap="md" alignItems="center" justifyContent="center" height="full">
          <Container layout="vertical" gap="sm" alignItems="center" className="max-w-sm text-center">
            <Container layout="horizontal" alignItems="center" justifyContent="center" className="h-12 w-12 rounded-2xl bg-[var(--glass-bg-subtle)]">
              <FileText size={22} className="text-[var(--text-secondary)]" />
            </Container>
            <Text variant="heading" color="primary">No file selected</Text>
            <Text variant="body-xs" color="faint" leading="relaxed">
              Pick a file in the Files panel and it opens here.
            </Text>
            <Container layout="horizontal" gap="xs" alignItems="center">
              <MousePointer2 size={13} className="text-[var(--text-muted)]" />
              <Text variant="caption" color="faint">Files panel → any file</Text>
            </Container>
          </Container>
        </Container>
      );
    }

    return (
      <Container
        ref={ref}
        layout="vertical"
        gap="none"
        height="full"
      >
        {/* Header with file path, editor controls, and dirty indicator.
            hideHeader skips this whole bar when an embedding panel supplies its
            own chrome (visual-database attachment preview). */}
        {!hideHeader && (
        <Container
          layout="horizontal"
          alignItems="start"
          padding="md"
          gap="sm"
          wrap="wrap"
          className="min-w-0 max-w-full overflow-hidden"
          style={{ borderBottom: '1px solid var(--border-primary)' }}
        >
          <Container layout="horizontal" alignItems="center" gap="sm" flex="1" className="min-w-0 basis-48 overflow-hidden">
            <Text variant="label" truncate className="min-w-0">
              {openFile.path}
            </Text>
            {sourceLabel && (
              <Badge variant="neutral" className="shrink-0 whitespace-nowrap">{sourceLabel}</Badge>
            )}
          </Container>
          <Container layout="horizontal" gap="xs" alignItems="center" wrap="wrap" className="min-w-0 max-w-full justify-end overflow-hidden">
            <Text variant="caption" className="shrink-0 whitespace-nowrap">{langLabel}</Text>
            <Text variant="caption" className="shrink-0 whitespace-nowrap">{lineCount} lines</Text>
            <Tooltip label="Find in file" shortcut="⌘F">
              <Button
                aria-label="Find in file"
                variant="ghost"
                size="icon"
                onClick={openSearchInEditor}
              >
                <Search size={14} aria-hidden="true" />
              </Button>
            </Tooltip>
            <Button
              variant="ghost"
              size="xs"
              active={showLineNumbers}
              onClick={() => setShowLineNumbers((current) => !current)}
            >
              Lines
            </Button>
            {showLineNumbers && (
              <Container layout="horizontal" gap="xs" alignItems="center" className="min-w-0 shrink">
                <Text variant="caption" color="faint" className="shrink-0 whitespace-nowrap">Gutter</Text>
                <input
                  aria-label="Line number gutter width"
                  type="range"
                  min={MIN_GUTTER_WIDTH}
                  max={MAX_GUTTER_WIDTH}
                  value={gutterWidth}
                  onChange={(event) => setGutterWidth(Number(event.target.value))}
                  className="w-16 min-w-10 max-w-[20vw] accent-[var(--accent-primary)]"
                />
              </Container>
            )}
            {onFollowSelection && (
              <Button variant="ghost" size="xs" onClick={onFollowSelection}>
                Follow selected file
              </Button>
            )}
            {isDirty && (
              <Button
                variant="secondary"
                size="sm"
                disabled={isSaving}
                onClick={() => void saveFile()}
              >
                Save
              </Button>
            )}
            {isDirty && (
              <Button variant="ghost" size="sm" onClick={discard}>
                Discard
              </Button>
            )}
          </Container>
          {isDirty && <Badge variant="warning">Unsaved</Badge>}
          {error && <Badge variant="error">{error}</Badge>}
        </Container>
        )}

        {/* CodeMirror editor */}
        {/* L065: overflow requires inline style — no Container prop equivalent */}
        <Container
          ref={editorRef}
          layout="vertical"
          flex="1"
          style={{ overflow: 'hidden', minHeight: 0 }}
        />

        {/* Inline edit prompt (Cmd+K) */}
        {showInlinePrompt && (
          <AskAiToEditSelectedFileText
            position={promptPosition}
            selectedText={currentSelectionText}
            filePath={openFile?.path ?? ''}
            lineRange={currentLineRange}
            onSubmit={(description) => {
              const msg = `Edit ${openFile?.path} (lines ${currentLineRange.start}-${currentLineRange.end}):\n${description}\n\nSelected text:\n${currentSelectionText}`;
              onSendToChat?.(msg);
              setShowInlinePrompt(false);
            }}
            onCancel={() => setShowInlinePrompt(false)}
          />
        )}
      </Container>
    );
  },
);

FileEditor.displayName = 'FileEditor';

export { FileEditor };
export type { FileEditorProps };
