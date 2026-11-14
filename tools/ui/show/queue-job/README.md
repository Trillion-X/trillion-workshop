# Queue Job

One button that asks someone's own AI to do a named job about the thing it sits on (a goal, a person, a file). It hands the caller's `send` the job id, the context and a fresh press key, shows it is sending, then shows it was sent: with the one loading mark while the caller's `follow` says the AI is still on it, and a check once it is done.

## Files

| File | Purpose |
|------|---------|
| `QueueJobButton.tsx` | The button: ready, sending (the shared Button's loading state), working (the loading mark from `../spinner` and the caller's sent words, while `follow` has not said done) and sent (a check and the caller's sent words). |
| `index.ts` | Exports the button and its types. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `QueueJobButton` | `(props: QueueJobButtonProps) => JSX.Element` | Draws the button and runs one press. |
| `QueueJobButtonProps` | `{ label, sentLabel, job, context, send(press), onSent?, onFailed?, follow?(answer, done) => stop, size? }` | Everything is the caller's: words, job id, context and the road it is sent on. |
| `QueueJobPress` | `{ job_id: string; context: Record<string, string>; press_key: string }` | What one press sends; the press key is new for each press and the same if the caller resends it. |

## Invariants

- No product words or roads: label, sent words, job id, context and where it is sent come from the caller.
- One press is one job: its press key is made once before sending.
- A failed send leaves the button ready and hands the error to `onFailed`.
- The button never guesses when a job is done: with no `follow` it shows sent at once; with one it shows the loading mark until `follow` says done.

## Dependencies

**Depends on:** `coss/ui/button` (the shared Button with its loading state), `spinner` (the one loading mark), `lucide-react` icons.

**Depended on by:** `dashboard` rows that carry `queue` (the Trillion Home goals) and the Trillion workspace's shared-space People rows, both sending each press through `src/workspace/queue-job.ts` to `/work/api/queue`.
