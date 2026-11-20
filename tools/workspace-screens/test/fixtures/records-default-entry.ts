// The page the records no-source test builds: it imports the records engine and nothing else, mounts no source, and reads
// one label. The read must fail with the engine's plain words, and nothing may leave the page.
import { readSavedLabels } from '../../web/src/workspace/records.ts';

(window as unknown as { readSettled: Promise<unknown> }).readSettled = readSavedLabels(['record-a']).then(
  records => ({ ok: true, records }),
  error => ({ ok: false, error: String(error?.message ?? error) }),
);
