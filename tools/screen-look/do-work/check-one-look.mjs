// tools/screen-look/do-work/check-one-look.mjs
//
// PURPOSE
//   Every screen, page, widget, extension view and native view wears the selected screen look: its fonts come from the
//   look (--font-primary, --font-display, Typeface on the devices), a filled button wears the look's button face (fill,
//   the highlight line along the top, the shadow) and no card wears a coloured bar down its left side. This reads every
//   source file under the roots in the owner's ../one-look-rules.json and refuses any line that breaks a rule there.
//   --root REPOSITORY selects the source repository; the rules always belong to this checker, not its caller.
//     node scripts/check-one-look.mjs                 checks every file
//     node scripts/check-one-look.mjs <path> [...]    checks only these files (scripts/commit-paths.sh runs this on
//                                                     every commit with the paths it commits; the AI edit guard runs
//                                                     it on the file an edit writes)
//     node scripts/check-one-look.mjs --count         also prints how many findings each rule has
//     node scripts/check-one-look.mjs --text <path>   judges the words on stdin as if they were <path> (what the AI
//                                                     edit guard, ai-command-center .claude/hooks/one-look-guard.py,
//                                                     runs on the new words an edit writes)
//   Exit 1 with one line per finding: <file>:<line>: <rule>: <the line>, then each broken rule's words once.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Rules are DATA (parts/screen-look/one-look-rules.json). A rule names its kind (a declaration's value, a style
//      block, a JSX tag, a JSON value, a look's tokens, a line, a native type) and its patterns; this file knows the kinds and nothing about which
//      fonts, colours or parts exist, so a new rule is a row, never a code change.
//   2. A file is judged by where it lives (the rules' roots and file pattern), so a screen added tomorrow is judged from
//      its first line; no screen is named here.
//   3. A file kept apart on purpose is a kept row with why; a kept row whose file no longer breaks that rule is itself a
//      finding, so the list cannot rot.
//   4. A rule may be scoped to the files that draw a surface (`files`, regexes on the repository path) and may leave the
//      owner out (`not_files`): the look's owner is src/workspace/looks.json and parts/screen-look/read-data/*, where
//      the literals are written once; the rendering files outside them take every colour, face and corner from the
//      look's variables. A kept row may name `values`, the exact literals that file may still hold; a literal not in the
//      list is a new one and is refused, and a listed value the file no longer holds is a finding, so the list shrinks
//      and never grows without a reason written here.
//
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, extname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(process.cwd());
export const RULES = JSON.parse(readFileSync(new URL('../one-look-rules.json', import.meta.url), 'utf8'));

const FILE = new RegExp(RULES.file_pattern);
const SKIP = new RegExp(RULES.skip_pattern);
const language = file => extname(file).slice(1);
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const lineText = (text, line) => (text.split('\n')[line - 1] ?? '').trim().slice(0, 160);

/** A colour as [r, g, b] in 0..255 from #rgb, #rrggbb or rgb()/rgba(); null for anything else. */
function rgbOf(value) {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) { const h = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1]; return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
  const fn = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  return fn ? fn.slice(1, 4).map(Number) : null;
}
const hueOf = ([r, g, b]) => {
  const [x, y, z] = [r, g, b].map(c => c / 255); const max = Math.max(x, y, z); const d = max - Math.min(x, y, z);
  if (!d) return null;
  const h = max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
  return (h * 60 + 360) % 360;
};
const luminance = rgb => { const [r, g, b] = rgb.map(c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Whether a look's tokens satisfy a json-tokens rule (equal value, or same hue and readable). */
function tokensAgree(rule, value) {
  if (rule.equals_token) {
    if (value.get(rule.token) !== value.get(rule.equals_token)) return false;
    if (!rule.min_contrast) return true;
    const [fillRgb, wordsRgb] = [rgbOf(value.get(rule.token) ?? ''), rgbOf(value.get(rule.contrast_with_token) ?? '')];
    return Boolean(fillRgb && wordsRgb) && contrast(fillRgb, wordsRgb) >= rule.min_contrast;
  }
  const fill = rgbOf(value.get(rule.token) ?? ''); const accent = rgbOf(value.get(rule.hue_of_token) ?? '');
  if (!fill || !accent) return false;
  const [hf, ha] = [hueOf(fill), hueOf(accent)];
  if (hf === null || ha === null || Math.min(Math.abs(hf - ha), 360 - Math.abs(hf - ha)) > rule.hue_within) return false;
  const words = rgbOf(value.get(rule.contrast_with_token) ?? '');
  return !rule.min_contrast || (Boolean(words) && contrast(fill, words) >= rule.min_contrast);
}

/** A border width as pixels, or null when the value does not start with a width (a colour, none, a variable). */
function widthPx(value) {
  const bare = value.replace(/^['"`]\s*/, '');
  const word = bare.match(/^(thin|medium|thick)\b/);
  if (word) return { thin: 1, medium: 3, thick: 5 }[word[1]];
  const size = bare.match(/^(\d*\.?\d+)(px|rem|em)?(?![\w.])/);
  if (!size) return null;
  const amount = Number(size[1]);
  return size[2] === 'rem' || size[2] === 'em' ? amount * 16 : amount;
}

/** The selector of the style block a position sits in (the words before its opening brace). */
function selectorBefore(text, index) {
  const open = text.lastIndexOf('{', index);
  return open < 0 || text.lastIndexOf('}', index) > open ? '' : text.slice(Math.max(0, text.lastIndexOf('}', open) + 1), open);
}

/** Style blocks in a text: every `selector { declarations }` with its selector and where its body starts. */
function* blocks(text) {
  const pattern = /([^{}]*)\{([^{}]*)\}/g;
  for (let match; (match = pattern.exec(text));) {
    yield { selector: match[1].split(/[;\n]/).pop().trim(), body: match[2], index: match.index + match[0].indexOf('{') };
  }
}

/** Every value a declaration pattern (its first group is the value) takes in a style block's body. */
const declarationValues = (pattern, body) => [...body.matchAll(new RegExp(pattern, 'g'))].map(match => match[1]);
/** A value the rule refuses: not one it allows outright, and one its refused pattern finds. */
const refused = (rule, value) => !(rule.allowed_value && new RegExp(rule.allowed_value).test(value)) && new RegExp(rule.refused_value).test(value);

/** The text with its comments blanked (same length, same lines), so a colour named in a comment is not a literal. */
const withoutComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
  .replace(/(^|[\s;{}])\/\/[^\n]*/g, (all, before) => before + ' '.repeat(all.length - before.length));

/** The text with comments, strings and regex literals blanked (same length, same lines); the code inside a template's
 *  `${ }` stays. A quote or apostrophe left open ends at its line, so apostrophes in JSX words never run on. */
function codeOnly(text) {
  const out = [...text];
  const blank = (from, to) => { for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '; };
  const modes = []; // 'tpl' while inside a template's text, 'sub' while inside one of its ${ }
  let prior = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const mode = modes[modes.length - 1];
    if (mode === 'tpl') {
      if (c === '\\') { blank(i, i + 2); i++; } else if (c === '`') { modes.pop(); blank(i, i + 1); } else if (c === '$' && text[i + 1] === '{') { modes.push('sub'); blank(i, i + 2); i++; } else blank(i, i + 1);
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { const end = text.indexOf('\n', i); blank(i, end < 0 ? text.length : end); i = (end < 0 ? text.length : end) - 1; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); blank(i, end < 0 ? text.length : end + 2); i = (end < 0 ? text.length : end + 2) - 1; continue; }
    if (c === '`') { modes.push('tpl'); blank(i, i + 1); continue; }
    if (c === "'" || c === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== c && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
      blank(i, end + 1); i = end; continue;
    }
    if (c === '/' && /[(,=:[!&|?{};]|\breturn|^$/.test(prior)) {
      let end = i + 1; let inClass = false;
      while (end < text.length && text[end] !== '\n' && (inClass || text[end] !== '/')) { if (text[end] === '[') inClass = true; else if (text[end] === ']') inClass = false; end += text[end] === '\\' ? 2 : 1; }
      if (text[end] === '/') { blank(i, end + 1); i = end; continue; }
    }
    if (mode === 'sub') { if (c === '{') modes.push('sub'); else if (c === '}') { modes.pop(); if (modes[modes.length - 1] === 'tpl') { blank(i, i + 1); continue; } } }
    if (!/\s/.test(c)) prior = (prior + c).slice(-6);
  }
  return out.join('');
}

/** Where the code after a parameter list's `)` begins, when that list belongs to a function with a body: the index of the
 *  body's `{`, else null (an arrow, or no function). An optional `: type` comes between; a `{` straight after a `:`, `|`
 *  or `&` opens a type, any other `{` at the type's own level opens the body. */
function bodyAfterParams(code, close) {
  let i = close + 1;
  while (/\s/.test(code[i] ?? '')) i++;
  if (code[i] === '{') return i;
  if (code[i] !== ':') return null;
  let depth = 0;
  for (let j = i + 1; j < code.length; j++) {
    const c = code[j];
    if (c === '=' && code[j + 1] === '>') { if (depth === 0) return null; j++; } else if ('<(['.includes(c)) depth++;
    else if ('>)]'.includes(c)) depth--;
    else if (c === '{') {
      const before = code.slice(i, j).trimEnd().slice(-1);
      if (depth === 0 && !/[:|&]/.test(before)) return j;
      for (let braces = 0; j < code.length; j++) { if (code[j] === '{') braces++; else if (code[j] === '}' && --braces === 0) break; }
    } else if (depth === 0 && (c === ';' || c === '=')) return null;
  }
  return null;
}

/** Positions in code that run when the file loads. Code waits for a call inside a function body, an arrow's expression,
 *  or a function's parameter list (a default is made per call). `positions` are ascending indexes into `code`; returns
 *  the ones that run at load. */
function runAtLoad(code, positions) {
  const CONTROL = /\b(?:if|for|while|switch|catch|with)\s*$/;
  const closeOf = new Map(); // each ( to its )
  const open = [];
  for (let i = 0; i < code.length; i++) { if (code[i] === '(') open.push(i); else if (code[i] === ')' && open.length) closeOf.set(open.pop(), i); }
  const bodies = new Set(); // the { that open a function's body
  const loaded = [];
  const stack = []; // each open ( [ { and each arrow's expression: true when its code waits for a call
  let next = 0;
  const waiting = () => stack.some(frame => frame.waits);
  const popArrows = () => { while (stack.length && stack[stack.length - 1].arrow) stack.pop(); };
  for (let i = 0; i < code.length; i++) {
    while (next < positions.length && positions[next] === i) { if (!waiting()) loaded.push(i); next++; }
    const c = code[i];
    if (c === ';') popArrows();
    else if (c === ',') popArrows();
    else if (c === '=' && code[i + 1] === '>') {
      const after = /\s*(.)/y; after.lastIndex = i + 2;
      if (after.exec(code)?.[1] !== '{') stack.push({ waits: true, arrow: true });
      else bodies.add(after.lastIndex - 1);
      i++;
    } else if (c === '(') {
      const body = closeOf.has(i) && !CONTROL.test(code.slice(Math.max(0, i - 12), i)) ? bodyAfterParams(code, closeOf.get(i)) : null;
      if (body !== null) bodies.add(body);
      const arrowAfter = /\s*(?::[^{};=()]*)?=>/y; arrowAfter.lastIndex = (closeOf.get(i) ?? -2) + 1;
      const arrow = closeOf.has(i) && arrowAfter.test(code);
      stack.push({ waits: body !== null || arrow });
    } else if (c === '[') stack.push({ waits: false });
    else if (c === '{') stack.push({ waits: bodies.has(i) });
    else if (c === ')' || c === ']' || c === '}') { popArrows(); stack.pop(); }
  }
  return loaded;
}

/** Each kind's findings for one rule over one file's text: [{ line, value? }]. */
const READ = {
  // Every match of `pattern` outside comments is a finding that names the literal it found (`value`), so a kept row can
  // list the literals a file still holds and refuse any other.
  literal(rule, text) {
    const pattern = new RegExp(rule.pattern, 'g');
    return [...withoutComments(text).matchAll(pattern)].map(match => ({ line: lineOf(text, match.index), value: match[0].trim().toLowerCase() }));
  },
  // Every match of `pattern` that runs while the file loads (outside any function body) is a finding: what a Worker
  // refuses at load time (randomness, time-dependent ids) must wait for first use.
  'module-load'(rule, text) {
    const pattern = new RegExp(rule.pattern, 'g');
    if (!new RegExp(rule.pattern).test(text)) return [];
    const code = codeOnly(text);
    const positions = [...code.matchAll(pattern)].map(match => match.index);
    return runAtLoad(code, positions).map(index => ({ line: lineOf(text, index) }));
  },
  declaration(rule, text) {
    const found = [];
    const property = new RegExp(rule.property, 'g');
    const allowed = rule.allowed_value ? new RegExp(rule.allowed_value) : null;
    for (let match; (match = property.exec(text));) {
      const value = text.slice(match.index + match[0].length, match.index + match[0].length + 120);
      if (allowed && allowed.test(value)) continue;
      if (rule.refused_value && !new RegExp(rule.refused_value).test(value)) continue;
      if (rule.skip_within && new RegExp(rule.skip_within).test(selectorBefore(text, match.index))) continue;
      if (rule.min_width_px !== undefined) {
        const width = widthPx(value);
        if (width === null || width < rule.min_width_px) continue;
      }
      found.push({ line: lineOf(text, match.index) });
    }
    return found;
  },
  line(rule, text) {
    const pattern = new RegExp(rule.pattern);
    return text.split('\n').flatMap((line, index) => (pattern.test(line) ? [{ line: index + 1 }] : []));
  },
  block(rule, text) {
    const selector = new RegExp(rule.selector, 'i');
    const unless = rule.unless ? new RegExp(rule.unless) : null;
    const found = [];
    for (const block of blocks(text)) {
      if (!selector.test(block.selector)) continue;
      if (unless && unless.test(block.body)) continue;
      if (rule.all && !rule.all.every(pattern => new RegExp(pattern).test(block.body))) continue;
      if (rule.declaration && !declarationValues(rule.declaration, block.body).some(value => refused(rule, value))) continue;
      const value = rule.declaration ? declarationValues(rule.declaration, block.body).find(item => refused(rule, item)) : undefined;
      found.push({ line: lineOf(text, block.index), value: value === undefined ? undefined : `${block.selector} ${value.trim()}`.toLowerCase() });
    }
    return found;
  },
  tag(rule, text) {
    const refused = new RegExp(rule.refused);
    return [...text.matchAll(new RegExp(rule.tag, 'g'))].filter(match => refused.test(match[0])).map(match => ({ line: lineOf(text, match.index) }));
  },
  'json-value'(rule, text) {
    const key = new RegExp(rule.key);
    const allowed = new RegExp(rule.allowed_value);
    const found = [];
    const pattern = /"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    for (let match; (match = pattern.exec(text));) {
      if (key.test(match[1]) && !allowed.test(JSON.parse(`"${match[2]}"`))) found.push({ line: lineOf(text, match.index) });
    }
    return found;
  },
  // A look's tokens (any object with a `tokens` list of { css_variable, value }): in every look that names
  // `when_token`, `token` must have the same value as `equals_token`, or (when the rule names them instead) the same hue
  // as `hue_of_token` within `hue_within` degrees and at least `min_contrast` against `contrast_with_token`.
  'json-tokens'(rule, text) {
    let data;
    try { data = JSON.parse(text); } catch { return []; }
    const found = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (Array.isArray(node.tokens)) {
        const value = new Map(node.tokens.filter(row => row && typeof row.css_variable === 'string').map(row => [row.css_variable, String(row.value ?? '').trim().toLowerCase()]));
        if (value.has(rule.when_token) && !tokensAgree(rule, value)) {
          const from = typeof node.id === 'string' ? Math.max(0, text.indexOf(`"${node.id}"`)) : 0;
          const at = text.indexOf(`"${rule.token}"`, from);
          found.push({ line: lineOf(text, at < 0 ? from : at) });
        }
      }
      for (const child of Object.values(node)) visit(child);
    };
    visit(data);
    return found;
  },
  'swift-type'(rule, text) {
    const declares = new RegExp(rule.declares, 'g');
    const fills = new RegExp(rule.fills);
    const unless = new RegExp(rule.unless);
    const found = [];
    for (let match; (match = declares.exec(text));) {
      const after = text.slice(match.index + match[0].length);
      const next = after.search(/\n(?:private |fileprivate |public )?(?:struct|final class|class|enum|extension)\s/);
      const body = text.slice(match.index, next < 0 ? undefined : match.index + match[0].length + next);
      if (fills.test(body) && !unless.test(body)) found.push({ line: lineOf(text, match.index) });
    }
    return found;
  },
};

function* sourceFiles(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else yield path;
  }
}

const judged = file => FILE.test(file) && !SKIP.test(file) && RULES.roots.some(root => file.startsWith(`${root}/`));

/** Every file the rules judge, relative to the repository. */
export function lookFiles(repositoryRoot = ROOT) {
  return RULES.roots.flatMap(root => [...sourceFiles(join(repositoryRoot, root))]).map(path => relative(repositoryRoot, path)).filter(judged);
}

/** What the rules find in one file's text (repository-relative `file`): [{ file, line, rule, says, text, kept }]. A file
 *  the rules do not judge has none. */
export function findingsInText(file, text) {
  if (!judged(file)) return [];
  return RULES.rules.filter(rule => rule.languages.includes(language(file)) && inScope(rule, file)).flatMap(rule => READ[rule.kind](rule, text).map(({ line, value }) => ({
    file, line, rule: rule.id, says: rule.says, text: lineText(text, line), value, kept: keptFor(file, rule.id, value),
  })));
}

/** Whether a rule judges this file: inside one of its `files` (all files when it names none; "scan" is the scan globs in the
 *  rules, plus the rule's `files_also`) and outside its `not_files` (and, for "scan", the owner). */
const inScope = (rule, file) => {
  const files = rule.files === 'scan' ? [...RULES.scan.files, ...(rule.files_also ?? [])] : rule.files;
  const owner = [...(rule.files === 'scan' ? RULES.scan.owner : []), ...(rule.not_files ?? [])];
  return (!files || files.some(pattern => new RegExp(pattern).test(file))) && !owner.some(pattern => new RegExp(pattern).test(file));
};
/** The kept row that excuses this finding: one for the file and rule, and when it lists `values`, one listing this literal. */
const keptFor = (file, rule, value) => RULES.kept.find(row => row.file === file && row.rule === rule && (!row.values || (value !== undefined && row.values.includes(value))));

/** Findings in these files (repository-relative): [{ file, line, rule, says, text }] outside the kept rows. */
export function oneLookFindings(files, repositoryRoot = ROOT) {
  files ??= lookFiles(repositoryRoot);
  const found = [];
  const broken = new Set();
  for (const file of files) {
    const path = join(repositoryRoot, file);
    if (!judged(file) || !existsSync(path)) continue;
    for (const finding of findingsInText(file, readFileSync(path, 'utf8'))) {
      if (finding.kept) { broken.add(`${file} ${finding.rule}`); if (finding.value !== undefined) broken.add(`${file} ${finding.rule} ${finding.value}`); }
      else found.push(finding);
    }
  }
  for (const row of RULES.kept) {
    if (!files.includes(row.file)) continue;
    if (!broken.has(`${row.file} ${row.rule}`)) found.push({ file: row.file, line: 0, rule: row.rule, says: 'A kept row whose file no longer breaks this rule: remove the row from tools/screen-look/one-look-rules.json.', text: row.why });
    for (const value of row.values ?? []) {
      if (broken.has(`${row.file} ${row.rule}`) && !broken.has(`${row.file} ${row.rule} ${value}`)) found.push({ file: row.file, line: 0, rule: row.rule, says: 'A kept row lists a literal the file no longer holds: remove it from the row\'s values in tools/screen-look/one-look-rules.json.', text: value });
    }
  }
  return found;
}

/** Run the same checker for one explicit source repository, with no caller-selected rules or exemptions. */
export function runOneLookCli(argv = process.argv.slice(2), defaultRoot = ROOT) {
  const args = [...argv];
  let repositoryRoot = defaultRoot;
  const rootAt = args.indexOf('--root');
  if (rootAt >= 0) {
    if (!args[rootAt + 1] || args[rootAt + 1].startsWith('--')) throw new Error('--root requires a repository directory');
    repositoryRoot = args[rootAt + 1];
    args.splice(rootAt, 2);
  }
  if (args.includes('--root')) throw new Error('--root may be supplied only once');
  repositoryRoot = resolve(repositoryRoot);
  if (!existsSync(repositoryRoot) || !statSync(repositoryRoot).isDirectory()) throw new Error('--root must be an existing directory');
  const fileAtRoot = path => {
    if (!path) throw new Error('a source path is required');
    const file = relative(repositoryRoot, resolve(repositoryRoot, path));
    if (file === '..' || file.startsWith(`..${sep}`) || isAbsolute(file)) throw new Error('the source path must remain inside --root');
    return file;
  };
  // --text <path>: judge the new words an edit is about to write to <path> (read on stdin), for the AI edit guard.
  if (args[0] === '--text') {
    if (args.length !== 2) throw new Error('--text requires exactly one source path');
    const file = fileAtRoot(args[1]);
    const found = findingsInText(file, readFileSync(0, 'utf8')).filter(finding => !finding.kept);
    for (const finding of found) console.error(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.text}`);
    for (const [rule, words] of new Map(found.map(finding => [finding.rule, finding.says]))) console.error(`\n${rule}: ${words}`);
    return found.length ? 1 : 0;
  }
  if (args.some(arg => arg.startsWith('-') && arg !== '--count')) throw new Error('unknown one-look option');
  const count = args.includes('--count');
  const given = args.filter(arg => arg !== '--count').map(fileAtRoot);
  const found = oneLookFindings(given.length ? given : lookFiles(repositoryRoot), repositoryRoot);
  if (count) {
    const by = {};
    for (const finding of found) by[finding.rule] = (by[finding.rule] ?? 0) + 1;
    console.log(JSON.stringify({ findings: found.length, by_rule: by }));
  }
  if (found.length) {
    for (const finding of found) console.error(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.text}`);
    for (const [rule, words] of new Map(found.map(finding => [finding.rule, finding.says]))) console.error(`\n${rule}: ${words}`);
    return 1;
  }
  return 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runOneLookCli(); }
  catch (error) { console.error(`one-look: ${error.message}`); process.exitCode = 2; }
}
