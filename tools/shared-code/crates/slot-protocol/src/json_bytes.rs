use serde::{de::Error as _, Deserializer, Serializer};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let (a, b, c) = (bytes[i], bytes[i + 1], bytes[i + 2]);
        out.push(ALPHABET[(a >> 2) as usize] as char);
        out.push(ALPHABET[(((a & 0b11) << 4) | (b >> 4)) as usize] as char);
        out.push(ALPHABET[(((b & 0b1111) << 2) | (c >> 6)) as usize] as char);
        out.push(ALPHABET[(c & 0b111111) as usize] as char);
        i += 3;
    }
    match bytes.len() - i {
        0 => {}
        1 => {
            let a = bytes[i];
            out.push(ALPHABET[(a >> 2) as usize] as char);
            out.push(ALPHABET[((a & 0b11) << 4) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let (a, b) = (bytes[i], bytes[i + 1]);
            out.push(ALPHABET[(a >> 2) as usize] as char);
            out.push(ALPHABET[(((a & 0b11) << 4) | (b >> 4)) as usize] as char);
            out.push(ALPHABET[((b & 0b1111) << 2) as usize] as char);
            out.push('=');
        }
        _ => unreachable!(),
    }
    serializer.serialize_str(&out)
}

pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let encoded: String = serde::Deserialize::deserialize(deserializer)?;
    let bytes = encoded.as_bytes();
    let val = |c: u8| -> Result<u8, D::Error> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(D::Error::custom("invalid base64 char")),
        }
    };
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let c0 = bytes[i];
        let c1 = bytes[i + 1];
        let c2 = bytes[i + 2];
        let c3 = bytes[i + 3];
        let v0 = val(c0)?;
        let v1 = val(c1)?;
        out.push((v0 << 2) | (v1 >> 4));
        if c2 != b'=' {
            let v2 = val(c2)?;
            out.push(((v1 & 0b1111) << 4) | (v2 >> 2));
            if c3 != b'=' {
                let v3 = val(c3)?;
                out.push(((v2 & 0b11) << 6) | v3);
            }
        }
        i += 4;
    }
    Ok(out)
}
