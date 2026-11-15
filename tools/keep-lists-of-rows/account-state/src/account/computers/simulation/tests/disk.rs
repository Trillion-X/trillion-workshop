//! The world's disk: a path-keyed store with a durable layer (fsynced bytes, kept through a power cut) and a pending
//! layer (written, not yet fsynced, lost on a power cut). `capacity` is the total size a view of the disk may reach; a
//! write past it is refused as ENOSPC and changes nothing.

use std::collections::BTreeMap;

#[derive(Debug, PartialEq, Eq)]
pub enum DiskError {
    /// The write would take the disk past its capacity (ENOSPC).
    NoSpace,
}

#[derive(Default)]
pub struct Disk {
    capacity: Option<usize>,
    durable: BTreeMap<String, Vec<u8>>,
    pending: BTreeMap<String, Vec<u8>>,
}

impl Disk {
    pub fn set_capacity(&mut self, bytes: usize) {
        self.capacity = Some(bytes);
    }

    /// What a reader sees: pending bytes shadow durable ones.
    pub fn read(&self, path: &str) -> Option<&[u8]> {
        self.pending.get(path).or_else(|| self.durable.get(path)).map(Vec::as_slice)
    }

    pub fn write(&mut self, path: &str, bytes: &[u8]) -> Result<(), DiskError> {
        if let Some(capacity) = self.capacity {
            let before = self.read(path).map_or(0, <[u8]>::len);
            if self.view_size() - before + bytes.len() > capacity {
                return Err(DiskError::NoSpace);
            }
        }
        self.pending.insert(path.to_string(), bytes.to_vec());
        Ok(())
    }

    /// Makes the pending bytes of `path` durable.
    pub fn fsync(&mut self, path: &str) {
        if let Some(bytes) = self.pending.remove(path) {
            self.durable.insert(path.to_string(), bytes);
        }
    }

    /// Power is lost: every write not yet fsynced is gone.
    pub fn power_cut(&mut self) {
        self.pending.clear();
    }

    /// The bytes a reader sees across every path.
    fn view_size(&self) -> usize {
        let durable: usize = self.durable.iter().filter(|(path, _)| !self.pending.contains_key(*path)).map(|(_, b)| b.len()).sum();
        let pending: usize = self.pending.values().map(Vec::len).sum();
        durable + pending
    }
}
