// The real documents-words.json, read as a module (upload.ts imports it without an import attribute).
import { readFileSync } from 'node:fs';
export default JSON.parse(readFileSync(new URL('../../../workspace-screens/web/src/workspace/documents-words.json', import.meta.url), 'utf8'));
