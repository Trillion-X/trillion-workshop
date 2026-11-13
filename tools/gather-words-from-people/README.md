# tools/gather-words-from-people/

Gathers words from people into an ordinary list: ask each person once for a case, keep what they say with the consent they gave, approve it exactly as it was reviewed, and read back only the words that may be shown on a page. Testimonials, reviews, case-study quotes and feedback are all this job; nothing here names one of them. Four Workshop tools run in the deployed tool container and reach the person's records through the records door (`tools/records-door`): `tool:ask-people-for-words`, `tool:keep-the-words-a-person-gave`, `tool:approve-words-to-show` and `tool:read-words-that-may-show`.

The list is an ordinary list. Its own definition holds a `gathers` block that says, as data, which of its fields hold what and which consents allow showing; the tools read that block and write rows of that list. A business that gathers words adds the fields and the block to a list it already has, or makes a list. There is no store, row type or tool for any one business or kind of words.

```json
"gathers": {
  "fields": { "words": "text", "who": "author", "person": "person", "consent": "consent", "consent_note": "consent_note",
              "status": "status", "case": "case", "win": "win", "asked_at": "asked_at", "approved_identity": "approved_identity" },
  "consents": [
    { "id": "full-name",  "label": "Show my words with my full name",       "may_show": true,  "name_use": "full" },
    { "id": "first-name", "label": "Show my words with my first name only", "may_show": true,  "name_use": "first" },
    { "id": "no-name",    "label": "Show my words with no name",            "may_show": true,  "name_use": "none" },
    { "id": "private",    "label": "Keep my words private",                 "may_show": false }
  ],
  "anonymous_heading": "A customer",
  "states": { "asked": "asked", "received": "received", "approved": "approved", "declined": "declined", "withdrawn": "withdrawn" },
  "ask": { "subject": "How did it go, {name}?", "body": "Hi {name}, ... Reply only if you want to." }
}
```

Every value is the person's: a field id from the list's `fields`, a consent id and label, what each state is called, the words of the ask. `{name}` in the ask is the only blank. `name_use` says how a speaker may appear: `full` the whole name, `first` the first word of it, `none` the list's `anonymous_heading`.

## Files

| File | Purpose |
|------|---------|
| `read-data/gathered-words.mjs` | `readGathers` (the list's block checked against the list's own fields, every problem named in one refusal), `shownIdentity` (the BLAKE3 identity of the speaker, words and consent together), `headingFor`, and the row ids for an asked person and for words nobody asked for. Pure. |
| `do-work/gather-words-on-the-records-door.mjs` | The four tools as functions run by `tools/records-door/do-work/run-an-export.mjs`: `askPeopleForWords`, `keepTheWordsAPersonGave`, `approveWordsToShow`, `readWordsThatMayShow`. |
| `tool-rows.json` | The four tool rows. Each is granted the list (read) and the list's own row type, which it names in its input (`type`, `record:<row_type>`), so a row type is never guessed. |
| `part.json` | No public files: only the tools run this code. |
| `test/gather-words.test.mjs` | The four tools over a made-up list in a small in-memory door: asking once, consent, approval pinned to the exact words, withdrawal, the held-back reasons, and a write refused when the row moved. Every name and line is invented. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `askPeopleForWords` | `{ list, type, case, people: [{ id, name, address?, win }], now? } => { asked: [{ row_id, person, draft: { to, subject, body } }], skipped: [{ person, reason }] }` | One asked row per person who may be asked; the draft goes out through the person's own sending tool. |
| `keepTheWordsAPersonGave` | `{ list, type, row_id? \| who, words, consent, consent_note } => { row_id, status, changed }` | The words and the consent that came with them; the row becomes received and loses any approval. |
| `approveWordsToShow` | `{ list, type, row_id, decision: approve \| decline \| withdraw, reviewed_words? } => { row_id, status }` | Approval pins the speaker, words and consent together. |
| `readWordsThatMayShow` | `{ list, type, limit? } => { items: [{ heading, body, row_id }], shown, may_show_total, held_back }` | The items are what `tool:write-a-sales-page` takes as a proof section's items. |

## Invariants

- A person is asked once for a case: the asked row's id is the identity of the case and the person, so a second ask finds the first and is skipped (`already_asked`), and the row is left as it was. Another case may ask the same person again.
- A person is asked only with `win`, a reference to their own positive word that made this the time to ask; without it they are skipped (`no_win`) and nothing is written. The tools cannot check what the reference points at; the caller names where it is. The ask is optional, asks for no rating and offers no incentive: those are the words of the list's `ask`, which the person writes.
- The tools send nothing. The draft carries the address; the kept row never does.
- Words are kept only with a consent id the list declares and `consent_note`, the person's own words that gave it (or where they are). Keeping words again changes them, the consent and the note, takes away any approval and makes the row received. A withdrawn row takes no more words. The same call again changes nothing, so a retry never takes an approval away.
- Approval takes `reviewed_words` equal to the words now in the row, a received row and a consent that allows showing. It writes the identity of the speaker, the words and the consent into the row. A write is conditional on the row as it was read, so a row that moved is refused, never overwritten.
- `readWordsThatMayShow` returns a row only when its state is approved, its pin still matches what the row says now, and its consent still allows showing. A change by any means (a tool, a hand edit, a list change that closes a consent) stops it showing at once. Every other row is counted in `held_back` by reason (`not_approved`, `changed_since_approved`, `consent_does_not_allow_showing`) and none of its words or name leave. A list that already holds words with no state or consent shows none of them until each is asked for and approved.
- A name leaves only as its consent says; a speaker who agreed to show words with no name appears under the list's `anonymous_heading`.

## Not brought in

- Sending. `tools/send-messages` is the one way a message leaves, under the account's mail rules; the draft here is its input.
- A public form that a person fills in from a link. Words arrive as the AI or the person calls `tool:keep-the-words-a-person-gave`; a form on a page is `tools/place-a-sign-up-form-or-a-published-recipe-on-a-site`.
- Writing the page. `tool:read-words-that-may-show` gives items; `tool:write-a-sales-page` writes the page from them.

## Dependencies

**Depends on:** `tools/records-door` (the run's door), `tools/content-identity` (the BLAKE3 identity of JSON), Node in the tool container.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names).
