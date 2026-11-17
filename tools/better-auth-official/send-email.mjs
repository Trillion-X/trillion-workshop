// The one place Better Auth's email callbacks go. settings.json `email` names who sends (`sender`: the person's description of
// their email provider's request, as DATA) and the address mail comes `from`; email-words.json gives each kind of message its
// words. The request's auth header carries the credential the description names (`vault_key`), read at each send from the
// unit's credentials folder (CREDENTIALS_DIRECTORY), never from this tool's files. A send the provider did not accept throws, so
// the page says the message was not sent; nothing is kept anywhere instead. No email vendor is named here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import words from './email-words.json' with { type: 'json' };

const at = (value, path) => path.split('.').reduce((held, key) => held?.[key], value);
// Each {name} in a string of the body is that value; a string that is only {name} becomes the value itself.
const filled = (shape, values) => {
  if (typeof shape === 'string') {
    const whole = shape.match(/^\{([a-z_]+)\}$/);
    if (whole) return values[whole[1]];
    return shape.replace(/\{([a-z_]+)\}/g, (_, key) => values[key] ?? '');
  }
  if (Array.isArray(shape)) return shape.map(item => filled(item, values));
  if (shape && typeof shape === 'object') return Object.fromEntries(Object.entries(shape).map(([key, item]) => [key, filled(item, values)]));
  return shape;
};

/** The message a kind says, in its words: { subject, text }, each {field} the message's own value. */
export function messageOf(message, extra = {}) {
  const said = words.kinds[message.kind];
  if (!said) throw new Error(`email-words.json has no words for ${message.kind}`);
  const values = { ...extra, ...message };
  return { subject: filled(said.subject, values), text: filled(said.text.join('\n'), values) };
}

export function emailHook(email, extra = {}) {
  return async message => {
    const sender = email?.sender;
    if (!sender?.request?.url || !email.from) throw new Error('settings.json email names no sender and from address, so no message can be sent');
    const folder = process.env.CREDENTIALS_DIRECTORY;
    if (!folder) throw new Error(`the credential ${sender.vault_key} is not handed to this process (no CREDENTIALS_DIRECTORY)`);
    const key = readFileSync(join(folder, sender.vault_key), 'utf8').trim();
    const { request } = sender;
    const body = filled(request.body, { from: email.from, to: message.to, ...messageOf(message, extra) });
    const answer = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers, [request.auth.header]: `${request.auth.prefix ?? ''}${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(request.timeout_ms),
    });
    const said = await answer.json().catch(() => ({}));
    const id = at(said, sender.message_id_at);
    if (!answer.ok || !id) throw new Error(`${sender.name} did not accept the message (HTTP ${answer.status}): ${String(at(said, sender.error_at) ?? '').slice(0, 300)}`);
    return { id };
  };
}
