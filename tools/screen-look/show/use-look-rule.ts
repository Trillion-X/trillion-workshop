// parts/screen-look/show/use-look-rule.ts
//
// PURPOSE
//   The look a rule picks for this screen (read-data/where-looks-apply.ts): the person's look rules (their workspace
//   record, followed live on every device), decided with the formula engine over what this page knows about where it is
//   drawn (the app it is in, the kind of device, the screen it was asked about) and the hour. Answers null while the
//   engine loads and when no rule holds, so the account's look shows until a rule says otherwise; decides again when
//   the rules change and at the next hour a rule reads.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a look, an app or a rule; the rules and where-looks-apply.json do.
//   2. The page never waits on it: before the engine has loaded, the account's look is worn.

import { useEffect, useMemo, useState } from 'react';
import { useWorkspacePreference } from '#workspace-records';
import { loadRowFilterNow } from '#workspace/record-filter.ts';
import { LOOK_RULES_RECORD, deviceKindOf, hostOf, lookForFacts, readLookRules, type LookFacts, type LookRuleAnswer } from '../read-data/where-looks-apply';

type Filter = Awaited<ReturnType<typeof loadRowFilterNow>>;

/** What this page can say about where it is drawn; `place` is the screen or area of the app when the caller knows it. */
export function readPageLookFacts(place: string | null = null): LookFacts {
  if (typeof window === 'undefined') return {};
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const globals = ['openai'].filter(name => name in window);
  return { host: hostOf({ globals, userAgent, protocol: window.location.protocol }), device: deviceKindOf(userAgent), place };
}

/** The look id a rule picks for this screen right now, or null when none holds. */
export function useLookRule(place: string | null = null): string | null {
  const record = useWorkspacePreference(LOOK_RULES_RECORD);
  const rules = useMemo(() => readLookRules(record), [record]);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [turn, setTurn] = useState(0);
  useEffect(() => { void loadRowFilterNow().then(setFilter).catch(error => console.error('Look rules could not load', error)); }, []);
  const facts = useMemo(() => readPageLookFacts(place), [place]);
  const answer = useMemo(() => {
    if (!filter || !rules.length) return null;
    // The account's look is not this hook's to know: a rule that holds has a look_id, otherwise rule_id is null.
    return lookForFacts({ rules, facts, accountLook: '', now: Date.now(), filterRows: filter, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }) as LookRuleAnswer;
  }, [filter, rules, facts, turn]);
  useEffect(() => {
    if (!answer?.next_change_at) return undefined;
    const timer = window.setTimeout(() => setTurn(n => n + 1), Math.min(Math.max(answer.next_change_at - Date.now(), 0) + 50, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [answer]);
  return answer?.rule_id ? answer.look_id : null;
}
