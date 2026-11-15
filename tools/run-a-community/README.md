# Run a community

This owner keeps the community tool definitions and the shared event actions. An event is an existing space membership with `label: "event"`; an RSVP is its member row. It does not keep a separate event database.

`moved-from.json` records the earlier moved files. `source-baselines/` records the complete original methods and route clauses at immutable source commits. Held originals are evidence, not executable implementations or retained active code.

## Event actions

`read-data/community-events.mjs` exposes `nativeCommunityEvents`, with these direct methods and `community:<method>` operations:

| Method | Behavior |
| --- | --- |
| `createEvent` | Creates one event or recurring occurrences sharing one series id. |
| `spaceEvents` | Reads visible events overlapping a time range. |
| `moveEvent` | Changes time or words; omitted end preserves duration, and explicit null removes the end. |
| `cancelEvent` | Removes the event and its RSVP rows atomically. |
| `rsvp` | Records going or declined, checking active membership and capacity. |
| `eventFile` | Produces a calendar file through the shared invitation exporter. |

`read-data/community-memberships.mjs` adapts the current records door to the existing membership fields. Its declared DATA bindings name record kinds and physical ids. Each adapter keeps its own transaction scope, so nested work on another records door cannot reuse the first door's cached rows or staged writes. A transaction stages its changes, then writes the event revision, RSVP changes, and captured authorization rows in one conditional batch. An unknown read is an error, never confirmed absence. Invitation callbacks must return a boolean: true proves acceptance, false denies, and any other result is unavailable evidence.

Permission decisions belong to the existing space-permissions owner. Checked membership and event permission callbacks must return an explicit grant or the actual matching community. Denied, unavailable, malformed, and unrelated results do not authorize a change.

## Native consumer binding

The original event routes are:

| Method | Route | Action |
| --- | --- | --- |
| POST | `/community/<id>/events` | Create |
| GET | `/community/events` | Read events across the actor's readable spaces |
| POST | `/community/events/<id>/move` | Move or edit |
| POST | `/community/events/<id>/cancel` | Cancel |
| POST | `/community/events/<id>/rsvp` | RSVP |
| GET | `/community/events/<id>/calendar` | Read calendar file |

The native task envelope separates caller input from engine-supplied task facts. Its trusted context identifies the holder account and, when disclosed, `{ kind, id }` for the actor. Actor fields inside input are not authority. Withheld identity remains withheld and cannot perform event mutations. Mapping that identity to membership references and current holdings belongs to the native binding owner. `holds: null` means paid evidence is unknown; it is not an empty grant list. The membership owner can prove owner, project, free or invited eligibility without making an unrelated paid source a prerequisite, and refuses with unavailable evidence when paid proof is required.

Calendar and space effects run only after the event transaction commits. Calendar delivery receives a captured event snapshot so cancellation does not lose the event before delivery. A failure after persistence retains the committed result and event ids for the existing recovery owner; it must not trigger duplicate event creation or create another receipt store. The current snapshot and pending effects are in memory: recovery after a crash between domain commit and effect acceptance is not proved.

Calendar UIDs retain the original producer's namespace through declared DATA. The organizer uses the community's configured reply-to first; an account fallback reads the maintained mail-settings owner. A missing or unreadable sender is not replaced with an invented address or the retired global sender.

The native calendar response requires generic text-file transport, preserving `text/calendar; charset=utf-8` and the `event.ics` download name. JSON-quoted calendar text is not a calendar download.

## Qualification state

The fresh event and membership cores and `do-work/community-event-route.mjs` request consumer are prepared, with synthetic owner-local tests. The route composes those owners with the canonical space-permissions factory; it requires actual native admission/identity, actor-space, activity, calendar, and recovery bindings. Functions cannot be supplied through tool input or DATA to stand in for those owners. Shared imports and runtime bindings remain held or unresolved, so there is no runnable CLI/catalogue or installed-route claim. Captured per-row authorization conditions do not fence new collection rows. A mutation that used a guarded collection, even an empty one, returns `community_collection_snapshot_unavailable` before writing. Point-read membership paths remain available, and read-only collection transactions do not write authorization rows. The adversarial native-conflict fixture remains TODO until the complete collection witness can join the domain commit. Cancellation currently refuses before any write when the event and RSVP removal exceeds the records door's atomic batch limit. The model's `guard_properties` describe proposed fields; they do not establish live native value validation.

The preliminary route draft was written before its raw route baseline. Its unchanged bytes and that sequencing mistake are recorded under `attempts/`; it is nonexecuted and unqualified. The fresh active route was authored after the genuine normal baseline commit `64fecded593b349c963d59f7aabbb1b72f2a1611`. `ports/community-event-route.json` excludes the attempted draft from retention proof.
