import test from 'node:test';
import assert from 'node:assert/strict';
import { boardFrameMedia } from 'trillion-workshop/tools/organize-the-sidebar/do-work/board-frame-media.ts';
import type { BoardDeck } from './board-deck';

const deck: BoardDeck = { slides: [
  { order: 1, frameId: 'first/frame', label: 'First', svg: '<svg><text>One</text></svg>', itemCount: 1 },
  { order: 2, frameId: 'second.frame', label: 'Second', svg: '<svg><text>Two</text></svg>', itemCount: 1 },
] };

test('keeps the source frame order and identities while giving each image a safe distinct file name', () => {
    const files = boardFrameMedia(deck);
    assert.deepEqual(files.map(file => file.frameId), ['first/frame', 'second.frame']);
    assert.deepEqual(files.map(file => file.content), deck.slides.map(slide => slide.svg));
    assert.deepEqual(files.map(file => file.fileName), ['001-First.svg', '002-Second.svg']);
    assert.equal(new Set(files.map(file => file.fileName)).size, 2);
});

test('refuses repeated frame identities before uploading public bytes', () => {
    assert.throws(() => boardFrameMedia({ slides: [deck.slides[0], { ...deck.slides[1], frameId: deck.slides[0].frameId }] }), /repeated frame identities/);
});

test('keeps public file names readable and safe for repeated or path-like labels', () => {
    const files = boardFrameMedia({ slides: [
      { ...deck.slides[0], label: '  Team / launch: first look?  ' },
      { ...deck.slides[1], label: '  Team / launch: first look?  ' },
    ] });
    assert.deepEqual(files.map(file => file.fileName), ['001-Team launch first look.svg', '002-Team launch first look.svg']);
    assert.throws(() => boardFrameMedia({ slides: [deck.slides[0], { ...deck.slides[1], order: 1 }] }), /frame order/);
});
