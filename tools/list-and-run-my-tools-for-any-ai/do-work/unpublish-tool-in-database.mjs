import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/list-and-run-my-tools-for-any-ai/do-work/unpublish-tool-in-database.mjs
//
// tool:unpublish-tool, one container process (what-this-tool-does-and-how-to-run-it.json): withdraws one listing from the database the request names. The
// connection and the request are read as tool:publish-tool's are (publish-tool-in-database.mjs); the withdrawal rules are unpublishTool's.
import { unpublishTool } from './publish-tool.mjs';
import { runInDatabase } from './publish-tool-in-database.mjs';

export async function main() {
  return runInDatabase(unpublishTool);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().then(answer => console.log(JSON.stringify(answer))).catch(error => {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
