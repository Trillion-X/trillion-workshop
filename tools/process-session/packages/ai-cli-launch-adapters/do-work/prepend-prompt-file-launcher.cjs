#!/usr/bin/env node

const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function buildWrappedLaunch(args, readFile = readFileSync) {
  const separator = args.indexOf('--');
  if (separator < 0 || separator === args.length - 1) {
    throw new Error('prepend launcher requires `-- <command> [args...]`');
  }
  const controls = args.slice(0, separator);
  const promptFile = valueAfter(controls, '--prompt-file');
  const promptArgIndexText = valueAfter(controls, '--prompt-arg-index');
  const promptArgIndex = Number.parseInt(promptArgIndexText ?? '', 10);
  if (!promptFile) throw new Error('prepend launcher requires --prompt-file');
  if (!Number.isInteger(promptArgIndex) || promptArgIndex < 1) {
    throw new Error('prepend launcher requires --prompt-arg-index at or after argv[1]');
  }

  const wrapped = args.slice(separator + 1);
  const command = wrapped[0];
  const commandArgs = wrapped.slice(1);
  if (promptArgIndex >= wrapped.length) {
    throw new Error(`prepend launcher prompt index ${promptArgIndex} exceeds wrapped argv length ${wrapped.length}`);
  }
  commandArgs[promptArgIndex - 1] = `${readFile(promptFile, 'utf8')}\n\n${wrapped[promptArgIndex]}`;
  return { command, args: commandArgs };
}

function run(args = process.argv.slice(2), deps = {}) {
  const launch = buildWrappedLaunch(args, deps.readFileSync ?? readFileSync);
  const spawnImpl = deps.spawn ?? spawn;
  const child = spawnImpl(launch.command, launch.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => {
    process.stderr.write(`[prepend-prompt-file-launcher] ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  return child;
}

module.exports = { buildWrappedLaunch, run };

if (require.main === module) run();
