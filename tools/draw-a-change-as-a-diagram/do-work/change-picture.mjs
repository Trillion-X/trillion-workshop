// tools/draw-a-change-as-a-diagram/do-work/change-picture.mjs
//
// A CHANGE BETWEEN TWO POINTS IN A CODE HOST, AS A PICTURE AND ONE COMMENT OF OURS THAT STAYS UP TO DATE.
//
// Purpose: reading a change as a list of files hides its shape. This reads the change through the person's own connection to the
// host (the connector operations the host's DATA row names), draws it with the graph engine (change-graph.mjs, or a richer graph
// document an AI wrote from the bounded input), writes the comment for what that host's comment surface can show
// (surface-compose.mjs), and, when asked, keeps ONE comment of ours on the pull request (owned-upsert.mjs): found by marker and
// author, never written twice, never written for a change that moved on while it was being made.
//
// Non-negotiable invariants:
//   1. Hosts are DATA rows (./change-picture.json): which connector operations, which comment fields, which surface record.
//      Nothing here names a host.
//   2. Reading is bounded by pages (DATA) and the model-input listing is what author-input.mjs would send, shown, never sent.
//   3. A graph document handed in is validated by the graph contract before it is drawn; a bad one is refused with its first error.
//   4. Writing is an opt-in (`post`); without it nothing is written anywhere.
//   5. The connector runner is handed in: this never reaches the network itself.
//
// Key concept: `pictureChange({ forge?, owner, repo, base, head, issue_number?, document?, image_url?, dark_image_url?, post?, run }, settings?)`
//   run(tool_id, input) -> the connector operation's output. -> { ok, files, picture, outbound, body, composed, posted }
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import rules from '../read-data/change-picture.json' with { type: 'json' };
import { changeGraph } from './change-graph.mjs';
import { validateGraphDocument } from './graph-contract.mjs';
import { graphSvgAssets } from './graph-svg.mjs';
import { boundAuthorInput, outboundList } from './author-input.mjs';
import { capabilityOf, composeFor } from './surface-compose.mjs';
import { upsertOwned } from './owned-upsert.mjs';

const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));
const at = (value, path) => path.split('.').reduce((current, key) => (current !== null && typeof current === 'object' && Object.hasOwn(current, key) ? current[key] : undefined), value);
const refusal = (code, values, settings) => ({ ok: false, error: code, said: fill(settings.errors[code], values) });
const keyOf = text => bytesToHex(blake3(new TextEncoder().encode(text))).slice(0, 12);

async function readChange({ forge, repo, base, head, run }, settings) {
  const files = [];
  let headSha = null;
  for (let page = 1; page <= settings.compare_pages_most; page += 1) {
    const answer = await run(forge.tools.compare, { ...repo, base, head, page: String(page) });
    const got = at(answer, forge.compare.files) ?? [];
    files.push(...got);
    headSha = (at(answer, forge.compare.commits) ?? []).at(-1)?.sha ?? headSha;
    if (got.length < forge.page_size) break;
  }
  return { files, head_sha: headSha };
}

function commentSurface(forge, repo, issue, run, settings) {
  return {
    async list(page) {
      const number = page ?? 1;
      if (number > settings.comment_pages_most) throw new Error('This pull request has more comments than are read.');
      const rows = await run(forge.tools.list, { ...repo, issue_number: String(issue), page: String(number) });
      return { messages: rows.map(row => ({ id: String(at(row, forge.comment.id)), author: at(row, forge.comment.author), body: at(row, forge.comment.body) ?? '' })), next: rows.length >= forge.page_size ? number + 1 : undefined };
    },
    create: body => run(forge.tools.create, { ...repo, issue_number: String(issue), body }),
    update: (id, body) => run(forge.tools.update, { ...repo, comment_id: id, body }),
  };
}

export async function pictureChange(input, settings = rules) {
  const { owner, repo: name, base, head, issue_number: issue, document, image_url: imageUrl, dark_image_url: darkUrl, post = false, run } = input;
  const forgeId = input.forge ?? settings.default_forge;
  if (!Object.hasOwn(settings.forges, forgeId)) return refusal('UNKNOWN_FORGE', { forge: forgeId }, settings);
  const forge = settings.forges[forgeId];
  const repo = { owner, repo: name };
  const change = await readChange({ forge, repo, base, head, run }, settings);
  if (!change.files.length) return refusal('NO_FILES', {}, settings);
  const graph = document ?? changeGraph(change.files);
  const checked = validateGraphDocument(graph);
  if (!checked.ok) return refusal('BAD_DOCUMENT', { first: checked.errors[0]?.message ?? '' }, settings);
  const assets = graphSvgAssets(graph);
  const outbound = outboundList(boundAuthorInput(change.files.map(file => ({ path: file.filename, text: file.patch ?? '' }))));
  const marker = fill(settings.marker, { key: keyOf(`${forgeId}:${owner}/${name}#${issue ?? `${base}...${head}`}`) });
  const blocks = [
    { type: 'heading', text: settings.words.heading, level: 3 },
    ...(imageUrl ? [{ type: 'image', alt: graph.label, url: imageUrl, ...(darkUrl ? { dark_url: darkUrl } : {}) }] : [{ type: 'paragraph', text: settings.words.no_picture }]),
    { type: 'paragraph', text: graph.caption ?? '' },
    { type: 'collapsible', summary: fill(settings.words.fold, { count: change.files.length }), blocks: [{ type: 'list', items: change.files.map(file => `${file.status}: ${file.filename}`) }] },
  ];
  const composed = composeFor(blocks, capabilityOf(forge.surface), { marker });
  const result = { ok: true, forge: forgeId, files: change.files.length, head_sha: change.head_sha, picture: assets.manifest, svg_files: assets.files, outbound, body: composed.body, composed: { degraded: composed.degraded, unproven_used: composed.unproven_used, truncated: composed.truncated }, said: settings.words.bounded_note, posted: null };
  if (!post) return result;
  if (issue === undefined || issue === null) throw new Error('Name the pull request to write the comment on (issue_number).');
  const me = await run(forge.tools.whoami, {});
  const surface = commentSurface(forge, repo, issue, run, settings);
  let reads = 0;
  result.posted = await upsertOwned({ surface, marker, owner: at(me, forge.whoami.author_path), compose: async () => composed.body,
    // The first reading is the one the picture was made from; the second, right before the write, is read again from the host.
    currentVersion: async () => (reads++ === 0 ? change.head_sha : (await readChange({ forge, repo, base, head, run }, settings)).head_sha) });
  return result;
}
