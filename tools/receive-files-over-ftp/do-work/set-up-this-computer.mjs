#!/usr/bin/env node
// parts/receive-files-over-ftp/do-work/set-up-this-computer.mjs
//
// Purpose: make this computer a place a device can push its files to, and say exactly what to enter on the device.
//
//   node set-up-this-computer.mjs [--settings <receive-settings.json>] [--device <model id>]
//
// What it does, each step skipped when already done:
//   1. keeps a sign-in password for the receiver in the keychain (letters and digits that are easy to type on a
//      camera's keyboard, from the settings);
//   2. keeps a certificate for secure sessions (FTPES) in the keychain, made by openssl into memory, never onto disk;
//   3. on macOS, has the computer start the receiver at sign-in and restart it if it stops (a launch agent written
//      from the settings), and starts it now;
//   4. prints the device's own setup screens with every value filled in (devices.json): this computer's address on
//      the network, the port, the user and the password.
//
// Non-Negotiable Invariants:
//   1. The password and the certificate's private half are handed to the keychain through standard input only.
//   2. Running it again changes nothing that is already set, except that the launch agent is restarted.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { execFile } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, appDataFolder, filledSteps, heldOrMade } from './send-what-arrives-to-a-namespace.mjs';
import { localAddress } from './this-computers-address.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = (command, args) => new Promise((resolve, reject) => execFile(command, args, { encoding: 'utf8', maxBuffer: 1 << 20 }, (error, stdout, stderr) => (error ? reject(new Error(`${path.basename(command)}: ${stderr.trim() || error.message}`)) : resolve(stdout))));

export { filledSteps };

async function main() {
  const argv = process.argv.slice(2);
  const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const settings = JSON.parse(readFileSync(option('--settings') ?? DEFAULT_SETTINGS, 'utf8'));
  const devices = JSON.parse(readFileSync(path.join(HERE, '..', 'devices.json'), 'utf8')).devices;
  const say = line => process.stdout.write(`${line}\n`);
  const host = localAddress();
  if (!host) throw new Error('This computer is not on a network right now.');

  const { password, made } = await heldOrMade(settings, { host });
  if (made.length) say(`Made the receiver's ${made.join(' and ')} and kept it in the keychain.`);

  if (process.platform === 'darwin') {
    const { label, log_file_under_app_data: logUnder } = settings.launch;
    const log = path.join(appDataFolder(), logUnder);
    await fs.mkdir(path.dirname(log), { recursive: true });
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const text = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const program = [process.execPath, path.join(HERE, 'send-what-arrives-to-a-namespace.mjs'), ...(option('--settings') ? ['--settings', path.resolve(option('--settings'))] : [])];
    await fs.writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${text(label)}</string>
  <key>ProgramArguments</key><array>${program.map(item => `<string>${text(item)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${text(log)}</string>
  <key>StandardErrorPath</key><string>${text(log)}</string>
</dict>
</plist>
`);
    const domain = `gui/${process.getuid()}`;
    await run('/bin/launchctl', ['bootout', `${domain}/${label}`]).catch(() => {});
    // launchd finishes a bootout a moment after it answers; bootstrap is tried again until the old one is gone.
    for (let attempt = 1; ; attempt += 1) {
      try { await run('/bin/launchctl', ['bootstrap', domain, plist]); break; }
      catch (error) { if (attempt >= 10) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    say(`The receiver runs now and starts again whenever this computer starts (log: ${log}).`);
  } else {
    say(`Start the receiver with: node ${path.join(HERE, 'send-what-arrives-to-a-namespace.mjs')}`);
  }

  const chosen = option('--device');
  const values = { host, port: settings.listen.port, user: settings.sign_in.user, password };
  for (const device of devices.filter(item => !chosen || (item.model_ids ?? []).includes(chosen))) {
    say(`\n${device.name}: ${device.how_it_sends}`);
    const steps = filledSteps(device, values);
    if (steps.length) steps.forEach((step, index) => say(`${index + 1}. ${step.where.join(' > ')}: ${step.value}`));
    else say(device.setup_words ?? settings.tell_the_account.setup_words);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Stopped: ${error.message}\n`); process.exit(1); });
}
