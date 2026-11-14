// parts/ui/show/queue-job/QueueJobButton.tsx
//
// PURPOSE
//   One button that asks someone's own AI to do a named job about the thing it sits on (a goal, a person, a file):
//   pressing it hands the caller's `send` the job's id, its context and a fresh press key, shows that it is sending,
//   then shows it was sent: with the one loading mark while the caller's `follow` says the AI is still on it, and a
//   check once it is done. The anatomy follows the small "Ask Again" chip that turns into a done state (Delphi, on
//   Mobbin) and a short sent toast (Dropbox Dash); the control is the shared coss Button.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words or roads: the label, the sent words, the job id, the context and where it is sent are all the
//      caller's. This part never names a job, an AI or an address.
//   2. One press is one job: each press gets its own press key, made once before sending, so the same press resent by
//      the caller after a lost answer is the same job, and a second press is a second job.
//   3. A failed send leaves the button ready again and hands the error to the caller's `onFailed`, which says it in
//      its own words (a plan refusal, a network failure); nothing here swallows it silently.
//   4. The button never guesses when the job is done: without a `follow` it shows sent at once; with one, it shows the
//      loading mark (../spinner, the one loading animation) until `follow` says done.

import * as React from 'react';
import { Check, Sparkles } from 'lucide-react';
import { Button } from '../coss/ui/button';
import { Spinner } from '../spinner';

export type QueueJobPress = { job_id: string; context: Record<string, string>; press_key: string };

export type QueueJobButtonProps = {
  /** The button's words, such as "Ask my AI to look into this". */
  label: string;
  /** What the button says once the job was sent. */
  sentLabel: string;
  /** The job's id, as the caller's jobs list names it. */
  job: string;
  /** Every value the job needs about the thing the button sits on, each a short line of text. */
  context: Record<string, string>;
  /** Sends one press; resolves when it was kept. */
  send: (press: QueueJobPress) => Promise<unknown>;
  /** Told after a send was kept. */
  onSent?: (answer: unknown) => void;
  /** Told when a send failed; the button is ready again. */
  onFailed?: (error: unknown) => void;
  /** Follows the job after it was sent: calls `done` when the AI has finished it; answers the function that stops. */
  follow?: (answer: unknown, done: () => void) => () => void;
  size?: 'xs' | 'sm' | 'default';
};

type State = 'ready' | 'sending' | 'working' | 'sent';

export function QueueJobButton({ label, sentLabel, job, context, send, onSent, onFailed, follow, size = 'sm' }: QueueJobButtonProps) {
  const [state, setState] = React.useState<State>('ready');
  const [answer, setAnswer] = React.useState<{ value: unknown } | null>(null);
  // While the AI works on it, the caller's follow says when it is done.
  React.useEffect(() => (state === 'working' && follow && answer ? follow(answer.value, () => setState('sent')) : undefined), [state, follow, answer]);
  const press = React.useCallback(async () => {
    if (state !== 'ready') return;
    setState('sending');
    const made: QueueJobPress = { job_id: job, context, press_key: crypto.randomUUID() };
    try {
      const answer = await send(made);
      setAnswer({ value: answer });
      setState(follow ? 'working' : 'sent');
      onSent?.(answer);
    } catch (error) {
      setState('ready');
      onFailed?.(error);
    }
  }, [state, job, context, send, onSent, onFailed, follow]);
  const sent = state === 'sent' || state === 'working';
  return (
    <Button size={size} variant={sent ? 'ghost' : 'outline'} loading={state === 'sending'} disabled={sent} work={null} data-state={state} aria-live="polite" onClick={press}>
      {state === 'working' ? <Spinner size="sm" aria-hidden /> : sent ? <Check aria-hidden /> : <Sparkles aria-hidden />}
      {sent ? sentLabel : label}
    </Button>
  );
}
