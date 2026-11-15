//! Short-lived connection capabilities derived by the explicitly enrolled
//! original computer credential. The read observer stays read-only; only this
//! narrow issue command borrows a bounded writer on the same selected policy.
use super::*;
use crate::{account_rights::resource_connection::{self as registration,credential::{self,Error,IssuedCredential}},
    forwarder::session::ConnectionGrant,storage::{sqlite::{self,Access},Storage}};
use std::{sync::atomic::{AtomicBool,Ordering},time::Instant};

struct Issuer<'a> {
    owner:&'a mut LocalAccount,key:&'a [u8],registration:registration::Registration,
    policy_path:PathBuf,policy_inode:Inode,deadline:Instant,cancel:Arc<AtomicBool>,now:u64,
    selection_check:&'a dyn Fn()->AccountResult<()>,
}
impl credential::Issuer for Issuer<'_> {
    fn assert_current(&mut self,store:&dyn Storage,current:&registration::Registration)->credential::Result<()> {
        if self.cancel.load(Ordering::Acquire)||Instant::now()>=self.deadline{return Err(crate::cause!(Error::Unauthorized))};
        (self.selection_check)().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        self.owner.assert_owned().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if current!=&self.registration||store.location()!=self.policy_path.to_str()
            ||self.owner.source.policy.path!=self.policy_path{return Err(crate::cause!(Error::Unauthorized))};
        self.policy_inode.check(&self.policy_path).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        check_sqlite_sidecars(&self.policy_path).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        store.custody().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let fresh=self.owner.resource_connection_for_key(self.key,self.now).map_err(|error| crate::carry_cause!(Error::Unauthorized, error))?;
        if fresh!=self.registration{return Err(crate::cause!(Error::Unauthorized))};
        self.owner.assert_owned().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        (self.selection_check)().map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }
}
impl LocalAccount {
    pub(crate) fn recover_current_resource_connection_credential(&mut self,key:&[u8],now:u64,
        selection_check:&dyn Fn()->AccountResult<()>)->credential::Result<Option<IssuedCredential>> {
        selection_check().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let registration=self.resource_connection_for_key(key,now).map_err(|error| crate::carry_cause!(Error::Unauthorized, error))?;
        let account=self.source.account.clone();
        let recovered={let store=sqlite::lend(&self.source.policy.connection,"account_policy",Access::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            credential::recover_current(&store,&account,key,now)?};
        if self.resource_connection_for_key(key,now).map_err(|error| crate::carry_cause!(Error::Unauthorized, error))?!=registration{return Err(crate::cause!(Error::Conflict))};
        if recovered.as_ref().is_some_and(|value|!self.resource_connection_credential_is_current(value.grant(),now)){return Err(crate::cause!(Error::Unavailable))};
        if recovered.is_none() {
            let store=sqlite::lend(&self.source.policy.connection,"account_policy",Access::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if credential::recover_current(&store,&account,key,now)?.is_some(){return Err(crate::cause!(Error::Conflict))};
        }
        self.assert_owned().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        selection_check().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(recovered)
    }

    pub(crate) fn resource_connection_credential_revision(&mut self,key:&[u8],now:u64)->credential::Result<u64> {
        let registered=self.resource_connection_for_key(key,now).map_err(|error| crate::carry_cause!(Error::Unauthorized, error))?;
        let account=self.source.account.clone();
        let store=sqlite::lend(&self.source.policy.connection,"account_policy",Access::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let revision=credential::revision(&store,&account,&registered.device_id)?;
        drop(store);
        if self.resource_connection_for_key(key,now).map_err(|error| crate::carry_cause!(Error::Unauthorized, error))?!=registered{return Err(crate::cause!(Error::Conflict))};
        self.assert_owned().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(revision)
    }

    pub(crate) fn issue_resource_connection_credential(&mut self,key:&[u8],request_key:&str,expected_revision:u64,
        lifetime_ms:u64,now:u64,deadline:Instant,cancel:Arc<AtomicBool>,selection_check:&dyn Fn()->AccountResult<()>)->credential::Result<IssuedCredential> {
        if cancel.load(Ordering::Acquire)||Instant::now()>=deadline{return Err(crate::cause!(Error::Unauthorized))};
        selection_check().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let registration=self.resource_connection_for_key(key,now).map_err(|error| crate::carry_cause!(Error::Unauthorized, error))?;
        let account=self.source.account.clone();
        self.assert_owned().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let policy_path=self.source.policy.path.clone();
        let policy_inode=self.source.policy.inode.clone();
        let (_held,current)=open_regular(&policy_path).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if current!=policy_inode{return Err(crate::cause!(Error::Unavailable))};
        check_sqlite_sidecars(&policy_path).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let duration=deadline.saturating_duration_since(Instant::now());
        if duration.is_zero(){return Err(crate::cause!(Error::Unauthorized))};
        let store=sqlite::open_selected(&policy_path,"account_policy",sqlite::Selected {
            access:Access::Write,trusted_schema:false,meter:Some(self.source.sql_work.clone()),
            bounds:sqlite::Bounds {value_bytes:MAX_JSON,work:200_000,deadline:duration,spend:sqlite::Spend::WholeHandle,cancel:Some(cancel.clone()),busy:Duration::ZERO},
        }).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let expected=registration.clone();
        let mut issuer=Issuer {owner:self,key,registration,policy_path,policy_inode,deadline,cancel,now,selection_check};
        let issued=credential::issue(&store,&mut issuer,&account,key,request_key,expected_revision,lifetime_ms,now)?;
        drop(issuer);drop(store);
        // The command may already be committed. Loss of source/registration
        // here is UNKNOWN, never permission to mint under a fresh request key.
        if self.resource_connection_for_key(key,now).map_err(|error| crate::carry_cause!(Error::Unknown, error))?!=expected{return Err(crate::cause!(Error::Unknown))};
        if !self.resource_connection_credential_is_current(issued.grant(),now){return Err(crate::cause!(Error::Unknown))};
        selection_check().map_err(|error| crate::carry_cause!(Error::Unknown, error))?;
        Ok(issued)
    }

    /// The revision of the current credential an admitted `grant` stands on: that credential's own, never a revision a
    /// caller supplies.
    pub(crate) fn admitted_resource_connection_revision(&mut self,grant:&ConnectionGrant)->credential::Result<u64> {
        self.assert_owned().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let now=self.source.clock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !self.resource_connection_credential_is_current(grant,now){return Err(crate::cause!(Error::Unauthorized))};
        let account=self.source.account.clone();
        let store=sqlite::lend(&self.source.policy.connection,"account_policy",Access::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let revision=credential::revision(&store,&account,&grant.route.device_id)?;
        drop(store);
        self.assert_owned().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(revision)
    }

    pub(crate) fn admit_resource_connection_credential(&mut self,raw:&[u8],now:u64)->credential::Result<ConnectionGrant> {
        self.assert_owned().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let account=self.source.account.clone();
        let grant={let store=sqlite::lend(&self.source.policy.connection,"account_policy",Access::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            credential::admit(&store,&account,raw,now)?};
        let registration=self.registered_resource_connection(&grant.route.device_id,now).map_err(|error| crate::carry_cause!(Error::Unauthorized, error))?;
        if registration.route().map_err(|error| crate::carry_cause!(Error::Unauthorized, error))?!=grant.route{return Err(crate::cause!(Error::Unauthorized))};
        let store=sqlite::lend(&self.source.policy.connection,"account_policy",Access::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        credential::is_current(&store,&account,&grant,now)?;
        drop(store);
        self.assert_owned().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(grant)
    }

    pub(crate) fn resource_connection_credential_is_current(&mut self,grant:&ConnectionGrant,now:u64)->bool {
        if self.assert_owned().is_err(){return false};
        let Ok(registration)=self.registered_resource_connection(&grant.route.device_id,now) else{return false};
        if registration.route().ok().as_ref()!=Some(&grant.route){return false};
        let account=self.source.account.clone();
        let Ok(store)=sqlite::lend(&self.source.policy.connection,"account_policy",Access::Read) else{return false};
        let valid=credential::is_current(&store,&account,grant,now).is_ok();
        drop(store);
        valid&&self.assert_owned().is_ok()
    }
}
