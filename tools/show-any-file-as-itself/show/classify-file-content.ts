// package-set://bitfield-studio/packages/file-content-renderer/show/classify-file-content.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Shared display classification for `FileContentRenderer` consumers. The
// runtime target remains the highest authority when available; extension/MIME
// fallback keeps package tests and offline render paths useful instead of
// collapsing to raw text.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. One classifier helper for file-content-renderer callers
// 2. Runtime `file-classification` target wins when it replies
// 3. Fallback is deterministic and based only on file name/MIME
// 4. No package-specific vocabulary
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export type FileContentRendererKind = 'code' | 'markdown' | 'diff' | 'image' | 'json' | 'raw';

export interface FileContentRendererClassification {
  language: string;
  renderer: FileContentRendererKind;
  icon: string;
  label: string;
  mimeType?: string;
}

export const DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION: FileContentRendererClassification = {
  language: 'text',
  renderer: 'raw',
  icon: 'File',
  label: 'Plain Text',
};

type ClassificationDispatch = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;
let classifyWithOwner: ClassificationDispatch | null = null;
/** Signed-in hosts install their current classification owner; public supplied content stays local. */
export function setFileContentClassificationOwner(dispatch: ClassificationDispatch) { classifyWithOwner = dispatch; }

const FILE_CLASSIFICATION_TARGET = 'file-classification';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'jsx',
  'kt', 'mjs', 'php', 'py', 'rb', 'rs', 'sh', 'sql', 'swift', 'toml', 'ts',
  'tsx', 'xml', 'yaml', 'yml',
]);
const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRenderer(value: unknown): FileContentRendererKind {
  return value === 'code' || value === 'markdown' || value === 'diff' || value === 'image' || value === 'json' || value === 'raw'
    ? value
    : 'raw';
}

function extensionFor(filePath: string): string {
  const clean = filePath.split(/[?#]/)[0] ?? filePath;
  const last = clean.lastIndexOf('.');
  return last >= 0 ? clean.slice(last + 1).toLowerCase() : '';
}

function fallbackMimeType(extension: string, mimeType?: string): string | undefined {
  if (mimeType) return mimeType;
  if (extension === 'html' || extension === 'htm') return 'text/html';
  if (extension === 'xhtml') return 'application/xhtml+xml';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'md' || extension === 'mdx') return 'text/markdown';
  if (extension === 'json') return 'application/json';
  if (extension === 'diff' || extension === 'patch' || extension === 'txt' || extension === 'log' || CODE_EXTENSIONS.has(extension)) return 'text/plain';
  if (IMAGE_EXTENSIONS.has(extension)) return `image/${extension === 'jpg' ? 'jpeg' : extension}`;
  return undefined;
}

function decodeClassification(raw: unknown, fallback: FileContentRendererClassification): FileContentRendererClassification {
  const payload = isRecord(raw) && raw.payload instanceof Uint8Array ? raw.payload : raw;
  const decoded = payload instanceof Uint8Array
    ? JSON.parse(textDecoder.decode(payload)) as unknown
    : payload;
  if (!isRecord(decoded)) return fallback;
  return {
    language: typeof decoded.language === 'string' ? decoded.language : fallback.language,
    renderer: readRenderer(decoded.renderer),
    icon: typeof decoded.icon === 'string' ? decoded.icon : fallback.icon,
    label: typeof decoded.label === 'string' ? decoded.label : fallback.label,
    mimeType: typeof decoded.mime_type === 'string' ? decoded.mime_type : fallback.mimeType,
  };
}

export function fallbackFileContentClassification(
  filePath: string,
  mimeType?: string,
): FileContentRendererClassification {
  const extension = extensionFor(filePath);
  const effectiveMimeType = fallbackMimeType(extension, mimeType);
  if (effectiveMimeType?.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) {
    return { language: extension || 'image', renderer: 'image', icon: 'Image', label: 'Image', mimeType: effectiveMimeType };
  }
  if (extension === 'md' || extension === 'mdx' || effectiveMimeType === 'text/markdown') {
    return { language: 'markdown', renderer: 'markdown', icon: 'FileText', label: 'Markdown', mimeType: effectiveMimeType };
  }
  if (extension === 'json' || effectiveMimeType === 'application/json') {
    return { language: 'json', renderer: 'json', icon: 'FileJson', label: 'JSON', mimeType: effectiveMimeType };
  }
  if (extension === 'diff' || extension === 'patch') {
    return { language: 'diff', renderer: 'diff', icon: 'GitCompare', label: 'Diff', mimeType: effectiveMimeType };
  }
  if (effectiveMimeType?.startsWith('text/') || CODE_EXTENSIONS.has(extension) || extension === 'txt' || extension === 'log') {
    return { language: extension || 'text', renderer: CODE_EXTENSIONS.has(extension) ? 'code' : 'raw', icon: 'FileCode2', label: 'Text', mimeType: effectiveMimeType };
  }
  return { ...DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION, mimeType: effectiveMimeType };
}

export async function classifyFileContent(
  filePath: string,
  mimeType?: string,
): Promise<FileContentRendererClassification> {
  const fallback = fallbackFileContentClassification(filePath, mimeType);
  if (!classifyWithOwner) return fallback;
  try {
    const payload = textEncoder.encode(JSON.stringify({ path: filePath, mime_type: mimeType }));
    const reply = await classifyWithOwner({ target: FILE_CLASSIFICATION_TARGET, payload });
    return decodeClassification(reply, fallback);
  } catch {
    return fallback;
  }
}
