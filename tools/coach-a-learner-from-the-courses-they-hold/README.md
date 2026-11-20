# tools/coach-a-learner-from-the-courses-they-hold/

Three Workshop tools that let a learner's own AI (Claude, ChatGPT or another) read the lessons the learner holds in a school's courses, through the school's engine: the list of lessons, one lesson, and a search of what the coach teaches. The answers come only from the courses the learner's held access opens.

Status: a draft, not landed. Not committed, not pushed, not applied to any server.

## Files

| File | Purpose |
|------|---------|
| `do-work/coach.mjs` | The three operations and the admission. Pure: each reads through `{ query(text, params) → rows }` handed in, inside a read-only transaction on each held connection. Also `HELD_CONNECTIONS` (the descriptor and the held name of each connection) and `settingsOf` (reads the school's settings row). |
| `do-work/run.mjs` | The container process the rows run: `node run.mjs <operation>`, the request on stdin. Opens the three held connections on their fixed descriptors, reads the school's settings, applies its statement time limit, prints the answer as JSON on stdout. A refusal or failure goes to stderr as plain words, exit 1. Connection strings and passwords are taken out of every message. |
| `kits/*.json` | One kit per tool, as the Workshop's kit check requires. |
| `tool-rows.json` | The three Workshop rows: `tool:list-the-lessons-i-hold`, `tool:read-a-lesson-i-hold`, `tool:search-what-my-coach-teaches`. Each `invoke.kind` is `container`, with the pinned `pg` tarballs and their blake3 fetches, `stdin.fill.from: input`, `stdout: json` and `internet: true`. |
| `test/coach.test.mjs` | 15 tests on PGlite with made-up rows, shaped like real tables. |
| `part.json` | Nothing here is imported by other code. |

## Connections and logins

Each row mounts three connections under fixed names. Each owner holds a read-only login under its name. These are new least-privilege logins, not copies of other keys.

| Descriptor | Held name | Database | The login reads |
|------------|-----------|----------|-----------------|
| 3 | `coach-sign-ins-connection` | sign-in store | the sign-in users table only |
| 4 | `coach-access-connection` | access database | the offers, payment events, access grants and people tables, and the `coach_settings` table |
| 5 | `coach-lessons-connection` | lessons database | the courses, lessons, videos, timed words, passages and articles tables |

Each login should be SELECT-only on just the tables the school's settings name. Make it with `tool:run-sql-in-my-database`'s read-only recipe, so the login can read and cannot write, change a table or make another login.

## The school's settings

The settings are one row in the access database's `coach_settings` table: `id` = `'coach'`, `settings` = jsonb. `run.mjs` reads it at the start of each run. A missing table, a missing row, or settings without the fields below is refused as "This school has not set up its coach yet."

Shape (placeholder names):

```json
{
  "issuer_url": "https://school.example.test",
  "required_access_ref": "access:coach",
  "statement_timeout_ms": 15000,
  "most_words": 4000,
  "most_matches": { "default": 20, "cap": 50 },
  "transcript_ref": {
    "from_video_url": "(?:youtu\\.be/|[?&]v=)([A-Za-z0-9_-]{11})",
    "template": "record:transcript-entry:youtube-{id}"
  },
  "names": {
    "user": { "table": "users", "id": "id", "email": "email", "verified": "email_verified" },
    "offers": { "table": "offers" },
    "payment_events": { "table": "payment_events", "email": "customer_email", "provider_object_ref": "provider_object_ref", "subscription_id": "subscription_id", "occurred_at": "occurred_at" },
    "access_grants": { "table": "access_grants", "id": "id", "person_id": "person_id", "email": "email", "access_ref": "access_ref", "starts_at": "starts_at", "ends_at": "ends_at" },
    "people": { "table": "people", "id": "id", "email": "email" },
    "transcript_segments": { "table": "transcript_segments", "ref": "transcript_ref", "start_ms": "start_ms", "text": "text" },
    "courses": { "table": "courses", "id": "id", "title": "title", "sort_order": "sort_order", "access_refs": "access_refs" },
    "lessons": { "table": "lessons", "course_id": "course_id", "lesson_id": "lesson_id", "position": "position", "title": "title", "video_id": "video_id", "collection": "collection" },
    "videos": { "table": "videos", "id": "id", "video_url": "video_url", "transcript": "transcript" },
    "words": { "table": "lesson_words", "video_id": "video_id", "n": "n", "word": "word", "start_s": "start_s" },
    "passages": { "table": "passages", "id": "id", "body": "body", "collection": "collection" },
    "articles": { "table": "articles", "path": "path", "title": "title", "body": "body", "published": "published" }
  }
}
```

| Field | Meaning |
|-------|---------|
| `issuer_url` | The issuer whose caller ids this school accepts. Its tag is the first 24 hex characters of BLAKE3 of this URL. |
| `required_access_ref` | The access ref a learner must hold to use the coach at all. |
| `statement_timeout_ms` | The statement time limit set on each connection. |
| `most_words` | The most words one read answers (passages and transcript together). |
| `most_matches` | `default` and `cap` for the search's `most`. |
| `transcript_ref` | `from_video_url`: the regex that takes the video id out of a video link. `template`: the transcript ref in the transcript-segments table, with `{id}` for that id. |
| `names` | Per logical table: the table name, and each column name the code reads. Identifiers must be plain names. |

## Who is asking

The engine admits the caller through a team share grant with identity `self` and fills `grant_person` with the caller's id, `<issuer tag>_<sub>`. The issuer tag is the first 24 hex characters of BLAKE3 of the issuer URL (trillion-rust `src/account/issuers.rs`, `issuer_tag`).

Each step is refused in plain words when it fails:

1. `grant_person` is present and its issuer tag equals the settings' issuer. Another issuer is refused.
2. The sub names a person in the sign-in store. An unknown person is refused.
3. That person's email is verified. An unverified email is refused, even with a purchase on it.
4. The held access comes from `heldAccessOf`, which calls `heldAccessOfRequest` from `tools/paid-access/read-data/who-holds-access.mjs` (the paid-access function) with the offers, the payment events for the email and the access grants. The learner must hold `required_access_ref`.
5. Courses are open when their access refs include a held ref. A lesson outside the open courses is refused.

## Answers

- `listTheLessonsIHold`: open courses with id and title; lessons with id, title, video link and `has_transcript`.
- `readALessonIHold` (`lesson_id`): title, course, video link, passages and a timed transcript as lines of `{ start_s, text }`. Passages are the video's transcript when it has one, else the passages of the lesson's collection. The timed transcript comes from the lesson's timed words, or from its transcript segments when it has no words. Cut to `most_words`, passages first; `truncated` says so.
- `searchWhatMyCoachTeaches` (`query`, `most?`): matches in held lesson titles, passages, timed transcript lines and transcript segments (segments only for lessons with no timed words), and published articles. Each match has its kind, its lesson id (none for an article), a snippet and `start_s` where it is spoken.

## Design

- Every read is parameterized SQL, with table and column names quoted from the settings. Each request runs `BEGIN READ ONLY` on each held connection, then `COMMIT`, or `ROLLBACK` on failure.
- The held access is folded by the paid-access function. The coach does not decide access itself.
- Search groups timed words into sentences inside the query, so only matching lines leave the database.
- A refusal's text is written for the learner and holds no secret. The process never prints a connection string.

## Dependencies

- Package files, as in `tool:see-who-holds-paid-access`: this folder's `do-work`; `tools/paid-access/read-data` (the access function and what it imports); the formula engine's built bytes; `@noble/hashes`.
- `tools/run-sql-in-my-database/do-work/through-the-run-proxy.mjs` for the connection tunnel, and the same pinned `pg` 8.23.1 tarballs.
- Tests: `@electric-sql/pglite` and `@noble/hashes` from the root `package.json`.

## Test

From the Workshop root:

```
env -u GIT_INDEX_FILE node --import ./test-helpers/own-tmpdir.mjs --test --test-force-exit tools/coach-a-learner-from-the-courses-they-hold/test/coach.test.mjs
```

The kit check: `node test-helpers/every-item-kit.mjs` from the Workshop root.
