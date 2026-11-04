// Trusted carrier data comes from the authenticated Worker session, never a form.
export function nativeBrowserRecorder(session,{device=session?.device??null}={}) {
  return {app:'this browser',app_basis:'authenticated',browser:{user_id:session.userId,session_id:session.id,
    created_at:session.created_at,method:session.method??null,browser_generation:session.browser_generation??0,device}};
}
