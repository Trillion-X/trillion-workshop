//! Consume the existing tc_ computer credential and explicitly enrolled route.
//! The selected state lock, original APP_KV and policy directory stay their owners.
//! No computer ID, key possession or route label manufactures hosting authority.
use super::*;
use content_crypto::advanced::blake3;
use crate::{account_rights::resource_connection as registration, storage::sqlite::{self,Access}};

pub(crate) fn device_key_identity(key:&[u8]) -> AccountResult<String> {
    let text=std::str::from_utf8(key).map_err(|error| crate::carry_cause!(AccountError::InvalidInput, error))?;
    if text.len()!=67 || !text.starts_with("tc_") || !hex(&text[3..],64) { return Err(crate::cause!(AccountError::InvalidInput)); }
    Ok(blake3::hash(key).to_hex().to_string())
}

impl LocalAccount {
    fn native_device_parent_current(&mut self,device:&str,saved:&Value,now:u64)->AccountResult<()> {
        let Some(parent)=saved.get("native_key_id") else {return Ok(())};
        let parent=parent.as_str().ok_or(crate::cause!(AccountError::KeyWithdrawn))?;
        if self.source.read_kv(&format!("native-device-revoked:{device}"),now)?.is_some() {return Err(crate::cause!(AccountError::KeyWithdrawn))}
        crate::account::native_parent_key_current(self,parent)
    }
    pub(crate) fn registered_resource_connection(&mut self, device:&str, now:u64) -> AccountResult<registration::Registration> {
        if !hex(device,64) || now==0 || now>MAX_SAFE { return Err(crate::cause!(AccountError::InvalidInput)); }
        self.assert_owned()?;
        let account=self.source.account.clone();
        let bytes=self.source.read_kv_bytes_bounded(&format!("device-key:{device}"),now,4096)?.ok_or(crate::cause!(AccountError::KeyWithdrawn))?;
        let saved:Value=serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if saved["userId"]!=account.user_id { return Err(crate::cause!(AccountError::KeyWithdrawn)); }
        self.native_device_parent_current(device,&saved,now)?;
        let created=chrono::DateTime::parse_from_rfc3339(saved["created_at"].as_str().ok_or(crate::cause!(AccountError::SourceUnavailable))?).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?.timestamp_millis();
        let created=u64::try_from(created).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if created==0 || created>now { return Err(crate::cause!(AccountError::KeyWithdrawn)); }
        let registration={
            let tx=self.source.policy.transaction()?;
            let store=sqlite::lend(&tx,"account_policy",Access::Read).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            if !registration::accepts_device_issued_at(&store,&account,created).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))? { return Err(crate::cause!(AccountError::KeyWithdrawn)); }
            let found=registration::current(&store,&account,device,"@own-records").map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?.ok_or(crate::cause!(AccountError::RightsRefused))?;
            drop(store);
            tx.commit().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            found
        };
        if !registration.active { return Err(crate::cause!(AccountError::RightsRefused)); }
        let actual=self.original_workspace_generation().map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        if u64::try_from(actual).ok()!=Some(registration.resource_generation) { return Err(crate::cause!(AccountError::SourceChanged)); }
        self.assert_owned()?;
        // Another owner can withdraw APP_KV while the resource header is read.
        // Re-read the same bounded original issuer, rather than trusting a cache.
        let fresh=self.source.read_kv_bytes_bounded(&format!("device-key:{device}"),now,4096)?.ok_or(crate::cause!(AccountError::KeyWithdrawn))?;
        if fresh.as_slice()!=bytes.as_slice() { return Err(crate::cause!(AccountError::SourceChanged)); }
        {
            let tx=self.source.policy.transaction()?;
            let store=sqlite::lend(&tx,"account_policy",Access::Read).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            if !registration::accepts_device_issued_at(&store,&account,created).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?
                || registration::current(&store,&account,device,"@own-records").map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?.as_ref()!=Some(&registration) {
                return Err(crate::cause!(AccountError::SourceChanged));
            }
            drop(store);
            tx.commit().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        }
        self.native_device_parent_current(device,&saved,now)?;
        self.assert_owned()?;
        Ok(registration)
    }
    pub(crate) fn resource_connection_for_key(&mut self, credential:&[u8], now:u64) -> AccountResult<registration::Registration> {
        let device=device_key_identity(credential)?;
        self.registered_resource_connection(&device,now)
    }
}
