import test from 'node:test';
import assert from 'node:assert/strict';
import { authoredInteractionState, authoredPrimaryGrip } from '../read-data/interaction-events.ts';
const handlers = { click: [{ kind: 'DISPATCH_FSM', event: { type: 'toggle' } }] };
const fsm = { initial: 'open', states: { open: { on: { toggle: [{ target: 'closed' }] } }, closed: { on: { toggle: [{ target: 'open' }] } } } };
test('authored state follows complete unguarded DATA transitions', () => {
  assert.equal(authoredInteractionState(fsm, handlers), 'closed');
  assert.equal(authoredInteractionState({ ...fsm, initial: 'closed' }, handlers), 'open');
});
test('conditional transitions and other handler effects never get approximated in the editor', () => {
  const conditional = structuredClone(fsm);
  conditional.states.open.on.toggle.unshift({ target: 'open', guard: { from: 'context', path: 'hold' } });
  assert.equal(authoredInteractionState(conditional, handlers), null);
  assert.equal(authoredInteractionState(fsm, { click: [...handlers.click, { kind: 'RUN_ACTION' }] }), null);
  const withActions = structuredClone(fsm);
  withActions.states.open.on.toggle[0].actions = [{ kind: 'RUN_ACTION' }];
  assert.equal(authoredInteractionState(withActions, handlers), null);
});

test('primary editable grip ownership comes from the interaction DATA', () => {
  const text = (id, role) => ({ id, kind: 'Text', props: { content_role: role } });
  assert.deepEqual(authoredPrimaryGrip({ id: 'control', props: { interaction: { structure: { primary_role: 'title' } } },
    children: [{ id: 'wrapper', synthetic: true, children: [text('heading', 'title')] }, text('body', 'title')] }),
  { ownerId: 'control', role: 'title', primaryNodeId: 'heading' });
  assert.deepEqual(authoredPrimaryGrip({ id: 'checkbox', props: { interaction: { role: 'checkbox', structure: {} } }, children: [text('label', 'primary')] }),
    { ownerId: 'checkbox', role: 'primary', primaryNodeId: 'label' });
  assert.deepEqual(authoredPrimaryGrip({ id: 'list', props: { interaction: { structure: { primary_role: 'title', body_role: 'items' } } }, children: [
    text('title', 'title'), { id: 'items-slot', kind: 'Container', props: { content_role: 'items' }, children: [text('child', 'primary')] },
  ] }), { ownerId: 'list', role: 'title', primaryNodeId: 'title', bodyNodeId: 'items-slot' }, 'the exact declared body slot has no separate block handle');
  assert.equal(authoredPrimaryGrip({ id: 'ordinary-action', props: { interaction: { role: 'button' } }, children: [text('content', 'primary')] }), null);
  assert.equal(authoredPrimaryGrip({ id: 'outer', props: { interaction: { structure: {} } }, children: [
    { id: 'inner', props: { interaction: {} }, children: [text('inner-primary', 'primary')] },
  ] }), null);
  assert.equal(authoredPrimaryGrip({ id: 'empty', props: { interaction: {} } }), null);
  assert.equal(authoredPrimaryGrip({ id: 'layout', synthetic: true }), null);
});
