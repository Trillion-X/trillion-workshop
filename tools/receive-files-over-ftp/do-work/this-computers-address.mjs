// parts/receive-files-over-ftp/do-work/this-computers-address.mjs
//
// Purpose: the address a device on the same network reaches this computer at, and a certificate for secure sessions
// that names that address, so the receiver can follow this computer when the network hands it a new address.
//
// Non-Negotiable Invariants:
//   1. A certificate is made by openssl into memory (stdout), never onto disk; its private half goes only to the
//      caller, who keeps it in the keychain. openssl is pointed at no output file at all (not /dev/stdout, which a
//      place cannot reopen when its output is a socket, as Node's is on Linux) and at ../certificate-request.cnf, which
//      names no key file, so every openssl writes both halves to its output.
//   2. The address is read from this computer's interfaces each time it is asked for, never remembered.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUEST_SETTINGS = fileURLToPath(new URL('../certificate-request.cnf', import.meta.url));

const run = (command, args) => new Promise((resolve, reject) => execFile(command, args, { encoding: 'utf8', maxBuffer: 1 << 20 }, (error, stdout, stderr) => (error ? reject(new Error(`${path.basename(command)}: ${stderr.trim() || error.message}`)) : resolve(stdout))));

/** This computer's address on its local network: the first private IPv4 address of an interface that is up. */
export function localAddress(interfaces = os.networkInterfaces()) {
  const addresses = Object.values(interfaces).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => item.address);
  return addresses.find(address => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) ?? addresses[0] ?? null;
}

/** The PEM blocks openssl printed, by their label: { 'CERTIFICATE': '...', ... }. */
export function pemBlocks(text) {
  return Object.fromEntries([...text.matchAll(/-----BEGIN ([A-Z ]+)-----[\s\S]+?-----END \1-----\n?/g)].map(match => [match[1], match[0].endsWith('\n') ? match[0] : `${match[0]}\n`]));
}

/** The openssl arguments that print a self-signed certificate and its private key naming `host`, valid `days`. */
export const certificateArgs = (host, days) => ['req', '-config', REQUEST_SETTINGS, '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(days), '-subj', `/CN=${host}`, '-addext', `subjectAltName=IP:${host}`];

/** A self-signed certificate { key, cert } in PEM naming `host` (its common name and IP address), valid `days`. */
export async function makeCertificate(host, days) {
  const blocks = pemBlocks(await run('openssl', certificateArgs(host, days)));
  const key = Object.entries(blocks).find(([label]) => label.endsWith('KEY'))?.[1];
  const cert = blocks.CERTIFICATE;
  if (!key || !cert) throw new Error('openssl did not make a certificate.');
  return { key, cert };
}

/** Whether a certificate { cert } names `host` as one of its IP addresses. */
export const certificateNames = (held, host) => new X509Certificate(held.cert).checkIP(host) !== undefined;
