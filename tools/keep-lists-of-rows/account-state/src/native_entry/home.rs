// src/native_entry/home.rs
//
// Purpose: The one home trillion-local keeps on a computer, and the one list of what may sit at its top, read from
// `home.json` beside this file. The home is the layout's `default` under the person's home folder, unless the one
// launch setting the layout names (`setting`) gives another absolute folder. Every path trillion-local makes in the home is
// an entry and a path inside it (`Home::engine_path`): an entry that is not a trillion-local row of the layout is refused
// before anything is made, so trillion-local can never make an unlisted entry. `undeclared_entries` lists what sits at the
// top of a home without a row, for trillion-local's tests and any other owner that checks a home.
//
// Non-Negotiable Invariants:
// - One home per computer: `default`, or the folder `setting` names. No other input moves it.
// - A row's name is one plain name by job: lowercase letters and `-`, a file adds lowercase extensions (`.json`,
//   `.sealed.log`); no digit, so no
//   date, code or hash. Names are unique.
// - A trillion-local row names the trillion-local DATA file that reads it (`reader`); no other row does. Every row says where its
//   writer is (`source`).
// - `engine_path` refuses an empty, `.` or `..` part, and an entry that is not a trillion-local row.
// - Every `moves` row goes to a row of the layout, or is deleted or ignored.
//
// Key Concepts: the layout (`Layout`, one `Row` per entry), the writers (trillion-local, app, a tool, AI command-line hook,
// person), the home (`Home`), and the folder check (`undeclared_entries`).
//
// Security Considerations: the layout is public trillion-local DATA. `undeclared_entries` reads only the names directly inside
// the folder it is given; it never opens, follows or removes an entry.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde::Deserialize;
use std::{
    collections::BTreeSet,
    fmt, fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

/// The layout, as DATA beside this file.
const DATA: &[u8] = include_bytes!("home.json");
/// The mark that starts a path under the person's home folder.
const PERSON_HOME: &str = "~/";

/// Who writes an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Writer {
    /// This program, at a path its DATA names through the layout.
    Engine,
    /// The installed app.
    App,
    /// One of the account's tools.
    Workshop,
    /// The hooks AI command-line programs run.
    AiCliHook,
    /// The person themself.
    Person,
    /// No writer was found in any repository; the entry is listed because today's home holds it.
    Nobody,
}

/// Whether an entry is a folder or a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Folder,
    File,
}

/// One allowed top-level entry.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Row {
    pub name: String,
    pub kind: Kind,
    /// Its job, in one plain sentence.
    pub job: String,
    pub writer: Writer,
    /// For a trillion-local row: the trillion-local DATA file (or the source) that reads it.
    #[serde(default)]
    pub reader: Option<String>,
    /// Where the writer is: a repository and file:line.
    pub source: String,
    /// For a job folder not in the home yet: where its data still sits.
    #[serde(default)]
    pub moved_from: Option<String>,
}

/// One entry of a second home and the job folder it goes to.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Move {
    pub from: String,
    /// A row name (and a path inside it), or `delete` or `ignore`.
    pub to: String,
    /// The reader to change and release before the data moves.
    pub reader_change: String,
}

/// The whole layout.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    #[serde(rename = "_what")]
    _what: String,
    /// The one launch setting that names another home.
    pub setting: String,
    /// The home under the person's home folder, as `~/` and one name.
    pub default: String,
    pub entries: Vec<Row>,
    pub moves: Vec<Move>,
}

/// A path trillion-local would make at an entry the layout does not let it write. It names the entry only.
#[derive(Clone)]
pub struct Unlisted(pub String, pub crate::refusal_cause::Cause);
impl Unlisted { pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.1 } }
crate::impl_caused!(Unlisted);
impl PartialEq for Unlisted { fn eq(&self, other: &Self) -> bool { self.0 == other.0 } }
impl Eq for Unlisted {}
impl fmt::Debug for Unlisted { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.debug_struct("Unlisted").field("cause", &self.1).finish() } }


impl fmt::Display for Unlisted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not an engine entry of the home layout cause={}", self.1)
    }
}

impl std::error::Error for Unlisted {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

impl Layout {
    /// The row named `name`.
    pub fn row(&self, name: &str) -> Option<&Row> {
        self.entries.iter().find(|row| row.name == name)
    }

    /// The home's folder name under the person's home folder.
    pub fn default_name(&self) -> &str {
        &self.default[PERSON_HOME.len()..]
    }

    /// Whether the layout is well formed (see the invariants above).
    fn valid(&self) -> bool {
        let one_name = |name: &str| !name.is_empty() && !name.contains('/') && name != "." && name != "..";
        // A plain word: lowercase letters and `-`, not starting or ending in `-`. A file adds lowercase extensions.
        let word = |part: &str| {
            !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'-') && !part.starts_with('-') && !part.ends_with('-')
        };
        let plain = |name: &str| name.split('.').all(word);
        let mut names = BTreeSet::new();
        let rows = self.entries.iter().all(|row| {
            plain(&row.name)
                && (row.kind == Kind::File) == row.name.contains('.')
                && !row.job.trim().is_empty()
                && !row.source.trim().is_empty()
                && (row.writer == Writer::Engine) == row.reader.as_deref().is_some_and(|reader| !reader.is_empty())
                && names.insert(row.name.as_str())
        });
        let moves = self.moves.iter().all(|moved| {
            !moved.from.is_empty()
                && !moved.reader_change.is_empty()
                && (matches!(moved.to.as_str(), "delete" | "ignore")
                    || moved.to.split('/').next().is_some_and(|entry| names.contains(entry)))
        });
        !self.setting.is_empty() && self.default.strip_prefix(PERSON_HOME).is_some_and(one_name) && rows && moves
    }
}

/// The layout, read and checked once. The shipped file is checked by this module's tests, so a malformed one never
/// ships.
pub fn layout() -> &'static Layout {
    static LAID_OUT: OnceLock<Layout> = OnceLock::new();
    LAID_OUT.get_or_init(|| {
        serde_json::from_slice::<Layout>(DATA).ok().filter(Layout::valid).expect("native_entry/home.json is valid")
    })
}

/// This computer's one home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Home {
    root: PathBuf,
}

impl Home {
    /// The home named by the launch setting in `env` (an absolute folder), else the layout's default inside
    /// `person_home`. None when neither names one.
    pub fn of(env: &dyn Fn(&str) -> Option<String>, person_home: Option<&Path>) -> Option<Home> {
        let layout = layout();
        match env(&layout.setting).filter(|value| !value.is_empty()) {
            Some(set) => Some(PathBuf::from(set)).filter(|path| path.is_absolute()),
            None => person_home.filter(|home| home.is_absolute()).map(|home| home.join(layout.default_name())),
        }
        .map(|root| Home { root })
    }

    /// This process's home: its environment and its `HOME`.
    pub fn of_this_process() -> Option<Home> {
        let person = std::env::var_os("HOME").filter(|home| !home.is_empty()).map(PathBuf::from);
        Self::of(&|name| std::env::var(name).ok(), person.as_deref())
    }

    /// The home folder itself.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `inside` (`<entry>/<path>`) in this home, when its entry is a trillion-local row; otherwise refused naming the entry.
    pub fn engine_path(&self, inside: &str) -> Result<PathBuf, Unlisted> {
        let entry = inside.split('/').next().unwrap_or_default();
        if inside.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
            return Err(Unlisted(inside.to_owned(), crate::cause!()));
        }
        match layout().row(entry) {
            Some(row) if row.writer == Writer::Engine => Ok(self.root.join(inside)),
            _ => Err(Unlisted(entry.to_owned(), crate::cause!())),
        }
    }

    /// Whether the absolute folder `path` may be used by trillion-local: anywhere outside this home, or inside it under an
    /// trillion-local row. Answers the refused entry otherwise.
    pub fn admits(&self, path: &Path) -> Result<(), Unlisted> {
        let Ok(inside) = path.strip_prefix(&self.root) else { return Ok(()) };
        let Some(entry) = inside.components().next() else { return Err(Unlisted(String::new(), crate::cause!())) };
        let entry = entry.as_os_str().to_string_lossy();
        match layout().row(&entry) {
            Some(row) if row.writer == Writer::Engine => Ok(()),
            _ => Err(Unlisted(entry.into_owned(), crate::cause!())),
        }
    }
}

/// The names directly inside the home folder `home_dir` that have no row in the layout, sorted. A missing folder
/// holds nothing undeclared.
pub fn undeclared_entries(home_dir: &Path) -> Vec<String> {
    let layout = layout();
    let mut names: Vec<String> = fs::read_dir(home_dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| layout.row(name).is_none())
        .collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests;
