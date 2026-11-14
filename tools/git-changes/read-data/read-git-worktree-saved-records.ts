import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const FIND_CURRENT_ITEMS_TARGET = 'slot::find-current-items';
const KNOWLEDGE_GIT_WORKTREE_KIND = 'type:knowledge_git_worktree';
const KNOWLEDGE_GIT_CHANGE_KIND = 'type:knowledge_git_change';
const textDecoder = new TextDecoder();

export interface GitWorktreeCurrentItem {
  recordId: string;
  projectId: string;
  projectName: string;
  latestScanId: string;
  branch: string;
  ahead: number;
  behind: number;
  refreshedAt: string | null;
}

export interface GitChangeCurrentItem {
  recordId: string;
  scanId: string;
  projectId: string;
  projectName: string;
  filePath: string;
  bucket: string;
  status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array');
}

function decodeReplyPayload(reply: unknown): unknown {
  const payload = isRecord(reply) && isBytes(reply.payload) ? reply.payload : reply;
  if (!isBytes(payload)) return payload;
  const text = textDecoder.decode(payload).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readCurrentItemRows(reply: unknown): Record<string, unknown>[] {
  const decoded = decodeReplyPayload(reply);
  if (Array.isArray(decoded)) {
    return decoded.filter(isRecord);
  }
  if (!isRecord(decoded)) return [];
  const items = decoded.items;
  return Array.isArray(items) ? items.filter(isRecord) : [];
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readRecordId(row: Record<string, unknown>): string {
  for (const key of ['record_id', 'recordId', 'id', 'address']) {
    if (typeof row[key] === 'string' && row[key].length > 0) return row[key] as string;
  }
  return '';
}

export function decodeGitWorktreeCurrentItems(reply: unknown): GitWorktreeCurrentItem[] {
  return readCurrentItemRows(reply)
    .map((row) => ({
      recordId: readRecordId(row),
      projectId: readText(row.project_id),
      projectName: readText(row.project_name),
      latestScanId: readText(row.latest_scan_id),
      branch: readText(row.branch) || 'HEAD',
      ahead: readNumber(row.ahead),
      behind: readNumber(row.behind),
      refreshedAt: readOptionalText(row.refreshed_at),
    }))
    .filter((row) => row.recordId.length > 0 && row.projectId.length > 0 && row.latestScanId.length > 0)
    .sort((left, right) => left.projectName.localeCompare(right.projectName));
}

export function decodeGitChangeCurrentItems(reply: unknown): GitChangeCurrentItem[] {
  return readCurrentItemRows(reply)
    .map((row) => ({
      recordId: readRecordId(row),
      scanId: readText(row.scan_id),
      projectId: readText(row.project_id),
      projectName: readText(row.project_name),
      filePath: readText(row.file_path),
      bucket: readText(row.bucket) || 'unstaged',
      status: readText(row.status) || '?',
    }))
    .filter((row) => row.recordId.length > 0 && row.projectId.length > 0 && row.scanId.length > 0 && row.filePath.length > 0)
    .sort((left, right) => (
      ({ staged: 0, unstaged: 1, untracked: 2 } as Record<string, number>)[left.bucket] ?? 3
    ) - (({ staged: 0, unstaged: 1, untracked: 2 } as Record<string, number>)[right.bucket] ?? 3)
      || left.filePath.localeCompare(right.filePath)
      || left.status.localeCompare(right.status)
    );
}

export async function readGitWorktreeCurrentItems(
  signal?: AbortSignal,
): Promise<GitWorktreeCurrentItem[]> {
  const reply = await sendRequestToBitfieldTarget({
    target: FIND_CURRENT_ITEMS_TARGET,
    payload: {
      operation: 'find-current-items',
      in: KNOWLEDGE_GIT_WORKTREE_KIND,
      select: [
        'record_id',
        'project_id',
        'project_name',
        'latest_scan_id',
        'branch',
        'ahead',
        'behind',
        'refreshed_at',
      ],
    },
  }, signal);
  return decodeGitWorktreeCurrentItems(reply);
}

export async function readGitChangeCurrentItems(
  signal?: AbortSignal,
): Promise<GitChangeCurrentItem[]> {
  const reply = await sendRequestToBitfieldTarget({
    target: FIND_CURRENT_ITEMS_TARGET,
    payload: {
      operation: 'find-current-items',
      in: KNOWLEDGE_GIT_CHANGE_KIND,
      select: [
        'record_id',
        'scan_id',
        'project_id',
        'project_name',
        'file_path',
        'bucket',
        'status',
      ],
    },
  }, signal);
  return decodeGitChangeCurrentItems(reply);
}
