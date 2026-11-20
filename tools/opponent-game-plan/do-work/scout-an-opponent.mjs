// tools/opponent-game-plan/do-work/scout-an-opponent.mjs
//
// The command of tool:scout-an-opponent. One JSON request on standard input:
//   { operation: "search" | "profile", rows: [...records], subject_id?, confidence_policy?, subject_kind?, profile_kind? }
// search  -> { opponents: [{ subjectId, name, facts, styleLabels, reportCount, profileCount, workedCount, failedCount }] }
//            every subject that is not the person themself
// profile -> { profile, evidence: { usable: [ids], needsReview: [ids] } }: the subject's reports, profiles and tactic
//            outcomes joined (strengths, weaknesses, strategies that worked and failed, style, ratings, public and private
//            reports apart), and which reports the confidence policy lets a plan use
// The policy is { minimumConfidence, missingConfidenceIsUsable }, given here or as an evidence-confidence-policy row; with
// none, no report is usable. subject_kind and profile_kind keep only subjects and profiles of that kind.
// record-report  { subject_id, subject_label, author_id, report_id?, subject_kind?, is_self?, facts?, visibility?, style_labels?,
//                  strengths?, weaknesses?, strategies_worked?, strategies_failed?, notes?, confidence?, now? }
//                -> { subject_record, report_record }: a subject and a report of evidence, private unless visibility says public
// record-profile { subject_id, profile_kind, source: { sourceId, ... }, payload: { ...facts, ratings?: { name: 0-100 } }, profile_id?, now? }
//                -> { profile_record }: a profile projection; a rating outside 0 to 100 is refused, never written
import { runAsMain } from '../read-data/run-as-main.mjs';
import {
  assertPolicy, profileForSubject, profileRecord, readScoutingState, reportRecord, searchRows, splitEvidenceByConfidence,
  subjectRecord,
} from '../read-data/scouting.mjs';

export function scoutAnOpponent(input) {
  switch (input?.operation) {
    case 'record-report': return { subject_record: subjectRecord(input), report_record: reportRecord(input) };
    case 'record-profile': return { profile_record: profileRecord(input) };
    case 'search': case 'profile': return scoutFromRows(input);
    default: throw new Error('operation must be search, profile, record-report or record-profile.');
  }
}

function scoutFromRows(input) {
  if (!Array.isArray(input?.rows)) throw new Error('rows must be a list of records.');
  const state = readScoutingState(input.rows, input);
  switch (input.operation) {
    case 'search': return { opponents: searchRows(state) };
    case 'profile': {
      if (!input.subject_id) throw new Error('subject_id is required.');
      const profile = profileForSubject(state, input.subject_id);
      if (!profile.player && profile.reports.length === 0 && profile.profiles.length === 0) throw new Error(`Nothing on file for ${JSON.stringify(input.subject_id)}.`);
      const split = splitEvidenceByConfidence(profile.reports, assertPolicy(input.confidence_policy) ?? state.policy);
      return { profile, evidence: { usable: split.usable.map(report => report.evidenceId), needsReview: split.needsReview.map(report => report.evidenceId) } };
    }
    default: throw new Error('operation must be search or profile.');
  }
}

await runAsMain(import.meta.url, scoutAnOpponent);
