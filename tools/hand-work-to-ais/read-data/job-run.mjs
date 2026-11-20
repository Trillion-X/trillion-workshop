// tools/hand-work-to-ais/read-data/job-run.mjs
//
// PURPOSE
//   One job run as the job-run screen reads it: the jobs a message handed on (or one job and every part handed on from
//   it), who took them, and the progress of its parts. Ported from the old PersonStore.jobRun (the old repository
//   src/person-store.mjs:2897, tag b6ae0ebf81). The choice of jobs is the same line as there: a held job on a plan that
//   keeps nothing, else agents.fromMessage, else agents.withParts (tools/shared-code/src/agents.mjs).
//
// NOT PORTED (stated, not hidden)
//   steps: the old run also drew each kept call (activityFor / activityIdentity over the activity rows). This folder
//   holds no activity read, so steps is [] and the screen shows no call list until that owner is wired.
//   app and model per actor: the old keyApps lookup is not here, so app is null.
//
// INVARIANTS
//   1. An addressed handoff that is not on this account returns null (the old "unavailable" answer).
//   2. A message whose work is not handed off yet returns an empty, waiting run, not null.
//   3. Nothing here writes; the store is read through the agents object passed in.
export function jobRunOf({ message = null, handoff = null } = {}, { agents, liveJobs = null } = {}) {
  const held = [message, handoff].find(id => typeof id === 'string' && id && liveJobs?.holds(id));
  const jobs = held ? liveJobs.list().filter(job => job.handoff_id === held)
    : typeof message === 'string' && message ? agents.fromMessage(message)
    : typeof handoff === 'string' && handoff ? agents.withParts(handoff) : [];
  if (typeof handoff === 'string' && handoff && !message && !jobs.length) return null;
  const named = [...new Set(jobs.flatMap(job => [job.taken_by, ...(job.attempts ?? []).map(attempt => attempt.agent_id)]).filter(Boolean))];
  const actors = named.map(agent_id => {
    const card = agents.cardOf(agent_id);
    return {
      id: agent_id, name: card?.name ?? agent_id, kind: card?.kind ?? 'ai', app: null,
      model: card?.model && card.model !== 'unknown' ? card.model : null,
      description: card?.description ?? null, skills: (card?.skills ?? []).map(skill => skill.name),
    };
  });
  // Progress counts the parts of a job named by its handoff, as the old run did; a single job or a message has none.
  const parts = handoff && !message && !held && jobs.length > 1 ? agents.read({ handoff_id: handoff }).progress ?? null : null;
  return { message, handoff, jobs, steps: [], actors, progress: parts };
}
