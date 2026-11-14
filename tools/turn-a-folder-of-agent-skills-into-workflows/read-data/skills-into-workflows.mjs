// tools/turn-a-folder-of-agent-skills-into-workflows/read-data/skills-into-workflows.mjs
//
// Purpose
//   Turns a person's own agent skills into workflows in their own account. The skills are the rows of their agent-skills
//   list (each file of a skill folder is a row, a long file in parts: document.parent, document.part, document.text); a
//   skill is a folder holding a SKILL.md with a `name` and a `description` in its front matter. One skill becomes one
//   workflow: a row in their list of workflows and one step row, whose `do` is the skill's instructions; its text files
//   ride along under `files`. Ported from old Trillion's scripts/skills-to-workflows.mjs and src/skill-rows.mjs (commit
//   99651cea06), with the same screens (data/skill-import-rules.json).
//
//     turnSkillsIntoWorkflows(input, { door }) -> { made, home, stale, written }
//       input: { private_words?: string[], folder?: string, dry_run?: boolean }, and the run's request key in task
//
// Non-negotiable invariants
//   1. The rows go only into the person's own account (through their records door); nothing here reaches the public
//      Workshop, so a skill's licence is recorded on the row's source and is not a gate.
//   2. A skill becomes a workflow only when none of the text that would ship matches a never_share pattern (a secret key,
//      a computer path, an email address, a phone number) or one of the person's private words. The text screened is
//      exactly the text that ships; a skill that fails stays home and the reasons are named, never the matched text.
//   3. A re-run writes the same ids, so it updates; a workflow whose skill is gone or held back is named under `stale`
//      and left as it is (the person removes it), so nothing is deleted here.
//   4. Nothing here names a skill, an author, a subject or a computer. Screens, budgets and file types are data.

import { readFileSync } from 'node:fs';
import { recipeProblems } from '../../workflows/read-data/recipe-problems.mjs';

const RULES = JSON.parse(readFileSync(new URL('../data/skill-import-rules.json', import.meta.url), 'utf8'));
const BATCH = 200;
const text = value => (typeof value === 'string' ? value : '');
const dirOf = path => path.slice(0, Math.max(path.lastIndexOf('/'), 0));
const baseOf = path => path.slice(path.lastIndexOf('/') + 1);

/** The front matter of a SKILL.md as flat fields, and the text after it. */
export function frontMatterOf(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { fields: {}, body: source };
  const fields = {};
  const lines = match[1].split(/\r?\n/);
  for (let at = 0; at < lines.length; at += 1) {
    const line = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[at]);
    if (!line) continue;
    let value = line[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded = [];
      while (at + 1 < lines.length && (/^\s+\S/.test(lines[at + 1]) || lines[at + 1].trim() === '')) folded.push(lines[(at += 1)].trim());
      value = folded.join(value.startsWith('>') ? ' ' : '\n').trim();
    } else if (/^["']/.test(value) && value.endsWith(value[0]) && value.length > 1) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    fields[line[1]] = value;
  }
  return { fields, body: source.slice(match[0].length) };
}

/** The licence a skill's folder declares (front matter, then a licence file), as an SPDX id, or null. */
export function licenceOf(fields, licenceText, rules = RULES) {
  const declared = String(fields.license ?? fields.licence ?? '').trim();
  const spdx = declared.replace(/\s+license$/i, '').trim();
  if (spdx && !/^see |terms in/i.test(spdx)) return spdx;
  if (licenceText) for (const row of rules.licence_words) if (licenceText.includes(row.words)) return row.licence;
  return declared || null;
}

/** Who a licence names as its holder (author_words), or null. */
export function authorOf(licenceText, rules = RULES) {
  if (!licenceText) return null;
  for (const row of rules.author_words ?? []) {
    const name = new RegExp(row.pattern, 'm').exec(licenceText)?.[row.group ?? 1]?.trim().replace(/[.,;]+$/, '');
    if (name) return name;
  }
  return null;
}

const wordsOf = name => name.replace(/[-_]+/g, ' ').replace(/^\w/, letter => letter.toUpperCase());

/** Every problem that keeps a skill's shipped text home, each named once and never quoting the text. */
export function screenProblems(texts, privateWords, rules = RULES) {
  const patterns = [
    ...rules.never_share.map(row => ({ says: row.says, test: new RegExp(row.pattern) })),
    ...(privateWords.length ? [{ says: 'names one of your private people, businesses or systems', test: new RegExp(`(?<![\\w-])(?:${privateWords.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`, 'i') }] : []),
  ];
  const problems = [];
  for (const { says, test } of patterns) {
    const hit = Object.entries(texts).find(([, body]) => test.test(body));
    if (hit) problems.push(`${hit[0]} ${says}`);
  }
  return problems;
}

/**
 * The files the skills list holds, whole: rows that are parts of one file are joined in order. A file whose parts are not
 * all here is `incomplete`. -> Map path -> { path, folder, ext, text | null, incomplete }
 */
export function filesOfRows(rows) {
  const files = new Map();
  for (const row of rows) {
    const value = row.value ?? row.values ?? {};
    const path = text(value['document.parent']) || text(value['file.path']);
    if (!path) continue;
    const file = files.get(path) ?? { path, folder: text(value['file.folder']) || dirOf(path), ext: text(value['file.ext']).toLowerCase() || (baseOf(path).includes('.') ? baseOf(path).split('.').pop().toLowerCase() : ''), parts: new Map(), expected: 1 };
    const at = Number.isInteger(value['document.part']) ? value['document.part'] : 1;
    file.parts.set(at, typeof value['document.text'] === 'string' ? value['document.text'] : null);
    if (Number.isInteger(value['document.parts'])) file.expected = value['document.parts'];
    files.set(path, file);
  }
  const whole = new Map();
  for (const [path, file] of files) {
    const ordered = [...file.parts.entries()].sort((a, b) => a[0] - b[0]);
    const complete = ordered.length === file.expected && ordered.every(([, body]) => body !== null);
    whole.set(path, { path, folder: file.folder, ext: file.ext, text: complete ? ordered.map(([, body]) => body).join('') : null, incomplete: ordered.length !== file.expected });
  }
  return whole;
}

/** Every skill: its SKILL.md and the files under its folder (a folder with its own SKILL.md is its own skill). */
export function skillsOfFiles(files, rules = RULES, under = '') {
  const all = [...files.values()].filter(file => file.folder.startsWith(under) && !file.folder.split('/').some(part => rules.skipped_folders.includes(part)));
  const folders = new Set(all.filter(file => baseOf(file.path) === rules.skill_file_name).map(file => file.folder));
  const ownerOf = folder => { for (let at = folder; ; at = dirOf(at)) { if (folders.has(at)) return at; if (!at.includes('/')) return null; } };
  const skills = new Map([...folders].sort().map(folder => [folder, { folder, skill: null, files: [] }]));
  for (const file of all) {
    const owner = ownerOf(file.folder);
    if (owner === null) continue;
    const skill = skills.get(owner);
    if (file.path === `${owner}/${rules.skill_file_name}`) skill.skill = file;
    else skill.files.push({ path: file.path.slice(owner.length + 1), ext: file.ext, text: file.text, incomplete: file.incomplete });
  }
  return [...skills.values()];
}

/** One skill as the rows of a workflow in the person's account and the files that did not fit, or why it stays home. */
export function skillRows({ folder, skill: skillFile, files }, privateWords, rules = RULES) {
  const name = baseOf(folder);
  if (!skillFile || skillFile.text === null) return { skill: name, folder, reasons: [`${rules.skill_file_name} is not whole in the skills list`] };
  const skillText = skillFile.text;
  const licenceFile = files.find(file => /^licen[cs]e/i.test(baseOf(file.path)) && !file.path.includes('/'));
  const { fields, body } = frontMatterOf(skillText);
  const skill = String(fields.name || name).trim();
  const job = String(fields.description ?? '').trim();
  const slug = skill.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const id = `${rules.id_prefix}${slug}`;
  const reasons = [];
  if (!job) reasons.push(`${rules.skill_file_name} has no description to find it by`);
  if (!body.trim()) reasons.push(`${rules.skill_file_name} has no instructions`);
  if (skillText.length > rules.budget.max_row_characters) reasons.push(`${rules.skill_file_name} is ${skillText.length} characters; a workflow holds at most ${rules.budget.max_row_characters}`);
  const licence = licenceOf(fields, licenceFile?.text ?? null, rules);
  const author = fields.author || authorOf(licenceFile?.text ?? null, rules);
  // The files that ride along: text only, smallest first, while the row stays inside its budget.
  const kept = {};
  const left_out = [];
  let size = skillText.length + job.length + 2000;
  for (const file of [...files].filter(item => item !== licenceFile && baseOf(item.path) !== '.DS_Store').sort((a, b) => (a.text?.length ?? Infinity) - (b.text?.length ?? Infinity) || a.path.localeCompare(b.path))) {
    if (file.text === null || !rules.text_files.includes(file.ext) || file.text.length > rules.budget.max_file_characters || size + file.text.length > rules.budget.max_row_characters) { left_out.push(file.path); continue; }
    kept[file.path] = file.text;
    size += file.text.length;
  }
  reasons.push(...screenProblems({ [rules.skill_file_name]: skillText, ...kept }, privateWords, rules));
  if (reasons.length) return { skill, folder, reasons };
  const listed = Object.keys(kept);
  const title = String(fields.title || wordsOf(skill));
  const recipe = {
    kind: 'workflow-recipe', id, label: title, job,
    source: { from: 'agent skill', name: skill, ...(licence ? { licence } : {}), ...(author ? { author: String(author) } : {}) },
    input_schema: { type: 'object', properties: { request: { type: 'string', description: 'What you want done with this skill, in plain words.' } } },
    steps: [{
      id: 'follow-the-skill', title,
      do: [
        `Do the request in this run's input by following the ${skill} skill below exactly.`,
        listed.length ? `It comes with ${listed.length} file${listed.length === 1 ? '' : 's'} (${listed.join(', ')}); describe_workflow returns each under files.` : null,
        left_out.length ? `Files it names that are not included here: ${left_out.join(', ')}.` : null,
        '',
        body.trim(),
      ].filter(line => line !== null).join('\n'),
      submit: { type: 'object', required: ['result'], properties: { result: { type: 'string', description: 'What was done or made, in plain words.' }, files: { type: 'array', items: { type: 'string' }, description: 'Files made, by name.' } } },
    }],
    ...(listed.length ? { files: kept } : {}),
    ...(left_out.length ? { files_left_out: left_out } : {}),
  };
  const problems = recipeProblems(recipe);
  if (problems.length) return { skill, folder, reasons: problems };
  const json = JSON.stringify;
  const [step] = recipe.steps;
  return {
    skill, folder, id,
    rows: [
      { id: `${rules.step_row_type}:skill-${slug}--${step.id}`, type: rules.step_row_type, value: { recipe: [`skill-${slug}`], step: step.id, position: 1, title: step.title, do: step.do, submit: json(step.submit) } },
      { id: `${rules.recipe_row_type}:skill-${slug}`, type: rules.recipe_row_type, value: { recipe: id, title, job, input_schema: json(recipe.input_schema), source: json(recipe.source), ...(listed.length ? { files: json(kept) } : {}), ...(left_out.length ? { files_left_out: left_out } : {}) } },
    ],
  };
}

/** Every skill of the rows, as workflows to write and the skills that stay home. A name seen once is not taken again. */
export function workflowsFromRows(rows, { privateWords = [], folder = '', rules = RULES } = {}) {
  const made = [];
  const home = [];
  const ids = new Set();
  for (const skill of skillsOfFiles(filesOfRows(rows), rules, folder)) {
    const result = skillRows(skill, privateWords, rules);
    if (!result.rows) { home.push(result); continue; }
    if (ids.has(result.id)) { home.push({ skill: result.skill, folder: result.folder, reasons: [`${result.id} is already taken by another skill`] }); continue; }
    ids.add(result.id);
    made.push(result);
  }
  return { made, home };
}

/** The run: read the person's skills, write their workflows, name what stayed home and what was left behind. */
export async function turnSkillsIntoWorkflows({ input = {}, task = {} } = {}, { door } = {}) {
  const privateWords = Array.isArray(input.private_words) ? input.private_words.filter(word => typeof word === 'string' && word.trim()).map(word => word.trim()) : [];
  const rows = [];
  for await (const row of door.list({ type: RULES.skill_row_type })) rows.push(row);
  const { made, home } = workflowsFromRows(rows, { privateWords, folder: typeof input.folder === 'string' ? input.folder : '' });
  const writes = made.flatMap(item => item.rows);
  const now = new Set(made.map(item => item.id));
  const stale = [];
  for await (const row of door.list({ type: RULES.recipe_row_type, prefix: `${RULES.recipe_row_type}:skill-`, fields: ['recipe', 'source'] })) {
    let source = row.value?.source;
    try { source = typeof source === 'string' ? JSON.parse(source) : source; } catch { source = null; }
    if (source?.from === 'agent skill' && typeof row.value.recipe === 'string' && !now.has(row.value.recipe)) stale.push(row.value.recipe);
  }
  let written = 0;
  if (!input.dry_run) {
    const key = task.request_key ?? `turn-skills:${made.length}`;
    for (let at = 0; at < writes.length; at += BATCH) {
      await door.write(writes.slice(at, at + BATCH), { key: `${key}:${at / BATCH}` });
      written += Math.min(BATCH, writes.length - at);
    }
  }
  return { made: made.map(item => item.id), home: home.map(({ skill, reasons }) => ({ skill, reasons })), stale, written, dry_run: Boolean(input.dry_run) };
}
