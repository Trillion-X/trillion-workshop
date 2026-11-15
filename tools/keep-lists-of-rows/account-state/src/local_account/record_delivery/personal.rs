//! Personal-key workspace store read custody within the original record-delivery owner.
//! The caller supplies its retained actual-key checker. No browser DTO, session,
//! alternate store, decoder or physical path selector is added.
use super::{BookCheck, Defaults, LocalAccount, StoreRead};
use crate::{
    account::{AccountError, AccountResult},
    workspace_store::{Failure, Kind, Page, Selection, Snapshot},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

pub(crate) struct PersonalProjectionWitness {
    book: BookCheck,
    receipt: String,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl PersonalProjectionWitness {
    pub(crate) fn expired(&self) -> bool {
        self.cancel.load(Ordering::Acquire) || Instant::now() >= self.deadline
    }
}
/// What a personal-key projection was admitted under (`LocalAccount::admit_personal_record_projection`) and the
/// read-only handles it reads through: it holds no account owner while it reads.
pub(crate) struct PersonalAdmission {
    receipt: String,
    book: BookCheck,
    store: StoreRead,
    defaults: Defaults,
}
impl PersonalAdmission {
    /// One read of the projection (`StoreRead::read`), holding no account owner.
    pub(crate) fn read(
        &self,
        asked: Option<&Selection>,
        page: Option<&Page>,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<Snapshot, Failure> {
        let snapshot = self.store.read(asked, page, cancel, deadline)?;
        Ok(self.defaults.laid_under(asked, page, snapshot))
    }
}
impl LocalAccount {
    /// Admit one projection read: the caller's full key, gate and asked-records check passes, then the account's state
    /// identity, the record book's delivery check and the read-only handles are taken, under the owner.
    pub(crate) fn admit_personal_record_projection(
        &mut self,
        current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<PersonalAdmission, Failure> {
        let fail = |kind| Failure::new(kind, Default::default());
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err(fail(crate::cause!(Kind::Cancelled)));
        }
        current(self).map_err(|error| fail(Kind::SourceChanged(error.cause())))?;
        let receipt = self.state_identity().to_owned();
        let book = self.record_book_check().map_err(|error| fail(Kind::SourceUnavailable(error.cause())))?;
        let store = self.store_read().map_err(|error| fail(Kind::SourceUnavailable(error.cause())))?;
        let defaults = Defaults::published(self.state_root());
        Ok(PersonalAdmission { receipt, book, store, defaults })
    }
    /// The admission still stands after the read of `snapshot`: the caller's full check passes again, the state
    /// identity and the record book are unchanged and the same file is still the account's. The witness it returns is
    /// the delivery's.
    pub(crate) fn finish_personal_record_projection(
        &mut self,
        current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
        admission: PersonalAdmission,
        snapshot: Snapshot,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<(Snapshot, PersonalProjectionWitness), Failure> {
        let PersonalAdmission { receipt, book, store, .. } = admission;
        let changed = |snapshot: Snapshot| Failure::new(crate::cause!(Kind::SourceChanged), snapshot.work);
        if current(self).is_err()
            || self.state_identity() != receipt
            || !self.store_read().is_ok_and(|now| now.same_file(&store))
            || book.assert_same_file().is_err()
            || self.assert_owned().is_err()
        {
            return Err(changed(snapshot));
        }
        let witness = PersonalProjectionWitness {
            book,
            receipt,
            cancel,
            deadline,
        };
        if witness.expired() {
            return Err(Failure::new(crate::cause!(Kind::Cancelled), snapshot.work));
        }
        Ok((snapshot, witness))
    }
    pub(crate) fn prepare_personal_record_projection(
        &mut self,
        current: &mut dyn FnMut(&mut LocalAccount) -> AccountResult<()>,
        selection: Option<&Selection>,
        page: Option<&Page>,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<(Snapshot, PersonalProjectionWitness), Failure> {
        let fail = |kind| Failure::new(kind, Default::default());
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err(fail(crate::cause!(Kind::Cancelled)));
        }
        current(self).map_err(|error| fail(Kind::SourceChanged(error.cause())))?;
        let receipt = self.state_identity().to_owned();
        let book = self.record_book_check().map_err(|error| fail(Kind::SourceUnavailable(error.cause())))?;
        let snapshot = self.read_workspace_store(selection, page, cancel.clone(), deadline)?;
        // Finish the original full key, gate and asked-records check before provisional
        // rows can leave this primitive.
        if current(self).is_err() || self.state_identity() != receipt || book.assert_same_file().is_err() {
            return Err(Failure::new(crate::cause!(Kind::SourceChanged), snapshot.work));
        }
        self.assert_owned().map_err(|error| fail(Kind::SourceChanged(error.cause())))?;
        let witness = PersonalProjectionWitness {
            book,
            receipt,
            cancel,
            deadline,
        };
        if witness.expired() {
            return Err(Failure::new(crate::cause!(Kind::Cancelled), snapshot.work));
        }
        Ok((snapshot, witness))
    }
    /// Called AFTER current key, both policy gates and Selection checks, at the
    /// actual response chunk release: the RECORD_BOOK file is unchanged.
    pub(crate) fn personal_record_projection_current(
        &mut self,
        witness: &PersonalProjectionWitness,
    ) -> AccountResult<()> {
        if witness.expired() {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        self.assert_owned()?;
        if self.state_identity() != witness.receipt {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        witness.book.assert_same_file()?;
        if witness.expired() {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        Ok(())
    }
}
