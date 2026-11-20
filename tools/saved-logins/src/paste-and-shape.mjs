// Reading and shaping a saved login from a pasted export, a form or a tool call. Pure: no storage, no network, no
// vault. Ported from the older Workshop copy of src/saved-logins.mjs (commit b6ae0ebf81), the parts
// that read words and shape logins; the sealed box and its owner stay in the vault owner (engine src/secrets.rs).
import settings from './saved-logins.json' with { type: 'json' };

/** The words at `key`, filled from `values`. */
export const loginsSaid = (key, values = {}) => settings.words[key].replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));

/** A refusal the person can act on: its words, its status, and whether signing in again is the way past it. */
export class SavedLoginRefused extends Error {
  constructor(key, values = {}, { status = 400, sign_in_again = false } = {}) {
    super(loginsSaid(key, values));
    this.name = 'SavedLoginRefused';
    this.status = status;
    this.sign_in_again = sign_in_again;
  }
}
const text = value => (typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim());
const sameLabel = (left, right) => left.toLowerCase() === right.toLowerCase();
const DOMAIN = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/i;
/** The site's host name, read from an address or from words that hold one ("namecheap.com (domain host)"). */
export const hostIn = value => {
  const given = text(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(given) && URL.canParse(given)) return new URL(given).hostname.toLowerCase();
  return DOMAIN.exec(given)?.[1]?.toLowerCase() ?? null;
};

/** A login as given (from a form, a tool or a pasted line), checked and shaped: { title, site, user_name, fields }. */
export function shapedLogin(input) {
  const site = text(input?.site);
  const title = text(input?.title) || hostIn(site) || site;
  if (!title) throw new SavedLoginRefused('no_name');
  const fields = [];
  for (const field of Array.isArray(input?.fields) ? input.fields : []) {
    const label = text(field?.label) || settings.password_label;
    const value = typeof field?.value === 'string' ? field.value : field?.value === undefined || field?.value === null ? '' : String(field.value);
    if (!value.trim()) continue;
    if (value.length > settings.max_value_chars) throw new SavedLoginRefused('too_long', { field: label, max: settings.max_value_chars });
    const at = fields.findIndex(kept => sameLabel(kept.label, label));
    if (at === -1) fields.push({ label, value }); else fields[at] = { label, value };
  }
  if (!fields.length) throw new SavedLoginRefused('no_values');
  if (fields.length > settings.max_fields) throw new SavedLoginRefused('too_many_fields', { max: settings.max_fields });
  return { title, site: site || null, user_name: text(input?.user_name) || null, fields };
}

/** The Save a login boxes as a login: the password and notes boxes, and one "Name: value" per line of the other box. */
export function loginFromForm(values = {}) {
  const fields = [
    { label: settings.password_label, value: values.password },
    { label: settings.notes_label, value: values.notes },
    ...String(values.other ?? '').split(/\r?\n/).map(line => {
      const at = line.indexOf(':');
      return at > 0 ? { label: line.slice(0, at), value: line.slice(at + 1).trim() } : { label: '', value: line };
    }),
  ];
  return shapedLogin({ site: values.site, user_name: values.user_name, fields });
}

// ---- Reading a pasted export ----

/** RFC 4180 rows: quoted cells may hold the delimiter, doubled quotes and line breaks. */
function csvRows(source, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at];
    if (quoted) {
      if (char === '"' && source[at + 1] === '"') { cell += '"'; at += 1; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ''; } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[at + 1] === '\n') at += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(cells => cells.some(value => value.trim()));
}

const columnsIn = (list, header) => list.includes(header);
const roleOf = header => Object.entries(settings.import.columns).find(([, names]) => columnsIn(names, header))?.[0] ?? null;
const capitalised = label => label.charAt(0).toUpperCase() + label.slice(1);

/** A CSV export, when the first line is a header that names a site, a user name or a password column; else null. */
function readCsv(source) {
  const firstLine = source.split(/\r?\n/).find(line => line.trim()) ?? '';
  const delimiter = [',', '\t', ';'].map(mark => [mark, firstLine.split(mark).length]).sort((left, right) => right[1] - left[1])[0][0];
  const rows = csvRows(source, delimiter);
  if (rows.length < 1) return null;
  const headers = rows[0].map(cell => cell.trim().toLowerCase());
  const known = headers.filter(header => roleOf(header) || columnsIn(settings.import.password_columns, header));
  if (headers.length < 2 || !known.length) return null;
  const logins = [];
  const skipped = [];
  rows.slice(1).forEach((cells, index) => {
    const login = { fields: [] };
    headers.forEach((header, column) => {
      const value = cells[column] ?? '';
      if (!header || columnsIn(settings.import.ignored, header)) return;
      const role = roleOf(header);
      if (role) { if (!text(login[role])) login[role] = value; return; }
      const label = columnsIn(settings.import.password_columns, header) ? settings.password_label
        : columnsIn(settings.import.notes_columns, header) ? settings.notes_label : capitalised(rows[0][column].trim());
      login.fields.push({ label, value });
    });
    try { logins.push(shapedLogin(login)); } catch (error) { skipped.push({ line: index + 2, why: error.message }); }
  });
  return { logins, skipped };
}

// An outline written with HTML toggles (a page export): the opening and closing toggle marks and the toggle's name.
// Written with \x3c so no markup text sits in this file.
const TOGGLE_MARK = /\x3c\/?details|\x3csummary/i;
const TOGGLE_PARTS = /(?=\x3cdetails|\x3c\/details>|\x3csummary)/i;
const OPENS = /^\x3cdetails[^>]*>/i;
const CLOSES = /^\x3c\/details>/i;
const NAMED = /^\x3csummary[^>]*>([\s\S]*?)(?:\x3c\/summary>|$)/i;
const ANY_MARK = /\x3c[^>]+>/g;
const ENTITIES = { amp: '&', lt: '\x3c', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decoded = value => value.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (whole, name) => ENTITIES[name]);
const BULLET = /^(?:[-*+•‣◦▪▶▸▹►▾▼]|\d+[.)]|\[[ xX]?\])\s+/;

/** Lines of an outline (a page copied whole, or its export) as a tree: indentation, HTML toggles and bullets all give
 *  the same nesting. */
export function outlineTree(source) {
  const root = { text: '', children: [] };
  const stack = [{ indent: -1, node: root }];
  let opened = 0;
  const place = (line, indent) => {
    const node = { text: decoded(line.replace(ANY_MARK, '').trim().replace(BULLET, '')).trim(), children: [] };
    if (!node.text) return;
    while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
    stack.at(-1).node.children.push(node);
    stack.push({ indent, node });
  };
  for (const raw of source.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (TOGGLE_MARK.test(raw)) {
      // Each toggle's name sits one level inside the toggles still open; a closing mark closes one.
      for (const part of raw.split(TOGGLE_PARTS)) {
        if (OPENS.test(part)) { opened += 1; place(part.replace(OPENS, ''), opened * 1000); } else if (CLOSES.test(part)) {
          opened = Math.max(0, opened - 1);
          place(part.replace(CLOSES, ''), opened * 1000 + 1);
        } else if (NAMED.test(part)) {
          place(NAMED.exec(part)[1], opened * 1000 - 1);
          place(part.replace(NAMED, ''), opened * 1000);
        } else place(part, opened * 1000);
      }
      continue;
    }
    const lead = /^[\t ]*/.exec(raw)[0];
    const indent = [...lead].reduce((width, char) => width + (char === '\t' ? 4 : 1), 0) + opened * 1000;
    place(raw, indent);
  }
  return root;
}

const isLeaf = node => node.children.length === 0;
const holdsLines = node => !isLeaf(node) && node.children.every(isLeaf);
const marksAValue = label => label.toLowerCase().split(/[^a-z0-9]+/).some(word => settings.import.field_words.includes(word));
const looksLikeAUserName = line => !/\s/.test(line);

/** The logins in an outline: a service is a toggle whose children are lines or toggles holding lines. Under it, a
 *  toggle whose name marks a value (field_words) is that value; any other toggle is a user name whose lines are its
 *  password; plain lines are notes, except a lone user name kept beside a value toggle. A group of services (a
 *  letter) is read through. */
function readOutline(source) {
  const logins = [];
  const skipped = [];
  const service = node => {
    const users = [];
    const values = [];
    const lines = [];
    for (const item of node.children) {
      if (isLeaf(item)) { lines.push(item.text); continue; }
      const value = item.children.map(line => line.text).join('\n');
      if (marksAValue(item.text)) values.push({ label: item.text, value }); else users.push({ user_name: item.text, password: value });
    }
    let userName = null;
    if (!users.length && values.length) {
      const at = lines.findIndex(looksLikeAUserName);
      if (at !== -1) userName = lines.splice(at, 1)[0];
    }
    const notes = lines.length ? [{ label: settings.notes_label, value: lines.join('\n') }] : [];
    const site = hostIn(node.text);
    const made = users.length
      ? users.map((user, index) => ({ title: node.text, site, user_name: user.user_name, fields: [{ label: settings.password_label, value: user.password }, ...(index === 0 ? [...values, ...notes] : [])] }))
      : [{ title: node.text, site, user_name: userName, fields: [...values, ...notes] }];
    for (const login of made) {
      try { logins.push(shapedLogin(login)); } catch (error) { skipped.push({ line: node.text, why: error.message }); }
    }
  };
  const walk = node => {
    for (const child of node.children) {
      if (isLeaf(child)) continue;
      if (child.children.every(item => isLeaf(item) || holdsLines(item))) service(child); else walk(child);
    }
  };
  walk(outlineTree(source));
  return { logins, skipped };
}

/** The logins in a pasted export: a CSV with a header row, else an outline. */
export function readPastedLogins(source) {
  const pasted = String(source ?? '');
  if (pasted.length > settings.max_paste_chars) throw new SavedLoginRefused('paste_too_long', { max: settings.max_paste_chars });
  const read = readCsv(pasted) ?? readOutline(pasted);
  if (read.logins.length > settings.max_import_logins) throw new SavedLoginRefused('too_many_in_paste', { max: settings.max_import_logins });
  return read;
}

