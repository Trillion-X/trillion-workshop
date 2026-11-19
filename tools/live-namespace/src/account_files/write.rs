//! Resumable byte writes through the existing account account files.
//!
//! The caller supplies only a random upload token, target name, optional declared
//! byte length, media type and actual piece bytes. Server-owned checkpoint state is
//! never accepted from the caller. Every piece is hashed from its bytes, kept
//! under the existing content-addressed chunk owner, then checkpointed and
//! span-paged before the accepted offset advances.

use base64::Engine as _;
use super::{
    AccountFiles, AccountFilesError, Answer, CHUNK_KIND, CHUNKS, FILE_KIND, FILES, LIVE, SPANS,
    UPLOAD_KIND, UPLOADS, names_scope, now_iso,
    objects::{ObjectError, Origin},
    paged_spans::{self, Span},
    parent, text,
};
use crate::{
    store::{Mutation},
};
use content_crypto::{
    Multihash,
    subtree::{Accumulator, Checkpoint, SUBTREE_BYTES},
};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const UPLOAD_ID_BYTES: usize = 32;
// Each page contains 256 chunk ids. Keep the chunk metadata lookup under
// record store's 1,000-id read batch limit; finish work is linear in accepted pages,
// but one verification step remains bounded to at most 768 spans.
const VERIFY_PAGES_AT_ONCE: usize = 3;

impl AccountFiles {
    /// Existing known-length entry point; its Rust signature and result shape
    /// remain stable for current callers.
    pub fn write_file_start(
        &mut self,
        upload_id: &str,
        name: &str,
        byte_length: u64,
        media_type: &str,
        app: Option<&str>,
    ) -> Answer<Value> {
        self.write_file_start_with_length(upload_id, name, Some(byte_length), media_type, app, None)
    }

    /// Start or resume one generic account files file write. The upload token is
    /// account-scoped and bound to a name and original length declaration. Starting
    /// never creates a file name or reuses an arbitrary content identity. `expected` is the
    /// name's version the caller read (0: the name must not be there): a start that finds
    /// another is refused with a conflict, and the finish writes the name at the version kept here.
    pub(super) fn write_file_start_with_length(
        &mut self,
        upload_id: &str,
        name: &str,
        byte_length: Option<u64>,
        media_type: &str,
        app: Option<&str>,
        expected: Option<i64>,
    ) -> Answer<Value> {
        self.expire_abandoned_upload()?;
        validate_upload_id(upload_id)?;
        validate_name(name)?;
        validate_media_type(media_type)?;
        validate_app(app)?;
        self.check_current()?;
        if let Some(upload) = self.get(UPLOADS, upload_id)? {
            // The append layout retains the original open-length declaration
            // after finish records the actual length. Replaying that start
            // must still return its finished result with the original binding.
            let append_layout =
                text(&upload.value, "span_layout") == Some(paged_spans::APPEND_LAYOUT);
            let declared_length = if append_layout {
                None
            } else {
                upload.value.get("byte_length").and_then(Value::as_u64)
            };
            if text(&upload.value, "name") != Some(name)
                || (!append_layout
                    && upload
                        .value
                        .get("length_known")
                        .and_then(Value::as_bool)
                        .unwrap_or(true))
                    != byte_length.is_some()
                || declared_length != byte_length
                || text(&upload.value, "media_type") != Some(media_type)
                || text(&upload.value, "app") != app
            {
                return Err(AccountFilesError::Invalid(
                    "upload id is already bound to another write",
                 crate::cause!()));
            }
            return match text(&upload.value, "status").unwrap_or("open") {
                "open" => {
                    self.ensure_name_version(&upload.value, name)?;
                    Ok(if let Some(byte_length) = byte_length {
                        json!({"upload_id":upload_id,"state":"open","next_offset":upload.value["next_offset"],"byte_length":byte_length})
                    } else {
                        json!({"upload_id":upload_id,"state":"open","next_offset":upload.value["next_offset"],"length_known":false})
                    })
                }
                "finished" => self.with_name_row(
                    name,
                    json!({"upload_id":upload_id,"state":"finished","identity":upload.value["identity"],"name":name,"byte_length":upload.value["byte_length"]}),
                ),
                "cancelled" => Ok(
                    json!({"upload_id":upload_id,"state":"cancelled","bytes_retained":true,"byte_length":upload.value["byte_length"]}),
                ),
                _ => Err(AccountFilesError::Invalid("upload state is unavailable", crate::cause!())),
            };
        }
        let (upload_version, held_upload) = self.held(UPLOADS, upload_id)?;
        if upload_version != 0 || held_upload.is_some() {
            return Err(AccountFilesError::Invalid("upload id cannot be reused", crate::cause!()));
        }
        let (name_version, name_record) = self.held(&names_scope(parent(name)), name)?;
        super::expect_name_version(expected, name_version, name_record.is_some())?;
        let checkpoint = byte_length.map(|length| Accumulator::new(length).checkpoint());
        let stored_length = byte_length.map_or(Value::Null, |length| json!(length));
        let value = json!({
            "kind": UPLOAD_KIND, "status": "open", "name": name, "byte_length": stored_length,
            "length_known": byte_length.is_some(), "span_layout": if byte_length.is_some() { paged_spans::CHUNKS_LAYOUT } else { paged_spans::APPEND_LAYOUT },
            "span_count": 0, "media_type": media_type, "next_offset": 0, "checkpoint": checkpoint,
            "name_version": name_version,
            "prior_file": name_record.as_ref().and_then(|record| text(&record.value, "file")).unwrap_or("").to_owned(),
            "app": app, "origin": null, "started_at": now_iso(),
        });
        self.mutate(
            UPLOADS,
            Mutation {
                id: upload_id.to_owned(),
                expected_version: 0,
                request_key: request_key(upload_id, "start", 0),
                deleted: false,
                value,
            },
        )?;
        Ok(if let Some(byte_length) = byte_length {
            json!({"upload_id":upload_id,"state":"open","next_offset":0,"byte_length":byte_length})
        } else {
            json!({"upload_id":upload_id,"state":"open","next_offset":0,"length_known":false})
        })
    }

    /// Accept one actual bounded piece. Retrying an accepted offset with the
    /// same bytes is idempotent; different bytes at that offset are refused.
    pub fn write_file_piece(
        &mut self,
        upload_id: &str,
        name: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Answer<Value> {
        validate_upload_id(upload_id)?;
        validate_name(name)?;
        self.check_current()?;
        let upload = self
            .get(UPLOADS, upload_id)?
            .ok_or(crate::cause!(AccountFilesError::NotFound))?;
        if text(&upload.value, "status").unwrap_or("open") != "open" {
            return Err(AccountFilesError::Invalid("upload is not open", crate::cause!()));
        }
        ensure_name_binding(&upload.value, name)?;
        if let Some(layout) = text(&upload.value, "span_layout").filter(|layout| paged_spans::is_variable(layout)).map(str::to_owned) {
            return self.write_variable_piece(upload, upload_id, name, offset, bytes, &layout);
        }
        if bytes.is_empty() || bytes.len() > SUBTREE_BYTES {
            return Err(AccountFilesError::Invalid(
                "file piece must contain 1 to 32768 bytes",
             crate::cause!()));
        }
        let byte_length = upload
            .value
            .get("byte_length")
            .and_then(Value::as_u64)
            .ok_or(AccountFilesError::Invalid("upload length is invalid", crate::cause!()))?;
        let next = upload
            .value
            .get("next_offset")
            .and_then(Value::as_u64)
            .ok_or(AccountFilesError::Invalid("upload offset is invalid", crate::cause!()))?;
        let mut accumulator = Accumulator::resume(checkpoint(&upload.value)?)
            .map_err(|_| AccountFilesError::Invalid("upload checkpoint is invalid", crate::cause!()))?;
        let identity = Multihash::blake3(bytes).to_code_hex();
        if offset < next {
            self.ensure_name_version(&upload.value, name)?;
            return self.replay_piece(upload_id, offset, bytes, &identity, next, byte_length);
        }
        if offset != next {
            return Err(AccountFilesError::Invalid(
                "file piece must start at the next byte",
             crate::cause!()));
        }
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or(AccountFilesError::Invalid("file piece range overflows", crate::cause!()))?;
        if end > byte_length {
            return Err(AccountFilesError::Invalid(
                "file piece extends past the declared length",
             crate::cause!()));
        }
        accumulator.push(offset, bytes).map_err(|_| {
            AccountFilesError::Invalid("file piece does not match the upload layout", crate::cause!())
        })?;
        self.ensure_name_version(&upload.value, name)?;

        // Hash actual input bytes before any content-address deduplication.
        let origins = self.origins()?;
        let existing = self.get(CHUNKS, &identity)?;
        let chunk_origin = if let Some(chunk) = existing {
            if chunk.value.get("byte_length").and_then(Value::as_u64) != Some(bytes.len() as u64) {
                return Err(AccountFilesError::Invalid(
                    "stored chunk metadata conflicts with its identity",
                 crate::cause!()));
            }
            let origin = text(&chunk.value, "origin")
                .ok_or(AccountFilesError::Invalid("stored chunk has no origin", crate::cause!()))?
                .to_owned();
            self.share_chunk(&chunk, upload_id, ordinal_for_offset(offset))?;
            origin
        } else {
            self.keep_chunk(
                upload_id,
                ordinal_for_offset(offset),
                &identity,
                bytes,
                &origins,
            )?
        };

        // The page is durable before next_offset moves. A retry repairs a
        // crash between these two records without changing accepted bytes.
        let ordinal = offset / SUBTREE_BYTES as u64;
        let page = paged_spans::page_number(ordinal);
        let page_record_id = paged_spans::page_id(upload_id, page);
        let (page_version, page_record) = self.held(SPANS, &page_record_id)?;
        let old_page = page_record
            .as_ref()
            .map(|record| record.value.clone())
            .unwrap_or_else(|| paged_spans::empty_page(upload_id, page));
        let span = Span {
            ordinal,
            offset,
            length: bytes.len() as u64,
            chunk: identity,
        };
        let (page_value, changed) = paged_spans::append(&old_page, upload_id, page, span)
            .map_err(|error| AccountFilesError::Invalid("file span page conflicts with the upload", error.cause()))?;
        if changed {
            self.ensure_name_version(&upload.value, name)?;
            self.mutate(
                SPANS,
                Mutation {
                    id: page_record_id,
                    expected_version: page_version,
                    request_key: request_key(upload_id, "span", ordinal),
                    deleted: false,
                    value: page_value,
                },
            )?;
        }

        let mut value = upload.value.clone();
        value["next_offset"] = json!(end);
        value["checkpoint"] = serde_json::to_value(accumulator.checkpoint())
            .map_err(|_| AccountFilesError::Invalid("upload checkpoint cannot be stored", crate::cause!()))?;
        if value.get("origin").and_then(Value::as_str).is_none() {
            value["origin"] = json!(chunk_origin);
        }
        self.ensure_name_version(&upload.value, name)?;
        self.mutate(
            UPLOADS,
            Mutation {
                id: upload_id.to_owned(),
                expected_version: upload.version,
                request_key: request_key(upload_id, "piece", ordinal),
                deleted: false,
                value,
            },
        )?;
        Ok(
            json!({"upload_id":upload_id,"next_offset":end,"accepted_bytes":bytes.len(),"already_received":false}),
        )
    }

    /// One piece of a variable-length upload: `pages-append-v1` (open length) or `chunks-v1` (declared length). A declared
    /// length keeps the server checkpoint, fed in 32 KiB subtrees, so finish needs no read-back.
    fn write_variable_piece(
        &mut self,
        upload: crate::store::Record,
        upload_id: &str,
        name: &str,
        offset: u64,
        bytes: &[u8],
        layout: &str,
    ) -> Answer<Value> {
        let next = upload
            .value
            .get("next_offset")
            .and_then(Value::as_u64)
            .ok_or(AccountFilesError::Invalid("upload offset is invalid", crate::cause!()))?;
        let count = upload
            .value
            .get("span_count")
            .and_then(Value::as_u64)
            .ok_or(AccountFilesError::Invalid("upload span count is invalid", crate::cause!()))?;
        if bytes.is_empty() || bytes.len() as u64 > paged_spans::most_span_bytes(layout) {
            return Err(AccountFilesError::Invalid(
                "file piece is outside its layout's size bounds",
             crate::cause!()));
        }
        let declared = upload.value.get("byte_length").and_then(Value::as_u64);
        let identity = Multihash::blake3(bytes).to_code_hex();
        if offset < next {
            self.ensure_name_version(&upload.value, name)?;
            let mut answer = self.replay_variable_piece(upload_id, offset, bytes, &identity, next, count)?;
            answer["length_known"] = json!(declared.is_some());
            return Ok(answer);
        }
        if offset != next {
            return Err(AccountFilesError::Invalid(
                "file piece must start at the next byte",
             crate::cause!()));
        }
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or(AccountFilesError::Invalid("file piece range overflows", crate::cause!()))?;
        // A known length is hashed before anything is kept. The checkpoint takes whole 32 KiB subtrees only, so the bytes
        // after the last whole subtree (the tail) wait for the next piece; the file's last piece pushes its whole tail.
        // The tail and the checkpoint are stored with the cursor, so a retry after a crash feeds the same bytes again.
        let new_state = match declared {
            None => None,
            Some(byte_length) => {
                if end > byte_length {
                    return Err(AccountFilesError::Invalid(
                        "file piece extends past the declared length",
                     crate::cause!()));
                }
                let mut accumulator = Accumulator::resume(checkpoint(&upload.value)?)
                    .map_err(|_| AccountFilesError::Invalid("upload checkpoint is invalid", crate::cause!()))?;
                let mut pending = match text(&upload.value, "tail") {
                    Some(tail) => crate::account_files::BASE64.decode(tail).map_err(|_| AccountFilesError::Invalid("upload tail is invalid", crate::cause!()))?,
                    None => Vec::new(),
                };
                if pending.len() as u64 != offset % SUBTREE_BYTES as u64 {
                    return Err(AccountFilesError::Invalid("upload tail does not match its cursor", crate::cause!()));
                }
                let base = offset - pending.len() as u64;
                pending.extend_from_slice(bytes);
                let mut from = 0usize;
                while pending.len() - from >= SUBTREE_BYTES || (end == byte_length && from < pending.len()) {
                    let to = (from + SUBTREE_BYTES).min(pending.len());
                    accumulator
                        .push(base + from as u64, &pending[from..to])
                        .map_err(|_| AccountFilesError::Invalid("file piece does not match the upload layout", crate::cause!()))?;
                    from = to;
                }
                let checkpoint_value = serde_json::to_value(accumulator.checkpoint())
                    .map_err(|_| AccountFilesError::Invalid("upload checkpoint cannot be stored", crate::cause!()))?;
                Some((checkpoint_value, pending[from..].to_vec()))
            }
        };
        self.ensure_name_version(&upload.value, name)?;
        let page = paged_spans::page_number(count);
        let page_record_id = paged_spans::page_id(upload_id, page);
        let (page_version, page_record) = self.held(SPANS, &page_record_id)?;
        let old_page = if let Some(record) = page_record.as_ref() {
            record.value.clone()
        } else {
            if count % paged_spans::SPANS_PER_PAGE == 0 && page > 0 {
                let prior_id = paged_spans::page_id(upload_id, page - 1);
                let prior = self
                    .get(SPANS, &prior_id)?
                    .ok_or(AccountFilesError::Invalid(
                        "the previous upload span page is missing",
                     crate::cause!()))?;
                let prior_spans = paged_spans::parse_variable_page(&prior.value, upload_id, page - 1)
                    .map_err(|error| {
                        AccountFilesError::Invalid("the previous upload span page is invalid", error.cause())
                    })?;
                let prior_end = prior
                    .value
                    .get("end_offset")
                    .and_then(Value::as_u64)
                    .ok_or(AccountFilesError::Invalid(
                        "the previous upload span page is invalid",
                     crate::cause!()))?;
                if prior_spans.len() as u64 != paged_spans::SPANS_PER_PAGE || prior_end != offset {
                    return Err(AccountFilesError::Invalid("upload span pages do not join", crate::cause!()));
                }
            }
            paged_spans::empty_variable_page(upload_id, page, offset, layout)
        };
        let page_start = old_page
            .get("start_offset")
            .and_then(Value::as_u64)
            .ok_or(AccountFilesError::Invalid("upload span page is invalid", crate::cause!()))?;
        let expected_start = if page == 0 {
            0
        } else {
            let prior_id = paged_spans::page_id(upload_id, page - 1);
            let prior = self
                .get(SPANS, &prior_id)?
                .ok_or(AccountFilesError::Invalid(
                    "the previous upload span page is missing",
                 crate::cause!()))?;
            let prior_spans = paged_spans::parse_variable_page(&prior.value, upload_id, page - 1)
                .map_err(|error| {
                    AccountFilesError::Invalid("the previous upload span page is invalid", error.cause())
                })?;
            if prior_spans.len() as u64 != paged_spans::SPANS_PER_PAGE {
                return Err(AccountFilesError::Invalid(
                    "the previous upload span page is incomplete",
                 crate::cause!()));
            }
            prior
                .value
                .get("end_offset")
                .and_then(Value::as_u64)
                .ok_or(AccountFilesError::Invalid(
                    "the previous upload span page is invalid",
                 crate::cause!()))?
        };
        if page_start != expected_start {
            return Err(AccountFilesError::Invalid("upload span pages do not join", crate::cause!()));
        }
        let span = Span {
            ordinal: count,
            offset,
            length: bytes.len() as u64,
            chunk: identity.clone(),
        };
        let (page_value, changed) = paged_spans::append_variable(&old_page, upload_id, page, span)
            .map_err(|error| AccountFilesError::Invalid("file span page conflicts with the upload", error.cause()))?;
        let origins = self.origins()?;
        let existing = self.get(CHUNKS, &identity)?;
        let chunk_origin = if let Some(chunk) = existing {
            if chunk.value.get("byte_length").and_then(Value::as_u64) != Some(bytes.len() as u64) {
                return Err(AccountFilesError::Invalid(
                    "stored chunk metadata conflicts with its identity",
                 crate::cause!()));
            }
            let origin = text(&chunk.value, "origin")
                .ok_or(AccountFilesError::Invalid("stored chunk has no origin", crate::cause!()))?
                .to_owned();
            self.share_chunk(&chunk, upload_id, count)?;
            origin
        } else {
            self.keep_chunk(upload_id, count, &identity, bytes, &origins)?
        };
        if changed {
            self.ensure_name_version(&upload.value, name)?;
            self.mutate(
                SPANS,
                Mutation {
                    id: page_record_id,
                    expected_version: page_version,
                    request_key: request_key(upload_id, "span", count),
                    deleted: false,
                    value: page_value,
                },
            )?;
        }
        let mut value = upload.value.clone();
        value["next_offset"] = json!(end);
        if let Some((new_checkpoint, tail)) = new_state {
            value["checkpoint"] = new_checkpoint;
            value["tail"] = json!(crate::account_files::BASE64.encode(tail));
        }
        // If the span page landed before the upload cursor (crash recovery),
        // append_variable returns unchanged but this accepted call still has
        // to move the cursor and span count past that durable span.
        value["span_count"] = json!(
            count
                .checked_add(1)
                .ok_or(AccountFilesError::Invalid("upload span count overflows", crate::cause!()))?
        );
        if value.get("origin").and_then(Value::as_str).is_none() {
            value["origin"] = json!(chunk_origin);
        }
        self.ensure_name_version(&upload.value, name)?;
        self.mutate(
            UPLOADS,
            Mutation {
                id: upload_id.to_owned(),
                expected_version: upload.version,
                request_key: request_key(upload_id, "piece", count),
                deleted: false,
                value,
            },
        )?;
        Ok(
            json!({"upload_id":upload_id,"next_offset":end,"accepted_bytes":bytes.len(),"already_received":false,"length_known":declared.is_some()}),
        )
    }

    /// The chunks a growing upload describes, kept with the upload so a restarted engine can go on (the growing route's
    /// `spans`, one record per span page under the upload's own id, in `@namespace/spans`). Each span is
    /// {ordinal, offset, length, chunk}; a span is written again only as the same span.
    pub fn write_described_spans(&mut self, upload_id: &str, name: &str, spans: &[Value]) -> Answer<Value> {
        validate_upload_id(upload_id)?;
        validate_name(name)?;
        self.check_current()?;
        let upload = self.get(UPLOADS, upload_id)?.ok_or(crate::cause!(AccountFilesError::NotFound))?;
        if text(&upload.value, "name") != Some(name) {
            return Err(AccountFilesError::Invalid("upload belongs to a different name", crate::cause!()));
        }
        let mut pages: BTreeMap<u64, Map<String, Value>> = BTreeMap::new();
        let per_page = crate::account_files::settings::settings().described.spans_per_page;
        for span in spans {
            let ordinal = span.get("ordinal").and_then(Value::as_u64)
                .ok_or(AccountFilesError::Invalid("a described span has no ordinal", crate::cause!()))?;
            pages.entry(ordinal / per_page).or_default().insert(ordinal.to_string(), json!({
                "offset": span["offset"], "length": span["length"], "chunk": span["chunk"],
            }));
        }
        for (page, entries) in pages {
            let id = described_page_id(upload_id, page);
            let (version, record) = self.held(SPANS, &id)?;
            let mut value = record.map_or_else(
                || json!({"kind": DESCRIBED_KIND, "upload_id": upload_id, "page": page, "spans": {}}),
                |record| record.value,
            );
            if let Some(known) = value["spans"].as_object_mut() {
                known.extend(entries);
            }
            self.mutate(SPANS, Mutation {
                id: id.clone(),
                expected_version: version,
                request_key: request_key(&id, "described", version as u64),
                deleted: false,
                value,
            })?;
        }
        Ok(json!({"upload_id": upload_id, "described": spans.len()}))
    }

    /// Cancel an abandoned upload past its expiry (DATA `described.open_upload_expiry_days`), found in the first page of the
    /// upload records. A new upload calls it, so abandoned uploads are cleared as uploads begin. Cancelling drops the
    /// upload's described spans too.
    fn expire_abandoned_upload(&mut self) -> Answer<()> {
        let days = crate::account_files::settings::settings().described.open_upload_expiry_days as i64;
        let cutoff = chrono::Utc::now() - chrono::Duration::days(days);
        let (cursor_version, cursor) = self.held(UPLOADS, EXPIRY_CURSOR)?;
        let after = cursor.as_ref().and_then(|record| text(&record.value, "after")).unwrap_or("").to_owned();
        let page = self.store.list_page(UPLOADS, &after, crate::store::MAX_PAGE_ITEMS)?;
        for record in page.items {
            if record.id == EXPIRY_CURSOR || text(&record.value, "status") != Some("open") {
                continue;
            }
            let started = text(&record.value, "started_at")
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .map(|at| at.with_timezone(&chrono::Utc));
            if started.is_some_and(|started| started < cutoff) {
                let name = text(&record.value, "name").unwrap_or_default().to_owned();
                self.write_file_cancel(&record.id, &name)?;
            }
        }
        // The next start resumes after this page; the end of the upload records wraps to the first page.
        self.mutate(UPLOADS, Mutation {
            id: EXPIRY_CURSOR.to_owned(),
            expected_version: cursor_version,
            request_key: request_key(EXPIRY_CURSOR, "advance", cursor_version as u64),
            deleted: false,
            value: json!({"kind": EXPIRY_CURSOR_KIND, "after": page.next.unwrap_or_default()}),
        })?;
        Ok(())
    }

    /// Drop an upload's described spans once it is finished: they served only its session.
    fn drop_described_spans(&mut self, upload_id: &str) -> Answer<()> {
        self.drop_pages(|page| described_page_id(upload_id, page))
    }

    /// Drop every span page of a cancelled upload, the described ones and the ones its pieces wrote: nothing reads them
    /// once the upload is cancelled. A finished file keeps its span pages, since its reads go through them.
    fn drop_cancelled_spans(&mut self, upload_id: &str) -> Answer<()> {
        self.drop_described_spans(upload_id)?;
        self.drop_pages(|page| paged_spans::page_id(upload_id, page))
    }

    /// Remove the pages `id_of` names, in order, until the first one the store does not hold.
    fn drop_pages(&mut self, id_of: impl Fn(u64) -> String) -> Answer<()> {
        for page in 0.. {
            let id = id_of(page);
            let (version, record) = self.held(SPANS, &id)?;
            if record.is_none() {
                return Ok(());
            }
            self.mutate(SPANS, Mutation {
                id: id.clone(),
                expected_version: version,
                request_key: request_key(&id, "span-gone", version as u64),
                deleted: true,
                value: Value::Null,
            })?;
        }
        Ok(())
    }

    /// The upload a growing session resumes from after a restart: its name, length and cursor, and every span described
    /// so far in order (`write_described_spans`). Held chunks are not kept; the client sends them again.
    pub fn read_described_spans(&self, upload_id: &str) -> Answer<Value> {
        validate_upload_id(upload_id)?;
        let upload = self.get(UPLOADS, upload_id)?.ok_or(crate::cause!(AccountFilesError::NotFound))?;
        let mut spans = Vec::new();
        for page in 0.. {
            let Some(record) = self.get(SPANS, &described_page_id(upload_id, page))? else { break };
            let known = record.value["spans"].as_object().ok_or(AccountFilesError::Invalid("a described span page is invalid", crate::cause!()))?;
            for (ordinal, span) in known {
                spans.push(json!({"ordinal": ordinal.parse::<u64>().ok(), "offset": span["offset"], "length": span["length"], "chunk": span["chunk"]}));
            }
        }
        spans.sort_by_key(|span| span["ordinal"].as_u64());
        Ok(json!({
            "name": upload.value["name"], "byte_length": upload.value["byte_length"],
            "next_offset": upload.value["next_offset"], "spans": spans,
        }))
    }

    /// Compute and verify the complete BLAKE3 identity before creating a file
    /// record or binding the target name.
    pub fn write_file_finish(&mut self, upload_id: &str, name: &str) -> Answer<Value> {
        self.write_file_finish_expecting(upload_id, name, None)
    }

    /// The same finish. When `expected` is given, the bytes' identity must be it: checked right after it is computed, so a
    /// mismatch keeps nothing and leaves the upload open.
    pub fn write_file_finish_expecting(&mut self, upload_id: &str, name: &str, expected: Option<&str>) -> Answer<Value> {
        validate_upload_id(upload_id)?;
        validate_name(name)?;
        self.check_current()?;
        let upload = self
            .get(UPLOADS, upload_id)?
            .ok_or(crate::cause!(AccountFilesError::NotFound))?;
        if text(&upload.value, "name") != Some(name) {
            return Err(AccountFilesError::Invalid(
                "upload belongs to a different name",
             crate::cause!()));
        }
        if text(&upload.value, "status") == Some("finished") {
            return self.with_name_row(
                name,
                json!({"upload_id":upload_id,"state":"finished","identity":upload.value["identity"],"name":name,"byte_length":upload.value["byte_length"]}),
            );
        }
        if text(&upload.value, "status") != Some("open") {
            return Err(AccountFilesError::Invalid("upload is not open", crate::cause!()));
        }
        let layout = text(&upload.value, "span_layout").unwrap_or(paged_spans::LAYOUT).to_owned();
        let append_layout = layout == paged_spans::APPEND_LAYOUT;
        let (byte_length, identity, span_count) = if append_layout {
            let next = upload
                .value
                .get("next_offset")
                .and_then(Value::as_u64)
                .ok_or(AccountFilesError::Invalid("upload offset is invalid", crate::cause!()))?;
            let count = upload
                .value
                .get("span_count")
                .and_then(Value::as_u64)
                .ok_or(AccountFilesError::Invalid("upload span count is invalid", crate::cause!()))?;
            let (byte_length, identity) = self.verify_and_hash_append_upload(upload_id, count, next)?;
            (byte_length, identity, count)
        } else {
            let accumulator = Accumulator::resume(checkpoint(&upload.value)?)
                .map_err(|_| AccountFilesError::Invalid("upload checkpoint is invalid", crate::cause!()))?;
            let byte_length = upload.value["byte_length"]
                .as_u64()
                .ok_or(AccountFilesError::Invalid("upload length is invalid", crate::cause!()))?;
            let next = upload.value["next_offset"]
                .as_u64()
                .ok_or(AccountFilesError::Invalid("upload offset is invalid", crate::cause!()))?;
            if next != byte_length {
                return Err(AccountFilesError::Invalid(
                    "upload does not contain its declared length",
                 crate::cause!()));
            }
            let digest = accumulator
                .finalize()
                .map_err(|_| AccountFilesError::Invalid("upload checkpoint is incomplete", crate::cause!()))?;
            let identity = Multihash::from_digest(Multihash::BLAKE3_CODE, digest.to_vec())
                .map_err(|_| AccountFilesError::Invalid("upload identity could not be formed", crate::cause!()))?
                .to_code_hex();
            let (expected_count, parse): (u64, ParsePage) = match layout.as_str() {
                paged_spans::CHUNKS_LAYOUT => (upload.value["span_count"].as_u64().unwrap_or(0), paged_spans::parse_variable_page),
                paged_spans::LAYOUT => (byte_length.div_ceil(SUBTREE_BYTES as u64), paged_spans::parse_page),
                _ => return Err(AccountFilesError::Invalid("upload span layout is unknown", crate::cause!())),
            };
            self.verify_span_pages(upload_id, expected_count, byte_length, parse)?;
            (byte_length, identity, expected_count)
        };
        if expected.is_some_and(|asked| asked != identity) {
            return Err(AccountFilesError::IdentityMismatch(identity.clone(), byte_length, crate::cause!()));
        }
        self.ensure_name_version_for_identity(&upload.value, name, &identity)?;

        let now = now_iso();
        let existing_file = self.get(FILES, &identity)?;
        if let Some(file) = &existing_file {
            if file.value.get("byte_length").and_then(Value::as_u64) != Some(byte_length) {
                return Err(AccountFilesError::Invalid(
                    "file identity conflicts with its stored length",
                 crate::cause!()));
            }
        } else if byte_length == 0 {
            self.ensure_name_version_for_identity(&upload.value, name, &identity)?;
            let origins = self.origins()?;
            let (origin, key) = self.keep_empty_file(
                &identity,
                text(&upload.value, "media_type").unwrap_or("application/octet-stream"),
                &origins,
            )?;
            let (version, record) = self.held(FILES, &identity)?;
            if record.is_some() {
                return Err(AccountFilesError::Invalid(
                    "file identity changed during upload",
                 crate::cause!()));
            }
            self.mutate(FILES, Mutation {
                id: identity.clone(), expected_version: version, request_key: request_key(upload_id, "file", 0), deleted: false,
                value: json!({"kind":FILE_KIND,"byte_length":0,"media_type":upload.value["media_type"],"origin":origin,"key":key,
                    "stored_at":now,"checked_at":now,"spans":0,"aliases":[],"names":[]}),
            })?;
        } else {
            self.ensure_name_version_for_identity(&upload.value, name, &identity)?;
            let origin = text(&upload.value, "origin").ok_or(AccountFilesError::Invalid(
                "upload has no stored chunk origin",
             crate::cause!()))?;
            let (version, record) = self.held(FILES, &identity)?;
            if record.is_some() {
                return Err(AccountFilesError::Invalid(
                    "file identity changed during upload",
                 crate::cause!()));
            }
            self.mutate(FILES, Mutation {
                id: identity.clone(), expected_version: version, request_key: request_key(upload_id, "file", 0), deleted: false,
                value: json!({"kind":FILE_KIND,"byte_length":byte_length,"media_type":upload.value["media_type"],"origin":origin,"key":"",
                    "stored_at":now,"checked_at":now,"spans":span_count,"span_layout":layout,"span_set":upload_id,
                    "aliases":[],"names":[]}),
            })?;
        }

        self.place_upload_name(upload_id, name, &identity, byte_length)?;
        let current_file = self
            .get(FILES, &identity)?
            .ok_or(AccountFilesError::Invalid(
                "file identity changed during upload",
             crate::cause!()))?;
        self.ensure_file_lists_name(&current_file.id, &current_file, name)?;
        let current_upload = self
            .get(UPLOADS, upload_id)?
            .ok_or(crate::cause!(AccountFilesError::NotFound))?;
        let mut finished = current_upload.value.clone();
        finished["kind"] = json!("namespace-upload-finished");
        finished["status"] = json!("finished");
        finished["identity"] = json!(identity);
        finished["byte_length"] = json!(byte_length);
        finished["length_known"] = json!(true);
        self.mutate(
            UPLOADS,
            Mutation {
                id: upload_id.to_owned(),
                expected_version: current_upload.version,
                request_key: request_key(upload_id, "finish", 0),
                deleted: false,
                value: finished,
            },
        )?;
        self.drop_described_spans(upload_id)?;
        self.with_name_row(name, json!({"upload_id":upload_id,"state":"finished","identity":identity,"name":name,"byte_length":byte_length}))
    }

    /// Retire an open upload without deleting any bytes. A cancelled token
    /// cannot be reused; accepted chunks remain content-addressed and can be
    /// reused only after another request supplies the matching actual bytes.
    pub fn write_file_cancel(&mut self, upload_id: &str, name: &str) -> Answer<Value> {
        validate_upload_id(upload_id)?;
        validate_name(name)?;
        self.check_current()?;
        let upload = self
            .get(UPLOADS, upload_id)?
            .ok_or(crate::cause!(AccountFilesError::NotFound))?;
        if text(&upload.value, "name") != Some(name) {
            return Err(AccountFilesError::Invalid(
                "open upload for this name was not found",
             crate::cause!()));
        }
        if text(&upload.value, "status") == Some("cancelled") {
            return Ok(
                json!({"upload_id":upload_id,"state":"cancelled","bytes_retained":true,"byte_length":upload.value["byte_length"]}),
            );
        }
        if text(&upload.value, "status") != Some("open") {
            return Err(AccountFilesError::Invalid("upload is not open", crate::cause!()));
        }
        let mut cancelled = upload.value.clone();
        cancelled["kind"] = json!("namespace-upload-cancelled");
        cancelled["status"] = json!("cancelled");
        self.mutate(
            UPLOADS,
            Mutation {
                id: upload_id.to_owned(),
                expected_version: upload.version,
                request_key: request_key(upload_id, "cancel", 0),
                deleted: false,
                value: cancelled,
            },
        )?;
        self.drop_cancelled_spans(upload_id)?;
        Ok(
            json!({"upload_id":upload_id,"state":"cancelled","bytes_retained":true,"byte_length":upload.value["byte_length"]}),
        )
    }

    fn replay_piece(
        &self,
        upload_id: &str,
        offset: u64,
        bytes: &[u8],
        identity: &str,
        next: u64,
        total: u64,
    ) -> Answer<Value> {
        if offset % SUBTREE_BYTES as u64 != 0
            || offset
                .checked_add(bytes.len() as u64)
                .is_none_or(|end| end > total)
        {
            return Err(AccountFilesError::Invalid(
                "replayed file piece range is invalid",
             crate::cause!()));
        }
        let ordinal = offset / SUBTREE_BYTES as u64;
        let page = paged_spans::page_number(ordinal);
        let record = self
            .get(SPANS, &paged_spans::page_id(upload_id, page))?
            .ok_or(crate::cause!(AccountFilesError::NotFound))?;
        let spans = paged_spans::parse_page(&record.value, upload_id, page)
            .map_err(|error| AccountFilesError::Invalid("replayed file span page is invalid", error.cause()))?;
        let prior = spans
            .get((ordinal % paged_spans::SPANS_PER_PAGE) as usize)
            .ok_or(crate::cause!(AccountFilesError::NotFound))?;
        if prior.offset != offset || prior.length != bytes.len() as u64 || prior.chunk != identity {
            return Err(AccountFilesError::Invalid(
                "replayed file piece differs from accepted bytes",
             crate::cause!()));
        }
        Ok(
            json!({"upload_id":upload_id,"next_offset":next,"accepted_bytes":bytes.len(),"already_received":true}),
        )
    }

    fn replay_variable_piece(
        &self,
        upload_id: &str,
        offset: u64,
        bytes: &[u8],
        identity: &str,
        next: u64,
        count: u64,
    ) -> Answer<Value> {
        if count == 0
            || offset
                .checked_add(bytes.len() as u64)
                .is_none_or(|end| end > next)
        {
            return Err(AccountFilesError::Invalid(
                "replayed file piece range is invalid",
             crate::cause!()));
        }
        let pages = count.div_ceil(paged_spans::SPANS_PER_PAGE);
        let mut low = 0u64;
        let mut high = pages;
        while low < high {
            let middle = low + (high - low) / 2;
            let id = paged_spans::page_id(upload_id, middle);
            let record = self.get(SPANS, &id)?.ok_or(crate::cause!(AccountFilesError::NotFound))?;
            let spans = paged_spans::parse_variable_page(&record.value, upload_id, middle)
                .map_err(|error| AccountFilesError::Invalid("replayed file span page is invalid", error.cause()))?;
            let expected = (count - middle * paged_spans::SPANS_PER_PAGE)
                .min(paged_spans::SPANS_PER_PAGE) as usize;
            if spans.len() != expected {
                return Err(AccountFilesError::Invalid(
                    "replayed file span page is incomplete",
                 crate::cause!()));
            }
            let start = record.value["start_offset"]
                .as_u64()
                .ok_or(AccountFilesError::Invalid(
                    "replayed file span page is invalid",
                 crate::cause!()))?;
            let end = record.value["end_offset"]
                .as_u64()
                .ok_or(AccountFilesError::Invalid(
                    "replayed file span page is invalid",
                 crate::cause!()))?;
            if middle == 0 && start != 0 || middle + 1 == pages && end != next {
                return Err(AccountFilesError::Invalid(
                    "replayed file span pages do not cover accepted bytes",
                 crate::cause!()));
            }
            if offset < end {
                high = middle;
            } else {
                low = middle + 1;
            }
        }
        if low >= pages {
            return Err(AccountFilesError::Invalid(
                "replayed file piece was not accepted",
             crate::cause!()));
        }
        let id = paged_spans::page_id(upload_id, low);
        let record = self.get(SPANS, &id)?.ok_or(crate::cause!(AccountFilesError::NotFound))?;
        let spans = paged_spans::parse_variable_page(&record.value, upload_id, low)
            .map_err(|error| AccountFilesError::Invalid("replayed file span page is invalid", error.cause()))?;
        let expected =
            (count - low * paged_spans::SPANS_PER_PAGE).min(paged_spans::SPANS_PER_PAGE) as usize;
        if spans.len() != expected {
            return Err(AccountFilesError::Invalid(
                "replayed file span page is incomplete",
             crate::cause!()));
        }
        if low > 0 {
            let prior_id = paged_spans::page_id(upload_id, low - 1);
            let prior = self
                .get(SPANS, &prior_id)?
                .ok_or(crate::cause!(AccountFilesError::NotFound))?;
            paged_spans::parse_variable_page(&prior.value, upload_id, low - 1)
                .map_err(|error| AccountFilesError::Invalid("replayed file span page is invalid", error.cause()))?;
            if prior.value.get("end_offset").and_then(Value::as_u64)
                != record.value.get("start_offset").and_then(Value::as_u64)
            {
                return Err(AccountFilesError::Invalid(
                    "replayed file span pages do not join",
                 crate::cause!()));
            }
        }
        if low + 1 < pages {
            let next_id = paged_spans::page_id(upload_id, low + 1);
            let next_page = self
                .get(SPANS, &next_id)?
                .ok_or(crate::cause!(AccountFilesError::NotFound))?;
            paged_spans::parse_variable_page(&next_page.value, upload_id, low + 1)
                .map_err(|error| AccountFilesError::Invalid("replayed file span page is invalid", error.cause()))?;
            if record.value.get("end_offset").and_then(Value::as_u64)
                != next_page.value.get("start_offset").and_then(Value::as_u64)
            {
                return Err(AccountFilesError::Invalid(
                    "replayed file span pages do not join",
                 crate::cause!()));
            }
        }
        let span =
            spans
                .iter()
                .find(|span| span.offset == offset)
                .ok_or(AccountFilesError::Invalid(
                    "replayed file piece was not accepted",
                 crate::cause!()))?;
        if span.offset != offset || span.length != bytes.len() as u64 || span.chunk != identity {
            return Err(AccountFilesError::Invalid(
                "replayed file piece differs from accepted bytes",
             crate::cause!()));
        }
        Ok(
            json!({"upload_id":upload_id,"next_offset":next,"accepted_bytes":bytes.len(),"already_received":true}),
        )
    }

    pub(super) fn ensure_name_version(&self, upload: &Value, name: &str) -> Answer<()> {
        self.ensure_name_version_for_identity(upload, name, "")
    }

    fn ensure_name_version_for_identity(
        &self,
        upload: &Value,
        name: &str,
        identity: &str,
    ) -> Answer<()> {
        let expected = upload
            .get("name_version")
            .and_then(Value::as_i64)
            .ok_or(AccountFilesError::Invalid("upload name version is invalid", crate::cause!()))?;
        let (current, record) = self.held(&names_scope(parent(name)), name)?;
        if current != expected {
            if !identity.is_empty()
                && record
                    .as_ref()
                    .and_then(|record| text(&record.value, "file"))
                    == Some(identity)
            {
                return Ok(());
            }
            return Err(AccountFilesError::Invalid(
                "target name changed while the upload was in progress",
             crate::cause!()));
        }
        Ok(())
    }

    fn keep_chunk(
        &mut self,
        upload_id: &str,
        ordinal: u64,
        identity: &str,
        bytes: &[u8],
        origins: &[(String, Origin)],
    ) -> Answer<String> {
        let mut ranked: Vec<&(String, Origin)> = origins
            .iter()
            .filter(|(_, origin)| origin.takes_new_bytes)
            .collect();
        ranked.sort_by_key(|(_, origin)| origin.rank);
        if let Some(file) = self.get(FILES, identity)? {
            if file.value.get("byte_length").and_then(Value::as_u64) != Some(bytes.len() as u64) {
                return Err(AccountFilesError::Invalid(
                    "file identity conflicts with its stored length",
                 crate::cause!()));
            }
            // A piece can have the same identity as an already stored whole
            // file. Reuse its exact object key so a chunk PUT cannot replace
            // that object's media-type metadata with octet-stream.
            if file.value.get("spans").and_then(Value::as_u64).unwrap_or(0) == 0 {
                let origin = text(&file.value, "origin")
                    .ok_or(AccountFilesError::Invalid("stored file has no origin", crate::cause!()))?
                    .to_owned();
                let key = text(&file.value, "key")
                    .filter(|key| !key.is_empty())
                    .ok_or(AccountFilesError::Invalid("stored file has no object key", crate::cause!()))?
                    .to_owned();
                let (version, existing) = self.held(CHUNKS, identity)?;
                if let Some(record) = existing {
                    if record.value.get("byte_length").and_then(Value::as_u64)
                        != Some(bytes.len() as u64)
                    {
                        return Err(AccountFilesError::Invalid(
                            "stored chunk metadata conflicts with its identity",
                         crate::cause!()));
                    }
                    self.share_chunk(&record, upload_id, ordinal)?;
                    return Ok(text(&record.value, "origin").unwrap_or(&origin).to_owned());
                }
                // The object is the whole file's too, so the chunk is shared from the start (release.rs invariant 3).
                self.mutate(CHUNKS, Mutation {
                    id: identity.to_owned(), expected_version: version,
                    request_key: request_key(upload_id, "chunk", ordinal), deleted: false,
                    value: json!({"kind":CHUNK_KIND,"byte_length":bytes.len(),"origin":origin,"key":key,"stored_at":now_iso(),
                        "used_by":upload_id,"shared":true}),
                })?;
                return Ok(origin);
            }
        }
        let mut refused = None;
        for (id, origin) in ranked {
            if let Some(home) = &self.home {
                if !origin.is_loopback() && origin.bound_to.as_deref() != Some(home.as_str()) {
                    refused = Some(ObjectError::NotBound(id.clone(), crate::cause!()));
                    continue;
                }
            }
            let key = chunk_key(origin, identity).ok_or(AccountFilesError::Invalid(
                "store does not declare a chunk key prefix",
             crate::cause!()))?;
            self.check_current()?;
            let started = self.now_ms();
            match self
                .objects
                .write(id, &key, bytes, "application/octet-stream")
            {
                Ok(()) => {
                    self.check_current()?;
                    let (version, existing) = self.held(CHUNKS, identity)?;
                    if let Some(record) = existing {
                        if record.value.get("byte_length").and_then(Value::as_u64)
                            == Some(bytes.len() as u64)
                        {
                            self.share_chunk(&record, upload_id, ordinal)?;
                            return Ok(text(&record.value, "origin").unwrap_or(id).to_owned());
                        }
                        return Err(AccountFilesError::Invalid(
                            "chunk identity conflicts with its stored length",
                         crate::cause!()));
                    }
                    // Bytes that raced a release of the same object are sent again (release.rs `may_record`).
                    self.record_or_again(id, &key, started)?;
                    // The one upload that first kept this chunk (release.rs invariant 3).
                    self.mutate(CHUNKS, Mutation {
                        id: identity.to_owned(), expected_version: version,
                        request_key: request_key(upload_id, "chunk", ordinal), deleted: false,
                        value: json!({"kind":CHUNK_KIND,"byte_length":bytes.len(),"origin":id,"key":key,"stored_at":now_iso(),"used_by":upload_id}),
                    })?;
                    return Ok(id.clone());
                }
                Err(error) => refused = Some(error),
            }
        }
        Err(refused.map_or(
            AccountFilesError::Invalid("the account has no store that takes new bytes", crate::cause!()),
            |value| AccountFilesError::Objects(value, crate::cause!()),
        ))
    }

    /// A chunk kept by one upload and now used by another is `shared` (release.rs invariant 3): its bytes then stay
    /// when either file goes. A chunk with no first user (migrated) stays as it is: it is never released.
    fn share_chunk(
        &mut self,
        chunk: &crate::store::Record,
        upload_id: &str,
        ordinal: u64,
    ) -> Answer<()> {
        let first = text(&chunk.value, "used_by");
        if first.is_none()
            || first == Some(upload_id)
            || chunk.value.get("shared").and_then(Value::as_bool) == Some(true)
        {
            return Ok(());
        }
        let mut value = chunk.value.clone();
        value["shared"] = json!(true);
        self.mutate(
            CHUNKS,
            Mutation {
                id: chunk.id.clone(),
                expected_version: chunk.version,
                request_key: request_key(upload_id, "shared", ordinal),
                deleted: false,
                value,
            },
        )?;
        Ok(())
    }

    fn keep_empty_file(
        &mut self,
        identity: &str,
        media_type: &str,
        origins: &[(String, Origin)],
    ) -> Answer<(String, String)> {
        let mut ranked: Vec<&(String, Origin)> = origins
            .iter()
            .filter(|(_, origin)| origin.takes_new_bytes)
            .collect();
        ranked.sort_by_key(|(_, origin)| origin.rank);
        let mut refused = None;
        for (id, origin) in ranked {
            if let Some(home) = &self.home {
                if !origin.is_loopback() && origin.bound_to.as_deref() != Some(home.as_str()) {
                    refused = Some(ObjectError::NotBound(id.clone(), crate::cause!()));
                    continue;
                }
            }
            let key = format!("{}{identity}", origin.file_key_prefix);
            self.check_current()?;
            let started = self.now_ms();
            match self.objects.write(id, &key, b"", media_type) {
                Ok(()) => {
                    self.check_current()?;
                    self.record_or_again(id, &key, started)?;
                    return Ok((id.clone(), key));
                }
                Err(error) => refused = Some(error),
            }
        }
        Err(refused.map_or(
            AccountFilesError::Invalid("the account has no store that takes new bytes", crate::cause!()),
            |value| AccountFilesError::Objects(value, crate::cause!()),
        ))
    }

    fn verify_and_hash_append_upload(
        &self,
        upload_id: &str,
        span_count: u64,
        byte_length: u64,
    ) -> Answer<(u64, String)> {
        let pages = span_count.div_ceil(paged_spans::SPANS_PER_PAGE);
        if span_count == 0 && byte_length != 0 {
            return Err(AccountFilesError::Invalid(
                "an empty upload has a nonzero byte count",
             crate::cause!()));
        }
        let mut expected_ordinal = 0u64;
        let mut expected_offset = 0u64;
        let mut admitted_spans = content_crypto::StreamingHasher::new();
        let mut page_number = 0u64;
        while page_number < pages {
            self.check_current()?;
            let end = (page_number + VERIFY_PAGES_AT_ONCE as u64).min(pages);
            let ids: Vec<String> = (page_number..end)
                .map(|page| paged_spans::page_id(upload_id, page))
                .collect();
            let page_records = self.store.get_many(
                SPANS,
                &ids.iter().map(String::as_str).collect::<Vec<_>>(),
            )?;
            for (page, record) in (page_number..end).zip(page_records) {
                let record = record.ok_or(AccountFilesError::Invalid(
                    "an uploaded span page is missing",
                 crate::cause!()))?;
                let spans = paged_spans::parse_variable_page(&record.value, upload_id, page)
                    .map_err(|error| AccountFilesError::Invalid("an uploaded span page is invalid", error.cause()))?;
                let expected_page_spans = (span_count - page * paged_spans::SPANS_PER_PAGE)
                    .min(paged_spans::SPANS_PER_PAGE)
                    as usize;
                if spans.len() != expected_page_spans
                    || record.value.get("start_offset").and_then(Value::as_u64)
                        != Some(expected_offset)
                {
                    return Err(AccountFilesError::Invalid(
                        "uploaded span pages do not cover the file",
                     crate::cause!()));
                }
                let ids: Vec<&str> = spans.iter().map(|span| span.chunk.as_str()).collect();
                let chunks = self.store.get_many(CHUNKS, &ids)?;
                for (span, chunk) in spans.iter().zip(chunks) {
                    let chunk = chunk.ok_or(AccountFilesError::Invalid(
                        "an uploaded chunk record is missing",
                     crate::cause!()))?;
                    if span.ordinal != expected_ordinal
                        || span.offset != expected_offset
                        || chunk.value.get("byte_length").and_then(Value::as_u64)
                            != Some(span.length)
                    {
                        return Err(AccountFilesError::Invalid(
                            "uploaded spans do not exactly cover the file",
                         crate::cause!()));
                    }
                    expected_ordinal = expected_ordinal
                        .checked_add(1)
                        .ok_or(AccountFilesError::Invalid("uploaded span count overflows", crate::cause!()))?;
                    expected_offset = expected_offset
                        .checked_add(span.length)
                        .ok_or(AccountFilesError::Invalid("uploaded byte count overflows", crate::cause!()))?;
                    hash_append_span(&mut admitted_spans, span);
                }
                if record.value.get("end_offset").and_then(Value::as_u64) != Some(expected_offset) {
                    return Err(AccountFilesError::Invalid(
                        "uploaded span page end is invalid",
                     crate::cause!()));
                }
            }
            page_number = end;
        }
        if expected_ordinal != span_count || expected_offset != byte_length {
            return Err(AccountFilesError::Invalid(
                "uploaded spans do not match the accepted bytes",
             crate::cause!()));
        }
        let mut digest = content_crypto::StreamingHasher::new();
        let mut verified_spans = content_crypto::StreamingHasher::new();
        let mut actual_span_count = 0u64;
        let mut actual_byte_length = 0u64;
        page_number = 0;
        while page_number < pages {
            self.check_current()?;
            let end = (page_number + VERIFY_PAGES_AT_ONCE as u64).min(pages);
            let ids: Vec<String> = (page_number..end)
                .map(|page| paged_spans::page_id(upload_id, page))
                .collect();
            let page_records = self.store.get_many(
                SPANS,
                &ids.iter().map(String::as_str).collect::<Vec<_>>(),
            )?;
            for (page, record) in (page_number..end).zip(page_records) {
                let record = record.ok_or(AccountFilesError::Invalid(
                    "an uploaded span page is missing",
                 crate::cause!()))?;
                let spans = paged_spans::parse_variable_page(&record.value, upload_id, page)
                    .map_err(|error| AccountFilesError::Invalid("an uploaded span page is invalid", error.cause()))?;
                let expected_page_spans = (span_count - page * paged_spans::SPANS_PER_PAGE)
                    .min(paged_spans::SPANS_PER_PAGE) as usize;
                if spans.len() != expected_page_spans
                    || record.value.get("start_offset").and_then(Value::as_u64)
                        != Some(actual_byte_length)
                {
                    return Err(AccountFilesError::Invalid(
                        "uploaded spans changed during final byte verification",
                     crate::cause!()));
                }
                let ids: Vec<&str> = spans.iter().map(|span| span.chunk.as_str()).collect();
                let chunks = self.store.get_many(CHUNKS, &ids)?;
                for (span, chunk) in spans.iter().zip(chunks) {
                    if span.ordinal != actual_span_count || span.offset != actual_byte_length {
                        return Err(AccountFilesError::Invalid(
                            "uploaded spans changed during final byte verification",
                         crate::cause!()));
                    }
                    let chunk = chunk.ok_or(AccountFilesError::Invalid(
                        "an uploaded chunk record is missing",
                     crate::cause!()))?;
                    let size = chunk
                        .value
                        .get("byte_length")
                        .and_then(Value::as_u64)
                        .filter(|size| *size == span.length)
                        .ok_or(AccountFilesError::Invalid(
                            "uploaded chunk length does not match its span",
                         crate::cause!()))?;
                    let origin = text(&chunk.value, "origin")
                        .ok_or(AccountFilesError::Invalid("uploaded chunk has no origin", crate::cause!()))?;
                    let key = text(&chunk.value, "key")
                        .ok_or(AccountFilesError::Invalid("uploaded chunk has no key", crate::cause!()))?;
                    self.check_current()?;
                    let bytes = self.objects.read(origin, key, 0, size)?;
                    self.check_current()?;
                    if bytes.len() as u64 != size
                        || Multihash::blake3(&bytes).to_code_hex() != span.chunk
                    {
                        return Err(AccountFilesError::Invalid(
                            "stored chunk bytes do not match their identity",
                         crate::cause!()));
                    }
                    digest.update(&bytes);
                    hash_append_span(&mut verified_spans, &span);
                    actual_span_count = actual_span_count.checked_add(1).ok_or(
                        AccountFilesError::Invalid("uploaded span count overflows", crate::cause!()),
                    )?;
                    actual_byte_length = actual_byte_length.checked_add(bytes.len() as u64).ok_or(
                        AccountFilesError::Invalid("uploaded byte count overflows", crate::cause!()),
                    )?;
                }
                if record.value.get("end_offset").and_then(Value::as_u64)
                    != Some(actual_byte_length)
                {
                    return Err(AccountFilesError::Invalid(
                        "uploaded span page end changed during final byte verification",
                     crate::cause!()));
                }
            }
            page_number = end;
        }
        if actual_span_count != span_count
            || actual_byte_length != byte_length
            || admitted_spans.finalize_multihash() != verified_spans.finalize_multihash()
        {
            return Err(AccountFilesError::Invalid(
                "verified stored bytes do not match the accepted upload",
             crate::cause!()));
        }
        Ok((actual_byte_length, digest.finalize_multihash().to_code_hex()))
    }

    fn verify_span_pages(&self, upload_id: &str, expected_count: u64, byte_length: u64, parse: ParsePage) -> Answer<()> {
        let pages = expected_count.div_ceil(paged_spans::SPANS_PER_PAGE);
        let mut total = 0u64;
        let mut ordinal = 0u64;
        let mut offset = 0u64;
        let mut page_number = 0u64;
        while page_number < pages {
            let end = (page_number + VERIFY_PAGES_AT_ONCE as u64).min(pages);
            let ids: Vec<String> = (page_number..end)
                .map(|page| paged_spans::page_id(upload_id, page))
                .collect();
            let page_records = self.store.get_many(
                SPANS,
                &ids.iter().map(String::as_str).collect::<Vec<_>>(),
            )?;
            for (page, record) in (page_number..end).zip(page_records) {
                let record = record.ok_or(AccountFilesError::Invalid(
                    "an uploaded span page is missing",
                 crate::cause!()))?;
                let spans = parse(&record.value, upload_id, page)
                    .map_err(|error| AccountFilesError::Invalid("an uploaded span page is invalid", error.cause()))?;
                let chunk_ids: Vec<&str> = spans.iter().map(|span| span.chunk.as_str()).collect();
                let chunks = self.store.get_many(CHUNKS, &chunk_ids)?;
                for (span, chunk) in spans.into_iter().zip(chunks) {
                    let chunk = chunk.ok_or(AccountFilesError::Invalid(
                        "an uploaded chunk record is missing",
                     crate::cause!()))?;
                    if span.ordinal != ordinal
                        || span.offset != offset
                        || chunk.value.get("byte_length").and_then(Value::as_u64)
                            != Some(span.length)
                    {
                        return Err(AccountFilesError::Invalid(
                            "uploaded span metadata does not cover the file",
                         crate::cause!()));
                    }
                    ordinal += 1;
                    offset = offset
                        .checked_add(span.length)
                        .ok_or(AccountFilesError::Invalid("uploaded span length overflows", crate::cause!()))?;
                    total = total
                        .checked_add(span.length)
                        .ok_or(AccountFilesError::Invalid("uploaded byte count overflows", crate::cause!()))?;
                }
            }
            page_number = end;
        }
        if ordinal != expected_count || total != byte_length || offset != byte_length {
            return Err(AccountFilesError::Invalid(
                "uploaded spans do not match the declared length",
             crate::cause!()));
        }
        Ok(())
    }

    fn place_upload_name(
        &mut self,
        upload_id: &str,
        name: &str,
        identity: &str,
        byte_length: u64,
    ) -> Answer<()> {
        let upload = self
            .get(UPLOADS, upload_id)?
            .ok_or(crate::cause!(AccountFilesError::NotFound))?;
        let (name_version, held_name) = self.held(&names_scope(parent(name)), name)?;
        let expected = upload
            .value
            .get("name_version")
            .and_then(Value::as_i64)
            .ok_or(AccountFilesError::Invalid("upload name version is invalid", crate::cause!()))?;
        if held_name
            .as_ref()
            .and_then(|record| text(&record.value, "file"))
            == Some(identity)
        {
            // A crash may have landed the name before removing it from the
            // prior file's metadata. The upload captured that prior identity
            // before any writes, so replay can finish the cleanup safely.
            self.ensure_name_version_for_identity(&upload.value, name, identity)?;
            if let Some(previous) = text(&upload.value, "prior_file")
                .filter(|file| !file.is_empty() && *file != identity)
            {
                self.remove_name_from_file(upload_id, previous, name)?;
            }
            return Ok(());
        }
        if name_version != expected {
            return Err(AccountFilesError::Invalid(
                "target name changed while the upload was in progress",
             crate::cause!()));
        }
        let previous = held_name
            .as_ref()
            .and_then(|record| text(&record.value, "file"))
            .filter(|file| *file != identity)
            .map(str::to_owned);
        self.ensure_upload_folders(&upload.value, name, identity, upload_id)?;
        self.ensure_name_version_for_identity(&upload.value, name, identity)?;
        self.mutate(&names_scope(parent(name)), Mutation {
            id: name.to_owned(), expected_version: name_version,
            request_key: request_key(upload_id, "name", 0), deleted: false,
            value: json!({"kind":"namespace-name","name":name,"identity":identity,"file":identity,
                "byte_length":byte_length,"modified_at_ms":null,"named_at":now_iso()}),
        })?;
        if let Some(previous) = previous {
            self.remove_name_from_file(upload_id, &previous, name)?;
        }
        Ok(())
    }

    fn remove_name_from_file(&mut self, upload_id: &str, identity: &str, name: &str) -> Answer<()> {
        if let Some(file) = self.get(FILES, identity)? {
            let Some(mut names) = file.value.get("names").and_then(Value::as_array).cloned() else {
                return Err(AccountFilesError::Invalid("file names are invalid", crate::cause!()));
            };
            if names.iter().any(|held| held.as_str() == Some(name)) {
                names.retain(|held| held.as_str() != Some(name));
                let mut value = file.value.clone();
                value["names"] = json!(names);
                self.mutate(
                    FILES,
                    Mutation {
                        id: identity.to_owned(),
                        expected_version: file.version,
                        request_key: request_key(upload_id, "left", 0),
                        deleted: false,
                        value,
                    },
                )?;
            }
        }
        Ok(())
    }

    fn ensure_upload_folders(
        &mut self,
        upload: &Value,
        name: &str,
        identity: &str,
        upload_id: &str,
    ) -> Answer<()> {
        let mut folder = parent(name).to_owned();
        while folder != "/" {
            self.ensure_name_version_for_identity(upload, name, identity)?;
            let scope = LIVE.folders(parent(&folder));
            let (version, held) = self.held(&scope, &folder)?;
            if held.is_some() {
                break;
            }
            self.mutate(
                &scope,
                Mutation {
                    id: folder.clone(),
                    expected_version: version,
                    request_key: request_key(upload_id, "folder", version as u64),
                    deleted: false,
                    value: json!({"kind":"namespace-folder","folder":folder}),
                },
            )?;
            folder = parent(&folder).to_owned();
        }
        Ok(())
    }

    fn ensure_file_lists_name(
        &mut self,
        identity: &str,
        file: &crate::store::Record,
        name: &str,
    ) -> Answer<()> {
        if file
            .value
            .get("names")
            .and_then(Value::as_array)
            .is_some_and(|names| names.iter().any(|held| held.as_str() == Some(name)))
        {
            return Ok(());
        }
        let (version, current) = self.held(FILES, identity)?;
        let mut value = current.as_ref().map(|record| record.value.clone()).ok_or(
            AccountFilesError::Invalid("file identity changed during upload", crate::cause!()),
        )?;
        if version != file.version {
            return Err(AccountFilesError::Invalid(
                "file identity changed during upload",
             crate::cause!()));
        }
        if !super::lists_name(&mut value, name)
            .map_err(|_| AccountFilesError::Invalid("file names are invalid", crate::cause!()))?
        {
            return Ok(());
        }
        self.mutate(
            FILES,
            Mutation {
                id: identity.to_owned(),
                expected_version: version,
                request_key: request_key(identity, "namespace-name", version as u64),
                deleted: false,
                value,
            },
        )?;
        Ok(())
    }
}

/// Decode the generic piece body without changing MCP's bounded message size.
pub fn decode_piece(encoded: &str) -> Answer<Vec<u8>> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| AccountFilesError::Invalid("content_base64 is not base64", crate::cause!()))?;
    piece_in_bounds(bytes.len() as u64)?;
    Ok(bytes)
}

/// A piece the engine's door was sent raw (`content_file`, the row's `session.byte_argument`): the door kept the request
/// body as a file and the engine moved it into this run's own folder `root`, naming it `{path, length}` with `path`
/// relative to `root`. The file is read whole and removed; its size must be the `length` named and inside the piece bounds.
pub fn take_piece_file(root: &std::path::Path, named: &Value) -> Answer<Vec<u8>> {
    let refused = || AccountFilesError::Invalid("content_file is {path, length}, path a file inside this run's folder", crate::cause!());
    let path = named.get("path").and_then(Value::as_str)
        .filter(|path| !path.is_empty() && std::path::Path::new(path).components().all(|part| matches!(part, std::path::Component::Normal(_))))
        .ok_or_else(refused)?;
    let length = named.get("length").and_then(Value::as_u64).ok_or_else(refused)?;
    let file = root.join(path);
    let taken = (|| {
        let size = std::fs::symlink_metadata(&file).ok().filter(std::fs::Metadata::is_file).map(|metadata| metadata.len());
        if size != Some(length) {
            return Err(refused());
        }
        piece_in_bounds(length)?;
        Ok(std::fs::read(&file).map_err(|error| ObjectError::Unavailable(error.to_string(), crate::cause!()))?)
    })();
    let _gone = std::fs::remove_file(&file);
    taken
}

/// The most a piece may be is the largest layout's span (a chunk); each layout checks its own bound when it writes.
fn piece_in_bounds(length: u64) -> Answer<()> {
    if length == 0 || length > super::settings::settings().chunks.bytes {
        return Err(AccountFilesError::Invalid(
            "file piece is outside its layout's size bounds",
         crate::cause!()));
    }
    Ok(())
}

fn checkpoint(value: &Value) -> Answer<Checkpoint> {
    serde_json::from_value(
        value
            .get("checkpoint")
            .cloned()
            .ok_or(AccountFilesError::Invalid("upload checkpoint is missing", crate::cause!()))?,
    )
    .map_err(|_| AccountFilesError::Invalid("upload checkpoint is invalid", crate::cause!()))
}

/// The record id and kind of the expiry sweep's cursor, kept in the upload records (`expire_abandoned_upload`).
const EXPIRY_CURSOR: &str = "expiry-cursor";
const EXPIRY_CURSOR_KIND: &str = "namespace-expiry-cursor";

/// The kind of a described-span page (`write_described_spans`).
const DESCRIBED_KIND: &str = "namespace-described-spans";

/// The record id of one described-span page of an upload, in the span pages' own store scope.
fn described_page_id(upload_id: &str, page: u64) -> String {
    paged_spans::page_id(&format!("{upload_id}:described"), page)
}

fn request_key(id: &str, operation: &str, ordinal: u64) -> String {
    Multihash::blake3(format!("{id}\0{operation}\0{ordinal}").as_bytes()).to_code_hex()
}

pub(super) fn validate_upload_id(id: &str) -> Answer<()> {
    if id.len() != UPLOAD_ID_BYTES
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(AccountFilesError::Invalid(
            "upload_id must be 32 hexadecimal characters",
         crate::cause!()));
    }
    Ok(())
}

pub(super) fn validate_name(name: &str) -> Answer<()> {
    if !name.starts_with('/')
        || name.ends_with('/')
        || name.len() > 2048
        || name.contains('\0')
        || name.chars().any(char::is_control)
    {
        return Err(AccountFilesError::Invalid(
            "name must be an absolute file path",
         crate::cause!()));
    }
    Ok(())
}

fn validate_media_type(media_type: &str) -> Answer<()> {
    if media_type.len() > 256 || media_type.chars().any(char::is_control) {
        return Err(AccountFilesError::Invalid("media_type is invalid", crate::cause!()));
    }
    Ok(())
}

fn chunk_key(origin: &Origin, identity: &str) -> Option<String> {
    if identity.len() != 67
        || !identity.starts_with("1f:")
        || !identity[3..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    // Chunks and whole files with the same BLAKE3 identity contain the same
    // bytes, so they use the existing declared content-addressed file prefix.
    Some(format!("{}{identity}", origin.file_key_prefix))
}

#[cfg(test)]
mod growing_tests {
    use super::*;
    use crate::{
        account_files::BASE64,
        account_files::objects::{Body, Listing, ObjectError, Objects, Stat},
        store::{Mutation, SqlStore},
    };
    use std::{
        collections::HashMap,
        io::Read as _,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    #[derive(Default)]
    struct Held {
        objects: Mutex<HashMap<String, Vec<u8>>>,
        reads: AtomicUsize,
    }
    struct Port(Arc<Held>);
    impl Objects for Port {
        fn set_control(&mut self, _: super::super::CallControl) {}
        fn read(
            &self,
            _: &str,
            key: &str,
            offset: u64,
            length: u64,
        ) -> Result<Vec<u8>, ObjectError> {
            self.0.reads.fetch_add(1, Ordering::SeqCst);
            let data = self.0.objects.lock().unwrap();
            let bytes = data.get(key).ok_or(ObjectError::Refused(404, crate::cause!()))?;
            let end = offset
                .checked_add(length)
                .filter(|end| *end <= bytes.len() as u64)
                .ok_or(ObjectError::Refused(416, crate::cause!()))?;
            Ok(bytes[offset as usize..end as usize].to_vec())
        }
        fn write(&self, _: &str, key: &str, bytes: &[u8], _: &str) -> Result<(), ObjectError> {
            self.0
                .objects
                .lock()
                .unwrap()
                .insert(key.to_owned(), bytes.to_vec());
            Ok(())
        }
        fn write_stream(
            &self,
            origin: &str,
            key: &str,
            body: Body<'_>,
            media_type: &str,
        ) -> Result<(), ObjectError> {
            let mut bytes = Vec::new();
            body.bytes
                .take(body.length)
                .read_to_end(&mut bytes)
                .map_err(|error| ObjectError::Unavailable(error.to_string(), crate::cause!()))?;
            self.write(origin, key, &bytes, media_type)
        }
        fn stat(&self, _: &str, key: &str) -> Result<Option<Stat>, ObjectError> {
            Ok(self.0.objects.lock().unwrap().get(key).map(|bytes| Stat {
                length: bytes.len() as u64,
                media_type: None,
            }))
        }
        fn list(&self, _: &str, _: &str, _: &str, _: usize) -> Result<Listing, ObjectError> {
            Ok(Listing::default())
        }
    }

    fn growing_files() -> (AccountFiles, Arc<Held>) {
        let records: crate::store::Store = Arc::new(SqlStore::memory().unwrap());
        let held = Arc::new(Held::default());
        let mut files =
            AccountFiles::with_objects(records, "account", Box::new(Port(held.clone())));
        let origin = json!({"kind":"namespace-origin","rank":1,"file_key_prefix":"p/","reach":{
            "key_id":{"value":"k"},"secret":{"value":"s"},"bucket":{"value":"b"},
            "endpoint":{"value":"http://127.0.0.1:9"},"region":{"value":"r"}}});
        files
            .mutate(
                "@namespace/origins",
                Mutation {
                    id: "local".into(),
                    expected_version: 0,
                    request_key: "test-origin".into(),
                    deleted: false,
                    value: origin,
                },
            )
            .unwrap();
        (files, held)
    }

    #[test]
    fn open_length_upload_accepts_arbitrary_fragments_reads_retries_and_finishes_by_hash() {
        let (mut files, _) = growing_files();
        let upload = "0123456789abcdef0123456789abcdef";
        let name = "/stream.txt";
        files
            .call(
                "write_file_start",
                &json!({"upload_id":upload,"name":name,"length_known":false,
            "media_type":"text/plain"}),
            )
            .unwrap()
            .unwrap();
        let first = b"hello ";
        files.write_file_piece(upload, name, 0, first).unwrap();
        let open = files
            .call(
                "read_file",
                &json!({"name_or_identity":name,"upload_id":upload,"offset":0,"length":20}),
            )
            .unwrap()
            .unwrap();
        assert_eq!(open["length_known"], false);
        assert_eq!(open["arrived_length"], first.len());
        assert_eq!(open["total_length"], Value::Null);
        assert_eq!(open["content"], "hello ");
        assert_eq!(open["retry"], true);
        assert_eq!(
            files.write_file_piece(upload, name, 0, first).unwrap()["already_received"],
            true
        );
        assert!(files.write_file_piece(upload, name, 0, b"hellx ").is_err());
        let last = b"world";
        files
            .write_file_piece(upload, name, first.len() as u64, last)
            .unwrap();
        let result = files.write_file_finish(upload, name).unwrap();
        let expected = Multihash::blake3(b"hello world").to_code_hex();
        assert_eq!(result["identity"], expected);
        let readback = files.read_file(name, 0, None).unwrap();
        assert_eq!(readback["content"], "hello world");
    }

    #[test]
    fn cancelled_upload_id_does_not_keep_provisional_read_authority() {
        let (mut files, _) = growing_files();
        let upload = "abcdef0123456789abcdef0123456789";
        let name = "/cancelled.bin";
        files
            .call(
                "write_file_start",
                &json!({"upload_id":upload,"name":name,"length_known":false}),
            )
            .unwrap()
            .unwrap();
        files.write_file_piece(upload, name, 0, b"private").unwrap();
        files.write_file_cancel(upload, name).unwrap();
        assert!(
            files
                .call(
                    "read_file",
                    &json!({"name_or_identity":name,"upload_id":upload})
                )
                .unwrap()
                .is_err()
        );
    }

    /// A cancelled growing upload drops its described span pages: they served only its session, and its bytes are what
    /// `bytes_retained` keeps (incident 23).
    fn growing_spans_outlive_cancel_body() -> std::result::Result<(), String> {
        let (mut files, _) = growing_files();
        let upload = "fedcba9876543210fedcba9876543210";
        let name = "/outlives-cancel.bin";
        files
            .call("write_file_start", &json!({"upload_id":upload,"name":name,"length_known":false}))
            .ok_or("the start call is not routed")?
            .map_err(|error| format!("start: {error:?}"))?;
        files.write_file_piece(upload, name, 0, b"described").map_err(|error| format!("piece: {error:?}"))?;
        files
            .write_described_spans(upload, name, &[json!({"ordinal":0,"offset":0,"length":9,"chunk":"c0"})])
            .map_err(|error| format!("describe: {error:?}"))?;
        let page = described_page_id(upload, 0);
        if files.get(SPANS, &page).map_err(|error| format!("reading the span page failed: {error:?}"))?.is_none() {
            return Err("the piece stored no described span page to cancel".into());
        }
        files.write_file_cancel(upload, name).map_err(|error| format!("cancel: {error:?}"))?;
        match files.get(SPANS, &page) {
            Ok(None) => Ok(()),
            Ok(Some(_)) => Err("the span page of a cancelled growing upload is still stored after cancel".into()),
            Err(error) => Err(format!("reading the span page failed: {error:?}")),
        }
    }

    #[test]
    fn growing_spans_outlive_cancel() {
        growing_spans_outlive_cancel_body().unwrap();
    }

    /// A known-length upload is cut into chunks: each chunk is one stored object, the server checkpoint finishes the
    /// file (no read-back), an identical chunk is stored once, and a range read crosses only the chunks it needs.
    #[test]
    fn known_length_chunks_are_one_object_each_finish_by_checkpoint_and_dedupe() {
        let (mut files, held) = growing_files();
        let upload = "1111111111111111aaaaaaaaaaaaaaaa";
        let name = "/chunked.bin";
        let content: Vec<u8> = (0..(5 * SUBTREE_BYTES + 5)).map(|index| (index % 251) as u8).collect();
        files
            .write_file_start_with_length(upload, name, Some(content.len() as u64), "application/octet-stream", None, None)
            .unwrap();
        let cuts = [(0, 2 * SUBTREE_BYTES), (2 * SUBTREE_BYTES, 3 * SUBTREE_BYTES), (5 * SUBTREE_BYTES, 5)];
        for (offset, length) in cuts {
            files.write_file_piece(upload, name, offset as u64, &content[offset..offset + length]).unwrap();
        }
        let finished = files.write_file_finish(upload, name).unwrap();
        let identity = Multihash::blake3(&content).to_code_hex();
        assert_eq!(finished["identity"], json!(identity));
        assert_eq!(held.objects.lock().unwrap().len(), 3);
        let file = files.get(FILES, &identity).unwrap().unwrap();
        assert_eq!(file.value["span_layout"], json!("chunks-v1"));
        assert_eq!(file.value["spans"], json!(3));
        let counted = files.file_objects(&identity).unwrap();
        assert_eq!(counted["objects"], json!(3));
        let reads = held.reads.load(Ordering::SeqCst);
        let crossing = files.read_range(&file, 2 * SUBTREE_BYTES as u64 - 4, 10).unwrap();
        assert_eq!(crossing, content[2 * SUBTREE_BYTES - 4..2 * SUBTREE_BYTES + 6]);
        assert_eq!(held.reads.load(Ordering::SeqCst) - reads, 2);
        assert_eq!(files.read_range(&file, 0, content.len() as u64).unwrap(), content);

        // The first chunk again, in another file: the chunk is already kept, so no object is added.
        let other = "2222222222222222bbbbbbbbbbbbbbbb";
        files
            .write_file_start_with_length(other, "/again.bin", Some(2 * SUBTREE_BYTES as u64), "application/octet-stream", None, None)
            .unwrap();
        let accepted = files.write_file_piece(other, "/again.bin", 0, &content[..2 * SUBTREE_BYTES]).unwrap();
        assert_eq!(accepted["length_known"], json!(true));
        files.write_file_finish(other, "/again.bin").unwrap();
        assert_eq!(held.objects.lock().unwrap().len(), 3);
    }

    /// An upload left open past its expiry (DATA `described.open_upload_expiry_days`) is cancelled by a later start, and its
    /// described spans go with it, so an abandoned upload cannot keep its spans in the store.
    #[test]
    fn an_abandoned_upload_past_its_expiry_is_cancelled_by_a_later_start() {
        let (mut files, _held) = growing_files();
        let abandoned = "5555555555555555eeeeeeeeeeeeeeee";
        let name = "/abandoned.bin";
        files.write_file_start_with_length(abandoned, name, Some(64 * 1024), "application/octet-stream", None, None).unwrap();
        let chunk = vec![3u8; 64 * 1024];
        let spans = vec![json!({"ordinal": 0, "offset": 0, "length": chunk.len(), "chunk": Multihash::blake3(&chunk).to_code_hex()})];
        files.write_described_spans(abandoned, name, &spans).unwrap();
        let mut record = files.get(UPLOADS, abandoned).unwrap().unwrap();
        record.value["started_at"] = json!("2026-11-01T00:00:00.000Z");
        files.mutate(UPLOADS, Mutation {
            id: abandoned.to_owned(), expected_version: record.version, request_key: request_key(abandoned, "aged", 0),
            deleted: false, value: record.value,
        }).unwrap();
        files.write_file_start_with_length("6666666666666666ffffffffffffffff", "/fresh.bin", Some(1), "application/octet-stream", None, None).unwrap();
        assert_eq!(files.get(UPLOADS, abandoned).unwrap().unwrap().value["status"], json!("cancelled"));
        assert_eq!(files.read_described_spans(abandoned).unwrap()["spans"], json!([]));
    }



    /// The expiry sweep keeps its place in a cursor record and wraps: a start that reaches the end of the upload records
    /// clears the cursor, so the next start looks at the first page again and finds the abandoned upload.
    #[test]
    fn the_expiry_sweep_keeps_a_cursor_and_wraps() {
        let (mut files, _held) = growing_files();
        let abandoned = "7777777777777777aaaaaaaaaaaaaaaa";
        files.write_file_start_with_length(abandoned, "/abandoned-cursor.bin", Some(64 * 1024), "application/octet-stream", None, None).unwrap();
        let mut record = files.get(UPLOADS, abandoned).unwrap().unwrap();
        record.value["started_at"] = json!("2026-11-01T00:00:00.000Z");
        files.mutate(UPLOADS, Mutation {
            id: abandoned.to_owned(), expected_version: record.version, request_key: request_key(abandoned, "aged-cursor", 0),
            deleted: false, value: record.value,
        }).unwrap();
        // The cursor is placed past every record, so this start's page is empty and it wraps the cursor.
        let (cursor_version, _) = files.held(UPLOADS, "expiry-cursor").unwrap();
        files.mutate(UPLOADS, Mutation {
            id: "expiry-cursor".to_owned(), expected_version: cursor_version, request_key: request_key("expiry-cursor", "place", 0),
            deleted: false, value: json!({"kind": "namespace-expiry-cursor", "after": "~"}),
        }).unwrap();
        files.write_file_start_with_length("8888888888888888bbbbbbbbbbbbbbbb", "/first-start.bin", Some(1), "application/octet-stream", None, None).unwrap();
        assert_eq!(files.get(UPLOADS, abandoned).unwrap().unwrap().value["status"], json!("open"), "the first start reads nothing past the cursor");
        files.write_file_start_with_length("9999999999999999cccccccccccccccc", "/second-start.bin", Some(1), "application/octet-stream", None, None).unwrap();
        assert_eq!(files.get(UPLOADS, abandoned).unwrap().unwrap().value["status"], json!("cancelled"));
    }


    /// A finish that asks for an identity the bytes do not have is refused before anything is kept: no file is stored under
    /// the bytes' identity, and the upload stays open so the right finish can still be made.
    #[test]
    fn a_finish_asking_another_identity_keeps_nothing_and_leaves_the_upload_open() {
        let (mut files, _held) = growing_files();
        let upload = "4444444444444444dddddddddddddddd";
        let name = "/asked.bin";
        let content: Vec<u8> = (0..(2 * SUBTREE_BYTES) as usize).map(|index| (index % 239) as u8).collect();
        files
            .write_file_start_with_length(upload, name, Some(content.len() as u64), "application/octet-stream", None, None)
            .unwrap();
        files.write_file_piece(upload, name, 0, &content).unwrap();
        let actual = Multihash::blake3(&content).to_code_hex();
        let other = Multihash::blake3(b"not these bytes").to_code_hex();
        let refused = files.write_file_finish_expecting(upload, name, Some(&other)).unwrap_err();
        assert!(matches!(&refused, AccountFilesError::IdentityMismatch(named, _, _) if named == &actual), "{refused:?}");
        assert!(files.get(FILES, &actual).unwrap().is_none(), "the refused finish kept a file");
        assert_eq!(files.get(UPLOADS, upload).unwrap().unwrap().value["status"], json!("open"));
        let finished = files.write_file_finish_expecting(upload, name, Some(&actual)).unwrap();
        assert_eq!(finished["identity"], json!(actual));
    }

    /// Known-length chunks may be any length up to the chunk size and are cut by content: the tail after the last whole
    /// 32 KiB subtree waits for the next piece, and the file's identity is still the BLAKE3 of its bytes. A piece past the
    /// declared length, a bad retry, and a piece larger than a chunk are refused before anything is kept.
    #[test]
    fn known_length_chunks_of_any_length_finish_to_the_blake3_of_their_bytes() {
        let (mut files, held) = growing_files();
        let upload = "3333333333333333cccccccccccccccc";
        let name = "/odd-chunks.bin";
        let content: Vec<u8> = (0..172_772usize).map(|index| (index * 31 % 253) as u8).collect();
        files
            .write_file_start_with_length(upload, name, Some(content.len() as u64), "application/octet-stream", None, None)
            .unwrap();
        let mut offset = 0usize;
        for length in [1, SUBTREE_BYTES - 1, 1, 40_000, 100_000, 3, 0] {
            if length == 0 {
                continue;
            }
            files.write_file_piece(upload, name, offset as u64, &content[offset..offset + length]).unwrap();
            offset += length;
        }
        assert_eq!(offset, content.len());
        let identity = Multihash::blake3(&content).to_code_hex();
        assert_eq!(files.write_file_finish(upload, name).unwrap()["identity"], json!(identity));
        assert_eq!(held.objects.lock().unwrap().len(), 6);
        let file = files.get(FILES, &identity).unwrap().unwrap();
        assert_eq!(files.read_range(&file, 32_000, 40_000).unwrap(), content[32_000..72_000]);
        assert_eq!(files.read_range(&file, 0, content.len() as u64).unwrap(), content);
    }

    #[test]
    fn known_length_chunk_pieces_stay_within_the_declared_length_and_a_chunk() {
        let (mut files, _) = growing_files();
        let upload = "5555555555555555eeeeeeeeeeeeeeee";
        let name = "/bounded-chunks.bin";
        files
            .write_file_start_with_length(upload, name, Some(2 * SUBTREE_BYTES as u64 + 7), "application/octet-stream", None, None)
            .unwrap();
        assert!(files.write_file_piece(upload, name, 0, &vec![1u8; 2 * SUBTREE_BYTES + 8]).is_err());
        let chunk_bytes = crate::account_files::settings::settings().chunks.bytes as usize;
        assert!(files.write_file_piece(upload, name, 0, &vec![1u8; chunk_bytes + 1]).is_err());
        let first = vec![7u8; SUBTREE_BYTES + 1];
        files.write_file_piece(upload, name, 0, &first).unwrap();
        let repeated = files.write_file_piece(upload, name, 0, &first).unwrap();
        assert_eq!(repeated["already_received"], json!(true));
        assert_eq!(repeated["length_known"], json!(true));
        assert!(files.write_file_piece(upload, name, 0, &vec![8u8; SUBTREE_BYTES + 1]).is_err());
    }

    #[test]
    fn a_piece_file_is_read_whole_and_removed_and_refused_outside_the_run_folder_or_off_its_length() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("byte-uploads")).unwrap();
        let put = |name: &str, bytes: &[u8]| std::fs::write(root.path().join(name), bytes).unwrap();
        put("byte-uploads/1", b"piece bytes");
        assert_eq!(take_piece_file(root.path(), &json!({"path": "byte-uploads/1", "length": 11})).unwrap(), b"piece bytes");
        assert!(!root.path().join("byte-uploads/1").exists());
        put("byte-uploads/2", b"piece bytes");
        assert!(take_piece_file(root.path(), &json!({"path": "byte-uploads/2", "length": 10})).is_err());
        assert!(!root.path().join("byte-uploads/2").exists());
        for path in ["../outside", "/etc/hosts", ""] {
            assert!(take_piece_file(root.path(), &json!({"path": path, "length": 1})).is_err());
        }
        put("empty", b"");
        assert!(take_piece_file(root.path(), &json!({"path": "empty", "length": 0})).is_err());
    }

    #[test]
    fn a_piece_over_one_chunk_is_refused_by_the_piece_decoder_too() {
        let chunk_bytes = crate::account_files::settings::settings().chunks.bytes as usize;
        let encoded = |length: usize| base64::engine::general_purpose::STANDARD.encode(vec![0u8; length]);
        assert!(decode_piece(&encoded(chunk_bytes)).is_ok());
        assert!(decode_piece(&encoded(chunk_bytes + 1)).is_err());
    }

    /// A fixed 32 KiB upload (opened before chunks-v1) keeps its layout: its pieces, finish and reads are unchanged.
    #[test]
    fn fixed_32k_layout_uploads_still_write_finish_and_read() {
        let (mut files, _) = growing_files();
        let upload = "4444444444444444dddddddddddddddd";
        let name = "/fixed-layout.bin";
        let content: Vec<u8> = (0..(SUBTREE_BYTES + 9)).map(|index| index as u8).collect();
        files
            .write_file_start_with_length(upload, name, Some(content.len() as u64), "application/octet-stream", None, None)
            .unwrap();
        let record = files.get(UPLOADS, upload).unwrap().unwrap();
        let mut value = record.value.clone();
        value["span_layout"] = json!(paged_spans::LAYOUT);
        files
            .mutate(UPLOADS, Mutation { id: upload.into(), expected_version: record.version, request_key: "test-fixed-layout".into(), deleted: false, value })
            .unwrap();
        files.write_file_piece(upload, name, 0, &content[..SUBTREE_BYTES]).unwrap();
        assert!(files.write_file_piece(upload, name, SUBTREE_BYTES as u64, &vec![1u8; SUBTREE_BYTES + 9]).is_err());
        files.write_file_piece(upload, name, SUBTREE_BYTES as u64, &content[SUBTREE_BYTES..]).unwrap();
        let identity = Multihash::blake3(&content).to_code_hex();
        assert_eq!(files.write_file_finish(upload, name).unwrap()["identity"], json!(identity));
        let file = files.get(FILES, &identity).unwrap().unwrap();
        assert_eq!(file.value["span_layout"], json!("pages-32k-v1"));
        assert_eq!(file.value["spans"], json!(2));
        assert_eq!(files.file_objects(&identity).unwrap()["objects"], json!(2));
        assert_eq!(files.read_range(&file, 0, content.len() as u64).unwrap(), content);
    }

    #[test]
    fn original_open_length_start_replays_after_finish_without_changing_its_binding() {
        let (mut files, _) = growing_files();
        let input = json!({"upload_id":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "name":"/start-replay.txt","length_known":false,"media_type":"text/plain","app":"test"});
        files.call("write_file_start", &input).unwrap().unwrap();
        files.write_file_piece(input["upload_id"].as_str().unwrap(), "/start-replay.txt", 0, b"kept").unwrap();
        let finished = files.write_file_finish(input["upload_id"].as_str().unwrap(), "/start-replay.txt").unwrap();
        assert_eq!(files.call("write_file_start", &input).unwrap().unwrap(), finished);
        for (field, changed) in [
            ("name", json!("/other.txt")),
            ("media_type", json!("application/octet-stream")),
            ("app", json!("other")),
            ("length_known", json!(true)),
        ] {
            let mut conflicting = input.clone();
            conflicting[field] = changed;
            if field == "length_known" {
                conflicting["byte_length"] = json!(4);
            }
            assert!(files.call("write_file_start", &conflicting).unwrap().is_err());
        }
    }

    #[test]
    fn finish_rechecks_actual_coverage_when_a_span_page_changes_between_passes() {
        reject_span_page_change_between_passes(false);
    }

    #[test]
    fn finish_rejects_same_length_valid_chunk_replacement_between_passes() {
        reject_span_page_change_between_passes(true);
    }

    fn reject_span_page_change_between_passes(replace_chunks: bool) {
        let (mut files, held) = growing_files();
        let upload = "ffffffffffffffffffffffffffffffff";
        let name = "/changed-page.bin";
        files.write_file_start_with_length(upload, name, None, "application/octet-stream", None, None).unwrap();
        files.write_file_piece(upload, name, 0, b"ab").unwrap();
        files.write_file_piece(upload, name, 2, b"cd").unwrap();
        let page_id = paged_spans::page_id(upload, 0);
        let page = files.get(SPANS, &page_id).unwrap().unwrap();
        let mut changed_page = page.value;
        if replace_chunks {
            let first = changed_page["spans"][0]["chunk"].clone();
            changed_page["spans"][0]["chunk"] = changed_page["spans"][1]["chunk"].clone();
            changed_page["spans"][1]["chunk"] = first;
        } else {
            changed_page["spans"].as_array_mut().unwrap().pop();
            changed_page["end_offset"] = json!(2);
        }
        let rival = Mutex::new(files.store.clone());
        let checks = Arc::new(AtomicUsize::new(0));
        let checked = checks.clone();
        // Change a genuine record at the second-pass boundary, after the
        // metadata pass accepted the full page and before actual byte reads.
        files = files.while_current(Arc::new(move || {
            if checked.fetch_add(1, Ordering::SeqCst) == 1 {
                rival.lock().unwrap().mutate(SPANS,
                    Mutation { id: page_id.clone(), expected_version: page.version,
                        request_key: "change-between-verification-passes".into(), deleted: false,
                        value: changed_page.clone() }).unwrap();
            }
            true
        }));
        held.reads.store(0, Ordering::SeqCst);
        assert!(files.verify_and_hash_append_upload(upload, 2, 4).is_err());
        assert_eq!(checks.load(Ordering::SeqCst), if replace_chunks { 6 } else { 2 });
        assert_eq!(held.reads.load(Ordering::SeqCst), if replace_chunks { 2 } else { 0 });
        assert!(files.get(FILES, &Multihash::blake3(b"ab").to_code_hex()).unwrap().is_none());
    }

    #[test]
    fn empty_open_length_upload_finishes_as_the_empty_file_identity() {
        let (mut files, _) = growing_files();
        let upload = "13579bdf13579bdf13579bdf13579bdf";
        let name = "/empty.bin";
        files
            .write_file_start_with_length(upload, name, None, "application/octet-stream", None, None)
            .unwrap();
        let result = files.write_file_finish(upload, name).unwrap();
        assert_eq!(result["byte_length"], 0);
        assert_eq!(result["identity"], Multihash::blake3(b"").to_code_hex());
        assert_eq!(files.read_file(name, 0, None).unwrap()["content"], "");
    }

    #[test]
    fn malformed_provisional_span_is_rejected_before_any_object_read() {
        let (mut files, held) = growing_files();
        let upload = "2468ace02468ace02468ace02468ace0";
        let name = "/malformed.bin";
        files
            .write_file_start_with_length(upload, name, None, "application/octet-stream", None, None)
            .unwrap();
        files.write_file_piece(upload, name, 0, b"stored").unwrap();
        held.reads.store(0, Ordering::SeqCst);
        let page_id = paged_spans::page_id(upload, 0);
        let page = files.get(SPANS, &page_id).unwrap().unwrap();
        let mut corrupt = page.value.clone();
        corrupt["start_offset"] = json!(1);
        files
            .mutate(
                SPANS,
                Mutation {
                    id: page_id,
                    expected_version: page.version,
                    request_key: "corrupt-page".into(),
                    deleted: false,
                    value: corrupt,
                },
            )
            .unwrap();
        assert!(
            files
                .call(
                    "read_file",
                    &json!({"name_or_identity":name,"upload_id":upload,"offset":0,"length":6})
                )
                .unwrap()
                .is_err()
        );
        assert_eq!(held.reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn retry_repairs_a_span_page_that_landed_before_the_upload_cursor() {
        let (mut files, _) = growing_files();
        let upload = "dddddddddddddddddddddddddddddddd";
        let name = "/recovered.bin";
        let bytes = b"crash-safe";
        files
            .write_file_start_with_length(upload, name, None, "application/octet-stream", None, None)
            .unwrap();
        let identity = Multihash::blake3(bytes).to_code_hex();
        let origins = files.origins().unwrap();
        files
            .keep_chunk(upload, 0, &identity, bytes, &origins)
            .unwrap();
        let span = Span {
            ordinal: 0,
            offset: 0,
            length: bytes.len() as u64,
            chunk: identity,
        };
        let empty = paged_spans::empty_variable_page(upload, 0, 0, paged_spans::APPEND_LAYOUT);
        let (page, changed) = paged_spans::append_variable(&empty, upload, 0, span).unwrap();
        assert!(changed);
        files
            .mutate(
                SPANS,
                Mutation {
                    id: paged_spans::page_id(upload, 0),
                    expected_version: 0,
                    request_key: "durable-span-before-cursor".into(),
                    deleted: false,
                    value: page,
                },
            )
            .unwrap();
        let repaired = files.write_file_piece(upload, name, 0, bytes).unwrap();
        assert_eq!(repaired["next_offset"], bytes.len());
        let upload_row = files.get(UPLOADS, upload).unwrap().unwrap();
        assert_eq!(upload_row.value["span_count"], 1);
        assert_eq!(upload_row.value["next_offset"], bytes.len());
        assert_eq!(
            files.write_file_finish(upload, name).unwrap()["identity"],
            Multihash::blake3(bytes).to_code_hex()
        );
    }

    #[test]
    fn name_replacement_revokes_open_and_finished_upload_tokens() {
        let (mut files, _) = growing_files();
        let name = "/replace.bin";
        let open_token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        files
            .write_file_start_with_length(open_token, name, None, "application/octet-stream", None, None)
            .unwrap();
        files.write_file_piece(open_token, name, 0, b"one").unwrap();
        let origins = files.origins().unwrap();
        files
            .write_file(name, b"replacement", "application/octet-stream", &origins)
            .unwrap();
        assert!(
            files
                .call(
                    "read_file",
                    &json!({"name_or_identity":name,"upload_id":open_token})
                )
                .unwrap()
                .is_err()
        );

        let finished_token = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        files
            .write_file_start_with_length(
                finished_token,
                name,
                None,
                "application/octet-stream",
                None,
                None,
            )
            .unwrap();
        files
            .write_file_piece(finished_token, name, 0, b"final")
            .unwrap();
        files.write_file_finish(finished_token, name).unwrap();
        files
            .write_file(name, b"new owner", "application/octet-stream", &origins)
            .unwrap();
        assert!(
            files
                .call(
                    "read_file",
                    &json!({"name_or_identity":name,"upload_id":finished_token})
                )
                .unwrap()
                .is_err()
        );
    }

    #[test]
    fn append_span_pages_join_across_the_256_span_boundary() {
        let (mut files, _) = growing_files();
        let upload = "cccccccccccccccccccccccccccccccc";
        let name = "/many-pieces.bin";
        let content: Vec<u8> = (0..=255)
            .chain(std::iter::once(42))
            .map(|value| value as u8)
            .collect();
        files
            .write_file_start_with_length(upload, name, None, "application/octet-stream", None, None)
            .unwrap();
        for (offset, byte) in content.iter().enumerate() {
            files
                .write_file_piece(upload, name, offset as u64, &[*byte])
                .unwrap();
        }
        let window = files
            .call(
                "read_file",
                &json!({"name_or_identity":name,"upload_id":upload,"offset":255,"length":2}),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            BASE64.decode(window["content"].as_str().unwrap()).unwrap(),
            content[255..257]
        );
        let result = files.write_file_finish(upload, name).unwrap();
        assert_eq!(
            result["identity"],
            Multihash::blake3(&content).to_code_hex()
        );
    }
}

// Every field has a fixed width (three u64s and a validated 67-byte identity),
// so this ordered digest needs neither an unbounded descriptor buffer nor
// ambiguous concatenation framing between the metadata and actual-byte passes.
/// A span page parser: the fixed 32 KiB layout or a variable-length one.
type ParsePage = fn(&Value, &str, u64) -> Result<Vec<Span>, paged_spans::Error>;

fn hash_append_span(hash: &mut content_crypto::StreamingHasher, span: &Span) {
    hash.update(&span.ordinal.to_le_bytes());
    hash.update(&span.offset.to_le_bytes());
    hash.update(&span.length.to_le_bytes());
    hash.update(span.chunk.as_bytes());
}

fn validate_app(app: Option<&str>) -> Answer<()> {
    if app.is_some_and(|app| app.is_empty() || app.len() > 256 || app.chars().any(char::is_control))
    {
        return Err(AccountFilesError::Invalid("app attribution is invalid", crate::cause!()));
    }
    Ok(())
}

pub(super) fn ensure_name_binding(upload: &Value, name: &str) -> Answer<()> {
    if text(upload, "name") != Some(name) {
        return Err(AccountFilesError::Invalid(
            "upload belongs to a different name",
         crate::cause!()));
    }
    Ok(())
}

fn ordinal_for_offset(offset: u64) -> u64 {
    offset / SUBTREE_BYTES as u64
}
