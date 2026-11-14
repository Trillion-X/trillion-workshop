// parts/sidebar/show/ListShowsWhen.tsx
//
// NO PRIOR: Trillion's own (a person's list shown only while a rule holds).
//
// PURPOSE
//   When one of the person's lists shows, chosen from that list's own menu ("When it shows"): the shared rule filter
//   (parts/ui rule-filter, the same menu and chips every record view's filter uses) over the facts that describe a list
//   (surfaces.json `sidebar_row_facts` marked `on: lists`: today's date, days since it was made, the count an AI left on
//   it), kept as the list's `shown_when` and decided by the formula engine as time passes
//   (read-data/apply-list-rules.ts). "For 7 days" is Days since it was made is less than 7; "until a date" is Today is
//   before that date.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One editor: the rule filter's own menu and chips, never a second form.
//   2. Which facts a rule may name is the caller's DATA (#workspace-list-rules); nothing here names a fact.
//   3. Every change is kept at once through the sidebar's own list ops; a rule with nothing in it takes the rule off,
//      so the list always shows again.

'use client';

import * as React from 'react';
import { Button, Container, NamedIcon, Text } from '../../ui';
import { countRules, readRuleTree, RuleFilterChips, RuleFilterMenu, type RuleFieldView, type RuleGroup, type RuleOperatorData } from '../../ui/show/rule-filter';
import operatorData from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json';
import { listRules } from '#workspace-list-rules';
import type { SurfaceCollection } from '../read-data/read-surface-collections';
import { setSurfaceCollectionRules } from '../do-work/edit-surface-collections';

const operators = operatorData as unknown as RuleOperatorData;
const fields: RuleFieldView[] = listRules.facts
  .filter((fact) => fact.on?.includes('lists'))
  .map((fact) => ({ id: fact.id, label: fact.label ?? fact.id, kind: fact.kind, ...(fact.icon ? { icon: fact.icon } : {}) }));

export function ListShowsWhen({ collection, onChanged, onDone }: {
  collection: SurfaceCollection;
  onChanged: () => void | Promise<void>;
  onDone: () => void;
}) {
  const [value, setValue] = React.useState<RuleGroup>(() => readRuleTree(collection.meta.shown_when, operators));
  const [builderOpen, setBuilderOpen] = React.useState(false);
  const change = (next: RuleGroup) => {
    setValue(next);
    void setSurfaceCollectionRules(collection, { shown_when: countRules(next) > 0 ? next : null }).then(onChanged);
  };
  const ruled = countRules(value) > 0;
  return (
    <Container padding="none" gap="xs" data-sidebar-list-shows-when={collection.id}>
      <Container layout="horizontal" alignItems="center" gap="xs" padding="none">
        <Text variant="body-xs" color="secondary">{ruled ? 'Shows while' : 'Always shows'}</Text>
        <RuleFilterMenu
          fields={fields}
          operators={operators}
          value={value}
          onChange={change}
          trigger={<Button variant="ghost" size="sm" aria-label={`When ${collection.name} shows`}/>}
          triggerContent={<><NamedIcon name="CalendarClock" size="xs" aria-hidden/><Text variant="body-xs">Add a rule</Text></>}
          onOpenBuilder={() => setTimeout(() => setBuilderOpen(true))}
        />
        <Button variant="ghost" size="icon-xs" aria-label="Done" onClick={onDone}>
          <NamedIcon name="Check" size="xs" aria-hidden/>
        </Button>
      </Container>
      {ruled || builderOpen
        ? <RuleFilterChips fields={fields} operators={operators} value={value} onChange={change} builderOpen={builderOpen} onBuilderOpenChange={setBuilderOpen}/>
        : null}
    </Container>
  );
}
