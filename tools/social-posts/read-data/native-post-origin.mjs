// src/typed-on-signed-in-screen.mjs
// The one header name by which the Worker's own signed-in page routes (src/work-messages.mjs) tell the person store that
// the words in a request were typed on the person's own signed-in page. Saved logins take a person's consent only from
// words captured by a verified road (src/saved-logins.mjs grantRefusal), and this is how the page road is told apart
// from an AI app's record_messages / send_to_all_ais. The Posts page road (src/work-posts.mjs) sets it on an approval the
// person pressed, the only approval a post that reaches someone accepts (src/social-posts.mjs invariant 7), and the
// native post and community owners set it for a command from that page (pressedOnSignedInPage), the only road a yes to
// meeting someone takes (src/community-matching.mjs answerMatch).
// Invariant: a caller never supplies it. The /mcp/api forward deletes it (src/worker.mjs), and the person store's
// send-to-all-ais drops it before calling its own routes (src/person-store.mjs sendToAllAis).
// The original native-look-authorization.mjs predicate is pure; the account policy directory is a host capability.
const isNativeLook = claims => claims?.approved_by === 'view-as' || claims?.look !== undefined;

export const TYPED_ON_SIGNED_IN_SCREEN = 'x-trillion-typed-on-signed-in-screen';

/** Whether a native command's claims are the person's own signed-in page: a session sign-in, never an AI app's key and
 *  never a look at someone's account. */
export const pressedOnSignedInPage = claims => /^session:/.test(claims?.sign_in ?? '') && !isNativeLook(claims);
