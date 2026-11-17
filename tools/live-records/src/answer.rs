// src/answer.rs
//
// Purpose: An answer that fits one message goes as it is; one that does not goes as pages of its own bytes, the contract of the records
// door (tools/records-door/README.md, read-data/byte-pages.mjs `wholeAnswer`): `{ byte_page: { total, blake3, offset, length, base64,
// next_after_byte } }`, and the same call with `after_byte` set to `next_after_byte` answers the next page, until it is null.
//
// Non-Negotiable Invariants:
// - A page names the same `total` and `blake3` as every other page of the answer, and starts where the bytes asked for start: a client that
//   joined pages of an answer that changed between calls sees the BLAKE3 differ and refuses.
// - The BLAKE3 is the identity of the declared owner of content identities (`1f:` and the BLAKE3-256 hex of the bytes), without the prefix.
// - A page's bytes are the answer's own JSON bytes; nothing is added to or taken from them.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

/// How an answer is cut to fit a message (settings.json `bounds`).
#[derive(Debug, Clone, Copy)]
pub struct Fit {
    /// The most bytes of JSON an answer may have and go whole.
    pub answer_bytes: usize,
    /// The most bytes of the answer one page carries.
    pub page_bytes: usize,
}

/// Why `after_byte` is not an answer's byte.
#[derive(Debug, PartialEq, Eq)]
pub struct PastTheEnd;

impl Fit {
    /// Whether `answer` goes whole.
    pub fn fits(&self, answer: &Value) -> bool {
        serde_json::to_vec(answer).is_ok_and(|bytes| bytes.len() <= self.answer_bytes)
    }

    /// The answer as the call asked for it: whole when it fits and no `after_byte` was named, else the page that starts at `after_byte`
    /// (0 when none was named).
    pub fn deliver(&self, answer: Value, after_byte: Option<u64>) -> Result<Value, PastTheEnd> {
        let bytes = serde_json::to_vec(&answer).map_err(|_| PastTheEnd)?;
        if after_byte.is_none() && bytes.len() <= self.answer_bytes {
            return Ok(answer);
        }
        let from = usize::try_from(after_byte.unwrap_or(0)).map_err(|_| PastTheEnd)?;
        if from >= bytes.len() {
            return Err(PastTheEnd);
        }
        let end = (from + self.page_bytes).min(bytes.len());
        let hash = content_crypto::advanced::blake3::hash(&bytes).to_hex();
        Ok(json!({"byte_page": {
            "total": bytes.len(), "blake3": hash.as_str(), "offset": from, "length": end - from,
            "base64": STANDARD.encode(&bytes[from..end]),
            "next_after_byte": if end < bytes.len() { json!(end) } else { Value::Null },
        }}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_small_answer_goes_whole_and_a_big_one_goes_as_pages_that_join_to_it() {
        let fit = Fit { answer_bytes: 200, page_bytes: 90 };
        let small = json!({"a": 1});
        assert_eq!(fit.deliver(small.clone(), None), Ok(small));
        let big = json!({"text": "x".repeat(400)});
        let (mut joined, mut after, mut hash) = (Vec::new(), None, None);
        loop {
            let page = fit.deliver(big.clone(), after).unwrap()["byte_page"].clone();
            assert_eq!(page["offset"], joined.len());
            hash.get_or_insert(page["blake3"].clone());
            assert_eq!(hash.as_ref(), Some(&page["blake3"]));
            joined.extend(STANDARD.decode(page["base64"].as_str().unwrap()).unwrap());
            if page["next_after_byte"].is_null() {
                break;
            }
            after = page["next_after_byte"].as_u64();
        }
        assert_eq!(serde_json::from_slice::<Value>(&joined).unwrap(), big);
        assert_eq!(hash.unwrap().as_str().unwrap(), content_crypto::advanced::blake3::hash(&joined).to_hex().as_str());
        assert_eq!(fit.deliver(big.clone(), Some(10_000)), Err(PastTheEnd));
        assert!(fit.deliver(small_page(), Some(0)).unwrap().get("byte_page").is_some(), "after_byte names a page even of a small answer");
    }

    fn small_page() -> Value {
        json!({"a": 1})
    }
}
