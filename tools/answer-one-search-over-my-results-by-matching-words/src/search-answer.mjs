// src/search-answer.mjs
//
// PURPOSE
//   One search answered where the person's results are kept: the question encoded once (src/search.mjs encodeQuestion),
//   the index lanes answered by the person's search follower (src/person-work.mjs search), and the answer finished over
//   the owner's own results (src/search.mjs finish), with the follower's candidate pages taken a page at a time. The
//   person's store finished its answers this way (src/person-store.mjs searchFinish); the account's own Namespace
//   resource answers the same way once its files are carried there (src/namespace-resource-mount.mjs namespaceSearch).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Rows the owner's feed holds after the follower's position never drop the index lanes: the lanes of their kinds
//      are named still reading and the follower is told (`notice`).
//   2. A follower that is not reachable, or lanes it is still building, are never guessed around: those index lanes are
//      named still reading. An owner with a frozen index of its own fills them from it before finishing (PersonStore).
//   3. A candidate page is transferred once per session and lane; a changed source revision restarts the fusion.
//

import personWork from '../../shared-code/src/person-work.json' with { type: 'json' };
import { realizeSearchCandidateTransfers } from './search-candidate-pages.mjs';
import { kindsWithFeedAfter } from '../../shared-code/src/search-feed.mjs';

/**
 * The follower's answer to the index lanes (`partial`, read through feed position `through`) finished over `sql`.
 * `owner` is the finisher (makeSearch with index false), `feed` the owner's searchFeedWriter, `follower` the account's
 * follower ({ identity, stub } or null) and `notice` tells it a change waits.
 */
export async function finishSearch({ sql, owner, feed, follower, notice }, question, options = {}, partial = null, through = 0) {
  if (partial === null) return owner.finish(question, options, null);
  const page = personWork.concerns.search.ahead_rows;
  const ahead = await feed.feed(through, page);
  if (ahead.length) notice();
  // A full page may not show every kind with rows ahead, so each registered kind is probed instead (one seek per kind).
  const named = ahead.length >= page ? kindsWithFeedAfter(sql, through).map(kind => ({ kind })) : ahead;
  partial = owner.behind(partial, named, options, false);
  const refs = partial.candidate_refs ?? [];
  if (refs.length) {
    const fusionSession = partial.fusion_session ?? owner.fusionSession(question, options);
    realizeSearchCandidateTransfers(sql);
    const fingerprint = owner.candidateFusionFingerprint(refs, options);
    owner.ensureCandidateFusion(fusionSession, fingerprint);
    if (!owner.candidateFusionReady(fusionSession, fingerprint)) {
      partial.candidate_refs = refs.map(ref => ({ ...ref, transferred: false }));
      const ref = refs[0];
      if (ref) partial.pending = [...(partial.pending ?? []).filter(item => item.lane !== ref.lane), { lane: ref.lane, source: ref.source, place: ref.place }];
      notice();
      return owner.finish(question, options, partial);
    }
    let advanced = null;
    for (const ref of refs) {
      const session = JSON.stringify([String(question ?? '').trim().slice(0, 500), ref.lane, ref.kind, ref.question, Boolean(ref.remote)]);
      let saved = sql.exec('SELECT after_score, after_seq, count, done, source_revision, fusion_session, cursor_json FROM search_candidate_transfers WHERE session = ? LIMIT 1', session).toArray()[0];
      if (saved && saved.fusion_session !== fusionSession) {
        sql.exec('DELETE FROM search_candidate_transfers WHERE session = ?', session);
        saved = null;
      }
      if (saved?.done) continue;
      if (!saved) sql.exec('INSERT OR IGNORE INTO search_candidate_transfers (session, lane, kind, source_question, fusion_session) VALUES (?, ?, ?, ?, ?)', session, ref.lane, ref.kind, ref.question, fusionSession);
      const cursor = saved?.cursor_json ? JSON.parse(saved.cursor_json) : saved ? { score: saved.after_score, seq: saved.after_seq, count: saved.count } : {};
      try {
        const transferPage = ref.remote
          ? await follower?.stub.searchCandidatePage(follower.identity, ref, cursor)
          : owner.candidatePage(ref, cursor);
        if (!transferPage) throw new Error('the search candidate owner is not reachable');
        if (saved?.source_revision != null && String(saved.source_revision) !== String(transferPage.revision)) {
          owner.resetCandidateFusion(fusionSession);
          advanced = { ref, done: false };
          break;
        }
        owner.acceptCandidatePage(fusionSession, ref.lane, transferPage.rows, { participated: transferPage.participated, transfer: {
          session, afterScore: transferPage.afterScore, afterSeq: transferPage.afterSeq, count: transferPage.count,
          done: !transferPage.more, sourceRevision: transferPage.revision, cursor: transferPage.cursor,
        } });
        advanced = { ref, done: !transferPage.more };
        break;
      } catch (error) {
        if (error?.code === 'SEARCH_FUSION_RESTART') {
          owner.resetCandidateFusion(fusionSession);
          advanced = { ref, done: false };
          break;
        }
        advanced = { ref, done: false, error };
        break;
      }
    }
    const resetting = !owner.candidateFusionReady(fusionSession, fingerprint);
    partial.candidate_refs = refs.map(ref => {
      if (resetting) return { ...ref, transferred: false };
      const session = JSON.stringify([String(question ?? '').trim().slice(0, 500), ref.lane, ref.kind, ref.question, Boolean(ref.remote)]);
      return { ...ref, transferred: sql.exec('SELECT done FROM search_candidate_transfers WHERE session = ? LIMIT 1', session).toArray()[0]?.done === 1 };
    });
    if (advanced && !advanced.done) {
      partial.pending = [...(partial.pending ?? []).filter(item => item.lane !== advanced.ref.lane), {
        lane: advanced.ref.lane, source: advanced.ref.source, place: advanced.ref.place,
      }];
      notice();
    }
  }
  return owner.finish(question, options, partial);
}

/**
 * One whole search over an owner that keeps no index of its own: the question encoded once, the follower's lanes (those
 * it is still building named still reading, invariant 2), then finishSearch. With no follower answer every index lane is
 * named still reading.
 */
export async function answerSearch(answerer, question, given = {}) {
  const { owner, follower } = answerer;
  const encoded = await owner.encodeQuestion(question, given);
  const options = Object.keys(encoded).length ? { ...given, encoded } : given;
  const found = follower ? await follower.stub.search(follower.identity, question, options).catch(error => { console.warn('search follower', error?.message ?? error); return null; }) : null;
  if (!found?.partial) return owner.finish(question, options, null);
  const building = new Set(found.building ?? []);
  const partial = { ...found.partial, candidate_refs: (found.partial.candidate_refs ?? []).map(ref => ({ ...ref, remote: true })),
    still_reading: { ...found.partial.still_reading, ...Object.fromEntries([...building].map(lane => [lane, 1])) } };
  return finishSearch(answerer, question, options, partial, found.through);
}
