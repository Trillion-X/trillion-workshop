# tool:forward-a-fact-to-my-computer

Tells a fact this computer heard to another of your own computers, so the work that fact starts runs where your work now runs. A fact only one computer can see (a message on this Mac, a volume attached to it, one of its checkouts) is told to the computer you name, through your gateway's door, as that door's own `wake:arrive`. The far computer takes it as a sender's fact, and its wakes hear it as they hear any sender's fact.

## How it works

1. A fact this computer hears wakes one of this tool's wakes. There is one wake per fact kind, listed in `tool-rows.json`.
2. The run gets the fact from the task's `cause.detail` and the wake's input `{to, door, forwarded_from}`. It reads this computer's own wakes of that kind (`wake:list` through its door on descriptor 4): while a wake of another tool here is switched on and hears the same kind from the same teller, it refuses, naming that wake, since the work would run on both computers.
3. It calls `door` with the door's JSON-RPC `tools/call`: `do_one_thing_in_my_account {method: "wake:arrive", request_key: "fact:<event id>", input: {kind, event_id, payload}, pins: [to]}`, the payload carrying `forwarded_from`. The bearer is the key on descriptor 3.
4. The meeting point at the gateway passes the call to `to`. That computer's door checks the key again and keeps the fact once per event id.

The fact goes as it came: the same kind, event id and payload, plus `forwarded_from`. A fact that already holds that field, or has no room for it, is refused, never changed. The far computer's wakes hear forwarded facts with `from: ["sender"]` and `match: {"forwarded_from": "mac"}` (exact equality on a payload field). An event id too long for the door's request key is named by its identity (`tools/content-identity` `requestKeyForEngine`).

## The key

`forward-facts-to-my-computer-key` (`read-data/forward.json` `key_name`) is a key your sign-in tool made for `wake:arrive` alone, kept in this computer's vault with your gateway's host as its only host. The engine fences a run that holds a key to that key's hosts, so the run reaches the gateway and nothing else, and a `door` elsewhere is never sent the key. It is never the carrier's key, which can do everything you can.

## Wakes

A wake is a row in the tool's `wakes` list (`tool-rows.json`). The engine accepts only the keys its wake declaration has (`id`, `on`, `budget`, `input`, `until`, `retry`, `skip_unchanged`, `rate`, `replay`, `needs_input`, `on_failure`). Each wake here:

- is named `forward-<kind>` and hears that kind from its own teller;
- is off until it is switched on, one kind at a time, when that kind's work moves to the other computer;
- needs `to` (the computer to tell), `door` (your gateway's door) and `forwarded_from` (the label the far wake matches) in its switch input;
- runs one step per fact, within 60 s;
- retries a failed run 12 times, starting at 30 s and doubling up to 30 min, so a gateway or far computer that is down for a while still gets the fact once it answers. Once the attempts are spent, the wake is failed with the run's own words.

## What a run answers

| Outcome | The run |
|---|---|
| The far computer kept it | answers `{to, computer, kind, event_id, request_key, kept: true, heard_by, starts}` |
| No wake there hears that kind | answers `kept: false` with `not_heard: {why: "no_wake_hears"}`. This is an answer, not a failure, so it is never asked again |
| The gateway refused the key (401 or 403) | fails, naming `forward-facts-to-my-computer-key` (never its value) |
| The gateway, or the far computer, did not answer | fails, and the wake asks again |
| A wake of another tool here still hears the kind from the same teller | fails, naming it, until it is switched off here |
| The gateway carries no computer named `to` | fails, quoting the meeting point's words (`tools_pin_names_the_computer`), until the wake's input is fixed |
| A `wake-failed` fact naming this tool | answers `forwarded: false` with no call (`not_forwarded_when`), so a gateway that stays down cannot turn each failed forward into another forward of that failure |

## Files

| File | What it is |
|---|---|
| `do-work/forward-a-fact.mjs` | The run: `forward` (one fact to one computer), `factOf`, `doorOk`, `computerNameOk`, `answerOf`, `notForwarded`, `requestKeyOf` |
| `read-data/forward.json` | The key's held name, the request key's start, the meeting point's refusal codes, the bounds, and the facts never forwarded |
| `test/forward-a-fact.test.mjs` | Every outcome above, through a stand-in gateway on loopback |
| `test/wake-rows.test.mjs` | Every wake uses only keys the engine accepts and needs its whole input, and the row reads only its own kinds' wakes |
| `kits/forward-a-fact-to-my-computer.json` | The kit |

## Tests

From the repository's top: `node --test tools/forward-a-fact-to-my-computer/test/*.test.mjs`.
