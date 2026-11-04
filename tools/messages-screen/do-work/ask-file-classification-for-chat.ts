// PORTED FROM: bitfield-packages/packages/chat/do-work/ask-file-classification-for-chat.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION,
  type FileContentRendererClassification,
  type FileContentRendererKind,
} from '../../file-content-renderer/show/FileContentRenderer';

const FILE_CLASSIFICATION_TARGET = 'file-classification';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRenderer(value: unknown): FileContentRendererKind {
  return value === 'code' || value === 'markdown' || value === 'diff' || value === 'image' || value === 'json' || value === 'raw'
    ? value
    : 'raw';
}

function decodeClassification(raw: unknown): FileContentRendererClassification {
  const payload = isRecord(raw) && raw.payload instanceof Uint8Array ? raw.payload : raw;
  const decoded = payload instanceof Uint8Array
    ? JSON.parse(textDecoder.decode(payload)) as unknown
    : payload;
  if (!isRecord(decoded)) return DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION;
  return {
    language: typeof decoded.language === 'string' ? decoded.language : DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION.language,
    renderer: readRenderer(decoded.renderer),
    icon: typeof decoded.icon === 'string' ? decoded.icon : DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION.icon,
    label: typeof decoded.label === 'string' ? decoded.label : DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION.label,
    mimeType: typeof decoded.mime_type === 'string' ? decoded.mime_type : undefined,
  };
}

export async function askFileClassificationForChat(filePath: string): Promise<FileContentRendererClassification> {
  const payload = textEncoder.encode(JSON.stringify({ path: filePath }));
  const reply = await sendRequestToBitfieldTarget({ target: FILE_CLASSIFICATION_TARGET, payload });
  return decodeClassification(reply);
}
