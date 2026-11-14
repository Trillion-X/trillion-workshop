import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const FILE_CLASSIFICATION_TARGET = 'file-classification';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function askFileEditorLanguage(filePath: string): Promise<string> {
  const payload = textEncoder.encode(JSON.stringify({ path: filePath }));
  const reply = await sendRequestToBitfieldTarget({ target: FILE_CLASSIFICATION_TARGET, payload });
  const rawPayload = isRecord(reply) && reply.payload instanceof Uint8Array ? reply.payload : reply;
  const decoded = rawPayload instanceof Uint8Array
    ? JSON.parse(textDecoder.decode(rawPayload)) as unknown
    : rawPayload;
  return isRecord(decoded) && typeof decoded.language === 'string' ? decoded.language : 'text';
}
