# tools/tell-the-person/

No tool is left here. What Trillion told the person is kept in the person's own store as one object per notice, and is
read and changed there directly, in the store's own language. The four tools that did this on the retired records door
are workflows now, each a recipe with its kit in `tools/workflows`:

| Retired tool | New home | What it does |
|--------------|----------|--------------|
| `tool:my-notices` | `workflow:read-my-notices` (`recipes/read-my-notices.json`, `kits/read-my-notices.json`) | The newest notices, optionally of one kind, with where each was seen and why a way did not carry it |
| `tool:my-device-notices` | `workflow:read-my-device-notices` (`recipes/read-my-device-notices.json`, `kits/read-my-device-notices.json`) | The notices ready for one registered device, oldest first after its cursor |
| `tool:mark-my-notices-read` | `workflow:mark-my-notices-read` (`recipes/mark-my-notices-read.json`, `kits/mark-my-notices-read.json`) | Records read or unread state and the first surface a notice was read on |
| `tool:act-on-my-notice` | `workflow:act-on-my-notice` (`recipes/act-on-my-notice.json`, `kits/act-on-my-notice.json`) | Completes an offered local open; refuses actions that need their source app or road |

## Files

| File | Purpose |
|------|---------|
| `what-this-tool-does-and-how-to-run-it.json` | Holds no tool rows (`records: []`). |
| `part.json` | The public view of this folder: none. |
| `test/no-records-door.test.mjs` | The rows hold no records-door method, and each workflow's recipe and kit exist. |

## Dependencies

**Depends on:** nothing. The workflows run on the person's own store.

**Depended on by:** `tools/send-to-trillion-from-my-browser` (its `src/notice-tools.mjs` still names the four retired
`tool:` ids at runtime, so it needs its own change to run the workflows). `tools/tell-one-person-something-through-every-way-they`
mentions them in `ports/tell-routes.json` and a comment in `read-data/tell-the-person.mjs`.
