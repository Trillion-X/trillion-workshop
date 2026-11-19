// The page the records default test builds: it imports the records engine and nothing else, and reads one label. With no
// source mounted, the engine's own default (the Workshop Worker's store) must answer it.
import { readSavedLabels } from '../../web/src/workspace/records.ts';

(window as unknown as { readSettled: Promise<unknown> }).readSettled = readSavedLabels(['record-a']).then(
  records => ({ ok: true, records }),
  error => ({ ok: false, error: String(error?.message ?? error) }),
);
