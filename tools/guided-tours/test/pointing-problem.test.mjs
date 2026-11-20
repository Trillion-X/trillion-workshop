// The pointing rule of a tour step, checked against the DATA in tools/tours-screen/read-data/tours.json. The cases are the
// four branches of the older Workshop copy of src/tours.mjs pointingProblem (b6ae0ebf81, lines 47-53); the old code had no test file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pointingProblem } from '../do-work/pointing-problem.mjs';
import settings from '../../tours-screen/read-data/tours.json' with { type: 'json' };

const pointing = settings.pointing;
const aimed = (query, surface) => ({ target_ref: { from: 'selector', query }, ...(surface ? { target_preparation: { surface: { id: surface } } } : {}) });

test('a step that holds its thing live in the card needs no target', () => {
  assert.equal(pointingProblem({ content: { content_kind: 'placeable-surface' } }, pointing), null);
  assert.equal(pointingProblem({ content: { content_kind: 'picture' } }, pointing), null);
});

test('a step with no query points at nothing, and the words say how to fix it', () => {
  assert.match(pointingProblem({ content: { content_kind: 'text' } }, pointing), /^points at nothing: give it target_ref/);
  assert.match(pointingProblem({ target_ref: { from: 'selector', query: '   ' } }, pointing), /^points at nothing/);
});

test('a query of only whole-page selectors is refused as the whole page, never as a control', () => {
  assert.match(pointingProblem(aimed('div, main'), pointing), /which is the whole page, not a control/);
  assert.match(pointingProblem(aimed('*'), pointing), /the whole page/);
  assert.equal(pointingProblem(aimed('Body'), pointing).includes('"Body"'), true, 'matched case-insensitively');
});

test('a control inside a screen is refused until its screen is opened, and passes once the screen is named', () => {
  assert.match(pointingProblem(aimed('[data-share-button]'), pointing), /inside a screen without opening it/);
  assert.equal(pointingProblem(aimed('[data-share-button]', 'sharing'), pointing), null);
});

test('a page-wide control needs no screen, and a mixed query is not whole-page', () => {
  assert.equal(pointingProblem(aimed('[data-sidebar-open-toggle]'), pointing), null);
  assert.equal(pointingProblem(aimed('div, [data-sidebar-open-toggle]'), pointing), null);
  assert.match(pointingProblem(aimed('div, [data-share-button]'), pointing), /inside a screen without opening it/);
});
