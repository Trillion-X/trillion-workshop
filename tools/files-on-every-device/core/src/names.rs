//! Full names in the contract's one name space: "/" is the top folder, "/a/b.mov" a file in folder "/a".

use crate::data::Contract;

/// The folder a full name is in ("/" for a name in the top folder).
pub fn parent(name: &str) -> &str {
    match name.trim_end_matches('/').rfind('/') {
        Some(cut) if cut > 0 => &name[..cut],
        _ => "/",
    }
}

/// The last part of a full name.
pub fn leaf(name: &str) -> &str {
    let trimmed = name.trim_end_matches('/');
    trimmed.rfind('/').map_or(trimmed, |cut| &trimmed[cut + '/'.len_utf8()..])
}

/// A name in a folder.
pub fn join(folder: &str, leaf: &str) -> String {
    if folder.ends_with('/') {
        format!("{folder}{leaf}")
    } else {
        format!("{folder}/{leaf}")
    }
}

/// The part of a leaf after its last dot, lower-cased; empty when the leaf has none or starts with its only dot.
pub fn extension(name: &str) -> String {
    let leaf = leaf(name);
    match leaf.rfind('.') {
        Some(dot) if dot > 0 => leaf[dot + '.'.len_utf8()..].to_lowercase(),
        _ => String::new(),
    }
}

/// The plain name a conflicting edit of `name` is kept under, beside the other version: the `attempt`th try, from
/// None (the first) on. `date` is the host's local date; the core reads no clock.
pub fn conflict_name(contract: &Contract, name: &str, device: &str, date: &str, attempt: Option<u64>) -> String {
    let leaf = leaf(name);
    let (stem, ext) = match leaf.rfind('.') {
        Some(dot) if dot > 0 => (&leaf[..dot], &leaf[dot..]),
        _ => (leaf, ""),
    };
    let template = match attempt {
        None => &contract.conflict_name,
        Some(_) => &contract.conflict_name_again,
    };
    let written = template
        .replace("{stem}", stem)
        .replace("{device}", device)
        .replace("{date}", date)
        .replace("{ext}", ext)
        .replace("{n}", &attempt.map(|n| n.to_string()).unwrap_or_default());
    join(parent(name), &written)
}
