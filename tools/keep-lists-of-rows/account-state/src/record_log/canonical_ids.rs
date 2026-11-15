//! Allocate the original journal's monotonic UUIDv7 sequence identifiers.
//! This is the existing wire format, not a content identity or request key.
use super::LogIds;
use ring::rand::{SecureRandom, SystemRandom};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
pub(crate) struct CanonicalLogIds {
    last: Option<[u8; 16]>,
}
impl CanonicalLogIds {
    /// Borrow the same monotonic sequence without holding its mutex for the caller's whole transaction.
    /// Only allocation takes the lock; physical I/O and current-rights callbacks never retain it.
    pub(crate) fn shared(source: &std::sync::Mutex<Self>) -> impl LogIds + '_ {
        SharedLogIds(source)
    }
}
struct SharedLogIds<'a>(&'a std::sync::Mutex<CanonicalLogIds>);
impl LogIds for SharedLogIds<'_> {
    fn next_log_id(&mut self) -> Option<String> {
        self.0.lock().ok()?.next_log_id()
    }
}
impl LogIds for CanonicalLogIds {
    fn next_log_id(&mut self) -> Option<String> {
        let now: u64 = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis()
            .try_into()
            .ok()?;
        if now == 0 || now >= (1u64 << 48) {
            return None;
        }
        let mut bytes = [0u8; 16];
        bytes[..6].copy_from_slice(&now.to_be_bytes()[2..]);
        SystemRandom::new().fill(&mut bytes[6..]).ok()?;
        bytes[6] = (bytes[6] & 15) | 0x70;
        bytes[8] = (bytes[8] & 63) | 0x80;
        if let Some(last) = self.last {
            if bytes[..6] <= last[..6] {
                bytes = last;
                let mut carry = true;
                for index in (0..16).rev() {
                    if !carry {
                        break;
                    }
                    if index == 8 {
                        let digit = bytes[index] & 63;
                        bytes[index] = 0x80 | ((digit + 1) & 63);
                        carry = digit == 63;
                    } else if index == 6 {
                        let digit = bytes[index] & 15;
                        bytes[index] = 0x70 | ((digit + 1) & 15);
                        carry = digit == 15;
                    } else {
                        let (next, overflow) = bytes[index].overflowing_add(1);
                        bytes[index] = next;
                        carry = overflow;
                    }
                }
                if carry {
                    return None;
                }
            }
        }
        self.last = Some(bytes);
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        Some(format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn shared_id_allocation_keeps_one_monotonic_sequence_across_command_adapters() {
        let source = Arc::new(Mutex::new(CanonicalLogIds::default()));
        let mut previous = None;
        for _ in 0..256 {
            let next = CanonicalLogIds::shared(&source).next_log_id().unwrap();
            if let Some(before) = previous {
                assert!(next > before);
            }
            previous = Some(next);
        }
        let mut workers = Vec::new();
        for _ in 0..8 {
            let source = source.clone();
            workers.push(std::thread::spawn(move || {
                let mut ids = CanonicalLogIds::shared(&source);
                (0..128)
                    .map(|_| ids.next_log_id().unwrap())
                    .collect::<Vec<_>>()
            }));
        }
        let mut all = std::collections::BTreeSet::new();
        for worker in workers {
            let allocated = worker.join().unwrap();
            assert!(allocated.windows(2).all(|pair| pair[0] < pair[1]));
            for id in allocated {
                assert!(all.insert(id));
            }
        }
        assert_eq!(all.len(), 1024);
        assert!(all.first().unwrap() > previous.as_ref().unwrap());
    }
}
