// Explicit own-browser management on the same retained selected account.
// Selection is checked again by the LocalAccount command's internal witness,
// including inside its original policy transaction before commit.
use super::SelectedAccount;
use crate::{
    account::{self, BrowserAdmission},
    account_rights::{self, resource_connection::{Change, Registration}},
    workspace::WorkspaceSession,
};
use std::{sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Instant};

pub(crate) struct BrowserConnectionChange {
    session: Arc<WorkspaceSession>,
    admitted: BrowserAdmission,
    registration: Registration,
    request_key: String,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl BrowserConnectionChange {
    pub(crate) fn expired(&self)->bool {
        self.cancel.load(Ordering::Acquire)||Instant::now()>=self.deadline
    }
}
fn same(admitted:&BrowserAdmission, session:&WorkspaceSession)->account_rights::Result<()> {
    if admitted.account.user_id!=session.account_id || !admitted.still() {
        return Err(crate::cause!(account_rights::Error::NotAuthorized));
    }
    Ok(())
}
impl SelectedAccount {
    pub(crate) fn change_browser_resource_connection(
        &mut self, session:Arc<WorkspaceSession>, change:&Change,
        cancel:Arc<AtomicBool>, deadline:Instant,
    )->account_rights::Result<BrowserConnectionChange> {
        if cancel.load(Ordering::Acquire)||Instant::now()>=deadline { return Err(crate::cause!(account_rights::Error::NotAuthorized)); }
        self.selection.assert_current().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        let admitted=account::current_browser(&mut self.owner,&session.session_id).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        same(&admitted,&session)?;
        let selection=&self.selection;
        let registration=self.owner.change_resource_connection(&session.session_id,change,deadline,cancel.clone(),
            &||selection.assert_current().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error)))?;
        self.selection.assert_current().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        Ok(BrowserConnectionChange {session,admitted,registration,request_key:change.request_key.clone(),cancel,deadline})
    }
    /// Re-read original metadata, never repeat the enrollment effect, before
    /// the first HTTP result message. A withdrawn session or changed row withholds.
    pub(crate) fn finish_browser_resource_connection(&mut self, held:&BrowserConnectionChange)->account_rights::Result<serde_json::Value> {
        if held.expired() { return Err(crate::cause!(account_rights::Error::NotAuthorized)); }
        self.selection.assert_current().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        let now=account::current_browser_read_only(&mut self.owner,&held.session.session_id).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        same(&now,&held.session)?;
        if now.account!=held.admitted.account || !held.admitted.still() {
            return Err(crate::cause!(account_rights::Error::NotAuthorized));
        }
        self.owner.resource_connection_management_result_current(&held.registration)?;
        self.selection.assert_current().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        if held.expired() { return Err(crate::cause!(account_rights::Error::NotAuthorized)); }
        let r=&held.registration;
        Ok(serde_json::json!({"active":r.active,"device_id":r.device_id,"resource_address":r.resource_address,
            "resource_generation":r.resource_generation,"registration_revision":r.registration_revision,"request_key":held.request_key}))
    }
}

/// One turn's real browser management admission, outside all physical domain
/// holds. It can be retained while a bounded local page runs; it is not a
/// serialized permission and cannot be minted by a computer's membership.
pub(crate) struct NativeTransferAdmission {
    pub(crate) account:String,
    pub(crate) domain:crate::storage::record_store_resources::domains::Bound,
    pub(crate) authority:crate::local_account::NativeDomainAuthority,
    pub(crate) current:Arc<dyn Fn()->bool+Send+Sync>,
}
impl SelectedAccount {
    pub(crate) fn admit_browser_domain_transfer(&mut self,session:&str,
        history:&crate::storage::record_store_resources::domains::Identity,
        cancel:Arc<AtomicBool>,deadline:Instant)->account_rights::Result<NativeTransferAdmission> {
        use crate::account::NativeAccountOwner;
        self.selection.assert_current().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        let browser=account::current_browser(&mut self.owner,session).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        let selection=self.selection.clone();
        let still=browser.current.clone();let expected=browser.account.clone();
        let mut current=|owner:&mut crate::local_account::LocalAccount| {
            selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?;
            let now=account::current_browser_read_only(owner,session)?;
            if now.account!=expected || !still() {return Err(crate::cause!(crate::account::AccountError::BrowserInactive));}
            Ok(())
        };
        let authority=self.owner.native_domain_authority(history,cancel.clone(),deadline,&mut current)?;
        let account=self.owner.account().owner_id;
        let generation=self.owner.original_records_read_generation().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        let domain=self.owner.selected_command_domain(&serde_json::json!({"scope":history}),&account,generation)
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?.ok_or(crate::cause!(account_rights::Error::NotAuthorized))?;
        let current=Arc::new(move || !cancel.load(Ordering::Acquire) && Instant::now()<deadline && still() && selection.assert_current().is_ok());
        if !current() {return Err(crate::cause!(account_rights::Error::NotAuthorized));}
        Ok(NativeTransferAdmission {account,domain,authority,current})
    }
    pub(crate) fn prepare_browser_domain_source(&mut self,session:&str,
        history:&crate::storage::record_store_resources::domains::Identity,move_id:&str,request_key:&str,expected_revision:u64,
        cancel:Arc<AtomicBool>,deadline:Instant,control:Option<crate::local_account::NativeDomainControl<'_>>)
        ->account_rights::Result<crate::local_account::record_writer::native_command_context::NativeRemoteDomainSource> {
        self.selection.assert_current().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        let browser=account::current_browser(&mut self.owner,session).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        let selection=self.selection.clone();
        let mut current=|owner:&mut crate::local_account::LocalAccount| {
            selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?;
            if !browser.same_as(&account::current_browser_read_only(owner,session)?) {return Err(crate::cause!(crate::account::AccountError::BrowserInactive));}
            Ok(())
        };
        self.owner.prepare_remote_domain_source(history,move_id,request_key,expected_revision,cancel,deadline,&mut current,control)
            .map(|(source,_)|source).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))
    }
    pub(crate) fn activate_browser_domain_source(&mut self,session:&str,
        source:&crate::local_account::record_writer::native_command_context::NativeRemoteDomainSource,
        cancel:Arc<AtomicBool>,deadline:Instant,control:crate::local_account::NativeDomainControl<'_>)->account_rights::Result<()> {
        self.selection.assert_current().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        let browser=account::current_browser(&mut self.owner,session).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        let selection=self.selection.clone();
        let mut current=|owner:&mut crate::local_account::LocalAccount| {
            selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?;
            if !browser.same_as(&account::current_browser_read_only(owner,session)?) {return Err(crate::cause!(crate::account::AccountError::BrowserInactive));}
            Ok(())
        };
        source.activate_canonical(&mut self.owner,cancel,deadline,&mut current,control).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))
    }
}

pub(crate) struct BrowserDomainTransferResult {
    session:Arc<WorkspaceSession>,value:serde_json::Value,
    transfer:Option<(crate::storage::record_store_resources::domains::Identity,String,String)>,
    cancel:Arc<AtomicBool>,deadline:Instant,
}
impl BrowserDomainTransferResult {
    pub(crate) fn new(session:Arc<WorkspaceSession>,value:serde_json::Value,transfer:Option<(crate::storage::record_store_resources::domains::Identity,String,String)>,cancel:Arc<AtomicBool>,deadline:Instant)->Self {
        Self {session,value,transfer,cancel,deadline}
    }
    pub(crate) fn expired(&self)->bool {self.cancel.load(Ordering::Acquire)||Instant::now()>=self.deadline}
}
impl SelectedAccount {
    pub(crate) fn finish_browser_domain_transfer(&mut self,result:&BrowserDomainTransferResult)->account_rights::Result<serde_json::Value> {
        if result.expired(){return Err(crate::cause!(account_rights::Error::NotAuthorized));}
        self.selection.assert_current().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        let browser=account::current_browser_read_only(&mut self.owner,&result.session.session_id).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        same(&browser,&result.session)?;
        if let Some((scope,move_id,target))=&result.transfer {
            let admitted=self.admit_browser_domain_transfer(&result.session.session_id,scope,result.cancel.clone(),result.deadline)?;
            let stage=admitted.authority.registration().staged.as_ref().ok_or(crate::cause!(account_rights::Error::SourceChanged))?;
            if stage.move_id!=*move_id {return Err(crate::cause!(account_rights::Error::SourceChanged));}
            if result.value["state"]=="active" {
                let copies=crate::account::computers::copies::running_for(&admitted.account).ok_or(crate::cause!(account_rights::Error::SourceChanged))?;
                if !stage.activated || copies.writer_row().is_none_or(|(writer,_,_)|writer!=*target) {
                    return Err(crate::cause!(account_rights::Error::SourceChanged));
                }
            }
        }
        self.selection.assert_current().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        Ok(result.value.clone())
    }
}

impl SelectedAccount {
    /// Original selected canonical source for automatic replica repair. This
    /// reads an existing registration only; computer membership cannot enroll,
    /// prepare or activate a move through this producer. The copy owner still
    /// proves current sender/term and the new physical token at publication.
    pub(crate) fn current_replica_domain_authority(&mut self,
        history:&crate::storage::record_store_resources::domains::Identity,
        cancel:Arc<AtomicBool>,deadline:Instant)->account_rights::Result<crate::local_account::NativeDomainAuthority> {
        use crate::account::NativeAccountOwner;
        self.selection.assert_current().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        let expected=self.owner.account();let selection=self.selection.clone();
        self.owner.native_domain_authority(history,cancel,deadline,&mut |owner| {
            selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?;
            owner.assert_source_current()?;
            if owner.account()!=expected || owner.original_records_read_generation().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?!=history.generation {
                return Err(crate::cause!(crate::account::AccountError::SourceChanged));
            }
            selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))
        })
    }
}
