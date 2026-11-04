// tools/build-a-screen-from-patches/read-data/screen-patch-tools.mjs
//
// The three rows' functions over view-patch.mjs and screen-spec.mjs (both moved unchanged). Nothing here reads or
// writes the person's records: each row answers from its input alone.
import { identityOf, makeAnswerCache, patchedAnswer, textAfter } from './view-patch.mjs';
import { checkSpec, specFromText } from './screen-spec.mjs';

const KEY = 'screen';
const asJson = text => ({ status: 200, content_type: 'application/json', text });
const needText = (value, name) => {
  if (typeof value !== 'string') throw new Error(`Give ${name} as the answer's JSON text.`);
  return value;
};

/** What a screen holds after reading `text`: { identity, text } in canonical form, or undefined when not JSON. */
const heldFromText = text => {
  try {
    const canonical = JSON.stringify(JSON.parse(text));
    return { identity: identityOf(canonical), text: canonical };
  } catch { return undefined; }
};

/** tool:make-a-view-patch: the next answer as a patch against the previous one when that is smaller, else whole. */
export function viewPatchBetween(input) {
  const previous = needText(input?.previous, 'previous');
  const next = needText(input?.next, 'next');
  const cache = makeAnswerCache();
  const first = patchedAnswer({ answer: asJson(previous), key: KEY, cache });
  return patchedAnswer({ answer: asJson(next), have: first.identity, key: KEY, cache });
}

/** tool:apply-a-view-patch: the text a screen holding `previous` shows after `answer`, or { stale: true }. */
export function textAfterViewPatch(input) {
  const previous = typeof input?.previous === 'string' ? input.previous : undefined;
  return textAfter(input?.answer, previous === undefined ? undefined : heldFromText(previous));
}

/** tool:build-a-screen-spec-from-a-patch-stream: the spec the lines make, what was said about them, and the check. */
export function screenSpecFromLines(input) {
  const { spec, said } = specFromText(needText(input?.text, 'text'));
  const checked = checkSpec(spec, { requests: input?.requests ?? {} });
  return { spec: checked.spec, said, fixes: checked.fixes, problems: checked.problems };
}
