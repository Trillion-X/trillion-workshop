// src/after-work-review.mjs
//
// Purpose: when the person turns it on (src/after-work-review.json `on`), finished work is followed by one review job
// for the AI that finished it, so what the work taught is kept as a reusable method rather than left in one chat.
//
// Non-negotiable invariants
//   1. Off unless the DATA says on; with it off nothing is handed.
//   2. One review per finished job: the review's once_per is derived from the job's id, so a finish seen twice hands one.
//   3. A review is never reviewed: its input carries `after_work_review`, and a job with that mark gets none.
//   4. Who is skipped, how many attempts a job needs and the words of the rule blocks are DATA; nothing here names an agent.
//   5. A failure here never undoes the finished work (the caller's onFinished already ignores a throw).
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** agents: makeAgents' handOff; settings: src/after-work-review.json. → { review(finished) } */
export function makeAfterWorkReview({ agents, settings }) {
  function review(finished) {
    if (settings.on !== true || !finished?.handoff_id || !finished.taken_by) return null;
    if (finished.input?.after_work_review) return null;
    const { min_attempts: minAttempts = 0, skip_from_agents: skip = [], only_if_input_flag: flag = null } = settings.applies_to ?? {};
    if ((finished.attempts?.length ?? 0) < minAttempts || skip.includes(finished.from_agent) || (flag && !finished.input?.[flag])) return null;
    const job = fill(settings.job, { handoff_id: finished.handoff_id, work: String(finished.job ?? '').slice(0, 200), blocks: settings.blocks.join('') });
    return agents.handOff({
      job, to_agent: finished.taken_by, parent_handoff_id: finished.handoff_id, once_per: `${settings.once_per_prefix}${finished.handoff_id}`,
      priority: settings.priority, hold_minutes: settings.hold_minutes, input: { after_work_review: finished.handoff_id },
    });
  }
  return { review };
}
