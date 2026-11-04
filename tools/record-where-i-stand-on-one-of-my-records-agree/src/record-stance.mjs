// src/record-stance.mjs
//
// Purpose: where the person stands on one of their own records (agree, disagree, or any stand src/record-stance.json
// lists), kept as one EEAF record that names the record in `about` the way a message names what it is about. Because
// src/record-scope.json links it like a message, the record's own trace (trace_item's records, a decision page's What
// came after) shows it beside every message, plan and AI call that came after the record, all by the record's id.
//
//   GET  /stance?record=<ref>     { record, kind, stance: { stance, said, why, by, at, decision_generation? } | null,
//        stances: [{ id, label, icon, tone }] }
//   POST /stance                  { record, stance | null, why?, answered_by: "person" }   take a stand (null takes it
//        back); answers as GET, plus `reopened` when the stand sent a decision back for a new one and `handoff_id` for
//        the AI job that makes it.
//
// Non-Negotiable Invariants:
//   1. A stance is only ever the person's: their own page sends it, and an AI sends it only with answered_by "person"
//      after asking them. It never claims a result happened; how a decision turned out stays report_result's.
//   2. Only the person's own records take a stance: the record is resolved by the scope owner (scopeRecordRef), which
//      refuses anything their Trillion does not keep.
//   3. A stand that `reopens` a kind of record (a disagreement with a decision) opens that decision for a corrected
//      one (engine.reopen) and hands one AI the job of making it, once per stand on that decision version, so taking
//      the same stand again repeats nothing.
//   4. This file names no stance, kind or word: they are DATA in src/record-stance.json. The kind of a record is the
//      scope owner's (scopeKindOf).
//
import stanceData from './record-stance.json' with { type: 'json' };
import scopeData from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-scope.json' with { type: 'json' };

const TYPE = stanceData.type;
const STANCES = new Map(stanceData.stances.map(row => [row.id, row]));
const WORDS = stanceData.words;
const WHY_LENGTH = 2000;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const text = value => (typeof value === 'string' ? value.trim() : '');
export const stanceId = ref => `${TYPE}:${ref}`;

export class StanceError extends Error {}

/** The stands a person can take, as their buttons draw them. */
export const stanceChoices = () => stanceData.stances.map(({ id, label, icon, tone }) => ({ id, label, icon, tone }));

// The id a record is named by in `about`: its kind's prefix taken off, as src/record-scope.mjs refOf puts it back.
const aboutId = (kind, ref) => { const prefix = scopeData.refs[kind]?.prefix; return prefix && ref.startsWith(prefix) ? ref.slice(prefix.length) : ref; };

export const recordStanceMethods = {
  // GET /stance: the person's stand on one record, with the stands they can take.
  async stanceOf(named) {
    const ref = await this.stanceRecordRef(named);
    const kept = this.store.eeaf.read(stanceId(ref));
    return { record: ref, kind: this.scopeKindOf(ref), stance: kept ? { stance: kept.stance, said: kept.said, why: kept.why ?? null, by: kept.by, at: kept.at, ...(kept.decision_generation ? { decision_generation: kept.decision_generation } : {}) } : null, stances: stanceChoices() };
  },

  async stanceRecordRef(named) {
    try { return await this.scopeRecordRef(named); } catch { throw new StanceError(WORDS.refused_record); }
  },

  // POST /stance: take a stand on one record, or take it back (stance null).
  async setStance({ record, stance, why, by = 'person' } = {}) {
    const ref = await this.stanceRecordRef(record);
    const kind = this.scopeKindOf(ref);
    if (stance === null) {
      this.store.eeaf.write([{ id: stanceId(ref), type: TYPE, value: null }], { actor: { by } });
      return this.stanceOf(ref);
    }
    const row = STANCES.get(text(stance));
    if (!row) throw new StanceError(fill(WORDS.refused_stance, { stances: [...STANCES.keys()].join(', ') }));
    const before = this.store.eeaf.read(stanceId(ref));
    const decision = kind === 'decision' ? await this.engine.get(ref) : null;
    const generation = decision?.decision ? decision.decision_generation ?? 1 : null;
    const sameStand = before && before.stance === row.id && (before.decision_generation ?? null) === (generation ?? null);
    const nextWhy = text(why) ? text(why).slice(0, WHY_LENGTH) : sameStand ? before.why : '';
    const changedExplanation = Boolean(sameStand && ((before.why ?? '') !== nextWhy || before.by !== by));
    const value = {
      record: ref, kind, about: [{ kind, id: aboutId(kind, ref) }], stance: row.id, said: row.said,
      ...(nextWhy ? { why: nextWhy } : {}), by, at: new Date().toISOString(),
      ...(generation ? { decision_generation: generation } : {}),
      // Every earlier stand stays, newest last, so a change of mind is part of the record's history.
      earlier: before ? [...(before.earlier ?? []), ...(changedExplanation ? [{ stance: before.stance, why: before.why ?? null, by: before.by, at: before.at, ...(before.decision_generation ? { decision_generation: before.decision_generation } : {}) }] : []), ...(!sameStand ? [{ stance: before.stance, why: before.why ?? null, by: before.by, at: before.at, ...(before.decision_generation ? { decision_generation: before.decision_generation } : {}) }] : [])].slice(-20) : [],
    };
    const same = sameStand;
    if (same) {
      value.at = changedExplanation ? value.at : before.at;
      value.correction = before.correction;
    }
    const correctsDecision = (row.reopens ?? []).includes(kind) && Boolean(decision?.decision);
    if (same && correctsDecision && before.correction?.status === 'complete') {
      if (changedExplanation) this.store.eeaf.write([{ id: stanceId(ref), type: TYPE, value }], { actor: { by } });
      return { ...await this.stanceOf(ref), reopened: before.correction.reopened, handoff_id: before.correction.handoff_id };
    }
    if (correctsDecision) {
      // The stance itself is also the durable correction intent. A retry can resume each effect independently even
      // when the stance was already written before the decision write, handoff, or scheduler refused it.
      value.correction = same && before.correction?.decision_generation === generation
        ? before.correction
        : { decision_generation: generation, stance: row.id, status: 'pending' };
    }
    if (!same || changedExplanation || (correctsDecision && value.correction !== before?.correction))
      this.store.eeaf.write([{ id: stanceId(ref), type: TYPE, value }], { actor: { by } });
    const answer = await this.stanceOf(ref);
    if (!correctsDecision) return answer;
    // A decision the person disagrees with is open for a corrected one, and one AI is handed the job of making it.
    const reason = value.why ?? stanceData.hand_off.no_words;
    let correction = value.correction;
    const priorReopen = decision.reopened?.find(entry => entry.source_ref === stanceId(ref) && entry.decision_generation === generation);
    const reopened = correction.reopened
      ? { reopened: correction.reopened }
      : priorReopen
        ? { reopened: priorReopen }
        : await this.engine.reopen(ref, { reason: `${row.said} ${reason}`, source_ref: stanceId(ref) });
    if (correction.status === 'pending') {
      correction = { ...correction, status: 'reopened', reopened: reopened.reopened };
      this.store.eeaf.write([{ id: stanceId(ref), type: TYPE, value: { ...value, correction } }], { actor: { by } });
    }
    const chosen = decision.decision.move ?? decision.input.options.find(option => option.id === decision.decision.option_id)?.label ?? decision.decision.option_id;
    const facts = { case_id: ref, goal: decision.input.goal, chosen, why: reason };
    let handoffId = correction.handoff_id;
    if (!handoffId) {
      const { handoff } = this.agents().handOff({
        job: fill(stanceData.hand_off.job, facts), said: fill(stanceData.hand_off.said, facts), outcome: fill(stanceData.hand_off.outcome, facts),
        from_agent: 'trillion', case_id: ref, priority: stanceData.hand_off.priority, request_key: `${stanceId(ref)}:${generation}:${row.id}`,
      });
      handoffId = handoff.handoff_id;
      correction = { ...correction, status: 'handed_off', handoff_id: handoffId };
      this.store.eeaf.write([{ id: stanceId(ref), type: TYPE, value: { ...value, correction } }], { actor: { by } });
    }
    await this.scheduler?.().arm();
    correction = { ...correction, status: 'complete' };
    this.store.eeaf.write([{ id: stanceId(ref), type: TYPE, value: { ...value, correction } }], { actor: { by } });
    return { ...answer, reopened: correction.reopened, handoff_id: handoffId };
  },

  // A lost POST /stance, read from the stand kept on the record, never taken again: the stand asked for (with its
  // words) is kept and any correction it starts is complete (committed, answered as setStance answers); a correction
  // begun but not complete is unknown; any other stand, or a refusal, kept nothing of this command (aborted).
  async stanceOutcome({ record, stance, why } = {}) {
    let ref;
    try { ref = await this.stanceRecordRef(record); } catch { return { state: 'aborted' }; }
    const kept = this.store.eeaf.read(stanceId(ref));
    if (stance === null) return kept ? { state: 'aborted' } : { state: 'committed', result: await this.stanceOf(ref) };
    const row = STANCES.get(text(stance));
    if (!row || kept?.stance !== row.id || (text(why) && kept.why !== text(why).slice(0, WHY_LENGTH))) return { state: 'aborted' };
    if (!kept.correction) return { state: 'committed', result: await this.stanceOf(ref) };
    if (kept.correction.status !== 'complete') return { state: 'unknown' };
    return { state: 'committed', result: { ...await this.stanceOf(ref), reopened: kept.correction.reopened, handoff_id: kept.correction.handoff_id } };
  },
};

export const isStancePath = path => path === '/stance';

export async function handleStanceRequest(person, request, { reachOf }) {
  try {
    // A stance names a private record, so a sign-in held to spaces cannot reach it.
    if (!reachOf(request).private) throw new StanceError(scopeData.refused.private_reach);
    const url = new URL(request.url);
    if (request.method === 'GET') return Response.json(await person.stanceOf(url.searchParams.get('record')));
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    const body = await request.json().catch(() => ({}));
    if (body?.answered_by !== 'person') throw new StanceError(WORDS.refused_answered_by);
    return Response.json(await person.setStance({ record: body.record, stance: body.stance, why: body.why, by: request.headers.get('x-trillion-app') || 'person' }));
  } catch (error) {
    return Response.json({ error: error.message }, { status: error instanceof StanceError ? 400 : 500 });
  }
}

/** The words the person's page says after a stand is taken. */
export const stanceSaid = answer => fill(answer.reopened ? WORDS.reopened : WORDS.saved, { said: answer.stance?.said ?? '' });

export const stanceTools = call => [
  { name: 'agree_or_disagree', description: `Records where the person stands on one of their own records: stance ${[...STANCES.keys()].map(id => `"${id}"`).join(' or ')} (null takes it back), why in their words, and answered_by "person". record is a decision case_id, pursuit id, message id, file name or identity, or tool:<tool id>. Only send what the person said; never take a stand for them. Disagreeing with a decision opens it for a corrected decision and hands one AI the job of making it. The stance is kept as a record about that record, so trace_item on it lists the stance with every message, plan and AI call that came after. Returns the stance, and reopened and handoff_id when it reopened a decision.`, inputSchema: { type: 'object', required: ['record', 'stance', 'answered_by'], properties: { record: { type: 'string' }, stance: { type: ['string', 'null'], enum: [...STANCES.keys(), null] }, why: { type: 'string' }, answered_by: { type: 'string' } } }, run: input => call('/stance', input) },
];

export const stanceAnnotations = {
  agree_or_disagree: { title: 'Say whether you agree', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
