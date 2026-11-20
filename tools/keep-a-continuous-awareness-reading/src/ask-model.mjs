// src/ask-model.mjs
//
// Purpose: the reader's one question to a model. It asks the one road every model call takes, the model-calls owner
// (tools/keep-and-wake-ai-sessions-on-this-computer/src/model-calls.mjs, `modelCalls(...).answered`): a conversation goes
// to the person's own routes (tools/route-model-calls/src/model-routes.json, `conversation`), and when none answers it
// throws NoChosenAI with `no_chosen_ai: true`, which the reader turns into a wait. The old askChosenAwarenessModel picked
// the person's connected providers itself and rethrew refusedWork errors from a retired module; that choice now lives in
// the routing owner, so it is not copied here.
//
// Shape: `calls` is the object modelCalls returns; the result is { reply, model } as the routing owner answered it.

/** The reader's `ask(system, user)` over the model-calls owner's `answered` road. */
export function askAwarenessModel(calls, { purpose = 'awareness' } = {}) {
  if (typeof calls?.answered !== 'function') throw new TypeError('The reader asks a model through modelCalls(...).answered.');
  return (system, user) => calls.answered(purpose, null, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
}
