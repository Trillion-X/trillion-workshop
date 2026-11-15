//! The record kinds are the tools': each is declared by the tool that keeps it (its row's `record_model`), and
//! trillion-local builds the model from the tools installed for the account (src/record_model_policy/installed.rs).
//! docs/PRINCIPLES.md rule 5: no record kind is named here.
//!
//! This walks every file under src/ and finds no kind of the record model once carried here
//! (src/record_model_policy/record-model.json and src/record_indexes/record-indexes.json, removed) named as a quoted
//! literal, except:
//! - `OWN_KINDS`, the kinds trillion-local writes itself (its own part in src/record_model_policy/settings.json);
//! - the 24 kinds named by one ordinary word (a list, a message, a group...), left out of `KINDS`: a grep cannot tell
//!   them from the same word used for anything else;
//! - `LEFT`: the files other owners still have that name a kind, each a gap to close. This list only shrinks: a file
//!   that stops naming its kind must leave it, and a file not listed here that names one fails.
use std::{collections::BTreeMap, fs, path::Path};

/// Every kind (and index type) of the old record model, with no plain word and no own kind among them.
const KINDS: &[&str] = &[
    "addressed-capability", "agent-card", "agent-delivery", "agent-delivery-secret", "agent-handoff",
    "agent-handoff-result", "agent-held-work", "agent-held-work-state", "agent-review-mark", "agent-schedule-state",
    "ask-again", "audience-answer-draft", "audience-question-decision", "audience-question-work", "audience-source",
    "availability-link", "availability-operation", "availability-reservation", "availability-reservation-hold",
    "commercial-event", "computer-sources", "content-resolution-failure", "customer-database", "database-dependency",
    "decision-call", "decision-made", "decision-step", "decision-step/checklist", "decision/method",
    "decision/method_history/guidance/checklist", "default-change", "entity-list", "entity-row", "entity-spelling",
    "face-print", "file-arrival", "item-of", "link-page", "list-filter", "list-heat", "list-key", "list-open-mark",
    "list-proposal", "list-snapshot", "list-tombstone", "list-trash", "list-view", "listening-voices",
    "made-by-trillion", "marketplace-content-section", "message-case", "message-content-key",
    "message-duplicate-correction", "message-provenance-correction", "message-resend-key", "message-source-key",
    "message-speaker-naming", "message-speaker-unconfirmed", "message-thread-index", "message-time-correction",
    "naming-fields-mark", "notice-list", "notice-readers", "plan-progress", "private-response",
    "record-scope", "record-stance", "record:audience-answer-evidence", "record:audience-question",
    "record:audience-question-review", "record:audience-question-work", "record:capability-check",
    "record:configuration", "record:court-notes.signup", "record:customer", "record:media-voice-cluster",
    "record:people", "record:person", "record:program-application", "record:program-client", "record:saved-login",
    "record:saved-login-grant", "record:saved-login-shown", "record:sent", "record:tennis-intake",
    "record:untitled-list-10-2-2026", "record:waiting-on-you", "resource-action-binding", "resource-binding",
    "resource-dependency", "resource-input-erasure", "resource-input-interpretation", "resource-input-provenance",
    "resource-input-source", "resource-operation-binding", "schedule-removed", "schedule-state", "scope-view",
    "sign-in-reach", "signed_event_effect", "space-calendar-event", "table-move", "thread-summary",
    "told-the-person", "trigger-dispatch-outcome", "trigger-rule", "trigger-rule-removed", "voice-edit",
    "voice-print", "voice-profile", "voice-session", "whatsapp-pairing-offer", "workflow-dispatch-failure",
];

/// The kinds trillion-local writes itself: a plain setting, the command journal's results, a table's schema change.
const OWN_KINDS: &[&str] = &["setting", "execution", "resource-command-result", "table-schema-change"];

/// The files other owners still have that name a kind, each a gap to close (by the owner named). The record store's
/// agent-handoff order (no reader) left its settings, the live heads read the told record the installed tools name
/// (`live_heads`), and the rules and runs read their kinds from the installed tools (`rules_and_runs`).
const LEFT: &[(&str, &str)] = &[
    // Not a record kind here: the name of a folder a Workshop tool keeps in the computer's one home, listed by the
    // home layout (src/native_entry/home.json) so the engine can tell a listed entry from an unlisted one.
    ("computer-sources", "src/native_entry/home.json"),
];

fn files(folder: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(folder).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files(&path, out);
        } else {
            out.push(path);
        }
    }
}

#[test]
fn no_file_under_src_names_a_record_kind_but_its_own_and_the_gaps_left() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for kind in KINDS {
        assert!(!OWN_KINDS.contains(kind), "{kind} is listed once");
    }
    let mut all = Vec::new();
    files(&root.join("src"), &mut all);
    let mut found: BTreeMap<(String, String), ()> = BTreeMap::new();
    for path in &all {
        let Ok(text) = fs::read_to_string(path) else { continue };
        let name = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        for kind in KINDS {
            if text.contains(&format!("\"{kind}\"")) {
                found.insert((kind.to_string(), name.clone()), ());
            }
        }
    }
    let left: BTreeMap<(String, String), ()> = LEFT.iter().map(|(kind, file)| ((kind.to_string(), file.to_string()), ())).collect();
    let new: Vec<_> = found.keys().filter(|named| !left.contains_key(*named)).collect();
    assert!(new.is_empty(), "a file under src names a record kind a tool keeps: {new:?}");
    let closed: Vec<_> = left.keys().filter(|named| !found.contains_key(*named)).collect();
    assert!(closed.is_empty(), "a gap was closed: take it off LEFT: {closed:?}");
}

#[test]
fn no_record_model_or_index_file_is_carried_here() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for gone in ["src/record_model_policy/record-model.json", "src/record_indexes/record-indexes.json",
        "src/record_indexes/reader_coverage_witnesses.json", "product/lists.json", "product/record-sharing.json"] {
        assert!(!root.join(gone).exists(), "{gone} is back");
    }
}
