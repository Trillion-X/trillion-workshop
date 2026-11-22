// tools/host-a-sites-own-backend-inside-the-install/read-data/workers-stand-ins.mjs
//
// What a site's Worker reads from the Workers runtime, made on a plain computer so the same bundle runs there unchanged
// (do-work/serve-a-site-worker.mjs). Each one keeps the Workers API the Worker calls, and nothing more:
//   HTMLRewriter      new HTMLRewriter().on(selector, handlers).onDocument(handlers).transform(response): lol-html, the
//                     rewriter Workers itself runs, through html-rewriter-wasm. The answer streams, as on Workers.
//   d1(pool)          env.DB: prepare(sql).bind(...values).first(column?) | all() -> { results } | run() -> { meta: { changes } },
//                     on the site's Postgres database. A `?` outside a quoted string becomes $1, $2, ... in order.
//   kv(pool, table)   env.SHARED_LISTS: get(key, type?), getWithMetadata(key, type?), put(key, value, { metadata, expirationTtl }),
//                     delete(key), kept as rows of `table` in the same database.
//   emailBy(...)      env.EMAIL: send({ from, to, subject, html, text, headers }) as the request an email provider file
//                     describes (the shape of tools/better-auth-official/email-providers/*.json: request {url, method, headers,
//                     auth {header, prefix}, body}, message_id_at, error_at), with the provider's key held for this site.
//   cachesDefault     caches.default: match(request) and put(request, response), held in this process's memory for the
//                     answer's own max-age (s-maxage first), never longer.
//   WorkerEntrypoint  the base class `cloudflare:workers` exports: { ctx, env }.
//   workerSecrets     the Worker's secrets from the unit's credentials folder: each file but the two this host reads itself
//                     (site-database, email-key) is env[NAME], its name in capitals with - as _.
import { HTMLRewriter as Lol } from 'html-rewriter-wasm';

// Postgres numbers its placeholders; D1 takes `?`. Quoted strings and identifiers are copied as they are.
export function numbered(sql) {
  let out = '', n = 0, quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (quote) { out += c; if (c === quote) quote = sql[i + 1] === quote ? (out += sql[++i], quote) : null; continue; }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    out += c === '?' ? `$${++n}` : c;
  }
  return out;
}

export function d1(pool) {
  const statement = (sql, values = []) => ({
    bind: (...given) => statement(sql, given),
    async first(column) {
      const { rows } = await pool.query(numbered(sql), values);
      if (!rows.length) return null;
      return column === undefined ? rows[0] : rows[0][column] ?? null;
    },
    async all() {
      const { rows } = await pool.query(numbered(sql), values);
      return { results: rows, success: true, meta: { rows_read: rows.length } };
    },
    async run() {
      const answer = await pool.query(numbered(sql), values);
      return { success: true, meta: { changes: answer.rowCount ?? 0 } };
    },
  });
  return {
    prepare: sql => statement(sql),
    async batch(statements) { const out = []; for (const one of statements) out.push(await one.all()); return out; },
  };
}

/** env.JOURNEY_DB: the journey database answered as env.DB is, when the unit's credentials name a connection for it. With
 *  none named there is no such binding at all: the key is absent from env, so a Worker that reads it finds nothing. */
export function journeyBindingOf(connectionString, makePool) {
  return connectionString ? { JOURNEY_DB: d1(makePool(connectionString)) } : {};
}

export function kv(pool, table) {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('The key-value table is named in lowercase letters, digits and _.');
  let made = null;
  const ready = () => (made ??= pool.query(`CREATE TABLE IF NOT EXISTS ${table} (key text PRIMARY KEY, value text NOT NULL, metadata jsonb, expires_at timestamptz)`));
  const typed = (value, type) => (value === null ? null : type === 'json' ? JSON.parse(value) : value);
  const read = async key => {
    await ready();
    const { rows } = await pool.query(`SELECT value, metadata FROM ${table} WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`, [key]);
    return rows[0] ?? null;
  };
  const typeOf = options => (typeof options === 'string' ? options : options?.type);
  return {
    async get(key, options) { const row = await read(key); return row ? typed(row.value, typeOf(options)) : null; },
    async getWithMetadata(key, options) { const row = await read(key); return { value: row ? typed(row.value, typeOf(options)) : null, metadata: row?.metadata ?? null }; },
    async put(key, value, { metadata = null, expirationTtl } = {}) {
      await ready();
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      await pool.query(`INSERT INTO ${table} (key, value, metadata, expires_at) VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(secs => $4::int) END)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, metadata = EXCLUDED.metadata, expires_at = EXCLUDED.expires_at`, [key, text, metadata, expirationTtl ?? null]);
    },
    async delete(key) { await ready(); await pool.query(`DELETE FROM ${table} WHERE key = $1`, [key]); },
  };
}

// A body template's text "{name}" is the message's value as it is (text, list or object); "{name}" inside longer text is
// that value as text; a field the message leaves out is left out. Arrays and objects are filled item by item.
export function fillTemplate(template, message) {
  if (typeof template === 'string') {
    const whole = /^\{([a-z_]+)\}$/.exec(template);
    if (whole) return message[whole[1]];
    return template.replace(/\{([a-z_]+)\}/g, (_, name) => String(message[name] ?? ''));
  }
  // A list item that fills to a list joins its items into the list: ["{to}"] with two recipients is two items.
  if (Array.isArray(template)) return template.flatMap(item => { const filled = fillTemplate(item, message); return filled === undefined ? [] : Array.isArray(filled) ? filled : [filled]; });
  if (template && typeof template === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(template)) { const filled = fillTemplate(value, message); if (filled !== undefined) out[key] = filled; }
    return out;
  }
  return template;
}

// The Workers EMAIL binding takes an address as text or { email, name }, and `to` as text or a list; a provider's request
// takes text. An address object becomes "Name <email>" (or the email alone), and a list of them a list of texts.
export function addressText(address) {
  if (Array.isArray(address)) return address.map(addressText);
  if (address && typeof address === 'object') return address.name ? `${String(address.name).replace(/[<>"]/g, '')} <${address.email}>` : String(address.email ?? '');
  return address;
}

const at = (value, path) => String(path ?? '').split('.').filter(Boolean).reduce((found, step) => found?.[step], value);

export function emailBy({ provider, key, fetchImpl = fetch }) {
  return {
    async send(message) {
      if (!provider?.request?.url) throw Object.assign(new Error('This site names no email provider, so no mail can be sent.'), { code: 'email_not_set_up' });
      if (!key) throw Object.assign(new Error(`This computer holds no ${provider.name ?? 'email provider'} key for the site, so no mail can be sent.`), { code: 'email_not_set_up' });
      const { url, method = 'POST', headers = {}, auth, body, timeout_ms: timeout = 15000 } = provider.request;
      const sent = { ...headers, ...(auth ? { [auth.header]: `${auth.prefix ?? ''}${key}` } : {}) };
      const answer = await fetchImpl(url, { method, headers: sent, body: JSON.stringify(fillTemplate(body, { ...message, from: addressText(message.from), to: addressText(message.to), replyTo: addressText(message.replyTo) })), signal: AbortSignal.timeout(timeout) });
      const reply = await answer.json().catch(() => ({}));
      if (!answer.ok) {
        const said = at(reply, provider.error_at);
        throw Object.assign(new Error(`${provider.name ?? 'The email provider'} refused the message (${answer.status})${said ? `: ${said}` : ''}.`), { code: 'email_refused', status: answer.status });
      }
      return { messageId: at(reply, provider.message_id_at) ?? null };
    },
  };
}

export function cachesDefault(now = () => Date.now()) {
  const held = new Map();
  const keyOf = request => (typeof request === 'string' ? request : request.url);
  return {
    async match(request) {
      const kept = held.get(keyOf(request));
      if (!kept) return undefined;
      if (kept.until <= now()) { held.delete(keyOf(request)); return undefined; }
      return new Response(kept.body, { status: kept.status, headers: kept.headers });
    },
    async put(request, response) {
      const control = response.headers.get('cache-control') ?? '';
      const seconds = Number((/s-maxage=(\d+)/.exec(control) ?? /max-age=(\d+)/.exec(control) ?? [])[1] ?? 0);
      if (!seconds || /no-store|private/.test(control)) return;
      held.set(keyOf(request), { body: await response.arrayBuffer(), status: response.status, headers: [...response.headers], until: now() + seconds * 1000 });
    },
    async delete(request) { return held.delete(keyOf(request)); },
  };
}

// The files the host reads for itself are not the Worker's: the database connection and the email provider's key.
const HOST_HELD = new Set(['site-database', 'email-key', 'journey-database']);
export function workerSecrets(folder, { readdirSync, readFileSync }) {
  if (!folder) return {};
  const secrets = {};
  for (const name of readdirSync(folder).sort()) {
    if (HOST_HELD.has(name) || name.startsWith('.')) continue;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error(`The credential ${name} is not named in lowercase words joined by -, so it names no Worker secret.`);
    secrets[name.toUpperCase().replaceAll('-', '_')] = readFileSync(`${folder}/${name}`, 'utf8').trim();
  }
  return secrets;
}

export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }

export class HTMLRewriter {
  #handlers = [];
  on(selector, handlers) { this.#handlers.push(['on', selector, handlers]); return this; }
  onDocument(handlers) { this.#handlers.push(['onDocument', handlers]); return this; }
  transform(response) {
    if (!response.body) return response;
    const handlers = this.#handlers;
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const rewriter = new Lol(chunk => { if (chunk.length) writer.write(chunk.slice()); });
    for (const [kind, a, b] of handlers) (kind === 'on' ? rewriter.on(a, b) : rewriter.onDocument(a));
    (async () => {
      try {
        for await (const chunk of response.body) await rewriter.write(chunk);
        await rewriter.end();
        await writer.close();
      } catch (error) {
        await writer.abort(error);
      } finally {
        rewriter.free();
      }
    })();
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(readable, { status: response.status, statusText: response.statusText, headers });
  }
}
