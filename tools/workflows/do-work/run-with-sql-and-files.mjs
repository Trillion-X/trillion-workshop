// tools/workflows/do-work/run-with-sql-and-files.mjs
//
// The same run as run-with-sql.mjs for a row that also reads a copy of a repository from the person's own files (its `files`
// right, on the descriptor the row's invoke.records.fd names): the function is handed `door`, the files door, which opens that
// descriptor on its first call.
//
//   node /opt/workflows/do-work/run-with-sql-and-files.mjs /opt/workflows/read-data/<file>.mjs <export> --files-door-fd N  < { input, task }
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { CONNECTION_DESCRIPTOR, runWithSql } from '../read-data/with-sql.mjs';

const [file, name, flag, fd, ...extra] = process.argv.slice(2);
const descriptor = flag === '--files-door-fd' && /^\d+$/.test(fd ?? '') && extra.length === 0 ? Number(fd) : NaN;
await runWithSql({ file, name, usageOk: !Number.isNaN(descriptor) && descriptor !== CONNECTION_DESCRIPTOR, openDoor: () => openRecordsDoor({ descriptor }) });
