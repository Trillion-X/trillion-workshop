// src/account_files/names.rs
//
// Purpose: The generic name operations of the person's files: find the names in a folder that start with a
// prefix, and carry a name or a whole folder of names from one folder to another: move (rename), copy, set aside and
// put back. Set aside and put back are moves between the person's tree of names and the set-aside tree (`Tree`), at
// the same full name. Only name and folder records change; a file and its bytes are never copied or deleted, so a
// copy is one more name for the same content and a name set aside still keeps its file.
//
// Non-Negotiable Invariants:
// - Bounded: one call carries at most `limit` steps (a name, or a folder whose names are all carried), and none after
//   the account files' `until` (its caller's time), and answers `next_after`, the full name of its last step, until the
//   whole folder is carried. The walk resumes there, so a
//   carry of any size is a run of bounded calls; a move or set-aside also resumes without it, since its carried names
//   have left the source.
// - The destination first, the source last: a name is placed at its destination before its file lists it, and only
//   then is it removed from the source. A crash between two steps leaves a name in both trees (the same file), never
//   in neither; running the same call again finishes it.
// - A destination name that already names another file stops the carry before anything of that name changes; one
//   that names the same file is already carried.
// - A folder is never carried into itself, and the root folder is never carried.
//
// Key Concepts:
// - Walk order: in each folder, its names (in name order), then each child folder's walk (in folder order), then the
//   folder itself. A step's position is its full name: a name, or a folder followed by `/` once it is walked.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{folder_name, now_iso, parent, text, Answer, AccountFiles, AccountFilesError, Tree, DEFAULT_LIST_LIMIT, FILES};
use crate::{
    records::{Mutation, Record, Records, MAX_PAGE_ITEMS},
    storage::Storage,
};
use serde_json::{json, Value};
use std::time::Instant;

/// One carry: from the name or folder `from` in `source` to `to` in `target`; `kept` leaves the source where it is.
#[derive(Clone, Copy)]
pub struct Carry<'a> {
    pub source: &'a Tree,
    pub from: &'a str,
    pub target: &'a Tree,
    pub to: &'a str,
    pub kept: bool,
}

/// One step of a walk.
enum Step {
    /// A name record.
    Name(Record),
    /// A folder whose names and child folders were all walked.
    Folder(String),
}
impl Step {
    /// The step's position in the walk.
    fn position(&self) -> String {
        match self {
            Step::Name(record) => record.id.clone(),
            Step::Folder(folder) => format!("{folder}/"),
        }
    }
}

/// Where a walk of one folder resumes, from the position of the last step taken.
enum Resume<'a> {
    /// At the folder's first name.
    Start,
    /// After one of the folder's names.
    AfterName(&'a str),
    /// Inside one child folder.
    InChild(&'a str, &'a str),
    /// After one child folder, all of it walked.
    AfterChild(&'a str),
}
fn resume<'a>(folder: &str, after: Option<&'a str>) -> Resume<'a> {
    let Some(after) = after else { return Resume::Start };
    let base = if folder == "/" { 0 } else { folder.len() };
    if after.len() <= base + 1 || !after.starts_with(folder) || after.as_bytes()[base] != b'/' {
        return Resume::Start;
    }
    let rest = &after[base + 1..];
    match rest.find('/') {
        None => Resume::AfterName(after),
        Some(at) if at + 1 == rest.len() => Resume::AfterChild(&after[..base + 1 + at]),
        Some(at) => Resume::InChild(&after[..base + 1 + at], after),
    }
}

/// A full name that can be carried: absolute, not the root, no trailing `/`, no NUL.
fn carriable(name: &str) -> bool {
    name.starts_with('/') && name.len() > 1 && !name.ends_with('/') && !name.contains('\0')
}

impl<S: Storage + Send> AccountFiles<S> {
    /// `find_names`: one page of the names in `prefix`'s folder that start with `prefix` (a folder ending in `/`
    /// lists that folder's names).
    pub fn find_names(&self, prefix: &str, after: Option<&str>, limit: Option<usize>) -> Answer<Value> {
        if !prefix.starts_with('/') || prefix.contains('\0') {
            return Err(AccountFilesError::Invalid("prefix must be an absolute name or folder", crate::cause!()));
        }
        let folder = folder_name(parent(prefix));
        let scope = super::LIVE.names(&folder);
        let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_PAGE_ITEMS);
        let mut found = Vec::new();
        let start = match after {
            Some(after) => after.to_owned(),
            None => {
                // A page walks names strictly after its cursor, so a name equal to the prefix is read first.
                found.extend(self.get(&scope, prefix)?);
                prefix.to_owned()
            }
        };
        let page = self.store.list_page(&self.account, &scope, &start, limit + 1 - found.len())?;
        let mut more = page.next.is_some();
        for record in page.items {
            if !record.id.starts_with(prefix) {
                more = false;
                break;
            }
            if found.len() == limit {
                more = true;
                break;
            }
            found.push(record);
        }
        let next = more.then(|| found.last().map(|record| record.id.clone())).flatten();
        Ok(json!({ "prefix": prefix, "names": self.name_rows(&found)?, "next_after": next }))
    }

    /// Carry a name or a whole folder (`Carry`), at most `limit` steps after `after`.
    pub fn carry_names(&mut self, carry: Carry<'_>, after: Option<&str>, limit: Option<usize>) -> Answer<Value> {
        let Carry { source, from, target, to, kept } = carry;
        if !carriable(from) || !carriable(to) {
            return Err(AccountFilesError::Invalid("from and to must be absolute names, not the root folder", crate::cause!()));
        }
        if source.names == target.names && (to == from || to.strip_prefix(from).is_some_and(|rest| rest.starts_with('/'))) {
            return Err(AccountFilesError::Invalid("a name or folder is never carried onto or into itself", crate::cause!()));
        }
        let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_PAGE_ITEMS);
        let mut steps = Vec::new();
        let complete = match self.get(&source.names(parent(from)), from)? {
            Some(record) => {
                steps.push(Step::Name(record));
                true
            }
            None => {
                if self.get(&source.folders(parent(from)), from)?.is_none() {
                    return Err(crate::cause!(AccountFilesError::NotFound));
                }
                let mut room = limit;
                self.walk(source, from, after.filter(|after| after.starts_with(from)), &mut room, &mut steps)?
            }
        };
        let now = now_iso();
        let (mut names, mut folders) = (0usize, 0usize);
        let mut taken = 0;
        for step in &steps {
            if self.until.is_some_and(|until| Instant::now() >= until) {
                break;
            }
            self.check_current()?;
            let request = |what: &str| {
                let key = format!("names\0{what}\0{}\0{}\0{from}\0{to}\0{now}", source.names, target.names);
                content_crypto::advanced::blake3::hash(format!("{key}\0{}", step.position()).as_bytes()).to_hex().to_string()
            };
            match step {
                Step::Name(record) => {
                    let name = format!("{to}{}", &record.id[from.len()..]);
                    self.carry_name(carry, record, &name, &now, &request("name"))?;
                    names += 1;
                }
                Step::Folder(folder) => {
                    let placed = format!("{to}{}", &folder[from.len()..]);
                    self.ensure_folders(target, &placed, &request("folder"))?;
                    if !kept {
                        let scope = source.folders(parent(folder));
                        if let Some(held) = self.get(&scope, folder)? {
                            let removal =
                                Mutation { id: folder.clone(), expected_version: held.version, request_key: request("left"), deleted: true, value: Value::Null };
                            self.mutate(&scope, removal)?;
                        }
                    }
                    folders += 1;
                }
            }
            taken += 1;
        }
        // Where the next call resumes: after the last step taken, or where this call was asked to start.
        let next = if complete && taken == steps.len() {
            None
        } else {
            match taken {
                0 => Some(after.map(str::to_owned).unwrap_or_default()),
                _ => Some(steps[taken - 1].position()),
            }
        };
        Ok(json!({ "from": from, "to": to, "names": names, "folders": folders, "next_after": next }))
    }

    /// `forget_set_aside`: a name or a whole folder set aside, forgotten for good (old trillion's Recently Deleted
    /// sweep, whose `onGone` notes each file for the byte release, ports/account-files-byte-release.json). Each name
    /// first leaves its file's `set_aside` list (what keeps the file), then the file is noted (`release.rs`
    /// `note_gone`), then the name's record goes; a folder goes once all its names have. At most `limit`
    /// steps after `after`, each answer naming `next_after` until done, the same walk as a carry. A stop between two steps
    /// leaves the name set aside, and running the call again finishes it.
    pub fn forget_set_aside(&mut self, name: &str, after: Option<&str>, limit: Option<usize>) -> Answer<Value> {
        if !carriable(name) {
            return Err(AccountFilesError::Invalid(super::settings::word("forget_name"), crate::cause!()));
        }
        let tree = &super::SET_ASIDE;
        let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_PAGE_ITEMS);
        let mut steps = Vec::new();
        let complete = match self.get(&tree.names(parent(name)), name)? {
            Some(record) => {
                steps.push(Step::Name(record));
                true
            }
            None => {
                if self.get(&tree.folders(parent(name)), name)?.is_none() {
                    return Err(crate::cause!(AccountFilesError::NotFound));
                }
                let mut room = limit;
                self.walk(tree, name, after.filter(|after| after.starts_with(name)), &mut room, &mut steps)?
            }
        };
        let now = now_iso();
        let (mut names, mut folders, mut taken) = (0usize, 0usize, 0usize);
        let mut files = Vec::new();
        for step in &steps {
            if self.until.is_some_and(|until| Instant::now() >= until) {
                break;
            }
            self.check_current()?;
            let request = |what: &str| {
                let key = format!("forget\0{what}\0{name}\0{now}\0{}", step.position());
                content_crypto::advanced::blake3::hash(key.as_bytes()).to_hex().to_string()
            };
            match step {
                Step::Name(record) => {
                    if let Some(file) = text(&record.value, "file").or_else(|| text(&record.value, "identity")).map(str::to_owned) {
                        // The name leaves the file's list first, then the file is noted: a release page between the two steps then
                        // finds nothing noted, never a note dropped because the name still held the file.
                        self.relist(&file, None, Some((tree.listed_in, record.id.as_str())), &request("file"))?;
                        if super::release::is_identity(&file) {
                            self.note_gone(&[file.as_str()])?;
                            files.push(file.clone());
                        }
                    }
                    let removal = Mutation { id: record.id.clone(), expected_version: record.version, request_key: request("gone"), deleted: true, value: Value::Null };
                    self.mutate(&tree.names(parent(&record.id)), removal)?;
                    names += 1;
                }
                Step::Folder(folder) => {
                    let scope = tree.folders(parent(folder));
                    if let Some(held) = self.get(&scope, folder)? {
                        let removal = Mutation { id: folder.clone(), expected_version: held.version, request_key: request("gone"), deleted: true, value: Value::Null };
                        self.mutate(&scope, removal)?;
                    }
                    folders += 1;
                }
            }
            taken += 1;
        }
        let next = if complete && taken == steps.len() {
            None
        } else {
            match taken {
                0 => Some(after.map(str::to_owned).unwrap_or_default()),
                _ => Some(steps[taken - 1].position()),
            }
        };
        Ok(json!({ "name": name, "names": names, "folders": folders, "noted": files, "next_after": next }))
    }

    /// `retire_names`: owned temporary names retired by exact path and expected identity (old trillion's name
    /// retirement :5-23, ports/account-files-name-retirement.json): each is set aside and forgotten at once, so its
    /// file is noted for the byte release, which still keeps the bytes while any other name holds them. A name that
    /// now names another file, or is a folder, is a conflict and nothing changes; a name already gone is repeated
    /// (and a set-aside copy of it left by a stop between the two steps, with the same file, is forgotten now).
    pub fn retire_names(&mut self, rows: &[Value]) -> Answer<Value> {
        let most = super::settings::settings().retire.items_per_request;
        let exact = |row: &Value| {
            row.get("retire") == Some(&Value::Bool(true))
                && text(row, "name").is_some_and(carriable)
                && text(row, "expected_identity").is_some_and(|identity| identity.starts_with("1f:") && super::release::is_identity(identity))
        };
        if rows.is_empty() || rows.len() > most || !rows.iter().all(exact) {
            return Err(AccountFilesError::Invalid(super::settings::word("retire_list"), crate::cause!()));
        }
        let mut seen = std::collections::BTreeSet::new();
        if !rows.iter().all(|row| seen.insert(text(row, "name"))) {
            return Err(AccountFilesError::Invalid(super::settings::word("retire_once"), crate::cause!()));
        }
        let mut current = Vec::new();
        let mut conflicts = Vec::new();
        for row in rows {
            let (name, expected) = (text(row, "name").unwrap_or_default(), text(row, "expected_identity").unwrap_or_default());
            let held = self.get(&super::LIVE.names(parent(name)), name)?;
            let named = held.as_ref().map(|record| (text(&record.value, "identity"), text(&record.value, "file")));
            match named {
                Some((identity, file)) if identity == Some(expected) || file == Some(expected) => current.push((name, expected, true)),
                Some((identity, file)) => conflicts.push(json!({ "name": name, "expected_identity": expected, "current_identity": identity.or(file) })),
                None if self.get(&super::LIVE.folders(parent(name)), name)?.is_some() => {
                    conflicts.push(json!({ "name": name, "expected_identity": expected, "current_identity": null }));
                }
                None => current.push((name, expected, false)),
            }
        }
        if !conflicts.is_empty() {
            return Ok(json!({ "retired": [], "repeated": [], "conflicts": conflicts }));
        }
        let (mut retired, mut repeated) = (Vec::new(), Vec::new());
        for (name, expected, live) in current {
            if live {
                let carry = Carry { source: &super::LIVE, from: name, target: &super::SET_ASIDE, to: name, kept: false };
                self.carry_names(carry, None, Some(1))
                    .map_err(|_| AccountFilesError::Invalid(super::settings::word("retire_changed"), crate::cause!()))?;
            }
            let aside = self.get(&super::SET_ASIDE.names(parent(name)), name)?;
            if aside.as_ref().is_some_and(|record| text(&record.value, "file") == Some(expected) || text(&record.value, "identity") == Some(expected)) {
                self.forget_set_aside(name, None, Some(1))?;
            }
            if live { retired.push(name) } else { repeated.push(name) }
        }
        Ok(json!({ "retired": retired, "repeated": repeated, "conflicts": [] }))
    }

    /// The steps of `folder`'s walk in `tree` after the position `after`, at most `room` of them. True when the walk
    /// of `folder` is complete.
    fn walk(&self, tree: &Tree, folder: &str, after: Option<&str>, room: &mut usize, steps: &mut Vec<Step>) -> Answer<bool> {
        let at = resume(folder, after);
        if let Resume::Start | Resume::AfterName(_) = at {
            let mut cursor = match at {
                Resume::AfterName(name) => name.to_owned(),
                _ => String::new(),
            };
            loop {
                if *room == 0 {
                    return Ok(false);
                }
                let page = self.store.list_page(&self.account, &tree.names(folder), &cursor, (*room).min(MAX_PAGE_ITEMS))?;
                let more = page.next.is_some();
                for record in page.items {
                    cursor.clone_from(&record.id);
                    steps.push(Step::Name(record));
                    *room -= 1;
                }
                if !more {
                    break;
                }
            }
        }
        let mut child_after = match at {
            Resume::InChild(child, inside) => {
                if !self.walk(tree, child, Some(inside), room, steps)? {
                    return Ok(false);
                }
                Some(child.to_owned())
            }
            Resume::AfterChild(child) => Some(child.to_owned()),
            Resume::Start | Resume::AfterName(_) => None,
        };
        loop {
            if *room == 0 {
                return Ok(false);
            }
            let (children, next) = self.store.ids(&self.account, &tree.folders(folder), child_after.as_deref(), MAX_PAGE_ITEMS)?;
            for child in &children {
                if !self.walk(tree, child, None, room, steps)? {
                    return Ok(false);
                }
            }
            match next {
                Some(last) => child_after = Some(last),
                None => break,
            }
        }
        if *room == 0 {
            return Ok(false);
        }
        steps.push(Step::Folder(folder.to_owned()));
        *room -= 1;
        Ok(true)
    }

    /// Carry one name record to `name` in the carry's target tree: write it there, let its file list the name it now
    /// has, then (unless the carry keeps its source) remove it from the source tree.
    fn carry_name(&mut self, carry: Carry<'_>, record: &Record, name: &str, now: &str, request: &str) -> Answer<()> {
        let Carry { source, target, kept, .. } = carry;
        let file = text(&record.value, "file").map(str::to_owned);
        let scope = target.names(parent(name));
        let (expected_version, held) = self.held(&scope, name)?;
        match held {
            Some(held) if file.is_some() && text(&held.value, "file") == file.as_deref() => {}
            Some(_) => return Err(AccountFilesError::Invalid("a name at the destination already names another file", crate::cause!())),
            None => {
                let mut value = record.value.clone();
                value["kind"] = json!(target.name_kind);
                value["name"] = json!(name);
                value["named_at"] = json!(now);
                let placed = Mutation { id: name.to_owned(), expected_version, request_key: format!("{request}:placed"), deleted: false, value };
                self.mutate(&scope, placed)?;
                self.ensure_folders(target, parent(name), request)?;
            }
        }
        let gone = (!kept).then_some((source.listed_in, record.id.as_str()));
        if let Some(file) = &file {
            self.relist(file, Some((target.listed_in, name)), gone, &format!("{request}:file"))?;
        }
        if !kept {
            let removal = Mutation { id: record.id.clone(), expected_version: record.version, request_key: format!("{request}:left"), deleted: true, value: Value::Null };
            self.mutate(&source.names(parent(&record.id)), removal)?;
        }
        Ok(())
    }

    /// Change the names a file lists: add `added` (a field and a name), remove `gone`. The field is the tree's
    /// (`Tree::listed_in`); a field the file record has not held yet starts empty. A name with no kept file changes
    /// nothing here.
    pub(super) fn relist(&mut self, file: &str, added: Option<(&str, &str)>, gone: Option<(&str, &str)>, request: &str) -> Answer<()> {
        let Some(held) = self.get(FILES, file)? else { return Ok(()) };
        let mut value = held.value.clone();
        if !value.is_object() {
            return Ok(());
        }
        let before = value.clone();
        if let Some((field, gone)) = gone {
            if let Some(names) = value.get_mut(field).and_then(Value::as_array_mut) {
                names.retain(|name| name.as_str() != Some(gone));
            }
        }
        if let Some((field, added)) = added {
            if !value.get(field).is_some_and(Value::is_array) {
                value[field] = json!([]);
            }
            if let Some(names) = value.get_mut(field).and_then(Value::as_array_mut) {
                if !names.iter().any(|name| name.as_str() == Some(added)) {
                    names.push(json!(added));
                }
            }
        }
        if value == before {
            return Ok(());
        }
        let change = Mutation { id: file.to_owned(), expected_version: held.version, request_key: request.to_owned(), deleted: false, value };
        self.mutate(FILES, change)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_walk_resumes_from_the_position_of_its_last_step() {
        assert!(matches!(resume("/a", None), Resume::Start));
        assert!(matches!(resume("/a", Some("/a/x.txt")), Resume::AfterName("/a/x.txt")));
        assert!(matches!(resume("/a", Some("/a/b/")), Resume::AfterChild("/a/b")));
        assert!(matches!(resume("/a", Some("/a/b/c/d.txt")), Resume::InChild("/a/b", "/a/b/c/d.txt")));
        assert!(matches!(resume("/a", Some("/ab/x.txt")), Resume::Start), "a sibling folder sharing the start is not inside");
        assert!(matches!(resume("/a", Some("/a/")), Resume::Start), "the folder's own end is not inside it");
        assert!(matches!(resume("/", Some("/b/c.txt")), Resume::InChild("/b", "/b/c.txt")));
        assert!(matches!(resume("/", Some("/c.txt")), Resume::AfterName("/c.txt")));
    }

    #[test]
    fn only_absolute_names_below_the_root_are_carried() {
        assert!(carriable("/a"));
        assert!(carriable("/a/b.txt"));
        assert!(!carriable("/"));
        assert!(!carriable("a"));
        assert!(!carriable("/a/"));
        assert!(!carriable("/a\0b"));
    }
}
