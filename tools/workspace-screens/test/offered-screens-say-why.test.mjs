// A screen a tool offers that cannot open or cannot draw says why, with Try again, in its own pane: the pane is never left
// blank. The page is not drawn in this test runner, so each rule is checked where the page's source writes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = name => readFileSync(new URL(`../web/src/workspace/${name}`, import.meta.url), 'utf8');
const toolScreen = source('tool-screen.tsx');
const partsScreen = source('parts-screen.tsx');
const failure = source('failure.ts');
const words = JSON.parse(source('failure-words.json'));

test('an offered row opens through showOffered, and a throw while it opens is said with Try again', () => {
  assert.ok(toolScreen.includes('if (own?.screen) return showOffered(element, own, own.screen, props, screens);'));
  assert.ok(toolScreen.includes('try { stop = show(element, tool, screen, props, screens); }'));
  assert.ok(toolScreen.includes('mountScreenState(element, failedState(error, open, screenFailed(tool, screen)));'));
  assert.ok(!toolScreen.includes('SHOWS[own.screen.kind] ?'), 'an offered kind is refused by a guard of its own');
});

test('a parts screen that throws while it mounts or shows says why, with Try again', () => {
  assert.ok(toolScreen.includes("shown = module.mountPartsScreen(slotOf(element, 'screen'), { requests: screen.requests ?? {}, title: screenFailed(tool, screen)"));
  assert.ok(toolScreen.includes('mountScreenState(element, failedState(error, open, screenFailed(tool, screen)));'));
});

test('a parts screen that throws as it draws is said by its own boundary, not drawn blank', () => {
  assert.ok(partsScreen.includes('class DrawBoundary extends React.Component'));
  assert.ok(partsScreen.includes('<DrawBoundary title={title}>'));
  assert.ok(partsScreen.includes('failedState(this.state.error.value, () => this.setState({ error: null }), this.props.title)'));
});

test('a conditions engine that did not load is said with its reason and Try again, not a bare caption', () => {
  assert.ok(!partsScreen.includes("state === 'failed') return <Fallback />"));
  assert.ok(partsScreen.includes("if (typeof state === 'object') return <ScreenState state={failedState(state.failed, () => setState('idle'), title)} />;"));
});

test('a refused read keeps its error in the failed state, so the reason (busy words included) reaches the person', () => {
  assert.ok(partsScreen.includes('const failed = (error: unknown) => store.fail({ error });'));
  assert.ok(partsScreen.includes('<ScreenState state={failedState(failure.error, host.retry, title)} />'));
  assert.ok(failure.includes('if (busy) return busy;'), 'reasonOf no longer gives the sign-in server busy words first');
});

test('the words of a screen that cannot be shown are data, with the screen name in them', () => {
  assert.match(words.screen_failed, /\{name\}/);
  assert.ok(words.screen_plain && words.screen_plain.length > 0);
});

// A pane's writers draw into their own slots: no mount empties the pane itself (mountReactSurface and guideScreen both
// replace a pane's children, which took the state and screen slots out of it: a failed state then drew into nodes that
// were no longer in the pane).
test('the parts, web-address and module screens mount into the pane\'s screen slot, never the pane itself', () => {
  assert.ok(toolScreen.includes("module.mountPartsScreen(slotOf(element, 'screen'), {"));
  assert.ok(toolScreen.includes("module.webAddress(slotOf(element, 'screen'), tool, screen, latest, screens);"));
  assert.ok(toolScreen.includes("mountReactSurface(slotOf(element, 'screen'), node(latestInput));"));
  assert.ok(!toolScreen.includes('mountPartsScreen(element,'), 'a parts screen mounts onto the raw pane');
});

// A renderer that a resource binding mounts draws into the pane's screen slot too, so it cannot empty the pane.
test('an addressed renderer mounts into the pane\'s screen slot', () => {
  assert.ok(toolScreen.includes("mountAddressedRenderer({ element: slotOf(element, 'screen'), binding: screen.resource_binding!"));
  assert.ok(!toolScreen.includes('mountAddressedRenderer({ element, binding'), 'an addressed renderer mounts onto the raw pane');
});
