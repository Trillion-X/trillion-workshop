// Test-only adapter for existing synthetic grant/carrier fixtures.
import { answerRecordShare as answerWithOwner } from '../src/record-share-pages.mjs';
export function answerRecordShare(request, options) {
  return answerWithOwner(request, { ...options, shareOwnerFor: options.shareOwnerFor ?? (async ({ index }) => {
    const original = options.env.PERSON.get(options.env.PERSON.idFromString(index.person_ref));
    const owner = Object.create(original);
    owner.withSharedNamespace = (_input, use) => use({ env: options.env, namespace: original, access: _input.access, target: _input.target });
    owner.mayAdmitShareEmail = async (code, { email }) => (await original.shareAccess(code, { link_index: index, verified_email: email })).needs === null;
    owner.readSharedTranscript = async ({ identity }) => {
      const answer = await original.namespaceResults('readBody', identity, 'transcript', 'public-share');
      if (answer?.busy) return answer;
      return (await new Response(answer).json()).results?.[0]?.value ?? null;
    };
    return owner;
  }) });
}
