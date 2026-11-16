// packages/send-requests-to-an-engine/do-work/send-one-request-with-one-field-read-from-standard-input.mjs
//
// PURPOSE: send one request to one running app, where exactly one field of the
// request body is read from standard input instead of being written in the
// command.
//
// WHY THIS EXISTS. Some values must not appear in a command. A command line is
// readable by every other process on the machine through the process list, it is
// written to the shell's history file, and it is echoed by anything that logs the
// command it ran. A key, a token, or a password that passes through an argument
// has been seen in three places before it arrives.
//
// The sibling `request-target` already reads a whole request body from standard
// input, which solves this when the caller has the finished JSON. It does not
// solve the common case, which is a person holding a raw value and a pipeline
// that has to wrap it. Wrapping it by hand means quoting it by hand, and a value
// containing a quote or a backslash then produces either a broken request or,
// worse, one that succeeds and sends the wrong bytes. Encoding it here removes
// that class entirely.
//
// This knows nothing about what the value is or which target wants it. The
// request shape is the caller's, named as DATA; this fills one named field in it.
//
// NOTHING PRINTS THE VALUE. The readback names the field and its byte length,
// which distinguishes "sent" from "sent something empty or truncated" without
// disclosing it. An empty value is refused rather than sent, because a target
// that stores an empty string is indistinguishable from one holding the right
// value until something authenticates as nobody, far from here, and reports a
// refusal that names nothing about this.
//
// Run (the value never appears in the command):
//   pbpaste | node send-one-request-with-one-field-read-from-standard-input.mjs \
//     --url https://app.example.com \
//     --target slot::credentials-vault \
//     --request '{"operation":"write","key":"google_ai_api_key"}' \
//     --field value

import { readFileSync } from "node:fs";

import {
  startRunningAppSession,
  sendRequestToRunningApp,
} from "../read-data/find-the-running-app-and-send-requests-to-it.mjs";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  const value = process.argv[index + 1];
  return !value || value.startsWith("--") ? null : value;
}

function requiredOption(name) {
  const value = optionValue(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const target = requiredOption("--target");
  const field = requiredOption("--field");
  const request = JSON.parse(requiredOption("--request"));
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("--request must be a JSON object");
  }
  // Refuse to overwrite rather than silently win: a caller who wrote the field in
  // --request meant something by it, and quietly replacing it would make the
  // command and what was sent two different things.
  if (Object.prototype.hasOwnProperty.call(request, field)) {
    throw new Error(`--request already carries ${field}; the value read from input would replace it`);
  }
  const url = optionValue("--url");
  const appId = optionValue("--app-id");
  if (!url && !appId) throw new Error("name the running app with --url or --app-id");

  // How long one request may take is the caller's knowledge, not this program's.
  // Two minutes suits a question; it silently cuts off work that builds or
  // deploys something, and the abort that follows reads as a transport fault
  // rather than as this number, which is the most expensive way to be wrong.
  const waitMs = optionValue("--wait-ms");
  const timeoutMs = waitMs === null ? 120000 : Number(waitMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--wait-ms must be a positive whole number of milliseconds");
  }

  // Trailing whitespace is what a copied value carries, and it is invisible in
  // every surface a person would check it in.
  const value = readFileSync(0, "utf8").trim();
  if (value.length === 0) {
    throw new Error(`the value for ${field} arrives on standard input and was empty; nothing was sent`);
  }

  const session = await startRunningAppSession({
    ...(url ? { url } : {}),
    ...(appId ? { appId } : {}),
  });
  const reply = await sendRequestToRunningApp(
    session,
    target,
    { ...request, [field]: value },
    { timeoutMs },
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        target,
        field_read_from_input: field,
        field_byte_length: Buffer.byteLength(value, "utf8"),
        reply,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
