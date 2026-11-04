// packages/group/read-data/board-output-targets.ts
//
// WHERE an exported board artifact goes — user-extensible DATA (the R19 egress seam).
// The browser anchor-download is dead inside the macOS WKWebView presenter, so board
// exports need a real egress: a catalog of OUTPUT TARGETS, each row naming the engine
// target that owns the actual file write. This is the sales-contract-builder
// output-target contract applied to boards: destinations are self-describing DATA rows,
// the surface stays blind and sends ONE envelope (see do-work/request-board-output.ts
// for the envelope grammars). Adding a destination — a project folder, a workflow-owner
// delivery — is ONE published-record DATA row, zero panel code (L069/L090/mergeCatalog).

import { mergeCatalog } from './catalog-merge';

// ---- untrusted-DATA caps (a target row is a label + an address, never a document) ----
const MAX_ID = 200;
const MAX_LABEL = 200;
const MAX_TARGET = 400;
const MAX_DEFINITION_ID = 400;
const MAX_DIR = 1024;
const capStr = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);

/** How a delivery envelope reaches the destination. The row declares WHICH grammar by
 *  what it carries (L090 — self-describing data, the reader never enumerates kinds):
 *  `definitionId` present → the target is a workflow owner (execute_definition envelope);
 *  absent → the target is the process runner (file-save protocol), writing into
 *  `destinationDir` when given, else the user's download folder. */
export interface BoardOutputRoute {
  /** The engine target the delivery envelope is sent to. */
  readonly target: string;
  /** Present → dispatch an execute_definition envelope with this workflow action id. */
  readonly definitionId?: string;
  /** For a process file-save route: the absolute folder to write into. */
  readonly destinationDir?: string;
  /** Explicit native copy protocol; enable only when that operation is installed. */
  readonly fileOperation?: 'write_new_file';
}

/** One destination the user can send an exported board artifact to. */
export interface BoardOutputTargetDescriptor {
  /** Stable id stored in DATA rows and menu values (never the label). */
  readonly id: string;
  /** Human label shown in the export menu ("Downloads", "Project folder", ...). */
  readonly label: string;
  readonly route: BoardOutputRoute;
}

/** The `payload.kind` a published-record uses to carry output-target DATA rows. */
export const OUTPUT_TARGET_CATALOG_KIND = 'output-target-catalog';

/** The builtin destination: the user's download folder, written by the process runner
 *  (the same engine contract structured-file-output proved). Always present, so every
 *  export has a working egress even with zero DATA rows. */
export const BOARD_OUTPUT_TARGETS: readonly BoardOutputTargetDescriptor[] = [
  { id: 'downloads', label: 'Downloads', route: { target: 'compute.process' } },
];

function parseRoute(value: unknown): BoardOutputRoute | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const target = typeof row.target === 'string' ? capStr(row.target.trim(), MAX_TARGET) : '';
  if (!target) return null;
  const definitionId = typeof row.definition_id === 'string' && row.definition_id.trim().length > 0
    ? capStr(row.definition_id.trim(), MAX_DEFINITION_ID)
    : typeof row.definitionId === 'string' && row.definitionId.trim().length > 0
      ? capStr(row.definitionId.trim(), MAX_DEFINITION_ID)
      : undefined;
  const rawDir = typeof row.destination_dir === 'string' ? row.destination_dir
    : typeof row.destinationDir === 'string' ? row.destinationDir
      : '';
  // A relative destination cannot name a real folder — the save script requires an
  // absolute path, so a non-absolute dir invalidates the whole row (fail-closed).
  const dir = capStr(rawDir.trim(), MAX_DIR);
  if (dir && !dir.startsWith('/')) return null;
  const fileOperation = row.file_operation ?? row.fileOperation;
  if (fileOperation !== undefined && (fileOperation !== 'write_new_file' || target !== 'local.files' || definitionId)) return null;
  return {
    target,
    ...(fileOperation === 'write_new_file' ? { fileOperation } as const : {}),
    ...(definitionId ? { definitionId } : {}),
    ...(dir ? { destinationDir: dir } : {}),
  };
}

function parseTargetRow(row: Record<string, unknown>): BoardOutputTargetDescriptor | null {
  const id = typeof row.id === 'string' ? capStr(row.id.trim(), MAX_ID) : '';
  const label = typeof row.label === 'string' ? capStr(row.label.trim(), MAX_LABEL) : '';
  const route = parseRoute(row.route);
  if (!id || !label || !route) return null;
  return { id, label, route };
}

/** The effective destination catalog: the builtin Downloads row overlaid with
 *  well-formed `output-target-catalog` DATA rows (override-by-id, else append). */
export function readBoardOutputTargets(
  records: ReadonlyArray<{ payload?: unknown }>,
): BoardOutputTargetDescriptor[] {
  return mergeCatalog(records, {
    kind: OUTPUT_TARGET_CATALOG_KIND,
    arrayKey: 'targets',
    idOf: (target: BoardOutputTargetDescriptor) => target.id,
    parseRow: parseTargetRow,
    builtins: BOARD_OUTPUT_TARGETS,
  });
}
