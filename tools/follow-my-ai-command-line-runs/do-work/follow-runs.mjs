// tools/follow-my-ai-command-line-runs/do-work/follow-runs.mjs
//
// The command line of this folder. The allow-list verbs are moved from Trillion-X/trillion harness/wake-sessions.mjs
// (its --allow-tools / --tools / --clear-tools branch); --events reads one command line's stream on standard input.
//
//   node do-work/follow-runs.mjs --allow-tools <folder> <Tool,Tool>   keep the tools the person allows in that folder
//   node do-work/follow-runs.mjs --tools [folder]                      read them (every folder's without one)
//   node do-work/follow-runs.mjs --clear-tools <folder>                take the list away
//   node do-work/follow-runs.mjs --events <harness id> < stream        the run's normalised events, one JSON per line
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { helperSettings as settings } from './computer-settings.mjs';
import { clearWorkspaceTools, eventsOfLine, lineSplitter, setWorkspaceTools, workspaceTools } from './session-runs.mjs';

const isEntryScript = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };

if (isEntryScript()) {
  try {
    const toolsFlag = ['--allow-tools', '--tools', '--clear-tools'].find(flag => process.argv.includes(flag));
    if (toolsFlag) {
      const [folder, tools] = process.argv.slice(process.argv.indexOf(toolsFlag) + 1);
      const answer = toolsFlag === '--allow-tools' ? setWorkspaceTools(settings, folder, tools)
        : toolsFlag === '--clear-tools' ? clearWorkspaceTools(settings, folder)
        : folder ? { folder, tools: workspaceTools(settings, folder) } : { workspace_tools: workspaceTools(settings) };
      process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`); process.exit(0);
    }
    const events = process.argv.indexOf('--events');
    if (events > 0) {
      const id = process.argv[events + 1];
      const stream = settings.harnesses[id]?.stream;
      if (!stream) throw new Error(`No command line ${JSON.stringify(id)} has a stream row. Known: ${Object.keys(settings.harnesses).join(', ')}.`);
      const lines = lineSplitter(line => { for (const event of eventsOfLine(stream, line)) process.stdout.write(`${JSON.stringify(event)}\n`); });
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) lines.push(chunk);
      lines.end();
      process.exit(0);
    }
    throw new Error('Name --allow-tools <folder> <Tool,Tool>, --tools [folder], --clear-tools <folder> or --events <harness id>.');
  } catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exit(2); }
}
