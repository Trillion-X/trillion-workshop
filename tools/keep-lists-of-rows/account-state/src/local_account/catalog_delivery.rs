//! Retained physical facts for one selected tool catalog read. The normal
//! catalog assembler still chooses every key and decodes every byte.

use super::catalog_source::CatalogMetadata;
use super::{source_check::SourceCheck, AccountError, AccountResult, FixedFile, LocalAccount};
use std::{fmt, sync::Mutex};

pub(crate) struct CatalogDeliveryWitness {
    kv: SourceCheck,
    observed: Mutex<Observed>,
}

#[derive(Default)]
struct Observed {
    blobs: Vec<FixedFile>,
    expires_at: Option<u64>,
    metadata: Vec<CatalogMetadata>,
}

impl fmt::Debug for CatalogDeliveryWitness {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CatalogDeliveryWitness([redacted])")
    }
}

impl CatalogDeliveryWitness {
    pub(crate) fn remember_metadata(&self, metadata: CatalogMetadata) -> AccountResult<()> {
        let mut held = self
            .observed
            .lock()
            .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        held.metadata.push(metadata);
        Ok(())
    }

    pub(crate) fn remember(
        &self,
        observation: Option<(FixedFile, Option<u64>)>,
    ) -> AccountResult<()> {
        if let Some((blob, expiry)) = observation {
            let mut held = self
                .observed
                .lock()
                .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
            held.blobs.push(blob);
            if let Some(expiry) = expiry {
                held.expires_at = Some(held.expires_at.map_or(expiry, |before| before.min(expiry)));
            }
        }
        Ok(())
    }

    pub(crate) fn current(&self, now: u64) -> AccountResult<()> {
        self.kv.current()?;
        let held = self
            .observed
            .lock()
            .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        for blob in &held.blobs {
            blob.check()?;
        }
        for metadata in &held.metadata {
            metadata
                .assert_current()
                .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        }
        if held.expires_at.is_some_and(|expiry| now >= expiry) {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        self.kv.current()
    }
}

impl LocalAccount {
    pub(crate) fn tools_catalog_delivery_witness(
        &self,
    ) -> AccountResult<CatalogDeliveryWitness> {
        self.assert_owned()?;
        Ok(CatalogDeliveryWitness {
            kv: SourceCheck::open(self.source.kv.path.clone(), self.source.sql_work.clone())?,
            observed: Mutex::new(Observed::default()),
        })
    }

    pub(crate) fn tools_catalog_delivery_current(
        &mut self,
        witness: &CatalogDeliveryWitness,
    ) -> AccountResult<()> {
        self.assert_owned()?;
        let now = self.source.clock()?;
        witness.current(now)?;
        self.assert_owned()
    }
}
