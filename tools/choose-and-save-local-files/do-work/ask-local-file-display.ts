import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export interface LocalFileDisplay {
  icon: string;
  label: string;
}

const FILE_CLASSIFICATION_TARGET = 'file-classification';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function askLocalFileDisplay(filePath: string): Promise<LocalFileDisplay> {
  const payload = textEncoder.encode(JSON.stringify({ path: filePath }));
  const reply = await sendRequestToBitfieldTarget({ target: FILE_CLASSIFICATION_TARGET, payload });
  const rawPayload = isRecord(reply) && reply.payload instanceof Uint8Array ? reply.payload : reply;
  const decoded = rawPayload instanceof Uint8Array
    ? JSON.parse(textDecoder.decode(rawPayload)) as unknown
    : rawPayload;
  if (!isRecord(decoded)) return { icon: 'File', label: 'File' };
  return {
    icon: typeof decoded.icon === 'string' ? decoded.icon : 'File',
    label: typeof decoded.label === 'string' ? decoded.label : 'File',
  };
}
