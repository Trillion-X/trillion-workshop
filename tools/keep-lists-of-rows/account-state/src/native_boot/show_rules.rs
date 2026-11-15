//! Selected-account join for the original show-rules read and its held body.
//! No source/schema/authority is supplied by the caller; preserve the installed
//! Selection around the existing LocalAccount owner and final disclosure.
use super::SelectedAccount;
use crate::{
    account::{AccountError, AccountResult},
    ecma_json::Value,
    local_account::ShowRulesDeliveryWitness,
    tool_label_locale::QualifiedLocale,
};
use std::sync::{Arc, atomic::AtomicBool};

impl SelectedAccount {
    pub fn current_show_rules(
        &mut self,
        session: &str,
        locale: &QualifiedLocale,
        cancel: Arc<AtomicBool>,
    ) -> AccountResult<(Value, ShowRulesDeliveryWitness)> {
        self.selection
            .assert_current()
            .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        let result = self.owner.current_show_rules(session, locale, cancel)?;
        self.selection
            .assert_current()
            .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        Ok(result)
    }

    pub fn assert_show_rules_delivery_current(
        &mut self,
        session: &str,
        cancel: Arc<AtomicBool>,
        witness: &ShowRulesDeliveryWitness,
    ) -> AccountResult<()> {
        self.selection
            .assert_current()
            .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        self.owner
            .assert_show_rules_delivery_current(session, cancel, witness)?;
        self.selection
            .assert_current()
            .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))
    }
}
