// PORTED FROM: bitfield-packages/packages/chat/show/tool-registry.ts @ e99ac5976
// frontends/web/src/packages/chat/read-data/tool-registry.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Static registry mapping tool names to metadata (icon, label, subtitle formatter,
// color variant, renderer type). This is the SINGLE SOURCE OF TRUTH for tool
// categorization and dispatch. Replaces the 4-category system in ToolUseBlock.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Tool metadata is immutable — no runtime mutations
// 2. Subtitle extractors are pure functions (params => string)
// 3. Unknown tools fall back to generic with tool name as label
// 4. Renderer types directly control body component dispatch
// 5. Color variants are exhaustive: 'subtle' | 'success' | 'warning' | 'accent'
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { LucideIcon } from 'lucide-react';
import {
  FileText,
  FileCheck,
  Search,
  Terminal,
  Wrench,
  Globe,
  Code,
  FolderSearch,
  Notebook,
} from 'lucide-react';
import type { ToolUseInfo } from '../read-data/chat-message-types';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/** Renderer type determines which component renders the tool result body. */
export type RendererType = 'diff' | 'code' | 'terminal' | 'search' | 'generic';

/** Color variant for tool badge and header. */
export type ToolColorVariant = 'subtle' | 'success' | 'warning' | 'accent';

/** Metadata for a tool type. */
export interface ToolMeta {
  /** Lucide icon component */
  icon: LucideIcon;
  /** Display label shown in badge */
  label: string;
  /** Extract subtitle from params (e.g., filename from path) */
  subtitle: (params: Record<string, unknown>) => string;
  /** Color variant for badge styling */
  colorVariant: ToolColorVariant;
  /** Which renderer component handles the result body */
  rendererType: RendererType;
  /** Extract a short result summary for collapsed header badge (e.g., "12 files") */
  resultSummary?: (params: Record<string, unknown>, result: string) => string | null;
  /** Extract a file path from params for reveal-in-Finder action */
  filePath?: (params: Record<string, unknown>) => string | null;
}

// ---------------------------------------------------------------------------
// HELPER FUNCTIONS
// ---------------------------------------------------------------------------

/** Extract filename from file_path param (last component after '/') */
function extractFilename(params: Record<string, unknown>): string {
  const filePath = String(params.file_path ?? '');
  return filePath.split('/').pop() ?? '';
}

/** Truncate a string with ellipsis if it exceeds maxLen */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

/** Count newlines to estimate line count from string content */
function countLines(s: string): number {
  if (!s) return 0;
  return (s.match(/\n/g) ?? []).length + 1;
}

// ---------------------------------------------------------------------------
// FILE PATH EXTRACTOR
// ---------------------------------------------------------------------------

/** Extract file path from params that use `file_path`, `path`, or `notebook_path`. */
function extractFilePathParam(params: Record<string, unknown>): string | null {
  const raw = params.file_path ?? params.notebook_path ?? params.path;
  if (typeof raw === 'string' && raw.startsWith('/')) return raw;
  return null;
}

function stringParam(params: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

export function hasPatchLikePayload(params: Record<string, unknown>): boolean {
  if (typeof params.old_string === 'string' && typeof params.new_string === 'string') return true;
  if (typeof params.content === 'string' && (typeof params.file_path === 'string' || typeof params.path === 'string')) return true;

  const patchText = stringParam(params, ['patch', 'diff', 'input', 'raw']);
  if (!patchText) return false;
  const trimmed = patchText.trimStart();
  return trimmed.startsWith('*** Begin Patch')
    || trimmed.startsWith('diff --git ')
    || trimmed.includes('\n@@');
}

// ---------------------------------------------------------------------------
// RESULT SUMMARY FORMATTERS
// ---------------------------------------------------------------------------

/** Grep: count matches/files based on output_mode. */
function grepResultSummary(_params: Record<string, unknown>, result: string): string | null {
  if (!result) return null;
  const lines = result.split('\n').filter(Boolean);
  const outputMode = String(_params.output_mode ?? 'files_with_matches');
  if (outputMode === 'count') {
    const total = lines.reduce((sum, l) => {
      const m = l.match(/:(\d+)$/);
      return sum + (m ? Number(m[1]) : 0);
    }, 0);
    return total > 0 ? `${total} matches` : null;
  }
  if (outputMode === 'content') {
    return lines.length > 0 ? `${lines.length} lines` : null;
  }
  // files_with_matches (default)
  return lines.length > 0 ? `${lines.length} files` : null;
}

/** Glob: count matching file paths. */
function globResultSummary(_params: Record<string, unknown>, result: string): string | null {
  if (!result) return null;
  const lines = result.split('\n').filter(Boolean);
  return lines.length > 0 ? `${lines.length} files` : null;
}

/** Bash: line count when result is long. */
function bashResultSummary(_params: Record<string, unknown>, result: string): string | null {
  if (!result) return null;
  const lines = result.split('\n').length;
  return lines > 3 ? `${lines} lines` : null;
}

/** Read: line count of returned content. */
function readResultSummary(_params: Record<string, unknown>, result: string): string | null {
  if (!result) return null;
  const lines = result.split('\n').length;
  return lines > 0 ? `${lines} lines` : null;
}

// ---------------------------------------------------------------------------
// RICH SUBTITLE FORMATTERS
// ---------------------------------------------------------------------------

/** Edit: "filename — X → Y lines" */
function editSubtitle(params: Record<string, unknown>): string {
  const filename = extractFilename(params);
  const oldStr = String(params.old_string ?? '');
  const newStr = String(params.new_string ?? '');
  if (oldStr || newStr) {
    const oldLines = countLines(oldStr);
    const newLines = countLines(newStr);
    return filename ? `${filename} — ${oldLines} → ${newLines} lines` : `${oldLines} → ${newLines} lines`;
  }
  return filename;
}

/** Write: "filename — N lines" */
function writeSubtitle(params: Record<string, unknown>): string {
  const filename = extractFilename(params);
  const content = String(params.content ?? '');
  if (content) {
    const lines = countLines(content);
    return filename ? `${filename} — ${lines} lines` : `${lines} lines`;
  }
  return filename;
}

/** Read: "filename — lines 123-456" or "filename" for full file */
function readSubtitle(params: Record<string, unknown>): string {
  const filename = extractFilename(params);
  const offset = params.offset !== undefined ? Number(params.offset) : null;
  const limit = params.limit !== undefined ? Number(params.limit) : null;
  if (offset !== null && limit !== null) {
    return filename ? `${filename} — lines ${offset}–${offset + limit - 1}` : `lines ${offset}–${offset + limit - 1}`;
  }
  if (offset !== null) {
    return filename ? `${filename} — from line ${offset}` : `from line ${offset}`;
  }
  return filename;
}

/** Bash: description if available, otherwise first 60 chars of command */
function bashSubtitle(params: Record<string, unknown>): string {
  const description = String(params.description ?? '');
  if (description) return truncate(description, 60);
  const cmd = String(params.command ?? '');
  return truncate(cmd, 60);
}

/** Grep: '"pattern" in path' with type/glob context */
function grepSubtitle(params: Record<string, unknown>): string {
  const pattern = truncate(String(params.pattern ?? ''), 30);
  const path = String(params.path ?? '');
  const glob = String(params.glob ?? '');
  const type = String(params.type ?? '');
  const location = glob || type || (path ? path.split('/').pop() ?? '' : '');
  if (pattern && location) return `"${pattern}" in ${location}`;
  if (pattern) return `"${pattern}"`;
  return location;
}

/** Glob: show the pattern string */
function globSubtitle(params: Record<string, unknown>): string {
  return truncate(String(params.pattern ?? ''), 50);
}

/** WebSearch: query truncated to 50 chars */
function webSearchSubtitle(params: Record<string, unknown>): string {
  return truncate(String(params.query ?? ''), 50);
}

/** WebFetch: URL truncated to 50 chars */
function webFetchSubtitle(params: Record<string, unknown>): string {
  return truncate(String(params.url ?? ''), 50);
}

/** Task: description or first 40 chars of prompt */
function taskSubtitle(params: Record<string, unknown>): string {
  const desc = String(params.description ?? params.prompt ?? '');
  return truncate(desc, 40);
}

/** NotebookEdit: notebook filename + cell number */
function notebookEditSubtitle(params: Record<string, unknown>): string {
  const filename = extractFilename(params);
  const cellNumber = params.cell_number !== undefined ? `cell ${params.cell_number}` : '';
  if (filename && cellNumber) return `${filename} — ${cellNumber}`;
  return filename || cellNumber;
}

/** Skill: skill name */
function skillSubtitle(params: Record<string, unknown>): string {
  return truncate(String(params.skill ?? params.name ?? ''), 40);
}

/** ExitPlanMode: first markdown heading from `plan` payload, if present */
function exitPlanSubtitle(params: Record<string, unknown>): string {
  const plan = String(params.plan ?? '');
  if (!plan) return 'Final plan ready';
  const headingMatch = /^#\s+(.+)$/m.exec(plan);
  if (headingMatch?.[1]) return truncate(headingMatch[1].trim(), 60);
  return 'Final plan ready';
}

// ---------------------------------------------------------------------------
// TOOL REGISTRY
// ---------------------------------------------------------------------------

const REGISTRY: Record<string, ToolMeta> = {
  // =========================================================================
  // FILE TOOLS (blue/subtle)
  // =========================================================================

  Edit: {
    icon: FileText,
    label: 'Edit',
    subtitle: editSubtitle,
    colorVariant: 'subtle',
    rendererType: 'diff',
    filePath: extractFilePathParam,
  },

  Write: {
    icon: FileText,
    label: 'Write',
    subtitle: writeSubtitle,
    colorVariant: 'subtle',
    rendererType: 'diff',
    filePath: extractFilePathParam,
  },

  Read: {
    icon: Code,
    label: 'Read',
    subtitle: readSubtitle,
    colorVariant: 'subtle',
    rendererType: 'code',
    resultSummary: readResultSummary,
    filePath: extractFilePathParam,
  },

  NotebookEdit: {
    icon: Notebook,
    label: 'NotebookEdit',
    subtitle: notebookEditSubtitle,
    colorVariant: 'subtle',
    rendererType: 'diff',
    filePath: extractFilePathParam,
  },

  // =========================================================================
  // SEARCH TOOLS (emerald/success)
  // =========================================================================

  Grep: {
    icon: Search,
    label: 'Grep',
    subtitle: grepSubtitle,
    colorVariant: 'success',
    rendererType: 'search',
    resultSummary: grepResultSummary,
  },

  Glob: {
    icon: FolderSearch,
    label: 'Glob',
    subtitle: globSubtitle,
    colorVariant: 'success',
    rendererType: 'code',
    resultSummary: globResultSummary,
  },

  // =========================================================================
  // SHELL TOOLS (yellow/warning)
  // =========================================================================

  Bash: {
    icon: Terminal,
    label: 'Bash',
    subtitle: bashSubtitle,
    colorVariant: 'warning',
    rendererType: 'terminal',
    resultSummary: bashResultSummary,
  },

  // =========================================================================
  // WEB TOOLS (accent/blue)
  // =========================================================================

  WebSearch: {
    icon: Globe,
    label: 'WebSearch',
    subtitle: webSearchSubtitle,
    colorVariant: 'accent',
    rendererType: 'generic',
  },

  WebFetch: {
    icon: Globe,
    label: 'WebFetch',
    subtitle: webFetchSubtitle,
    colorVariant: 'accent',
    rendererType: 'generic',
  },

  // =========================================================================
  // ORCHESTRATION TOOLS (muted/subtle)
  // =========================================================================

  Task: {
    icon: Wrench,
    label: 'Task',
    subtitle: taskSubtitle,
    colorVariant: 'subtle',
    rendererType: 'generic',
  },

  // =========================================================================
  // OTHER TOOLS (fallback to generic)
  // =========================================================================

  Skill: {
    icon: Wrench,
    label: 'Skill',
    subtitle: skillSubtitle,
    colorVariant: 'subtle',
    rendererType: 'generic',
  },

  SendMessage: {
    icon: Wrench,
    label: 'SendMessage',
    subtitle: (params) => truncate(String(params.recipient ?? params.content ?? ''), 40),
    colorVariant: 'subtle',
    rendererType: 'generic',
  },

  ExitPlanMode: {
    icon: FileCheck,
    label: 'Plan Ready',
    subtitle: exitPlanSubtitle,
    colorVariant: 'success',
    rendererType: 'generic',
  },

  TaskCreate: {
    icon: Wrench,
    label: 'TaskCreate',
    subtitle: (params) => truncate(String(params.subject ?? ''), 40),
    colorVariant: 'subtle',
    rendererType: 'generic',
  },

  TaskUpdate: {
    icon: Wrench,
    label: 'TaskUpdate',
    subtitle: (params) => truncate(String(params.taskId ?? ''), 40),
    colorVariant: 'subtle',
    rendererType: 'generic',
  },

  TaskList: {
    icon: Wrench,
    label: 'TaskList',
    subtitle: () => '',
    colorVariant: 'subtle',
    rendererType: 'generic',
  },

  TaskGet: {
    icon: Wrench,
    label: 'TaskGet',
    subtitle: (params) => truncate(String(params.taskId ?? ''), 40),
    colorVariant: 'subtle',
    rendererType: 'generic',
  },
};

// ---------------------------------------------------------------------------
// FALLBACK FOR UNKNOWN TOOLS
// ---------------------------------------------------------------------------

// FALLBACK is command-aware so ANY tool whose params carry a shell `command`
// (an unknown / dynamically-published tool — e.g. the live guarded-process tool)
// gets the same rich treatment as Bash: the command as subtitle and a line-count
// result summary. This is a self-describing-data rule (L090), not a hardcoded tool
// name — a new command-bearing tool needs ZERO registry entry to render richly.
const FALLBACK: ToolMeta = {
  icon: Wrench,
  label: 'Tool',
  subtitle: (params) => truncate(String(params.command ?? params.description ?? params.query ?? ''), 60),
  colorVariant: 'subtle',
  rendererType: 'generic',
  resultSummary: (_params, result) => {
    if (!result) return null;
    const lines = result.split('\n').length;
    return lines > 3 ? `${lines} lines` : null;
  },
};

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Get metadata for a tool by name.
 * Returns registry entry if found, otherwise returns fallback with tool name as label.
 */
export function getToolMeta(toolName: string): ToolMeta {
  if (toolName in REGISTRY) {
    return REGISTRY[toolName];
  }
  // Unknown tool: use fallback but with the actual tool name as label
  return {
    ...FALLBACK,
    label: toolName,
  };
}

export function inferToolRendererType(toolUse: ToolUseInfo): RendererType {
  if (hasPatchLikePayload(toolUse.params)) return 'diff';
  // A tool call carrying a shell `command` is a process/terminal run regardless of
  // its display name — render its output in the terminal view (L090 payload-shape
  // rule). This is what makes the live guarded-process tool look like an imported
  // Bash block without the chat hardcoding the name "Bash".
  const command = toolUse.params?.command;
  if (typeof command === 'string' && command.trim()) return 'terminal';
  return getToolMeta(toolUse.tool).rendererType;
}
