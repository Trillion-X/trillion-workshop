//! The device outbox shares the copies' settle transport, not the canonical feed.
//! Port of old trillion quiet-writes.ts:334-375,601-613,682-693,747-758,798-832.
//! A proposed value is visible only as a local overlay until its writer checks
//! the original caller and returns a durable native command receipt.
use super::*;

fn pending_settings() -> &'static super::super::PendingWrites {
    &settings().pending_writes
}
/// The tombstone window: past it no client retry can still arrive, so a pruned command's answer is kept until then. It is
/// `settle_max_age_ms` (src/account/computers/settings.json, `pending_writes`), the longest a command waits for its writer,
/// plus the largest request deadline in src/tool_runs/tools/tool-runs.json (`deadline_ms`, `http.max_timeout_ms`).
/// `run_ceiling_ms` is a run's total cap, not a request deadline, so it is not counted. Computed once at first use.
pub(super) fn tombstone_window_ms() -> i64 {
    static WINDOW: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *WINDOW.get_or_init(|| {
        let tools: serde_json::Value = serde_json::from_slice(include_bytes!("../../../tool_runs/tools/tool-runs.json")).expect("tool-runs.json is valid");
        let deadlines = [tools["deadline_ms"].as_i64(), tools["http"]["max_timeout_ms"].as_i64()];
        let longest = deadlines.into_iter().flatten().max().expect("tool-runs.json declares a request deadline");
        pending_settings().settle_max_age_ms + longest
    })
}
/// Hands the outbox file's free pages back to the file, one page per step, until none are left or `due` answers true.
/// The outbox is opened `auto_vacuum = incremental`, so this is the only reclaim; a busy file is left for the next tick.
fn reclaim_free_pages(path: &std::path::Path, due: &dyn Fn() -> bool) -> Result<(), SyncError> {
    let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
    while !due() {
        let free: i64 = db
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        if free == 0 {
            break;
        }
        db.execute_batch("PRAGMA incremental_vacuum(1)")
            .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
    }
    Ok(())
}
pub(super) fn pending_part_limits() -> (usize, usize) {
    (
        pending_settings().incoming_transfers,
        pending_settings().incoming_bytes,
    )
}
/// The outbox's record store resource: the one row whose readers name this file (src/storage/record_store_resources.json).
pub(crate) fn pending_resource() -> &'static str {
    crate::storage::record_store_resources::resource_of(file!()).expect("the outbox resource row names this file")
}

impl Copies {
    fn pending_roots(&self) -> SecretsKeys {
        let mut roots = self.roots();
        // The app-kept local root remains the queue's sealing root across
        // remote rekeys and removal. Other held roots remain opening keys.
        if let Ok(root) = secrets_key::given() {
            if let Ok(identity) = roots.add(&root) {
                let _ = roots.make_current(&identity);
            }
        }
        roots
    }
    fn pending_queue(&self) -> Result<pending::Queue<ComputerStore>, SyncError> {
        let resource = pending_resource();
        let path = self.records.path(resource);
        let supply: ComputerStore = match &self.records.opener {
            Some(opener) => opener.open(&path).map_err(|error| crate::carry_cause!(SyncError::storage, error))?,
            None => Box::new(
                sqlite::open_owned(&path, SCHEMA, placements::bounds())
                    .map_err(|error| crate::carry_cause!(SyncError::storage, error))?,
            ),
        };
        let limits = pending_settings();
        Ok(pending::Queue::new(
            supply,
            &self.owner,
            resource,
            self.pending_roots(),
            pending::Bounds {
                entries: limits.entries,
                bytes: limits.bytes,
                tombstone_ms: tombstone_window_ms(),
            },
        ))
    }
    pub(crate) fn set_pending_handler(
        &self,
        handler: Arc<dyn Fn(&pending::Command) -> Option<pending::Terminal> + Send + Sync>,
    ) {
        let _ = self.pending_handler.set(handler);
    }
    pub(crate) fn queue_pending(
        &self,
        command: pending::Command,
    ) -> Result<pending::Submission, SyncError> {
        if command.owner != self.owner {
            return Err(SyncError::new(
                403,
                "The command belongs to another account.",
             crate::cause!()));
        }
        let bases = self.committed_bases(&command)?;
        let submission = self.pending_queue()?.enqueue_based(&command, &bases)?;
        self.touch();
        self.step_now.store(true, Ordering::Release);
        Ok(submission)
    }
    pub(crate) fn pending_requires_queue(&self, sign_in: &str, resource: &str, request_key: &str) -> Result<bool, SyncError> {
        self.pending_queue()?.requires_queue(sign_in, resource, request_key)
    }
    pub(crate) fn pending_result(&self, id: &str) -> Result<Option<pending::Terminal>, SyncError> {
        self.pending_queue()?.terminal(id)
    }
    /// The committed version of each projected record of an unscoped command, as the copy holds it now (a missing record is version 0).
    fn committed_bases(&self, command: &pending::Command) -> Result<std::collections::BTreeMap<String, i64>, SyncError> {
        if command.scope.is_some() {
            return Ok(std::collections::BTreeMap::new());
        }
        command.projection.iter().map(|row| {
            let version = self.committed(&row.id)?.map_or(0, |(version, _)| version);
            Ok((row.id.clone(), version))
        }).collect()
    }
    /// The record `id` as this copy holds it: its committed version and value (`own-records`, the account's own records).
    fn committed(&self, id: &str) -> Result<Option<(i64, serde_json::Value)>, SyncError> {
        let read = self.read("own-records", id).map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
        // The own-records store keeps each record as its body (native::body, own_records.rs:1008); the record's value is the
        // body's `stored` text, which is what the store's own read (native::stored_form) answers.
        read.record
            .map(|record| {
                let stored = crate::storage::record_store::native::stored_form(id, &record.value)
                    .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
                let value = serde_json::from_str(&stored.value_json)
                    .map_err(|error| crate::carry_cause!(SyncError::storage, error))?;
                Ok((record.version, value))
            })
            .transpose()
    }
    /// Test-only: queue a command the way a head written before bases existed was queued (no committed version kept).
    #[cfg(test)]
    pub(crate) fn queue_pending_unbased(&self, command: pending::Command) -> Result<pending::Submission, SyncError> {
        let submission = self.pending_queue()?.enqueue(&command)?;
        self.touch();
        self.step_now.store(true, Ordering::Release);
        Ok(submission)
    }
    pub(crate) fn pending_projection(
        &self,
        sign_in: &str,
        id: &str,
        scope: Option<&placements::domains::Identity>,
        generation: i64,
    ) -> Result<Option<pending::Projection>, SyncError> {
        let store = if scope.is_none() { self.committed(id)? } else { None };
        let Some((_, entry, projection)) =
            self.pending_queue()?.projection_state_with_store(sign_in, id, scope, Some(generation), store)?
        else {
            return Ok(None);
        };
        if entry
            .terminal
            .as_ref()
            .is_some_and(|terminal| !terminal.refused)
        {
            locked(&self.pending_refresh).insert((
                sign_in.to_owned(),
                id.to_owned(),
                scope.cloned(),
            ));
            self.step_now.store(true, Ordering::Release);
        }
        Ok(Some(projection))
    }
    pub(crate) fn has_pending(&self) -> bool {
        !locked(&self.pending_refresh).is_empty()
            || self
                .pending_queue()
                .and_then(|queue| queue.pending_count())
                .is_ok_and(|count| count > 0)
    }
    /// The account timer runs one pass per tick: the settle of waiting commands first (a waiting write always goes ahead of a
    /// refresh read), then the prune, which takes writer reads only until the tick's period (`period`) is up. Network and
    /// native commit waits never block that timer's writer-term renewal.
    pub(crate) fn pending_step(self: &Arc<Self>, period: std::time::Duration) {
        if self
            .pending_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let copies = self.clone();
        crate::forwarder::lease_time::spawn(self.waiting.clone(), move || {
            struct Pass(Arc<Copies>);
            impl Drop for Pass {
                fn drop(&mut self) {
                    self.0.pending_active.store(false, Ordering::Release);
                }
            }
            let pass = Pass(copies);
            if pass.0.has_pending() {
                pass.0.settle_pending();
                pass.0.refresh_pending();
            }
            pass.0.prune_pending(period);
        });
    }
    /// One prune pass for the tick, then the free pages it left go back to the file, both until the tick is due.
    fn prune_pending(&self, period: std::time::Duration) {
        let Ok(queue) = self.pending_queue() else {
            return;
        };
        let until = std::time::Instant::now() + period;
        let due = || std::time::Instant::now() >= until;
        let _ = queue.prune((self.clock)(), &due, &mut |sign_in, id, scope| {
            self.refresh_item(&queue, sign_in.to_owned(), id.to_owned(), scope.cloned());
        });
        let _ = reclaim_free_pages(&self.records.path(pending_resource()), &due);
    }
    /// Deliver one bounded run in durable acceptance order. A lost answer
    /// keeps the earlier command first, so a later local value cannot overtake
    /// it and then be overwritten by its predecessor at the writer.
    pub fn settle_pending(&self) -> usize {
        let Ok(queue) = self.pending_queue() else {
            return 0;
        };
        let mut completed = 0;
        for _ in 0..pending_settings().page_entries {
            let Ok(Some((id, _))) = queue.next_pending() else {
                break;
            };
            if !self.settle_pending_one(&id) {
                break;
            }
            completed += 1;
        }
        completed
    }
    /// Try this accepted request now. Only network absence leaves it pending;
    /// every known writer refusal is durably returned under the original key.
    pub(crate) fn settle_pending_one(&self, id: &str) -> bool {
        let Ok(queue) = self.pending_queue() else {
            return false;
        };
        let Ok(terminal) = queue.terminal(id) else {
            return false;
        };
        if terminal.is_some() {
            return true;
        }
        let Ok(Some(entry)) = queue.get(id) else {
            return false;
        };
        // Immediate caller attempts obey the same order as restart recovery.
        if !queue
            .next_pending()
            .ok()
            .flatten()
            .is_some_and(|(next, _)| next == id)
        {
            return false;
        }
        // Past its max age the head entry completes as refused: a command nothing answers must not block every later
        // command of the account. Only the head is completed, so commands keep their durable order.
        if (self.clock)().saturating_sub(entry.command.accepted_at_ms) > pending_settings().settle_max_age_ms {
            let Ok(Some(request)) = queue.submission(id) else {
                return false;
            };
            let terminal = pending::Terminal {
                cause: crate::cause!(tokens: settle_timed_out),
                status: 504,
                body: serde_json::json!({"code": "settle_timed_out", "reason": "no answer before settle_max_age_ms"}),
                refused: true,
            };
            let Ok(receipt) = pending::seal_reply_to_submission(&self.owner, pending_resource(), &self.roots(), &request, &terminal) else {
                return false;
            };
            return queue.complete(&receipt).is_ok();
        }
        // A model changed while this computer was away. Local-only data must
        // stay here even when it was once eligible to travel.
        if let Some(state) = &self.records.state {
            if entry
                .command
                .checked_kinds
                .iter()
                .any(|kind| crate::record_model_policy::stays_on_this_device(state, kind))
            {
                return false;
            }
            if entry
                .command
                .projection
                .iter()
                .any(|row| crate::record_model_policy::stays_on_this_device(state, &row.kind))
            {
                return false;
            }
        }
        let Ok(Some(request)) = queue.submission(id) else {
            return false;
        };
        let message = Message::SettleCommand {
            request: request.clone(),
        };
        let receipt = if self.writes_here() {
            match self.answer_pending(&request) {
                Answer::SettleCommand { receipt } => Some(receipt),
                _ => None,
            }
        } else {
            let mut peers = self.row().may_answer;
            if let Some((writer, _, _)) = self.writer_row() {
                if let Some(at) = peers.iter().position(|peer| peer == &writer) {
                    peers.swap(0, at);
                }
            }
            peers
                .into_iter()
                .filter(|peer| peer != &self.me)
                .find_map(|peer| match self.send(&peer, &message) {
                    Some(Answer::SettleCommand { receipt }) => Some(receipt),
                    _ => None,
                })
                .or_else(|| match self.send(&pending_settings().current_writer_path, &message) {
                    Some(Answer::SettleCommand { receipt }) => Some(receipt),
                    _ => None,
                })
        };
        receipt.is_some_and(|receipt| queue.complete(&receipt).is_ok())
    }
    /// Read-backed local images follow later writer changes on this same timer.
    /// They remain available while offline. Refresh never replaces a newer
    /// pending command and never changes the original command or its receipt.
    pub(super) fn refresh_pending(&self) {
        let work = {
            let mut held = locked(&self.pending_refresh);
            let work = held
                .iter()
                .take(pending_settings().page_entries)
                .cloned()
                .collect::<Vec<_>>();
            for item in &work {
                held.remove(item);
            }
            work
        };
        let Ok(queue) = self.pending_queue() else {
            return;
        };
        for (sign_in, id, scope) in work {
            self.refresh_item(&queue, sign_in, id, scope);
        }
    }
    /// One writer read for one local image (the head's command, its projection id and scope): the read's answer applies
    /// only as the head's observed image, so a refusal or a missing answer leaves the head as it was.
    fn refresh_item(
        &self,
        queue: &pending::Queue<ComputerStore>,
        sign_in: String,
        id: String,
        scope: Option<placements::domains::Identity>,
    ) {
        let Ok(Some((head, entry, prior))) =
            queue.projection_state(&sign_in, &id, scope.as_ref())
        else {
            return;
        };
        if !entry
            .terminal
            .as_ref()
            .is_some_and(|terminal| !terminal.refused)
        {
            return;
        }
        // A kind that stays on this computer has no writer image to read. The image this device holds is its applied image:
        // the head's own projection, which its completed command left here, so the row can prune once it completed.
        if self.records.state.as_ref().is_some_and(|state| {
            crate::record_model_policy::stays_on_this_device(state, &prior.kind)
        }) {
            let _ = queue.refresh_projection(&sign_in, &id, scope.as_ref(), &head, &prior);
            return;
        }
        let mut command = entry.command.clone();
        let mut input = serde_json::json!({"id":id});
        if let Some(scope) = &scope {
            input["scope"] = serde_json::to_value(scope).unwrap_or(serde_json::Value::Null);
        }
        command.operation = "records:read".into();
        command.request_key = format!(
            "local-read:{}",
            content_crypto::advanced::blake3::hash(
                &serde_json::to_vec(&(
                    &sign_in,
                    &id,
                    &scope,
                    self.transfers.fetch_add(1, Ordering::AcqRel),
                    (self.clock)()
                ))
                .unwrap_or_default()
            )
            .to_hex()
        );
        command.input = input.clone();
        command.projection.clear();
        command.person_present = None;
        command.request["params"]["arguments"] = serde_json::json!({"address":"@own-records","method":"records:read","request_key":command.request_key,"input":input});
        let Some((_, terminal)) = self.settle_read(command) else {
            return;
        };
        if terminal.refused {
            return;
        }
        let Some(value) = terminal.body.pointer("/result/structuredContent") else {
            return;
        };
        if value.get("id").and_then(|value| value.as_str()) != Some(id.as_str()) {
            return;
        }
        let Some(image) = value.get("value") else {
            return;
        };
        let projection = pending::Projection {
            id: id.clone(),
            kind: value
                .get("type")
                .and_then(|kind| kind.as_str())
                .unwrap_or(&prior.kind)
                .to_owned(),
            value: (!image.is_null()).then(|| image.clone()),
        };
        let _ = queue.refresh_projection(&sign_in, &id, scope.as_ref(), &head, &projection);
    }
    /// A remote read uses the same authenticated command settle boundary,
    /// without adding anything to the durable writes outbox.
    pub(crate) fn settle_read(
        &self,
        command: pending::Command,
    ) -> Option<(Option<String>, pending::Terminal)> {
        if command.operation != "records:read"
            || command.resource != "@own-records"
            || command.owner != self.owner
            || !command.projection.is_empty()
        {
            return None;
        }
        let roots = self.pending_roots();
        let request =
            pending::seal_submission(&self.owner, pending_resource(), &roots, &command).ok()?;
        let message = Message::SettleCommand { request };
        for peer in self
            .row()
            .may_answer
            .into_iter()
            .filter(|peer| peer != &self.me)
        {
            if let Some(Answer::SettleCommand { receipt }) = self.send(&peer, &message) {
                if let Ok(terminal) =
                    pending::open_receipt(&self.owner, pending_resource(), &roots, &receipt)
                {
                    return Some((Some(peer), terminal));
                }
            }
        }
        let Answer::SettleCommand { receipt } =
            self.send(&pending_settings().current_writer_path, &message)?
        else {
            return None;
        };
        let terminal = pending::open_receipt(&self.owner, pending_resource(), &roots, &receipt).ok()?;
        // The transport chose a current writer; do not invent its public id
        // from a stale placement row for the answered-by response header.
        Some((None, terminal))
    }
    pub(super) fn answer_pending(&self, request: &pending::Submission) -> Answer {
        if self.removed() {
            return refused("removed_from_this_account", crate::cause!());
        }
        if !self.writes_here() {
            self.claim_for_write();
        }
        if !self.writes_here() {
            return refused("not_writer", crate::cause!());
        }
        let roots = self.roots();
        let command =
            match pending::open_submission(&self.owner, pending_resource(), &roots, request) {
                Ok(command) => command,
                Err(error) => return refused("invalid_command_settle", error.cause()),
            };
        let records = command.resource == "@own-records" && matches!(command.operation.as_str(), "records:write" | "records:read");
        let sealed_put = command.resource == "@held-values" && crate::secrets::queued_held_operation(&command.operation);
        if command.owner != self.owner || !(records || sealed_put) {
            return refused("invalid_command_settle", crate::cause!());
        }
        let Some(handler) = self.pending_handler.get() else {
            return refused("command_settle_unavailable", crate::cause!());
        };
        let Some(terminal) = handler(&command) else {
            return refused("command_settle_pending", crate::cause!());
        };
        match pending::seal_reply_to_submission(
            &self.owner,
            pending_resource(),
            &roots,
            request,
            &terminal,
        ) {
            Ok(receipt) => Answer::SettleCommand { receipt },
            Err(error) => refused("command_settle_unavailable", error.cause()),
        }
    }
}

impl Copies {
    /// The computer that holds the account's writer turn now, when it is not this one (`Secrets::put_as` queues there).
    pub(crate) fn writer_computer(&self) -> Option<String> {
        self.writer_row().map(|(writer, _, _)| writer)
    }

    /// Whether this copy holds the account's writer turn now.
    pub(crate) fn is_writer(&self) -> bool {
        self.holding().is_some()
    }

    /// The computer key this computer keeps for the account's copies (`with_secrets_key`), when it holds one.
    pub(crate) fn computer_key(&self) -> Option<std::sync::Arc<crate::secrets::secrets_key::ComputerKey>> {
        locked(&self.vault).computer_key.clone()
    }

    /// A held-value write sealed to the writer (`Secrets::put_as`, `Secrets::remove_as`), queued as a system command for the
    /// writer to settle (`Secrets::settle_sealed_put`, `Secrets::settle_sealed_remove`). The command carries only the sealed
    /// bytes, base64: no plaintext of the value enters the outbox, its request or its log.
    pub(crate) fn queue_sealed(&self, operation: &str, sealed: Vec<u8>) -> Result<pending::Submission, SyncError> {
        use crate::account::computers::{command_credential, command_parts, ComputerSigner};
        use base64::Engine as _;
        let key = self.computer_key().ok_or_else(|| SyncError::new(403, "This computer holds no computer key.", crate::cause!()))?;
        let signer = ComputerSigner::of(&key).map_err(|_| SyncError::new(403, "This computer holds no computer key.", crate::cause!()))?;
        let resource = crate::secrets::resource().map_err(|_| SyncError::new(500, "No secrets resource is declared.", crate::cause!()))?;
        let input = serde_json::json!({"sealed": base64::engine::general_purpose::STANDARD.encode(&sealed)});
        let accepted_at_ms = crate::account::rows::now_ms() as i64;
        let request_key = format!(
            "held-put-{}",
            &content_crypto::advanced::blake3::hash(&serde_json::to_vec(&(&sealed, accepted_at_ms)).unwrap_or_default()).to_hex()[..16]
        );
        let source_generation = self.stamp(resource);
        let parts = command_parts(&self.owner, resource, operation, &request_key, source_generation, &input);
        let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
        let bearer = command_credential(&signer, &refs, accepted_at_ms).ok_or_else(|| SyncError::new(403, "This computer holds no computer key.", crate::cause!()))?;
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_key,
            "method": "tools/call",
            "params": {"name": "run_resource_operation", "arguments": {"address": resource, "method": operation, "request_key": request_key, "input": input}}
        });
        self.queue_pending(pending::Command {
            owner: self.owner.clone(),
            sign_in: self.me.clone(),
            resource: resource.to_owned(),
            operation: operation.to_owned(),
            request_key,
            input,
            scope: None,
            source_generation,
            request,
            bearer,
            accepted_at_ms,
            person_present: None,
            checked_kinds: Vec::new(),
            projection: Vec::new(),
        })
    }
}

#[cfg(test)]
mod current_writer_tests {
    use super::*;
    use serde_json::json;

    struct CurrentWriter {
        owner: String,
        roots: Mutex<SecretsKeys>,
        available: AtomicBool,
        received: Mutex<Vec<String>>,
    }
    impl Link for CurrentWriter {
        fn send(&self, peer: &str, message: &Message) -> Option<Answer> {
            if peer != pending_settings().current_writer_path || !self.available.load(Ordering::Acquire) {
                return None;
            }
            let Message::SettleCommand { request } = message else { return None };
            let roots = locked(&self.roots);
            let command = pending::open_submission(&self.owner, pending_resource(), &roots, request).unwrap();
            locked(&self.received).push(command.request_key.clone());
            let terminal = pending::Terminal { cause: crate::cause!(pending terminal), status: 200, body: json!({"result":{"structuredContent":{"write_count":1}}}), refused: false };
            Some(Answer::SettleCommand { receipt: pending::seal_reply_to_submission(
                &self.owner, pending_resource(), &roots, request, &terminal).unwrap() })
        }
    }

    /// A head the writer cannot answer is refused once it is older than `settle_max_age_ms`, so it never blocks the command
    /// behind it: that command settles at the writer as soon as the writer is reachable.
    #[test]
    fn a_head_no_writer_answers_is_refused_past_its_max_age_and_the_next_command_settles() {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().canonicalize().unwrap();
        let owner = content_crypto::advanced::blake3::hash(state.as_os_str().as_encoded_bytes()).to_hex().to_string();
        let account = super::super::super::AccountKey::generate().unwrap();
        let address = account.address();
        let old_writer = "b".repeat(64);
        let row = super::super::super::ComputersRow::sign_with_voters(&address, 1,
            &[old_writer.clone()], &[old_writer.clone()], &[old_writer], &account).unwrap();
        let roots = SecretsKeys::of(&secrets_key::generate().unwrap()).unwrap();
        let link = Arc::new(CurrentWriter { owner: owner.clone(), roots: Mutex::new(roots.clone()),
            available: AtomicBool::new(false), received: Mutex::new(Vec::new()) });
        let now = Arc::new(AtomicI64::new(1_000_000));
        let clock = now.clone();
        let copies = Copies::for_local_commands(CopiesConfig { user: "person".into(), stores: None, address, owner: owner.clone(),
            computer: "a".repeat(64), row, records: state.join("records.sqlite"),
            limits: Some(Limits::fixed(1 << 20, 1 << 30)), sign_in: sign_in_rows(&state).unwrap(),
        }, link.clone(), Arc::new(move || clock.load(Ordering::Acquire))).unwrap();
        locked(&copies.vault).roots = roots;
        *locked(&link.roots) = copies.pending_roots();
        let queue = |request_key: &str, accepted_at_ms: i64| pending::Command { owner: owner.clone(), sign_in: "key:synthetic-current-writer".into(),
            resource: "@own-records".into(), operation: "records:write".into(), request_key: request_key.into(),
            input: json!({"records":[{"id":request_key,"type":"note","value":{"words":"kept here"}}]}),
            scope: None, source_generation: 1, request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
            bearer: "synthetic-only".into(), accepted_at_ms, person_present: None, checked_kinds: vec![],
            projection: vec![pending::Projection { id: request_key.into(), kind: "note".into(), value: Some(json!({"words":"kept here"})) }] };
        let head = copies.queue_pending(queue("transiently-unanswered-head", 1_000_000)).unwrap();
        let behind = copies.queue_pending(queue("command-behind-the-head", 1_500_000)).unwrap();
        assert_eq!(copies.settle_pending(), 0, "no writer answers the head yet, so nothing settles");
        assert!(copies.pending_result(&head.id).unwrap().is_none() && copies.pending_result(&behind.id).unwrap().is_none());
        now.store(1_000_000 + pending_settings().settle_max_age_ms + 1, Ordering::Release);
        link.available.store(true, Ordering::Release);
        assert_eq!(copies.settle_pending(), 2, "the head completes as refused past its max age, then the command behind it settles");
        let refused = copies.pending_result(&head.id).unwrap().expect("the head has a terminal answer");
        assert!(refused.refused && refused.body["code"] == json!("settle_timed_out"), "the head is refused with its reason: {refused:?}");
        assert!(!copies.pending_result(&behind.id).unwrap().unwrap().refused, "the command behind the head settled");
        assert_eq!(*locked(&link.received), vec!["command-behind-the-head".to_owned()], "the writer answered only the command behind");
    }

    /// A caller whose command was refused at settle reads the refusal by retrying its request key: the same key names the same
    /// command, and its settled answer is returned.
    #[test]
    fn a_refused_settle_is_readable_by_its_request_key_when_the_caller_retries() {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().canonicalize().unwrap();
        let owner = content_crypto::advanced::blake3::hash(state.as_os_str().as_encoded_bytes()).to_hex().to_string();
        let account = super::super::super::AccountKey::generate().unwrap();
        let address = account.address();
        let old_writer = "b".repeat(64);
        let row = super::super::super::ComputersRow::sign_with_voters(&address, 1,
            &[old_writer.clone()], &[old_writer.clone()], &[old_writer], &account).unwrap();
        let roots = SecretsKeys::of(&secrets_key::generate().unwrap()).unwrap();
        let link = Arc::new(CurrentWriter { owner: owner.clone(), roots: Mutex::new(roots.clone()),
            available: AtomicBool::new(false), received: Mutex::new(Vec::new()) });
        let now = Arc::new(AtomicI64::new(1_000_000));
        let clock = now.clone();
        let copies = Copies::for_local_commands(CopiesConfig { user: "person".into(), stores: None, address, owner: owner.clone(),
            computer: "a".repeat(64), row, records: state.join("records.sqlite"),
            limits: Some(Limits::fixed(1 << 20, 1 << 30)), sign_in: sign_in_rows(&state).unwrap(),
        }, link.clone(), Arc::new(move || clock.load(Ordering::Acquire))).unwrap();
        locked(&copies.vault).roots = roots;
        *locked(&link.roots) = copies.pending_roots();
        let queue = |request_key: &str, accepted_at_ms: i64| pending::Command { owner: owner.clone(), sign_in: "key:synthetic-current-writer".into(),
            resource: "@own-records".into(), operation: "records:write".into(), request_key: request_key.into(),
            input: json!({"records":[{"id":request_key,"type":"note","value":{"words":"kept here"}}]}),
            scope: None, source_generation: 1, request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
            bearer: "synthetic-only".into(), accepted_at_ms, person_present: None, checked_kinds: vec![],
            projection: vec![pending::Projection { id: request_key.into(), kind: "note".into(), value: Some(json!({"words":"kept here"})) }] };
        let head = copies.queue_pending(queue("transiently-unanswered-head", 1_000_000)).unwrap();
        let behind = copies.queue_pending(queue("command-behind-the-head", 1_500_000)).unwrap();
        assert_eq!(copies.settle_pending(), 0, "no writer answers the head yet, so nothing settles");
        assert!(copies.pending_result(&head.id).unwrap().is_none() && copies.pending_result(&behind.id).unwrap().is_none());
        now.store(1_000_000 + pending_settings().settle_max_age_ms + 1, Ordering::Release);
        link.available.store(true, Ordering::Release);
        assert_eq!(copies.settle_pending(), 2, "the head completes as refused past its max age, and the command behind it settles");
        let again = copies.queue_pending(queue("transiently-unanswered-head", 1_000_000)).unwrap();
        assert_eq!(again.id, head.id, "the same request key names the same command");
        let refused = copies.pending_result(&again.id).unwrap().expect("the retried request has its settled answer");
        assert!(refused.refused && refused.body["code"] == json!("settle_timed_out"),
            "a caller that retries its request key reads the refusal: {refused:?}");
    }

    /// A row whose projection kind stays on this computer has no writer image to wait for: the device's own completed
    /// command is its applied image, so once the command completed the outbox prunes it, with no timer tick and no writer.
    #[test]
    fn a_completed_device_only_row_prunes_without_a_writer_image() {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().canonicalize().unwrap();
        crate::record_model_policy::install_test_tools(&state);
        let owner = content_crypto::advanced::blake3::hash(state.as_os_str().as_encoded_bytes()).to_hex().to_string();
        let account = super::super::super::AccountKey::generate().unwrap();
        let address = account.address();
        let old_writer = "b".repeat(64);
        let row = super::super::super::ComputersRow::sign_with_voters(&address, 1,
            &[old_writer.clone()], &[old_writer.clone()], &[old_writer], &account).unwrap();
        let roots = SecretsKeys::of(&secrets_key::generate().unwrap()).unwrap();
        let link = Arc::new(CurrentWriter { owner: owner.clone(), roots: Mutex::new(roots.clone()),
            available: AtomicBool::new(false), received: Mutex::new(Vec::new()) });
        let now = Arc::new(AtomicI64::new(1_000_000));
        let clock = now.clone();
        let copies = Copies::for_local_commands(CopiesConfig { user: "person".into(), stores: None, address, owner: owner.clone(),
            computer: "a".repeat(64), row, records: state.join("records.sqlite"),
            limits: Some(Limits::fixed(1 << 20, 1 << 30)), sign_in: sign_in_rows(&state).unwrap(),
        }, link.clone(), Arc::new(move || clock.load(Ordering::Acquire))).unwrap()
            .with_state(state.clone());
        locked(&copies.vault).roots = roots;
        *locked(&link.roots) = copies.pending_roots();
        let kept = pending::Command { owner: owner.clone(), sign_in: "key:synthetic-current-writer".into(),
            resource: "@own-records".into(), operation: "records:write".into(), request_key: "kept-here-row".into(),
            input: json!({"records":[{"id":"kept-one","type":"kept-here","value":{"words":"kept here"}}]}),
            scope: None, source_generation: 1, request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
            bearer: "synthetic-only".into(), accepted_at_ms: 1_000_000, person_present: None, checked_kinds: vec![],
            projection: vec![pending::Projection { id: "kept-one".into(), kind: "kept-here".into(), value: Some(json!({"words":"kept here"})) }] };
        let queued = copies.queue_pending(kept).unwrap();
        let queue = copies.pending_queue().unwrap();
        let request = queue.submission(&queued.id).unwrap().expect("the row is queued");
        let terminal = pending::Terminal { cause: crate::cause!(pending terminal), status: 200, body: json!({"result":{"structuredContent":{"committed":true}}}), refused: false };
        let receipt = pending::seal_reply_to_submission(&owner, pending_resource(), &copies.pending_roots(), &request, &terminal).unwrap();
        queue.complete(&receipt).unwrap();
        assert!(queue.get(&queued.id).unwrap().is_some_and(|entry| entry.terminal.is_some()), "the row completed on this device");
        copies.prune_pending(std::time::Duration::from_secs(60));
        assert!(queue.get(&queued.id).unwrap().is_none(), "a completed device-only row prunes once its own command is its applied image");
        assert!(link.received.lock().unwrap().is_empty(), "no writer read was needed for a device-only row");
    }

    /// A tick of zero length prunes nothing, so no single pass holds a large outbox; a later full tick prunes the backlog.
    #[test]
    fn a_zero_length_tick_prunes_nothing_and_a_later_tick_prunes_the_backlog() {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().canonicalize().unwrap();
        crate::record_model_policy::install_test_tools(&state);
        let owner = content_crypto::advanced::blake3::hash(state.as_os_str().as_encoded_bytes()).to_hex().to_string();
        let account = super::super::super::AccountKey::generate().unwrap();
        let address = account.address();
        let old_writer = "b".repeat(64);
        let row = super::super::super::ComputersRow::sign_with_voters(&address, 1,
            &[old_writer.clone()], &[old_writer.clone()], &[old_writer], &account).unwrap();
        let roots = SecretsKeys::of(&secrets_key::generate().unwrap()).unwrap();
        let link = Arc::new(CurrentWriter { owner: owner.clone(), roots: Mutex::new(roots.clone()),
            available: AtomicBool::new(false), received: Mutex::new(Vec::new()) });
        let now = Arc::new(AtomicI64::new(1_000_000));
        let clock = now.clone();
        let copies = Copies::for_local_commands(CopiesConfig { user: "person".into(), stores: None, address, owner: owner.clone(),
            computer: "a".repeat(64), row, records: state.join("records.sqlite"),
            limits: Some(Limits::fixed(1 << 20, 1 << 30)), sign_in: sign_in_rows(&state).unwrap(),
        }, link.clone(), Arc::new(move || clock.load(Ordering::Acquire))).unwrap()
            .with_state(state.clone());
        locked(&copies.vault).roots = roots;
        *locked(&link.roots) = copies.pending_roots();
        let queue = copies.pending_queue().unwrap();
        let mut ids = Vec::new();
        for number in 0..200 {
            let kept = pending::Command { owner: owner.clone(), sign_in: "key:synthetic-current-writer".into(),
                resource: "@own-records".into(), operation: "records:write".into(), request_key: format!("kept-row-{number}"),
                input: json!({"records":[{"id":format!("kept-{number}"),"type":"kept-here","value":{"words":"kept here"}}]}),
                scope: None, source_generation: 1, request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
                bearer: "synthetic-only".into(), accepted_at_ms: 1_000_000, person_present: None, checked_kinds: vec![],
                projection: vec![pending::Projection { id: format!("kept-{number}"), kind: "kept-here".into(), value: Some(json!({"words":"kept here"})) }] };
            let queued = copies.queue_pending(kept).unwrap();
            let request = queue.submission(&queued.id).unwrap().expect("the row is queued");
            let terminal = pending::Terminal { cause: crate::cause!(pending terminal), status: 200, body: json!({"result":{"structuredContent":{"committed":true}}}), refused: false };
            let receipt = pending::seal_reply_to_submission(&owner, pending_resource(), &copies.pending_roots(), &request, &terminal).unwrap();
            queue.complete(&receipt).unwrap();
            ids.push(queued.id);
        }
        let remaining = |queue: &pending::Queue<ComputerStore>| ids.iter().filter(|id| queue.get(id).unwrap().is_some()).count();
        copies.prune_pending(std::time::Duration::ZERO);
        assert_eq!(remaining(&queue), 200, "a zero-length tick stops before its first row");
        copies.prune_pending(std::time::Duration::from_secs(60));
        assert_eq!(remaining(&queue), 0, "a full tick prunes the completed device rows");
    }

    /// A removed sender's signed row still names an unreachable old writer.
    /// Its durable command must drain without a placement pull or a new write.
    #[test]
    fn a_pending_command_reaches_the_current_writer_when_every_local_peer_is_stale() {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().canonicalize().unwrap();
        let owner = content_crypto::advanced::blake3::hash(state.as_os_str().as_encoded_bytes()).to_hex().to_string();
        let account = super::super::super::AccountKey::generate().unwrap();
        let address = account.address();
        let old_writer = "b".repeat(64);
        let row = super::super::super::ComputersRow::sign_with_voters(&address, 1,
            &[old_writer.clone()], &[old_writer.clone()], &[old_writer], &account).unwrap();
        let roots = SecretsKeys::of(&secrets_key::generate().unwrap()).unwrap();
        let link = Arc::new(CurrentWriter { owner: owner.clone(), roots: Mutex::new(roots.clone()),
            available: AtomicBool::new(false), received: Mutex::new(Vec::new()) });
        let copies = Copies::for_local_commands(CopiesConfig { user: "person".into(), stores: None, address, owner: owner.clone(),
            computer: "a".repeat(64), row, records: state.join("records.sqlite"),
            limits: Some(Limits::fixed(1 << 20, 1 << 30)), sign_in: sign_in_rows(&state).unwrap(),
        }, link.clone(), Arc::new(|| 1_000_000)).unwrap();
        locked(&copies.vault).roots = roots;
        *locked(&link.roots) = copies.pending_roots();
        assert!(copies.removed(), "ordinary copying and writer claims remain refused");
        let command = pending::Command { owner, sign_in: "key:synthetic-current-writer".into(),
            resource: "@own-records".into(), operation: "records:write".into(), request_key: "stale-placement-request".into(),
            input: json!({"records":[{"id":"note","type":"note","value":{"words":"kept here"}}]}),
            scope: None, source_generation: 1, request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
            bearer: "synthetic-only".into(), accepted_at_ms: 1_000_000, person_present: None, checked_kinds: vec![],
            projection: vec![pending::Projection { id: "note".into(), kind: "note".into(), value: Some(json!({"words":"kept here"})) }] };
        let queued = copies.queue_pending(command).unwrap();
        assert_eq!(copies.settle_pending(), 0, "no writer is reachable yet");
        assert!(copies.pending_result(&queued.id).unwrap().is_none());
        assert_eq!(copies.pending_projection("key:synthetic-current-writer", "note", None, 1).unwrap().unwrap().value,
            Some(json!({"words":"kept here"})), "the retained command stays locally visible");
        link.available.store(true, Ordering::Release);
        assert_eq!(copies.settle_pending(), 1, "the existing queue drains despite its stale placement");
        assert_eq!(*locked(&link.received), vec!["stale-placement-request".to_owned()]);
        assert!(!copies.pending_result(&queued.id).unwrap().unwrap().refused);
        assert!(copies.removed() && copies.holding().is_none(), "delivery changes no membership or writer turn");
    }
}

#[cfg(test)]
mod reclaim_tests {
    use super::reclaim_free_pages;

    /// An incremental-vacuum file whose rows are all removed still holds its freed pages; the reclaim step hands them back.
    #[test]
    fn emptied_outbox_file_shrinks_after_the_reclaim_pass() {
        let path = std::env::temp_dir().join(format!("outbox-reclaim-{}-{}.sqlite", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; CREATE TABLE rows (id INTEGER PRIMARY KEY, body BLOB);").unwrap();
        db.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000) INSERT INTO rows (id, body) SELECT i, zeroblob(1024) FROM n", []).unwrap();
        db.execute("DELETE FROM rows", []).unwrap();
        let before: i64 = db.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap();
        let free: i64 = db.query_row("PRAGMA freelist_count", [], |row| row.get(0)).unwrap();
        assert!(free > 0, "the deleted rows leave free pages behind");
        drop(db);
        reclaim_free_pages(&path, &|| false).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        let after: i64 = db.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap();
        let free_after: i64 = db.query_row("PRAGMA freelist_count", [], |row| row.get(0)).unwrap();
        drop(db);
        std::fs::remove_file(&path).unwrap();
        assert!(after < before, "the file shrinks: {before} pages before, {after} after");
        assert_eq!(free_after, 0);
    }

    /// The reclaim stops at once when the tick is already due, so a busy tick leaves its free pages for the next one.
    #[test]
    fn reclaim_stops_when_the_tick_is_due() {
        let path = std::env::temp_dir().join(format!("outbox-reclaim-due-{}-{}.sqlite", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; CREATE TABLE rows (id INTEGER PRIMARY KEY, body BLOB);").unwrap();
        db.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO rows (id, body) SELECT i, zeroblob(1024) FROM n", []).unwrap();
        db.execute("DELETE FROM rows", []).unwrap();
        drop(db);
        reclaim_free_pages(&path, &|| true).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        let free: i64 = db.query_row("PRAGMA freelist_count", [], |row| row.get(0)).unwrap();
        drop(db);
        std::fs::remove_file(&path).unwrap();
        assert!(free > 0, "a due tick does no reclaim");
    }
}
