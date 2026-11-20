// tools/better-auth-official/pages/safe-next.mjs
//
// Where a sign-in page sends a person after signing in: the `next` path when it is a same-origin path, else the root. Ported from old
// trillion-rust src/account/sign_in/routes.rs `safe_next` (2b8b821a4, lines 181-190): a path starts with one "/", is never "//" or "/\"
// (browsers read both as another host), and carries no control character.
export function safeNext(asked, root = '/') {
  if (typeof asked !== 'string') return root;
  if (!asked.startsWith('/') || asked.startsWith('//') || asked.startsWith('/\\') || /[\u0000-\u001f\u007f-\u009f]/.test(asked)) return root;
  return asked;
}
