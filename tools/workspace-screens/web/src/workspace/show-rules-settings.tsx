// src/workspace/show-rules-settings.tsx
//
// NO PRIOR: searched the Bitfield packages (packages/*/show) for "quiet hours", "do not disturb", "shown_when" (only a
// Do Not Disturb radio, notifications/show/notification-setting-screen.tsx) and 21st.dev for "notification rules
// list" (#26523 Notification Settings Field: a row per setting with a switch). References (anatomy only): Mobbin
// Slack Pause notifications and Schedule rows, Gmail filters (condition, then what happens, one row per filter).
//
// PURPOSE
//   "When things show" in Notification settings: every show rule the person keeps (the ones everyone starts with,
//   such as tours waiting when a link is opened, then their own: a kind silenced on the phone, a layout shown only in
//   the morning, anything silenced from a card's bell or set by their AI), each with its switch, its words and Remove,
//   and Add a rule: what it is about, what happens, and when, in the shared rule filter's own menu and chips.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a subject, a fact, an effect or a choice: show-rules.json says them, and a fact's values
//      come from where its `values_from` says.
//   2. One editor: the rule filter every list uses, never a second form; the formula engine decides the rule.
//   3. Every change is kept at once in the person's own record (show-rules-live.ts), which every open page and their
//      AIs read; a rule with a problem is refused in its own words.
//   4. Every control is a shared part (parts/ui); this file writes no markup and no appearance.

import * as React from 'react';
import { Button, Card, Container, InlineEditText, SegmentedControl, Switch, Text } from '../../parts/ui';
import { countRules, emptyGroup, RuleFilterChips, RuleFilterMenu, type RuleFieldView, type RuleGroup, type RuleOperatorData } from '../../parts/ui/show/rule-filter';
import { useShowChange } from '../../parts/ui/show/show-rules/show-of';
import operatorData from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json';
import data from 'trillion-workshop/tools/set-up-my-account/read-data/show-rules.json';
import { changeShowRules, profilesNow, showRulesNow } from './show-rules-live';
import { readInputValue } from './records';
import { readJson } from './api';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';

type Choice = string | { id: string; label: string };
type Fact = { id: string; label: string; kind: string; choices?: Choice[]; values_from?: { input?: string; route?: string; list?: string[]; id: string[]; label: string[]; parent?: string[] } };
type Subject = { label: string; facts: Fact[]; changed_only?: boolean };
type Values = NonNullable<RuleFieldView['values']>;

const operators = operatorData as unknown as RuleOperatorData;
const subjects = data.subjects as unknown as { [id: string]: Subject };
const reportChangeProblem = (error: unknown) => notify(errorWords(error, 'This rule could not be changed.'), { kind: 'error' });
const at = (value: unknown, path: readonly string[] = []) => path.reduce<unknown>((held, key) => (held && typeof held === 'object' ? (held as { [key: string]: unknown })[key] : undefined), value);
const fill = (template: string, values: { [name: string]: string }) => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');

// The values a person can pick for a choice fact: its own choices (an id, or an id with its words), then the ones its
// `values_from` names.
async function valuesOf(fact: Fact): Promise<Values> {
  const own: Values = Object.fromEntries((fact.choices ?? []).map(choice => (typeof choice === 'string'
    ? [choice, { label: choice.replace(/_/g, ' ') }]
    : [choice.id, { label: choice.label }])));
  const from = fact.values_from;
  if (!from) return own;
  const held = from.input ? readInputValue<unknown>(from.input) : await readJson<unknown>(from.route!).catch(() => null);
  const list = at(held, from.list ?? []);
  return { ...own, ...Object.fromEntries((Array.isArray(list) ? list : []).map(item => {
    const parent = from.parent ? at(item, from.parent) : undefined;
    return [String(at(item, from.id)), { label: String(at(item, from.label) ?? at(item, from.id)), ...(typeof parent === 'string' ? { parent } : {}) }];
  })) };
}

function useFields(subject: string): RuleFieldView[] {
  const facts = React.useMemo(() => [...(subjects[subject]?.facts ?? []), ...(data.moment_facts as Fact[])], [subject]);
  const [fields, setFields] = React.useState<RuleFieldView[]>(() => facts.map(fact => ({ id: fact.id, label: fact.label, kind: fact.kind })));
  React.useEffect(() => {
    let live = true;
    void Promise.all(facts.map(async fact => ({ id: fact.id, label: fact.label, kind: fact.kind, ...(fact.kind === 'choice' || fact.choices || fact.values_from ? { values: await valuesOf(fact) } : {}) })))
      .then(next => { if (live) setFields(next); });
    return () => { live = false; };
  }, [facts]);
  return fields;
}

type Rule = ReturnType<typeof showRulesNow>[number] & { label?: string; subject?: string; effect?: string; until?: string | null; on?: boolean; starting?: boolean; given?: string };

function ruleLine(rule: Rule): string {
  const effect = data.effects.find(row => row.id === rule.effect)?.label ?? rule.effect ?? '';
  const subject = subjects[rule.subject ?? '']?.label ?? rule.subject ?? '';
  const until = rule.until ? fill(data.words.until, { time: new Date(rule.until).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }) : data.words.always;
  return [subject, effect, until, rule.starting ? data.words.starting : '', rule.given ? fill(data.words.given, { from: rule.given }) : ''].filter(Boolean).join(' · ');
}

function AddRule({ onKept }: { onKept: () => void }) {
  // A subject only changed on the thing itself (`changed_only`) is never a bare rule here.
  const subjectIds = Object.keys(subjects).filter(id => !subjects[id].changed_only);
  const [subject, setSubject] = React.useState(subjectIds[0]);
  // Changes are made on the thing itself (the canvas), never as a bare rule here: a change rule needs the fields it sets.
  const effects = data.effects.filter(row => !('changes' in row && row.changes));
  const [effect, setEffect] = React.useState(effects[0].id);
  const [label, setLabel] = React.useState('');
  const [when, setWhen] = React.useState<RuleGroup>(() => emptyGroup(operators));
  const [builderOpen, setBuilderOpen] = React.useState(false);
  const fields = useFields(subject);
  const keep = async () => {
    try {
      await changeShowRules({ save: {
        label: label.trim() || `${data.effects.find(row => row.id === effect)?.label} ${subjects[subject].label.toLowerCase()}`,
        subject, effect, when: countRules(when) > 0 ? when : null, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, by: 'person',
      } });
      setWhen(emptyGroup(operators));
      setLabel('');
      onKept();
    } catch (error) { reportChangeProblem(error); }
  };
  return (
    <Container layout="vertical" gap="sm" padding="md" data-show-rules-add="">
      <Container layout="horizontal" gap="sm" alignItems="center" wrap>
        <SegmentedControl ariaLabel="What it is about" value={subject} onValueChange={next => { setSubject(next); setWhen(emptyGroup(operators)); }}
          items={subjectIds.map(id => ({ id, label: subjects[id].label }))} />
        <SegmentedControl ariaLabel="What happens" value={effect} onValueChange={setEffect} items={effects.map(row => ({ id: row.id, label: row.label }))} />
      </Container>
      <Container layout="horizontal" gap="xs" alignItems="center" wrap>
        <Text variant="body-xs" color="secondary">{countRules(when) ? 'When' : data.words.always}</Text>
        <RuleFilterMenu fields={fields} operators={operators} value={when} onChange={setWhen}
          trigger={<Button variant="ghost" size="sm" aria-label="When it holds" />}
          triggerContent={<Text variant="body-xs">Add a condition</Text>}
          onOpenBuilder={() => setTimeout(() => setBuilderOpen(true))} />
      </Container>
      {countRules(when) > 0 || builderOpen
        ? <RuleFilterChips fields={fields} operators={operators} value={when} onChange={setWhen} builderOpen={builderOpen} onBuilderOpenChange={setBuilderOpen} />
        : null}
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Container flex={1}>
          <InlineEditText variant="body" tone="secondary" aria-label="Name this rule" placeholder="Name it, like Quiet on my phone" value={label} onCommit={setLabel} />
        </Container>
        <Button size="sm" variant="primary" onClick={keep}>{data.words.add}</Button>
      </Container>
    </Container>
  );
}

/** The profiles the person keeps: each with the rules it holds, its switch (on applies it to what it names) and Remove. */
function ProfileRows({ onChanged }: { onChanged: () => void }) {
  const { profiles, in_use: inUse } = profilesNow();
  if (!profiles.length) return null;
  return (
    <>
      <Container layout="horizontal" padding="md">
        <Text variant="caption" color="muted">{data.words.profiles}</Text>
      </Container>
      {profiles.map(profile => (
        <Container key={profile.id} layout="horizontal" gap="md" alignItems="center" padding="md" data-show-profile={profile.id}>
          <Container layout="vertical" gap="xs" flex={1}>
            <Text variant="body" weight="semibold">{profile.label || profile.id}</Text>
            <Text variant="caption" color="muted">{(profile.rules ?? []).map(rule => rule.label || rule.id).join(' · ')}</Text>
          </Container>
          <Button size="sm" variant="ghost" onClick={() => { return changeShowRules({ remove_type: profile.id }).then(onChanged).catch(error => { reportChangeProblem(error); throw error; }); }}>Remove</Button>
          <Switch size="sm" label={profile.label || profile.id} checked={inUse.includes(profile.id)}
            onCheckedChange={on => { void changeShowRules({ use: { type: profile.id, on } }).then(onChanged).catch(reportChangeProblem); }} />
        </Container>
      ))}
    </>
  );
}

/** "When things show": the person's show rules, each with its switch and Remove, their profiles, and Add a rule. */
export function ShowRulesSettings() {
  useShowChange();
  const [, redraw] = React.useReducer((count: number) => count + 1, 0);
  const rules = showRulesNow() as Rule[];
  const setOn = (rule: Rule, on: boolean) => (rule.starting
    ? changeShowRules({ starting: { id: rule.id, on } })
    : changeShowRules({ save: { ...rule, on } }));
  return (
    <Container layout="vertical" gap="sm" data-show-rules-settings="">
      <Text variant="heading-xs">{data.words.heading}</Text>
      <Card variant="surface" padding="none">
        {rules.length ? null : <Container padding="md"><Text variant="caption" color="muted">{data.words.nothing_yet}</Text></Container>}
        {rules.map(rule => (
          <Container key={rule.id} layout="horizontal" gap="md" alignItems="center" padding="md" data-show-rule={rule.id}>
            <Container layout="vertical" gap="xs" flex={1}>
              <Text variant="body" weight="semibold">{rule.label || subjects[rule.subject ?? '']?.label}</Text>
              <Text variant="caption" color="muted">{ruleLine(rule)}</Text>
            </Container>
            {rule.starting || rule.given ? null : <Button size="sm" variant="ghost" onClick={() => changeShowRules({ remove: rule.id }).catch(reportChangeProblem)}>Remove</Button>}
            {rule.given ? null : <Switch size="sm" label={rule.label || rule.id} checked={rule.on !== false} onCheckedChange={on => { void setOn(rule, on).then(redraw).catch(reportChangeProblem); }} />}
          </Container>
        ))}
        <ProfileRows onChanged={redraw} />
        <AddRule onKept={redraw} />
      </Card>
    </Container>
  );
}
