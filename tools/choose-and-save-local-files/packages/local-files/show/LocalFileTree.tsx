// package-set://bitfield-studio/packages/local-files/show/LocalFileTree.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Finder-like local file browser. The browser is a current-directory navigator,
// not a static tree: it exposes current path, back/forward/up navigation, root
// shortcuts, arbitrary path entry, OS file picking, and file selection into the
// shared File Editor record. All local filesystem work still flows through the
// neutral local file operations helpers and the native `local.files`
// capability.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. File operations go through the local file operations helper
// 2. Directory listing is path-data driven; no hardcoded project path
// 3. Folders navigate the current directory; files select into File Editor
// 4. Current location is always visible and editable
// 5. Back/forward/up are explicit navigation state, not browser history hacks
// 6. OS file picker can move the navigator to a chosen file's parent directory
// 7. Error states show inline and do not crash the surface
// 8. Hidden files remain excluded by the read-data listing policy
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Container, Text, Button, ExpandableTabs, Icon, Input, Card, emitPlaceableSurfaceIntent, setPlaceableSurfaceDragData } from '@/packages/ui';
import { askLocalFileDisplay } from '@/packages/local-files/do-work/ask-local-file-display';
import {
  listLocalRootShortcuts,
  type LocalRootShortcut,
} from '@/packages/local-files/read-data/read-local-file-roots';
import {
  listLocalDirectory,
  type LocalFileEntry,
} from '@/packages/local-files/read-data/read-local-directory';
import { chooseLocalFiles } from '@/packages/local-files/do-work/choose-local-files';
import { chooseLocalFolder } from '@/packages/local-files/do-work/choose-local-folder';
import { createLocalDirectory } from '@/packages/local-files/do-work/create-local-directory';
import { createLocalEmptyFile } from '@/packages/local-files/do-work/create-local-empty-file';
import { moveLocalPathToTrash } from '@/packages/local-files/do-work/move-local-path-to-trash';
import { renameLocalPath } from '@/packages/local-files/do-work/rename-local-path';
import { revealLocalPath } from '@/packages/local-files/do-work/reveal-local-path';
import {
  FilePlus2,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Home,
  Loader2,
  Pin,
  PinOff,
  Search,
} from 'lucide-react';
import { FloatingPanel } from '@/packages/screen-arrangement/show/FloatingPanel';

const PINNED_PATHS_STORAGE_KEY = 'bitfield.local-files.pinned-paths.v1';
const SHOW_HIDDEN_STORAGE_KEY = 'bitfield.local-files.show-hidden.v1';

interface PinnedPath {
  label: string;
  path: string;
  isDir: boolean;
}

function basename(path: string): string {
  if (path === '/') return '/';
  const cleanPath = path.replace(/\/+$/, '');
  return cleanPath.split('/').pop() || cleanPath;
}

function dirname(path: string): string {
  const cleanPath = path.replace(/\/+$/, '');
  if (!cleanPath || cleanPath === '/') return '/';
  const index = cleanPath.lastIndexOf('/');
  if (index <= 0) return '/';
  return cleanPath.slice(0, index);
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
}

function labelForPath(path: string): string {
  if (path === '/') return 'Computer';
  return basename(path);
}

function pinnedPathFromShortcut(shortcut: LocalRootShortcut): PinnedPath {
  return {
    label: shortcut.label,
    path: normalizePath(shortcut.path),
    isDir: true,
  };
}

function pinnedPathFromTarget(path: string, isDir: boolean): PinnedPath {
  const normalizedPath = normalizePath(path);
  return {
    label: labelForPath(normalizedPath),
    path: normalizedPath,
    isDir,
  };
}

function loadPinnedPaths(defaultPins: PinnedPath[]): PinnedPath[] {
  if (typeof window === 'undefined') return defaultPins;

  try {
    const raw = window.localStorage.getItem(PINNED_PATHS_STORAGE_KEY);
    if (!raw) return defaultPins;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultPins;
    const pins = parsed
      .filter((item): item is PinnedPath =>
        item
        && typeof item.label === 'string'
        && typeof item.path === 'string'
        && typeof item.isDir === 'boolean',
      )
      .map((item) => ({ ...item, path: normalizePath(item.path) }))
      .filter((item) => item.path);
    return pins.length > 0 ? pins : defaultPins;
  } catch {
    return defaultPins;
  }
}

function persistPinnedPaths(pins: PinnedPath[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PINNED_PATHS_STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Pinned paths are a convenience preference; navigation remains functional.
  }
}

function loadShowHidden(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SHOW_HIDDEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistShowHidden(showHidden: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHOW_HIDDEN_STORAGE_KEY, showHidden ? 'true' : 'false');
  } catch {
    // Hidden-file visibility is a local preference; listing still works.
  }
}

function joinPath(parentPath: string, name: string): string {
  if (parentPath === '/') return `/${name}`;
  return `${parentPath.replace(/\/+$/, '')}/${name}`;
}

function filePathMaterialPayload(path: string) {
  return {
    version: 1,
    id: `local-file-path:${path}`,
    title: basename(path),
    icon: 'FileText',
    material: {
      kind: 'local.file-path',
      path,
    },
    surfaceInput: {
      filePath: path,
      path,
    },
  };
}

function menuPosition(x: number, y: number, bounds?: DOMRect | null): { x: number; y: number } {
  const width = 190;
  const height = 224;
  const margin = 10;
  const leftBound = bounds?.left ?? 0;
  const topBound = bounds?.top ?? 0;
  const rightBound = bounds?.right ?? (typeof window === 'undefined' ? x + width + margin : window.innerWidth);
  const bottomBound = bounds?.bottom ?? (typeof window === 'undefined' ? y + height + margin : window.innerHeight);
  return {
    x: Math.max(leftBound + margin, Math.min(x, rightBound - width - margin)),
    y: Math.max(topBound + margin, Math.min(y, bottomBound - height - margin)),
  };
}

function LocalFileIcon({ path }: { path: string }) {
  const [icon, setIcon] = useState('File');

  useEffect(() => {
    let cancelled = false;
    askLocalFileDisplay(path)
      .then((display) => {
        if (!cancelled) setIcon(display.icon);
      })
      .catch(() => {
        if (!cancelled) setIcon('File');
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return <Icon icon={icon} size="sm" />;
}

interface FileTreeProps {
  /** Callback when user clicks a file — parent should open in editor */
  onFileSelect: (path: string) => void | Promise<void>;
  /** Optional callback when tree structure changes */
  onRefresh?: () => void;
}

const FileTree = React.forwardRef<HTMLDivElement, FileTreeProps>(
  ({ onFileSelect, onRefresh }, ref) => {
    const [entries, setEntries] = useState<LocalFileEntry[]>([]);
    const [searchText, setSearchText] = useState('');
    const [pinnedPaths, setPinnedPaths] = useState<PinnedPath[]>([]);
    const [currentPath, setCurrentPath] = useState('');
    const [pathInput, setPathInput] = useState('');
    const [backStack, setBackStack] = useState<string[]>([]);
    const [forwardStack, setForwardStack] = useState<string[]>([]);
    const [isInitializing, setIsInitializing] = useState(true);
    const [isLoadingDirectory, setIsLoadingDirectory] = useState(false);
    const [showHidden, setShowHidden] = useState(loadShowHidden);
    const [contextMenu, setContextMenu] = useState<{
      path: string;
      isDir: boolean;
      isCurrentDirectory?: boolean;
      x: number;
      y: number;
    } | null>(null);
    const [renamingPath, setRenamingPath] = useState<string | null>(null);
    const [newName, setNewName] = useState('');
    const [showCreateDialog, setShowCreateDialog] = useState<{
      parentPath: string;
      isDir: boolean;
    } | null>(null);
    const [trashConfirm, setTrashConfirm] = useState<string | null>(null);
    const [trashPendingPath, setTrashPendingPath] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
    const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
    const [draggingPaths, setDraggingPaths] = useState<string[]>([]);
    const [pendingSelectionPath, setPendingSelectionPath] = useState<string | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const renameInputRef = useRef<HTMLInputElement>(null);
    const hasInitializedRef = useRef(false);

    useImperativeHandle(ref, () => panelRef.current as HTMLDivElement, []);

    const canGoBack = backStack.length > 0;
    const canGoForward = forwardStack.length > 0;
    const canGoUp = currentPath.length > 0 && currentPath !== '/';

    const selectedName = useMemo(
      () => (selectedPath ? basename(selectedPath) : 'No file selected'),
      [selectedPath],
    );

    const selectedPathList = useMemo(() => Array.from(selectedPaths), [selectedPaths]);
    const pinnedPathSet = useMemo(
      () => new Set(pinnedPaths.map((pin) => pin.path)),
      [pinnedPaths],
    );

    const filteredEntries = useMemo(() => {
      const trimmedQuery = searchText.trim().toLowerCase();
      if (!trimmedQuery) return entries;
      return entries.filter((entry) => entry.name.toLowerCase().includes(trimmedQuery));
    }, [entries, searchText]);

    const openDirectory = useCallback(
      async (path: string, options: { recordHistory?: boolean } = {}) => {
        const nextPath = normalizePath(path);
        if (!nextPath) return;

        setIsLoadingDirectory(true);
        setError(null);
        try {
          const nextEntries = await listLocalDirectory(nextPath, { showHidden });
          setEntries(nextEntries);
          setPathInput(nextPath);
          setCurrentPath((previousPath) => {
            if (options.recordHistory !== false && previousPath && previousPath !== nextPath) {
              setBackStack((previous) => [...previous, previousPath]);
              setForwardStack([]);
            }
            return nextPath;
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : `Failed to open directory: ${err}`);
        } finally {
          setIsLoadingDirectory(false);
          setIsInitializing(false);
        }
      },
      [showHidden],
    );

    useEffect(() => {
      if (hasInitializedRef.current) return undefined;
      hasInitializedRef.current = true;

      let cancelled = false;

      listLocalRootShortcuts()
        .then((shortcuts) => {
          if (cancelled) return;
          const defaultPins = shortcuts.map(pinnedPathFromShortcut);
          setPinnedPaths(loadPinnedPaths(defaultPins));
          const homeRoot = shortcuts.find((shortcut) => shortcut.label === 'Home') ?? shortcuts[0];
          if (homeRoot) void openDirectory(homeRoot.path, { recordHistory: false });
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setIsInitializing(false);
        });

      return () => {
        cancelled = true;
      };
    }, [openDirectory]);

    const pinPath = useCallback((path: string, isDir: boolean) => {
      const pin = pinnedPathFromTarget(path, isDir);
      setPinnedPaths((current) => {
        if (current.some((item) => item.path === pin.path)) return current;
        const next = [...current, pin];
        persistPinnedPaths(next);
        return next;
      });
      setContextMenu(null);
    }, []);

    const unpinPath = useCallback((path: string) => {
      const normalizedPath = normalizePath(path);
      setPinnedPaths((current) => {
        const next = current.filter((item) => item.path !== normalizedPath);
        persistPinnedPaths(next);
        return next;
      });
      setContextMenu(null);
    }, []);

    const copyPath = useCallback(async (path: string) => {
      try {
        await navigator.clipboard.writeText(path);
      } catch (err) {
        setError(`Failed to copy path: ${err}`);
      } finally {
        setContextMenu(null);
      }
    }, []);

    const refreshCurrentDirectory = useCallback(async () => {
      if (!currentPath) return;
      await openDirectory(currentPath, { recordHistory: false });
      onRefresh?.();
    }, [currentPath, onRefresh, openDirectory]);

    const toggleShowHidden = useCallback(() => {
      setShowHidden((current) => {
        const next = !current;
        persistShowHidden(next);
        return next;
      });
    }, []);

    useEffect(() => {
      if (!currentPath || isInitializing) return;
      void openDirectory(currentPath, { recordHistory: false });
    }, [currentPath, isInitializing, openDirectory]);

    const goBack = useCallback(async () => {
      const previousPath = backStack[backStack.length - 1];
      if (!previousPath) return;
      setBackStack((previous) => previous.slice(0, -1));
      if (currentPath) setForwardStack((previous) => [...previous, currentPath]);
      await openDirectory(previousPath, { recordHistory: false });
    }, [backStack, currentPath, openDirectory]);

    const goForward = useCallback(async () => {
      const nextPath = forwardStack[forwardStack.length - 1];
      if (!nextPath) return;
      setForwardStack((previous) => previous.slice(0, -1));
      if (currentPath) setBackStack((previous) => [...previous, currentPath]);
      await openDirectory(nextPath, { recordHistory: false });
    }, [currentPath, forwardStack, openDirectory]);

    const goUp = useCallback(async () => {
      if (!canGoUp) return;
      await openDirectory(dirname(currentPath));
    }, [canGoUp, currentPath, openDirectory]);

    const selectFile = useCallback(
      async (entry: LocalFileEntry) => {
        if (entry.isDir) return;
        setSelectedPath(entry.path);
        setPendingSelectionPath(entry.path);
        setError(null);
        try {
          await onFileSelect(entry.path);
        } catch (err) {
          setError(`Failed to open file: ${err}`);
        } finally {
          setPendingSelectionPath((current) => current === entry.path ? null : current);
        }
      },
      [onFileSelect],
    );

    const selectEntry = useCallback((entry: LocalFileEntry, event: React.MouseEvent) => {
      if (event.shiftKey && lastSelectedPath) {
        const first = entries.findIndex((item) => item.path === lastSelectedPath);
        const second = entries.findIndex((item) => item.path === entry.path);
        if (first >= 0 && second >= 0) {
          const [start, end] = first <= second ? [first, second] : [second, first];
          setSelectedPaths(new Set(entries.slice(start, end + 1).map((item) => item.path)));
          setSelectedPath(entry.path);
          return;
        }
      }

      if (event.metaKey || event.ctrlKey) {
        setSelectedPaths((current) => {
          const next = new Set(current);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
        setSelectedPath(entry.path);
        setLastSelectedPath(entry.path);
        return;
      }

      setSelectedPaths(new Set([entry.path]));
      setSelectedPath(entry.path);
      setLastSelectedPath(entry.path);
    }, [entries, lastSelectedPath]);

    const pickFile = useCallback(async () => {
      try {
        const files = await chooseLocalFiles({ multiple: false, prompt: 'Choose a file to open' });
        const file = files[0];
        if (!file) return;
        await openDirectory(dirname(file.path));
        await selectFile({ path: file.path, name: file.name, isDir: false });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, [openDirectory, selectFile]);

    const pickFolder = useCallback(async () => {
      try {
        const folder = await chooseLocalFolder({ prompt: 'Choose a folder to browse' });
        if (!folder) return;
        await openDirectory(folder);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, [openDirectory]);

    const openPathAsSurface = useCallback(
      (path: string) => {
        const accepted = emitPlaceableSurfaceIntent(filePathMaterialPayload(path));
        if (!accepted) {
          setError('No active screen tab could open this file. Click a File Editor tab or an empty screen area, then try again.');
        }
      },
      [],
    );

    const createItem = useCallback(async () => {
      if (!showCreateDialog || !newName.trim()) return;

      try {
        const fullPath = joinPath(showCreateDialog.parentPath, newName.trim());
        if (showCreateDialog.isDir) {
          await createLocalDirectory(fullPath);
        } else {
          await createLocalEmptyFile(fullPath);
          setSelectedPath(fullPath);
          openPathAsSurface(fullPath);
        }
        setShowCreateDialog(null);
        setNewName('');
        await refreshCurrentDirectory();
      } catch (err) {
        setError(`Failed to create item: ${err}`);
      }
    }, [showCreateDialog, newName, openPathAsSurface, refreshCurrentDirectory]);

    const beginCreate = useCallback((parentPath: string, isDir: boolean) => {
      setContextMenu(null);
      setShowCreateDialog({ parentPath, isDir });
      setNewName('');
    }, []);

    const renameItem = useCallback(
      async (oldPath: string, newNameVal: string) => {
        if (!newNameVal.trim()) return;
        try {
          const newPath = `${dirname(oldPath)}/${newNameVal.trim()}`;
          await renameLocalPath(oldPath, newPath);
          if (selectedPath === oldPath) setSelectedPath(newPath);
          setRenamingPath(null);
          setNewName('');
          await refreshCurrentDirectory();
        } catch (err) {
          setError(`Failed to rename: ${err}`);
        }
      },
      [refreshCurrentDirectory, selectedPath],
    );

    const moveItems = useCallback(
      async (paths: string[], targetDirectory: string) => {
        const uniquePaths = Array.from(new Set(paths)).filter((path) =>
          dirname(path) !== targetDirectory
          && path !== targetDirectory
          && !targetDirectory.startsWith(`${path}/`),
        );
        if (uniquePaths.length === 0) return;

        try {
          for (const path of uniquePaths) {
            await renameLocalPath(path, `${targetDirectory}/${basename(path)}`);
          }
          setSelectedPaths(new Set(uniquePaths.map((path) => `${targetDirectory}/${basename(path)}`)));
          setSelectedPath(`${targetDirectory}/${basename(uniquePaths[0])}`);
          await refreshCurrentDirectory();
        } catch (err) {
          setError(`Failed to move item: ${err}`);
        } finally {
          setDraggingPaths([]);
        }
      },
      [refreshCurrentDirectory],
    );

    const trashItem = useCallback(
      async (path: string) => {
        if (trashPendingPath) return;
        setTrashPendingPath(path);
        try {
          await moveLocalPathToTrash(path);
          if (selectedPath === path) setSelectedPath(null);
          setTrashConfirm(null);
          await refreshCurrentDirectory();
        } catch (err) {
          setError(`Failed to move to Trash: ${err}`);
        } finally {
          setTrashPendingPath(null);
        }
      },
      [refreshCurrentDirectory, selectedPath, trashPendingPath],
    );

    useEffect(() => {
      if (!contextMenu) return undefined;

      const dismiss = () => setContextMenu(null);
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') dismiss();
      };

      window.addEventListener('pointerdown', dismiss);
      window.addEventListener('keydown', onKeyDown);
      return () => {
        window.removeEventListener('pointerdown', dismiss);
        window.removeEventListener('keydown', onKeyDown);
      };
    }, [contextMenu]);

    const renderEntry = (entry: LocalFileEntry): React.ReactNode => {
      const isRenaming = renamingPath === entry.path;
      const isSelected = selectedPaths.has(entry.path) || selectedPath === entry.path;
      const isPending = pendingSelectionPath === entry.path;

      return (
        <Container
          key={entry.path}
          as="button"
          type="button"
          layout="horizontal"
          alignItems="center"
          gap="sm"
          padding="sm"
          width="full"
          className="group min-h-10 rounded-xl text-left transition-all duration-150 hover:bg-[var(--glass-bg-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-purple active:scale-[0.995]"
          aria-label={entry.isDir ? `Open folder ${entry.name}` : `Open file ${entry.name}`}
          aria-selected={isSelected || undefined}
          style={{
            background: isSelected ? 'var(--glass-bg-active)' : undefined,
            color: 'var(--text-primary)',
          }}
          draggable
          onDragStart={(event) => {
            const paths = selectedPaths.has(entry.path) ? selectedPathList : [entry.path];
            setDraggingPaths(paths);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', JSON.stringify(paths));
            if (!entry.isDir) {
              setPlaceableSurfaceDragData(
                event.dataTransfer,
                filePathMaterialPayload(entry.path),
                `Open ${entry.path}`,
              );
            }
          }}
          onDragOver={(event) => {
            if (entry.isDir && draggingPaths.length > 0) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }
          }}
          onDrop={(event) => {
            if (!entry.isDir) return;
            event.preventDefault();
            event.stopPropagation();
            let paths = draggingPaths;
            try {
              const parsed = JSON.parse(event.dataTransfer.getData('text/plain'));
              if (Array.isArray(parsed)) paths = parsed.filter((item): item is string => typeof item === 'string');
            } catch {
              // Same-surface drags use component state; dataTransfer is a browser fallback.
            }
            void moveItems(paths, entry.path);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const position = menuPosition(event.clientX, event.clientY, panelRef.current?.getBoundingClientRect());
            setContextMenu({
              path: entry.path,
              isDir: entry.isDir,
              x: position.x,
              y: position.y,
            });
          }}
          onClick={(event) => {
            selectEntry(entry, event);
            if (!event.metaKey && !event.ctrlKey && !event.shiftKey) {
              void (entry.isDir ? openDirectory(entry.path) : selectFile(entry));
            }
          }}
        >
          {entry.isDir ? (
            <Folder size={17} className="text-[var(--text-secondary)]" />
          ) : (
            <LocalFileIcon path={entry.path} />
          )}

          {isRenaming ? (
            <Input
              ref={renameInputRef}
              value={newName}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.stopPropagation();
                  void renameItem(entry.path, newName);
                } else if (event.key === 'Escape') {
                  event.stopPropagation();
                  setRenamingPath(null);
                  setNewName('');
                }
              }}
              autoFocus
              borderless
              className="h-7 rounded-none border-b border-x-0 border-t-0 bg-transparent px-0 py-0 text-sm"
              style={{ flex: 1 }}
            />
          ) : (
            <Container layout="vertical" gap="none" style={{ flex: 1, minWidth: 0 }}>
              <Text
                variant="body-xs"
                truncate
                color={isSelected ? 'primary' : 'secondary'}
                weight={isSelected ? 'medium' : 'normal'}
              >
                {entry.name}
              </Text>
              {isSelected && (
                <Text variant="caption" color="faint" truncate>
                  {entry.path}
                </Text>
              )}
            </Container>
          )}

          {isPending && <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />}
        </Container>
      );
    };

    if (isInitializing) {
      return (
        <Container ref={ref} layout="vertical" padding="lg" gap="sm">
          <Loader2 size={18} className="animate-spin text-[var(--text-muted)]" />
          <Text color="faint">Loading local files...</Text>
        </Container>
      );
    }

    return (
      <Container ref={panelRef} layout="vertical" gap="sm" height="full" minHeight="0" style={{ overflow: 'hidden' }}>
        <Card variant="ghost" padding="sm" className="border-b border-[var(--border-primary)] rounded-none">
          <Container layout="vertical" gap="sm">
            <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm">
              <Container layout="horizontal" alignItems="center" gap="sm" style={{ flex: 1, minWidth: 0 }}>
                <Input
                  aria-label="Filter files by name"
                  placeholder="Filter files by name"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  icon={<Search size={15} />}
                  borderless
                  style={{ flex: 1 }}
                />
              </Container>
              <Text variant="caption" color="faint">{filteredEntries.length} items</Text>
            </Container>

            <Container layout="horizontal" gap="xs" alignItems="center">
              <ExpandableTabs
                mode="action"
                size="sm"
                ariaLabel="Folder history"
                items={[
                  { id: 'back', label: 'Back', icon: 'ArrowLeft', disabled: !canGoBack },
                  { id: 'forward', label: 'Forward', icon: 'ArrowRight', disabled: !canGoForward },
                  { id: 'up', label: 'Up one folder', icon: 'ArrowUp', disabled: !canGoUp },
                ]}
                onSelect={(id) => void (id === 'back' ? goBack() : id === 'forward' ? goForward() : goUp())}
              />
              <Input
                aria-label="Current folder path"
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void openDirectory(pathInput);
                }}
                className="h-8 py-1 text-xs font-mono"
                style={{ flex: 1 }}
              />
              <Button variant="secondary" size="sm" onClick={() => void openDirectory(pathInput)}>
                Go
              </Button>
            </Container>

            <Container layout="horizontal" gap="xs" alignItems="center" wrap="wrap">
              {pinnedPaths.map((pin) => (
                <Button
                  key={pin.path}
                  variant="ghost"
                  size="xs"
                  active={pin.isDir ? currentPath === pin.path : selectedPath === pin.path}
                  title={pin.path}
                  onClick={() => {
                    if (pin.isDir) void openDirectory(pin.path);
                    else {
                      setSelectedPath(pin.path);
                      openPathAsSurface(pin.path);
                    }
                  }}
                >
                  {pin.label === 'Home' && <Home size={12} />}
                  {pin.label !== 'Home' && pin.isDir && <FolderOpen size={12} />}
                  {!pin.isDir && <LocalFileIcon path={pin.path} />}
                  {pin.label}
                </Button>
              ))}
              <Button variant="ghost" size="xs" onClick={() => void pickFile()}>
                <FolderInput size={12} />
                Pick File
              </Button>
              <Button variant="ghost" size="xs" onClick={() => void pickFolder()}>
                <FolderOpen size={12} />
                Pick Folder
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={!currentPath}
                onClick={() => beginCreate(currentPath, false)}
              >
                <FilePlus2 size={12} />
                New File
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={!currentPath}
                onClick={() => beginCreate(currentPath, true)}
              >
                <FolderPlus size={12} />
                New Folder
              </Button>
              <Button
                variant="ghost"
                size="xs"
                active={showHidden}
                onClick={toggleShowHidden}
                title={showHidden ? 'Hide dotfiles and hidden folders' : 'Show dotfiles and hidden folders'}
              >
                {showHidden ? 'Hide Hidden' : 'Show Hidden'}
              </Button>
            </Container>

            <Container layout="horizontal" justifyContent="between" gap="sm">
              <Text variant="caption" color="faint" truncate title={currentPath}>
                {currentPath || 'No directory loaded'}
              </Text>
              <Text variant="caption" color="faint" truncate title={selectedPath ?? undefined}>
                {selectedName}
              </Text>
            </Container>
          </Container>
        </Card>

        {error && (
          <Card variant="error" padding="sm" className="mx-2">
            <Text color="error" variant="caption">
              {error}
            </Text>
          </Card>
        )}

        <Container
          layout="vertical"
          gap="none"
          overflow="auto"
          flex="1"
          minHeight="0"
          className="px-2 pb-2"
          onContextMenu={(event) => {
            event.preventDefault();
            const position = menuPosition(event.clientX, event.clientY, panelRef.current?.getBoundingClientRect());
            setContextMenu({
              path: currentPath,
              isDir: true,
              isCurrentDirectory: true,
              x: position.x,
              y: position.y,
            });
          }}
          onDragOver={(event) => {
            if (draggingPaths.length > 0) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            let paths = draggingPaths;
            try {
              const parsed = JSON.parse(event.dataTransfer.getData('text/plain'));
              if (Array.isArray(parsed)) paths = parsed.filter((item): item is string => typeof item === 'string');
            } catch {
              // Same-surface drags use component state; dataTransfer is a browser fallback.
            }
            void moveItems(paths, currentPath);
          }}
        >
          {isLoadingDirectory ? (
            <Container layout="horizontal" gap="sm" alignItems="center" padding="md">
              <Loader2 size={16} className="animate-spin text-[var(--text-muted)]" />
              <Text variant="body-xs" color="faint">Loading {pathInput}...</Text>
            </Container>
          ) : entries.length === 0 ? (
            <Container layout="vertical" gap="xs" alignItems="center" justifyContent="center" padding="lg">
              <FolderOpen size={24} color="var(--text-muted)" />
              <Text variant="body-xs" color="faint">This folder is empty.</Text>
            </Container>
          ) : filteredEntries.length === 0 ? (
            <Container layout="vertical" gap="xs" alignItems="center" justifyContent="center" padding="lg">
              <Search size={24} color="var(--text-muted)" />
              <Text variant="body-xs" color="faint">No files match your search.</Text>
            </Container>
          ) : (
            filteredEntries.map(renderEntry)
          )}
        </Container>

        {contextMenu && (
          <Card
            variant="popover"
            style={{
              position: 'fixed',
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`,
              zIndex: 1000,
              minWidth: '190px',
            }}
            padding="none"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Container layout="vertical" gap="none" className="p-1 text-left">
              {pinnedPathSet.has(contextMenu.path) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-left"
                  onClick={() => unpinPath(contextMenu.path)}
                >
                  <PinOff size={13} />
                  Unpin
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-left"
                  onClick={() => pinPath(contextMenu.path, contextMenu.isDir)}
                >
                  <Pin size={13} />
                  Pin
                </Button>
              )}
              {contextMenu.isDir && !contextMenu.isCurrentDirectory && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-left"
                  onClick={() => {
                    setContextMenu(null);
                    void openDirectory(contextMenu.path);
                  }}
                >
                  Open Folder
                </Button>
              )}
              {contextMenu.isDir && (
                <>
                  <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-left"
                  onClick={() => {
                      beginCreate(contextMenu.path, false);
                    }}
                  >
                    New File
                  </Button>
                  <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-left"
                  onClick={() => {
                      beginCreate(contextMenu.path, true);
                    }}
                  >
                    New Folder
                  </Button>
                </>
              )}
              {!contextMenu.isDir && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-left"
                  onClick={() => {
                    openPathAsSurface(contextMenu.path);
                    setContextMenu(null);
                  }}
                >
                  Open in new editor tab
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-left"
                onClick={() => void copyPath(contextMenu.path)}
              >
                Copy Path
              </Button>
              {!contextMenu.isCurrentDirectory && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-left"
                  onClick={() => {
                    setRenamingPath(contextMenu.path);
                    setNewName(basename(contextMenu.path));
                    setContextMenu(null);
                  }}
                >
                  Rename
                </Button>
              )}
              {!contextMenu.isCurrentDirectory && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-left"
                  onClick={() => {
                    setTrashConfirm(contextMenu.path);
                    setContextMenu(null);
                  }}
                >
                  Move to Trash
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-left"
                onClick={async () => {
                  try {
                    await revealLocalPath(contextMenu.path);
                  } catch (err) {
                    setError(`Failed to reveal: ${err}`);
                  }
                  setContextMenu(null);
                }}
              >
                Reveal in Finder
              </Button>
            </Container>
          </Card>
        )}

        {showCreateDialog && (
          <FloatingPanel
            open
            onClose={() => {
              setShowCreateDialog(null);
              setNewName('');
            }}
            title={showCreateDialog.isDir ? 'New Folder' : 'New File'}
            description={`Create inside ${showCreateDialog.parentPath}`}
          >
            <Container layout="vertical" gap="md" padding="lg">
              <Input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder={showCreateDialog.isDir ? 'Folder name' : 'File name'}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void createItem();
                  } else if (event.key === 'Escape') {
                    setShowCreateDialog(null);
                    setNewName('');
                  }
                }}
              />
              <Text variant="caption" color="faint" truncate title={showCreateDialog.parentPath}>
                In {showCreateDialog.parentPath}
              </Text>
              <Container layout="horizontal" gap="sm" justifyContent="end">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setShowCreateDialog(null);
                    setNewName('');
                  }}
                >
                  Cancel
                </Button>
                <Button variant="primary" disabled={!newName.trim()} onClick={() => void createItem()}>
                  Create
                </Button>
              </Container>
            </Container>
          </FloatingPanel>
        )}

        {trashConfirm && (
          <FloatingPanel
            open
            onClose={() => {
              if (!trashPendingPath) setTrashConfirm(null);
            }}
            title="Move to Trash?"
          >
            <Container layout="vertical" gap="md" padding="lg">
              <Text variant="body-xs" color="secondary">
                You can restore this item from Trash in Finder.
              </Text>
              <Text variant="caption" color="faint" truncate title={trashConfirm}>
                {trashConfirm}
              </Text>
              <Container layout="horizontal" gap="sm" justifyContent="end">
                <Button variant="secondary" disabled={Boolean(trashPendingPath)} onClick={() => setTrashConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  disabled={Boolean(trashPendingPath)}
                  onClick={() => void trashItem(trashConfirm)}
                >
                  {trashPendingPath ? <Loader2 size={14} className="animate-spin" /> : null}
                  {trashPendingPath ? 'Moving…' : 'Move to Trash'}
                </Button>
              </Container>
            </Container>
          </FloatingPanel>
        )}
      </Container>
    );
  },
);

FileTree.displayName = 'FileTree';

export { FileTree };
export type { FileTreeProps };
