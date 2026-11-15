//! A read check over one account SQLite file: it remembers the file's data version when opened and refuses with
//! SourceChanged once another connection has written it. Moved from setup_source.rs, whose Get started reads left the
//! engine for the Workshop (tools/set-up-my-account); the catalog delivery and catch-up still check their reads with it.
use super::{AccountError, AccountResult, CurrentSqlite};

pub(super) struct SourceCheck {
    source: CurrentSqlite,
    version: i64,
}
impl SourceCheck {
    pub(super) fn open(
        path: std::path::PathBuf,
        meter: crate::sqlite_work::WorkMeter,
    ) -> AccountResult<Self> {
        let source = CurrentSqlite::open_with_meter(path, meter)?;
        let version = Self::version(&source)?;
        Ok(Self { source, version })
    }
    fn version(source: &CurrentSqlite) -> AccountResult<i64> {
        source.assert_file()?;
        if !source.connection.is_autocommit() {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        source
            .connection
            .query_row("PRAGMA main.data_version", [], |row| row.get(0))
            .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))
    }
    pub(super) fn current(&self) -> AccountResult<()> {
        if Self::version(&self.source)? != self.version {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        Ok(())
    }
}
