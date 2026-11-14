// The account a person signed in to, carried in every pass this tool signs. settings.account_claim names the user field
// that holds it (`field`, a user additional field the person cannot set: input false) and the claim it goes out as
// (`claim`). The session JWT keeps its default payload (the user) and adds the claim; an MCP access token gets it through
// the OAuth provider's customAccessTokenClaims. No account_claim in the settings, or a user with no account: no claim.

const of = settings => settings.account_claim ?? null;
const claimFor = (named, user) => (named && user?.[named.field] ? { [named.claim]: user[named.field] } : {});

/** The user additional fields the account needs (Better Auth `user.additionalFields`). */
export const accountFields = settings => {
  const named = of(settings);
  return named ? { [named.field]: { type: 'string', required: false, input: false } } : {};
};

/** The jwt plugin's definePayload: the default payload (the user) with the account claim. */
export const sessionPayload = settings => ({ user }) => ({ ...user, ...claimFor(of(settings), user) });

/** The OAuth provider's customAccessTokenClaims: the account claim of the user a token is for. */
export const accessTokenClaims = settings => ({ user }) => claimFor(of(settings), user);

/** An API key's metadata entry for the account of the party creating it (empty when it has none). */
export const keyAccount = (settings, user) => claimFor(of(settings), user);
