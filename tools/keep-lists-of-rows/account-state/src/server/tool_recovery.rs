//! Native response composition for an already delivered Workshop result. The primary receipt remains owned by
//! Workshop pages; this owner retains only this actual caller/source and supplies the existing final body guard.
use super::*;
use crate::{
    account::NativeAccountOwner,
    account_rights::run_capability::{Admitted, Issuer, ParentIssuer, ParentKey},
    tool_runs::tools::{Held, Place, RecoveryReceipt, Workshop, task_context::{Context,ContextIssuer}},
};
use std::sync::atomic::{AtomicBool,Ordering};

struct NoReadOnlyValues;
impl Held for NoReadOnlyValues {
    fn plain(&self, _: &str) -> Result<zeroize::Zeroizing<String>,crate::tool_runs::tools::Failure> {
        Err(crate::cause!(crate::tool_runs::tools::Failure::Credential))
    }
}
impl LocalSelectedMcp {
    /// Rebuild only the same native issuer and read-only kind query inside the callback. Nothing borrowed from the
    /// runner survives the call, and no capability/process/grant is issued while the body is being disclosed.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn retain_tool_recovery(&self, workshop:&'static Workshop, caller:&Caller,
        disclosure:&crate::mcp::RequestDisclosure, cancel:Arc<AtomicBool>, deadline:Option<Instant>,
        context:Option<Context>, journal_input:bool, nested:Option<Admitted>, proof:RecoveryReceipt)
        -> Result<(),OperationFailure> {
        // The run is finished: its answer's time is counted from now, not from the request's start, which a run of
        // the records bound's own length has already spent.
        let deadline=Some(super::installed_instructions::answer_deadline(Instant::now(),deadline));
        // Native composition already holds this actual static runtime; the body retains that same owner.
        let owner=workshop;
        let here = self.me.clone();
        let accepts:Arc<dyn Fn(&[u8])->bool + Send + Sync> = match nested.as_ref() {
            Some(run) => { let actual=run.duplicate(); Arc::new(move |bearer|actual.matches_bearer(bearer)) },
            None => {
                let credential=caller.credential.clone();
                Arc::new(move |bearer|bearer == credential.as_slice())
            }
        };
        let actor = caller.clone();
        let keeper = proof.read_only_held();
        let kind_cancel = cancel.clone();
        let source_pause: account_routes::Current = Arc::new(move || !cancel.load(Ordering::Acquire)
            && deadline.is_none_or(|until|Instant::now() < until));
        let body_pause = source_pause.clone();
        let current = Arc::new(move || {
            if !source_pause() || !actor.stands() { return false; }
            let Some(here) = here.upgrade() else { return false; };
            // Current selected account/placement before source/kind work. Release its hold before re-entering
            // the original native source owners (a share or browser current pause can hold its own admission owner).
            let state_root = {
                let Ok(mut selected) = owner_wait::acquire(&here.owner, || !source_pause()) else { return false; };
                if selected.assert_source_current().is_err() || selected.account().owner_id != actor.principal.account_id {
                    return false;
                }
                selected.state_root().to_owned()
            };
            let authority = if nested.is_some() { None } else { here.credential_parent(&actor) };
            let route = here.route();
            let ordinary = route.as_ref().zip(authority).map(|(route,authority)| ParentIssuer {
                parent:ParentKey {address:&route.address,account:&actor.principal.account_id,bearer:&actor.credential,door:route.door,cause:None},
                authority,journal_input,
            });
            let inherited = nested.as_ref().zip(route.as_ref()).map(|(run,route)| run.nested_issuer(route));
            let base:Option<&dyn Issuer> = match (inherited.as_ref(),ordinary.as_ref()) {
                (Some(nested),_) => Some(nested),
                (_,Some(ordinary)) => Some(ordinary),
                _ => None,
            };
            let contextual = context.as_ref().map(|context| ContextIssuer {parent:base,context:context.clone()});
            let source:&dyn Issuer = match (contextual.as_ref(),base) {
                (Some(context),_) => context,
                (_,Some(parent)) => parent,
                _ => return false,
            };
            let issuer = computer_actions::ParentActionIssuer {parent:source,current:source_pause.clone()};
            let held:&dyn Held = keeper.as_deref().map_or(&NoReadOnlyValues as &dyn Held,|keeper|keeper as &dyn Held);
            let place=Place {account:&actor.principal.account_id,state_root:&state_root,door:Some(&issuer),origin:None};
            if !proof.recheck_kind(owner,&place,held,&kind_cancel,deadline) || !source_pause() || !actor.stands() { return false; }
            // The original readonly primary row/file custody is the LAST source query. Only local cancellation and
            // the original deadline are checked afterward; the existing CurrentBody retains this closure and keeper.
            proof.current() && body_pause()
        });
        disclosure.register_current_matching(&caller.principal,accepts,current)
            .map_err(|error|OperationFailure {cause:error.cause(),..refusal("original_workspace_read_unavailable",true)})
    }
}
