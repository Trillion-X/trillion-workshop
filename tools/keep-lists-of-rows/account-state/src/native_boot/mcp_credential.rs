//! Selected descriptor plus original-account short-lived token admission.
//! No private tc_ credential crosses the resource connection on this adapter.
use super::SelectedAccount;
use crate::{account::NativeAccountOwner,account_rights::resource_connection::credential::{self,Error,IssuedCredential},
    forwarder::session::{ConnectionAdmission,ConnectionGrant}};
use std::{sync::{Arc,Mutex,atomic::AtomicBool},time::Instant};

pub(crate) struct SelectedCredentialAdmission {selected:Arc<Mutex<SelectedAccount>>}
impl SelectedCredentialAdmission {
    pub(crate) fn new(selected:Arc<Mutex<SelectedAccount>>)->Self{Self{selected}}
    pub(crate) fn recover_current(&self,tc:&[u8],now:i64)->credential::Result<Option<IssuedCredential>> {
        let now=u64::try_from(now).ok().filter(|n|*n>0).ok_or(crate::cause!(Error::Invalid))?;
        let mut owner=crate::workspace_session::owner_wait::acquire(&self.selected,||false).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        owner.assert_source_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let SelectedAccount {owner:local,selection,..}= &mut *owner;
        let selection_check=||selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error));
        let recovered=local.recover_current_resource_connection_credential(tc,now,&selection_check)?;
        owner.assert_source_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(recovered)
    }
    pub(crate) fn current_revision(&self,tc:&[u8],now:i64)->credential::Result<u64> {
        let now=u64::try_from(now).ok().filter(|n|*n>0).ok_or(crate::cause!(Error::Invalid))?;
        let mut owner=crate::workspace_session::owner_wait::acquire(&self.selected,||false).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        owner.assert_source_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let revision=owner.owner.resource_connection_credential_revision(tc,now)?;
        owner.assert_source_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(revision)
    }
    pub(crate) fn issue(&self,tc:&[u8],request_key:&str,expected_revision:u64,lifetime_ms:u64,now:i64,
        deadline:Instant,cancel:Arc<AtomicBool>)->credential::Result<IssuedCredential> {
        let now=u64::try_from(now).ok().filter(|n|*n>0).ok_or(crate::cause!(Error::Invalid))?;
        let mut owner=crate::workspace_session::owner_wait::acquire(&self.selected,||cancel.load(std::sync::atomic::Ordering::Acquire)||Instant::now()>=deadline).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        owner.assert_source_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let SelectedAccount {owner:local,selection,..}= &mut *owner;
        let selection_check=||selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error));
        let issued=local.issue_resource_connection_credential(tc,request_key,expected_revision,lifetime_ms,now,deadline,cancel,&selection_check)?;
        owner.assert_source_current().map_err(|error| crate::carry_cause!(Error::Unknown, error))?;
        Ok(issued)
    }
}
impl SelectedCredentialAdmission {
    /// Admit a short connection credential and answer its grant with the credential revision of the slot it stands
    /// on, read under the same hold of the account.
    pub(crate) fn admit_with_revision(&self,raw:&[u8],now:i64)->credential::Result<(ConnectionGrant,u64)> {
        let now=u64::try_from(now).ok().filter(|n|*n>0).ok_or(crate::cause!(Error::Invalid))?;
        let mut owner=crate::workspace_session::owner_wait::acquire(&self.selected,||false).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        owner.assert_source_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let grant=owner.owner.admit_resource_connection_credential(raw,now)?;
        let revision=owner.owner.admitted_resource_connection_revision(&grant)?;
        owner.assert_source_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok((grant,revision))
    }
}
impl ConnectionAdmission for SelectedCredentialAdmission {
    fn admit(&self,raw:&[u8],now:i64)->Option<ConnectionGrant> {
        let now=u64::try_from(now).ok().filter(|n|*n>0)?;
        let mut owner=crate::workspace_session::owner_wait::acquire(&self.selected,||false).ok()?;
        owner.assert_source_current().ok()?;
        let grant=owner.owner.admit_resource_connection_credential(raw,now).ok()?;
        owner.assert_source_current().ok()?;
        Some(grant)
    }
    fn is_current(&self,grant:&ConnectionGrant,now:i64)->bool {
        let Ok(now)=u64::try_from(now) else{return false};
        if now==0{return false};
        let Ok(mut owner)=crate::workspace_session::owner_wait::acquire(&self.selected,||false) else{return false};
        owner.assert_source_current().is_ok()&&owner.owner.resource_connection_credential_is_current(grant,now)
            &&owner.assert_source_current().is_ok()
    }
}
