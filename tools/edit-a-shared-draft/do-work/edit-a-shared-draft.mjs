// tools/edit-a-shared-draft/do-work/edit-a-shared-draft.mjs
//
// Purpose: One draft that several people write together (`tool:edit-a-shared-draft`). The draft lives in its owner's store only.
// A co-author reaches it through a run share that names only this tool, so the edit runs at the owner's door and is written
// there, never on the co-author's computer. Each author then approves the one content identity they read, in their OWN store,
// and an approval counts only while it still names the draft's current identity. The tool does the work only a function can do
// here: it computes the content identity of the draft (BLAKE3 through the content-identity owner), refuses a stale or frozen
// edit, judges who may change what, and works out whether every author has approved the same version. It reaches no database
// and no share record (rule a-tool-is-only-what-the-store-cannot-do): the caller reads the draft from its store, passes it in as
// `stored`, and writes back the `writes` the answer lists, each only while its store still holds the `expect`.
//
//   editSharedDraft(input)  input { op: "edit" | "approve" | "freeze" | "unfreeze" | "check", draft_id, author?, owner?,
//                           expect?, changes?, stored?, now? } -> the answer, with `writes` (possibly empty).
//
//   stored  { draft: the draft record at draft:<draft_id> as its store holds it (null when there is none), approval: the caller's
//           own approval record for this draft (approve only; null when it has none), approvals: the approval records the owner
//           read back from each author's share (check only) }.
//   writes  [{ kind: "draft" | "approval", address, value, expect }]. `expect` is the content identity the stored record had when
//           this was made (null when there was no record): the caller writes only while the store still holds `expect`.
//
// A draft record: { owner, authors: [principal], title, body, pictures: [{ id, identity }], sections: { principal: text },
// status: "open" | "frozen", edits: [{ by, at, from, to }] }. Its content identity is the identity of { title, body, pictures,
// sections } alone (status and edits are not content), so an unchanged text keeps its identity and any edit changes it.
//
// Non-Negotiable Invariants:
// - An edit lands only if `expect` is the draft's current content identity and the draft is open. Otherwise it is refused with
//   the current identity, and no write is made.
// - An author edits title, body and pictures, and only their own entry in sections. A person who is not an author is refused.
// - Freezing stops every edit. An approval names the identity it approves, so any later change makes it stale: a check then
//   counts it as withdrawn, and the draft is not ready until every author approves the new identity.
// - Only the owner freezes and unfreezes. Approvals and drafts are written only to the store the caller passes in.
//
// Key Concepts: `identity` (the content identity, `1f:` + BLAKE3 of the canonical JSON of the content), `expect` (compare and set
// on that identity), `approval` (one person's record of the identity they read and approved, kept in their own store).
//
// Security Considerations: the tool holds no key and no connection. It refuses an author who is not named in `authors`, so a
// share that grants the tool is not enough by itself; the draft's own list decides who may change it.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import data from '../read-data/edit-a-shared-draft.json' with { type: 'json' };

const words = data.words;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The content identity of a draft: only what the authors wrote, never its status or its edit log.
export function contentOf(draft) {
  return { title: draft.title ?? '', body: draft.body ?? '', pictures: draft.pictures ?? [], sections: draft.sections ?? {} };
}

export function identityOf(draft) {
  return makeHashCodeHexFromJson(contentOf(draft));
}

function refuse(op, reason, said, extra = {}) {
  return { op, ok: false, refused: reason, said, writes: [], ...extra };
}

function editOf(input, draft) {
  const { author, expect, changes = {} } = input;
  if (!draft) return refuse('edit', 'no_draft', words.no_draft);
  if (draft.status === 'frozen') return refuse('edit', 'frozen', words.frozen);
  if (!draft.authors.includes(author)) return refuse('edit', 'not_an_author', words.not_an_author);
  const current = identityOf(draft);
  if (expect !== current) return refuse('edit', 'stale', words.stale, { current });
  if (!object(changes)) return refuse('edit', 'bad_field', words.bad_field);
  for (const key of Object.keys(changes)) {
    if (data.fields.includes(key)) continue;
    if (key === data.sections_field) {
      if (!object(changes.sections) || Object.keys(changes.sections).some(who => who !== author)) {
        return refuse('edit', 'not_your_section', words.not_your_section);
      }
      continue;
    }
    return refuse('edit', 'bad_field', words.bad_field);
  }
  const next = {
    ...draft,
    ...Object.fromEntries(data.fields.filter(field => field in changes).map(field => [field, changes[field]])),
    sections: { ...(draft.sections ?? {}), ...(changes.sections ?? {}) },
  };
  const to = identityOf(next);
  if (to === current) return refuse('edit', 'no_change', words.no_change);
  next.edits = [...(draft.edits ?? []), { by: author, at: input.now ?? new Date().toISOString(), from: current, to }];
  return {
    op: 'edit',
    ok: true,
    draft_id: input.draft_id,
    identity: to,
    writes: [{ kind: 'draft', address: data.record_prefix + input.draft_id, value: next, expect: current }],
  };
}

function approveOf(input, draft) {
  const { author, expect } = input;
  if (!draft) return refuse('approve', 'no_draft', words.no_draft);
  if (!draft.authors.includes(author)) return refuse('approve', 'not_an_author', words.not_an_author);
  const current = identityOf(draft);
  if (expect !== current) return refuse('approve', 'approval_stale', words.approval_stale, { current });
  // The approval record is kept in the approver's own store; `expect` is the identity its previous approval named (null: none).
  const previous = input.stored?.approval ?? null;
  const value = { draft_id: input.draft_id, principal: author, identity: current, at: input.now ?? new Date().toISOString() };
  return {
    op: 'approve',
    ok: true,
    draft_id: input.draft_id,
    identity: current,
    writes: [{ kind: 'approval', address: data.approval_prefix + input.draft_id, value, expect: previous ? previous.identity : null }],
  };
}

function setStatus(op, input, draft, status) {
  if (!draft) return refuse(op, 'no_draft', words.no_draft);
  if (input.owner !== draft.owner) return refuse(op, 'not_owner', words.not_owner);
  const current = identityOf(draft);
  if (input.expect !== current) return refuse(op, 'stale', words.stale, { current });
  const next = { ...draft, status };
  return { op, ok: true, draft_id: input.draft_id, identity: current, writes: [{ kind: 'draft', address: data.record_prefix + input.draft_id, value: next, expect: current }] };
}

// Who has approved the draft's current identity. An approval for any other identity is withdrawn, and an approval by someone who
// is not an author is ignored: the draft's own author list decides.
export function judgeApprovals(draft, approvals = []) {
  const current = identityOf(draft);
  const approved = [];
  const withdrawn = [];
  for (const record of approvals) {
    if (!record || !draft.authors.includes(record.principal)) continue;
    if (record.identity === current) approved.push(record.principal);
    else withdrawn.push(record.principal);
  }
  const missing = draft.authors.filter(author => !approved.includes(author));
  return { identity: current, approved, withdrawn, missing, ready: missing.length === 0 };
}

export function editSharedDraft(input) {
  const op = input.op;
  const draft = input.stored?.draft ?? null;
  if (op === 'edit') return editOf(input, draft);
  if (op === 'approve') return approveOf(input, draft);
  if (op === 'freeze') return setStatus(op, input, draft, 'frozen');
  if (op === 'unfreeze') return setStatus(op, input, draft, 'open');
  if (op === 'check') {
    if (!draft) return refuse(op, 'no_draft', words.no_draft);
    return { op, ok: true, draft_id: input.draft_id, ...judgeApprovals(draft, input.stored?.approvals ?? []), writes: [] };
  }
  return refuse(op, 'bad_field', words.bad_field);
}
