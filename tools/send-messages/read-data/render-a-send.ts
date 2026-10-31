// tools/send-messages/read-data/render-a-send.ts
//
// Purpose: Pure, I/O-free assembly of one send over a program on the person's own computer: build the command line
// (plus success marker and permission-denial classification data) from a provider row in
// read-data/message-providers.json. Unit-testable standalone.
//
// Non-negotiable invariant (Feature-Package-Behavior-Is-DATA): this file NEVER enumerates which channels exist and
// NEVER hardcodes the osascript (or any transport script). Both are DATA: each such provider is one row with a
// `process` block (interpreter_argv, timeout_ms, success_stdout_marker, tcc_denial), and callers supply
// {recipient, body}. Adding a channel (WhatsApp, Instagram DM, SMS, Slack, ...) = one DATA row, ZERO change to this
// file. Messages on the Mac is one DATA configuration of this one generic renderer.
//
// Injection safety (Physics, not convention): the message body is appended as a SEPARATE positional argv element,
// NEVER interpolated into the transport script source. The osascript reads it via `item 2 of argv`. Body-as-script-
// injection is therefore structurally impossible, not merely guarded against.

export class SendDescriptorError extends Error {
  public readonly publicStatus = 502;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export interface SendParameters {
  recipient: string;
  body: string;
  extraArgs?: readonly string[];
}

export interface SendInvocation {
  argv: string[];
  timeout_ms: number;
  success_stdout_marker: string;
  tcc_denial_patterns: string[];
  tcc_remediation: string;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SendDescriptorError(`${label} is required.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new SendDescriptorError(`${label} is required.`);
  }
  return Number(value);
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SendDescriptorError(`${label} is required.`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new SendDescriptorError(`${label}[${index}] must be a string.`);
    }
    return item;
  });
}

const DEFAULT_TCC_REMEDIATION =
  'Grant Automation control of "Messages" to the sending process in System Settings → Privacy & Security → Automation, then retry.';

/**
 * Build the command from a provider row's `process` block and the caller's send parameters. The recipient and body
 * (then any extraArgs) are appended as positional argv AFTER the row's `interpreter_argv`: the body is never woven
 * into the script text.
 */
export function buildSendInvocation(
  descriptor: Record<string, unknown>,
  params: SendParameters,
): SendInvocation {
  const process = isRecord(descriptor.process) ? descriptor.process : {};
  const interpreterArgv = readStringArray(
    process.interpreter_argv,
    'descriptor.process.interpreter_argv',
  );
  const recipient = readRequiredString(params.recipient, 'recipient');
  const body = typeof params.body === 'string' ? params.body : '';
  const extraArgs = Array.isArray(params.extraArgs)
    ? params.extraArgs.map((arg, index) => {
        if (typeof arg !== 'string') {
          throw new SendDescriptorError(`extraArgs[${index}] must be a string.`);
        }
        return arg;
      })
    : [];

  const tccDenial = isRecord(process.tcc_denial) ? process.tcc_denial : {};

  return {
    argv: [...interpreterArgv, recipient, body, ...extraArgs],
    timeout_ms: readPositiveInteger(process.timeout_ms, 'descriptor.process.timeout_ms'),
    success_stdout_marker: readRequiredString(
      process.success_stdout_marker,
      'descriptor.process.success_stdout_marker',
    ),
    tcc_denial_patterns: readStringArray(
      tccDenial.stderr_patterns,
      'descriptor.process.tcc_denial.stderr_patterns',
    ),
    tcc_remediation:
      typeof tccDenial.remediation === 'string' && tccDenial.remediation.trim().length > 0
        ? tccDenial.remediation
        : DEFAULT_TCC_REMEDIATION,
  };
}

/**
 * Classify a stderr string against the row's permission-denial patterns (case-insensitive substring match). A match
 * means the OS refused the Automation event (macOS TCC): the send must fail CLOSED with the remediation string, never
 * silently degrade.
 */
export function isTccDenial(stderr: string, patterns: readonly string[]): boolean {
  const haystack = stderr.toLowerCase();
  return patterns.some((pattern) => haystack.includes(pattern.toLowerCase()));
}
