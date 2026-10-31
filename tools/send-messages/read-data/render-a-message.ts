// tools/send-messages/read-data/render-a-message.ts
//
// Purpose: Pure, I/O-free email assembly — select a `message-template`
// by `template_name` and render its message templates by substituting `{{key}}`
// placeholders from a variables map. It imports nothing, so it is unit-testable standalone.
//
// Non-negotiable invariant (L090 / Feature-Package-Behavior-Is-DATA): this handler
// NEVER enumerates which templates or which placeholders exist. Both are DATA —
// each email kind is one `message-template` record (template_name +
// message.{from,subject,html_template,text_template} with `{{key}}` placeholders),
// and callers supply a `variables` map. Adding a new email (onboarding, receipt,
// password-reset, …) = one DATA descriptor + the caller's variables, ZERO change
// to this file. The login-link email and the onboarding email are two DATA
// configurations of this one generic renderer.

export class MessageTemplateError extends Error {
  public readonly publicStatus = 502;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Select the `message-template` whose `template_name` matches.
 * Generic: any number of descriptors may coexist; selection is by DATA, never by
 * a hardcoded "first descriptor" or an enumerated template list.
 */
export function selectDescriptor(
  things: readonly unknown[],
  templateName: string,
): Record<string, unknown> {
  for (const thing of things) {
    if (!isRecord(thing)) continue;
    const payload = thing.payload;
    if (!isRecord(payload) || payload.kind !== 'message-template') continue;
    if (payload.template_name === templateName) return payload;
  }
  throw new MessageTemplateError(`Unsupported email template: ${templateName}`);
}

function escapeHtmlValue(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

/** Substitute every `{{key}}` in a single string from the variables map. */
function substituteLine(line: string, variables: Record<string, string>, escapeHtml: boolean): string {
  let out = line;
  for (const [key, raw] of Object.entries(variables)) {
    out = out.replaceAll(`{{${key}}}`, escapeHtml ? escapeHtmlValue(raw) : raw);
  }
  return out;
}

/**
 * Render an array of template lines, substituting `{{key}}` placeholders. In HTML
 * mode each substituted value is HTML-escaped (matching the prior login-link
 * behavior, which escaped the link inside the HTML body but not the text body).
 */
export function renderTemplateLines(
  lines: unknown,
  variables: Record<string, string>,
  label: string,
  escapeHtml = false,
): string {
  if (!Array.isArray(lines)) {
    throw new MessageTemplateError(
      `MESSAGE_0002_TEMPLATE_LINES_MISSING: ${label} must be an array of strings.`,
    );
  }
  return lines
    .map((line, index) => {
      if (typeof line !== 'string') {
        throw new MessageTemplateError(
          `MESSAGE_0001_TEMPLATE_LINE_INVALID: ${label}[${index}] must be a string.`,
        );
      }
      return substituteLine(line, variables, escapeHtml);
    })
    .join('\n');
}

export type RenderedEmail = { from: string; subject: string; html: string; text: string };

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MessageTemplateError(`${label} is required.`);
  }
  return value.trim();
}

/**
 * Build the rendered email (from/subject/html/text) from a descriptor's message
 * block and a variables map. Subject is plain-substituted (no HTML escape);
 * html_template is HTML-escaped per substituted value; text is raw.
 *
 * `overrideMessage` MERGES OVER the descriptor's message, field by field. It used to REPLACE it
 * wholesale, which was invisible for as long as this package shipped a `from` on every descriptor:
 * a caller either wanted everything from DATA or supplied everything itself, and no caller wanted
 * to change one field.
 *
 * That stopped being true on 2026-09-09, when the shipped descriptors lost their `from`, because
 * the sending identity belongs to whoever installs this package and not to the package. Under
 * replace semantics an installer supplying only its address would have LOST the templates it was
 * trying to use, so the shipped descriptors would have been unusable by exactly the caller they
 * exist for. Merging is also what the word override means.
 *
 * Strictly more permissive than what it replaced: a caller passing a full message still gets its
 * full message, because every key it supplies wins.
 */
export function buildEmailMessage(
  descriptor: Record<string, unknown>,
  variables: Record<string, string>,
  overrideMessage?: unknown,
): RenderedEmail {
  const fromDescriptor = isRecord(descriptor.message) ? descriptor.message : {};
  const message = isRecord(overrideMessage)
    ? { ...fromDescriptor, ...overrideMessage }
    : fromDescriptor;
  return {
    from: readRequiredString(message.from, 'descriptor.message.from'),
    subject: substituteLine(readRequiredString(message.subject, 'descriptor.message.subject'), variables, false),
    html: renderTemplateLines(message.html_template, variables, 'descriptor.message.html_template', true),
    text: renderTemplateLines(message.text_template, variables, 'descriptor.message.text_template', false),
  };
}
