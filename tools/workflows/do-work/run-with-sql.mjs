// tools/workflows/do-work/run-with-sql.mjs
//
// The command a workflows row runs when its tool keeps rows in the person's own Postgres and reads nothing from the person's
// files: it imports the module the row names, calls the export the row names with the run's stdin and prints { result } (or
// { error }) as its last line. How the run works, and what the function is handed, is read-data/with-sql.mjs.
//
//   node /opt/workflows/do-work/run-with-sql.mjs /opt/workflows/read-data/<file>.mjs <export>  < { input, task }
import { runWithSql } from '../read-data/with-sql.mjs';

const [file, name, ...extra] = process.argv.slice(2);
await runWithSql({ file, name, usageOk: extra.length === 0 });
