// Stripe returns to the workspace root. Keep a space invite in this tab only while checkout is open.
const KEY = 'trillion:space-invite-after-checkout';

export function rememberSpaceInviteForCheckout(address = location.href, storage = sessionStorage) {
  const url = new URL(address);
  const code = url.pathname === '/spaces' ? url.searchParams.get('join') : null;
  if (code) storage.setItem(KEY, code);
}

export function takeSpaceInviteAfterCheckout(storage = sessionStorage) {
  const code = storage.getItem(KEY);
  storage.removeItem(KEY);
  return code ? `/spaces?join=${encodeURIComponent(code)}` : null;
}
