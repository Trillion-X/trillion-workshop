// The one place Better Auth's email callbacks go. settings.json `email` says where a message goes: `command` (an argv array) gets
// the message as JSON on stdin; with no command it is appended to the `outbox` file. No email vendor is named here.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function emailHook(email) {
  return async message => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...message });
    if (!Array.isArray(email?.command) || !email.command.length) {
      mkdirSync(dirname(email.outbox), { recursive: true });
      appendFileSync(email.outbox, `${line}\n`);
      return;
    }
    await new Promise((resolve, reject) => {
      const child = spawn(email.command[0], email.command.slice(1), { stdio: ['pipe', 'inherit', 'inherit'] });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`email command exited ${code}`))));
      child.stdin.end(line);
    });
  };
}
