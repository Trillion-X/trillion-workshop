#!/usr/bin/env python3
"""Independently check source joins and preservation in compiled packaging output."""

import argparse
import json
from pathlib import Path
import sys

import blake3
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_packaging_ledger import project_hook_references


def fail(message):
    raise ValueError(message)


def require(condition, message):
    if not condition:
        fail(message)


def file_identity(path):
    raw = path.read_bytes()
    return {"bytes": len(raw), "blake3": blake3.blake3(raw).hexdigest()}


def resolve_path(root, value):
    path = Path(value)
    return path if path.is_absolute() else root / path


def identity_digest(identity):
    return identity.get("blake3", identity.get("value")) if isinstance(identity, dict) else None


def normalize_metadata_reference(root, provenance, row, metadata_path, metadata_identity, expected_identity, video_id):
    """Normalize canonical or fully pinned legacy metadata provenance after source readback."""
    canonical = provenance.get("metadata_source_reference")
    legacy_path_present = "source_metadata_path" in provenance
    legacy_identity_present = "metadata_file_identity" in provenance
    legacy_present = legacy_path_present or legacy_identity_present

    def check_reference(reference, label):
        require(isinstance(reference, dict), f"{video_id}: {label} metadata reference is malformed")
        path = reference.get("path")
        identity = reference.get("identity")
        require(isinstance(path, str) and path, f"{video_id}: {label} metadata path is missing")
        require(isinstance(identity, dict) and identity.get("bytes") == metadata_identity["bytes"]
                and identity_digest(identity) == metadata_identity["blake3"],
                f"{video_id}: {label} metadata identity mismatch")
        require(resolve_path(root, path).resolve() == metadata_path.resolve(),
                f"{video_id}: {label} metadata path differs from ledger locator")
        return {"path": path, "identity": identity}

    canonical_ref = None
    if canonical is not None:
        canonical_ref = check_reference(canonical, "compiled canonical")
    legacy_ref = None
    if legacy_present:
        require(legacy_path_present and legacy_identity_present,
                f"{video_id}: legacy metadata provenance requires both source_metadata_path and metadata_file_identity")
        legacy_ref = check_reference({"path": provenance.get("source_metadata_path"),
                                      "identity": provenance.get("metadata_file_identity")}, "compiled legacy")
    require(canonical_ref is not None or legacy_ref is not None,
            f"{video_id}: compiled metadata source reference missing")
    if canonical_ref and legacy_ref:
        require(canonical_ref["identity"].get("bytes") == legacy_ref["identity"].get("bytes")
                and identity_digest(canonical_ref["identity"]) == identity_digest(legacy_ref["identity"]),
                f"{video_id}: canonical and legacy metadata provenance conflict")
        basis = "metadata_source_reference+verified-legacy-aliases"
        reference = canonical_ref
    elif canonical_ref:
        basis = "metadata_source_reference"
        reference = canonical_ref
    else:
        require(expected_identity and metadata_identity["bytes"] == expected_identity.get("bytes")
                and metadata_identity["blake3"] == identity_digest(expected_identity),
                f"{video_id}: legacy metadata aliases require a verified ledger metadata identity")
        require(legacy_ref["path"] == row.get("metadata_source_path"),
                f"{video_id}: legacy metadata path differs from ledger locator")
        basis = "source_metadata_path+metadata_file_identity"
        reference = legacy_ref
    return reference, basis


def validate_legacy_hook_reference(root, row, sample):
    """Resolve grouped historical units against their declared, pinned source owner."""
    owner = (row.get("hook_analysis") or {}).get("source_provenance") or {}
    declaration = owner.get("source_file")
    declarations = ([declaration] if isinstance(declaration, dict) else
                    [item for item in owner.get("source_files", [])
                     if item.get("role") == "caption_or_transcript"])
    units = sample.get("source_units") or sample.get("verbatim_source_excerpt")
    require(isinstance(units, list) and units, "legacy hook has no retained source units")
    matches = []
    for declared in declarations:
        path = resolve_path(root, declared.get("path", ""))
        if not path.is_file():
            continue
        identity = file_identity(path)
        digest = declared.get("blake3")
        if not isinstance(digest, str):
            continue
        digest = digest.removeprefix("b3:").removeprefix("1f:")
        if digest != identity["blake3"]:
            continue
        source = json.loads(path.read_text())
        events = source.get("events", [])
        words = {word.get("id"): word for word in source.get("words", [])}
        valid = True
        for unit in units:
            index = unit.get("event_index_0based")
            uid = unit.get("id", "")
            if index is None and isinstance(uid, str) and uid.startswith("json-event-index-"):
                suffix = uid.removeprefix("json-event-index-")
                index = int(suffix) if suffix.isdigit() else None
            if isinstance(index, int) and 0 <= index < len(events):
                original = events[index]
                start, end = event_times(original)
                text = "".join(segment.get("utf8", "") for segment in original.get("segs", []))
            elif uid in words:
                original = words[uid]
                start, end = original.get("start"), original.get("end")
                text = original.get("text")
            else:
                valid = False
                break
            ustart, uend = unit.get("start_s", unit.get("start")), unit.get("end_s", unit.get("end"))
            if not all(isinstance(value, (int, float)) for value in (start, end, ustart, uend)):
                valid = False
                break
            if abs(start - ustart) > 0.001 or abs(end - uend) > 0.001:
                valid = False
                break
            exact = unit.get("source_text_exact", unit.get("text_exact"))
            if exact is not None:
                valid = isinstance(text, str) and exact == text
            else:
                displayed = unit.get("text")
                valid = (isinstance(text, str) and isinstance(displayed, str)
                         and " ".join(text.split()) == " ".join(displayed.split()))
            if not valid:
                break
        if valid:
            matches.append({"path": str(path), "identity": identity, "source_units": len(units)})
    require(len(matches) == 1, f"{row.get('video_id')}: legacy hook must resolve to one pinned source with exact unit text and clocks")
    return matches[0]


def ledger_rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def records_from_compiled(document):
    try:
        records = document["notes"]["html_json_records_source"]["raw_records"]
    except (KeyError, TypeError) as exc:
        fail(f"compiled document has no html_json_records raw source: {exc}")
    require(isinstance(records, list), "compiled raw_records must be a list")
    by_id = {}
    for record in records:
        require(isinstance(record, dict) and isinstance(record.get("id"), str), "compiled raw record has no string id")
        require(record["id"] not in by_id, f"duplicate compiled raw record id: {record['id']}")
        by_id[record["id"]] = record
    return records, by_id


def thumbnail_text_and_provenance(item):
    if isinstance(item, dict):
        text = item.get("text", item.get("thumbnail_text"))
        provenance = {key: item[key] for key in ("role", "glyph_confidence", "confidence") if item.get(key) is not None}
    else:
        text = item
        provenance = {}
    require(isinstance(text, str), "ledger thumbnail word must resolve to string text")
    return text, provenance


def metadata_path_for(root, row):
    path = row.get("metadata_source_path")
    require(isinstance(path, str) and path, f"{row.get('video_id')}: metadata_source_path missing")
    candidate = Path(path)
    return candidate if candidate.is_absolute() else root / candidate


def image_path_for(root, row):
    path = row.get("thumbnail_image_path")
    require(isinstance(path, str) and path, f"{row.get('video_id')}: thumbnail_image_path missing")
    candidate = Path(path)
    return candidate if candidate.is_absolute() else root / candidate


def thumbnail_identity_from_row(row):
    value = row.get("thumbnail_blake3")
    if isinstance(value, dict):
        value = value.get("value")
    require(isinstance(value, str), f"{row.get('video_id')}: thumbnail BLAKE3 missing")
    return value


def event_times(event):
    start = event.get("tStartMs", 0) / 1000
    end = (event.get("tStartMs", 0) + event.get("dDurationMs", 0)) / 1000
    return start, end


def compare_legacy_package(root, before_compiled, before_ledger, current_rows, current_by_id):
    """Compare old raw records to current semantics, migrating only caption text to locators."""
    old_records, old_by_id = records_from_compiled(json.loads(before_compiled.read_text()))
    old_rows_all = ledger_rows(before_ledger)
    key = next((row.get("source_key") for row in old_rows_all if row.get("source_key") == "ch-dankoe-intake-videos"), None)
    require(key is not None, "before ledger lacks ch-dankoe-intake-videos")
    old_rows = {row["video_id"]: row for row in old_rows_all if row.get("source_key") == key}
    current_by_video = {row["video_id"]: row for row in current_rows}
    require(set(old_rows) <= set(current_by_video), "one or more preexisting source-key rows are missing from current ledger")
    for video_id, old_row in old_rows.items():
        require(current_by_video[video_id] == old_row, f"preexisting ledger row changed: {video_id}")

    old_ids = set(old_by_id)
    require(old_ids <= set(current_by_id), f"compiled package lost legacy records: {sorted(old_ids - set(current_by_id))}")
    legacy_caption_ids = []
    for record_id, old_record in old_by_id.items():
        current = current_by_id[record_id]
        old_region = old_record.get("region")
        if old_region == "captions" and ".caption.opening." in record_id:
            legacy_caption_ids.append(record_id)
            video_id = record_id.split(".caption.opening.", 1)[0]
            index = int(record_id.rsplit(".", 1)[1]) - 1
            samples = old_rows[video_id].get("opening_hook_evidence") or []
            require(0 <= index < len(samples), f"{record_id}: baseline ledger sample missing")
            sample = samples[index]
            provenance = current.get("source_provenance") or {}
            source = resolve_path(root, sample["source_path"])
            identity = file_identity(source)
            require(identity["blake3"] == sample.get("source_blake3"), f"{record_id}: baseline caption source hash mismatch")
            require(provenance.get("video_id") == video_id, f"{record_id}: wrong caption video id")
            require(resolve_path(root, provenance.get("path", "")).resolve() == source.resolve(), f"{record_id}: caption source path changed")
            source_identity = provenance.get("source_file_identity") or {}
            require(source_identity.get("bytes") == identity["bytes"] and source_identity.get("blake3") == identity["blake3"], f"{record_id}: current caption file identity mismatch")
            raw = json.loads(source.read_text())
            events = raw.get("events", [])
            matches = [i for i, event in enumerate(events) if all(abs(a - b) <= 0.001 for a, b in zip(event_times(event), (sample["start_s"], sample["end_s"]))) ]
            require(len(matches) == 1, f"{record_id}: selected opening span does not map uniquely to one source event")
            index_in_file = matches[0]
            start, end = event_times(events[index_in_file])
            require(provenance.get("source_event_index") == index_in_file, f"{record_id}: event index changed")
            require(abs(provenance.get("t0", -999) - start) <= 0.001 and abs(provenance.get("t1", -999) - end) <= 0.001, f"{record_id}: event time changed")
            require(current.get("fields") == {}, f"{record_id}: derived caption text is present in record fields")
            require(provenance.get("caption_text_copied") is False, f"{record_id}: caption copy boundary missing")
            require("text" not in provenance and "opening_caption_text" not in provenance, f"{record_id}: copied caption text is present in provenance")
        else:
            require(current.get("fields") == old_record.get("fields"), f"{record_id}: preexisting record fields changed")
            if old_region == "thumbnail":
                thumb_text = current["fields"].get("thumbnail_text")
                require(isinstance(thumb_text, str), f"{record_id}: thumbnail_text is not a string")
                video_id = old_record.get("unit", "").removeprefix("video-")
                old_row = old_rows[video_id]
                ordinal = int(record_id.rsplit("-", 1)[1]) - 1
                words = old_row.get("thumbnail_words", {}).get("value") or []
                require(0 <= ordinal < len(words), f"{record_id}: source thumbnail word is missing")
                _, expected_provenance = thumbnail_text_and_provenance(words[ordinal])
                current_provenance = current.get("source_provenance") or {}
                for field, value in expected_provenance.items():
                    require(current_provenance.get(field) == value, f"{record_id}: thumbnail {field} provenance changed")
    expected_caption_count = sum(len(row.get("opening_hook_evidence") or []) for row in old_rows.values())
    require(len(legacy_caption_ids) == expected_caption_count, f"legacy opening reference count mismatch: {len(legacy_caption_ids)} != {expected_caption_count}")
    return {
        "status": "pass",
        "preexisting_ledger_rows_preserved": len(old_rows),
        "preexisting_compiled_records_preserved": len(old_ids),
        "legacy_selected_opening_locators": len(legacy_caption_ids),
        "legacy_caption_text_copied": False,
        "baseline_compiled_path": str(before_compiled),
        "baseline_ledger_path": str(before_ledger),
    }


def check_ledger_prefix(current_ledger, before_ledger, expected_new_ids):
    before_bytes = before_ledger.read_bytes()
    current_bytes = current_ledger.read_bytes()
    require(current_bytes.startswith(before_bytes), "current ledger does not preserve exact pre-adoption byte prefix")
    old_rows, current_rows = ledger_rows(before_ledger), ledger_rows(current_ledger)
    old_ids = {row["video_id"] for row in old_rows}
    current_ids = [row["video_id"] for row in current_rows]
    require(len(current_ids) == len(set(current_ids)), "current ledger contains duplicate video IDs")
    additions = [row for row in current_rows if row["video_id"] not in old_ids]
    actual_new_ids = {row["video_id"] for row in additions}
    require(actual_new_ids == set(expected_new_ids), f"ledger additions differ from declared six IDs: {sorted(actual_new_ids)}")
    require(all(row.get("source_key") == "ch-dankoe-intake-videos" for row in additions), "a new ledger row is under an undeclared source key")
    return {
        "status": "pass",
        "before_bytes": len(before_bytes),
        "current_bytes": len(current_bytes),
        "exact_byte_prefix": True,
        "before_rows": len(old_rows),
        "current_rows": len(current_rows),
        "new_video_ids": sorted(actual_new_ids),
    }


def validate(root, source_key, ledger_path, compiled_path, selected_ids=None,
             before_compiled=None, before_ledger=None, expected_new_ids=None):
    root = root.resolve()
    compiled = json.loads(compiled_path.read_text())
    rows_all = ledger_rows(ledger_path)
    all_rows = [row for row in rows_all if row.get("source_key") == source_key]
    require(all_rows, "source_key has no packaging rows")
    all_by_video = {row["video_id"]: row for row in all_rows}
    require(len(all_by_video) == len(all_rows), "duplicate video_id within source_key")
    if selected_ids is None:
        rows = all_rows
    else:
        require(len(set(selected_ids)) == len(selected_ids) and set(selected_ids) <= set(all_by_video), "requested video IDs are not a unique subset of the source key")
        rows = [all_by_video[video_id] for video_id in selected_ids]

    records, by_id = records_from_compiled(compiled)
    require(compiled.get("piece", {}).get("source_key") == source_key, "compiled package source_key mismatch")
    require(len(records) == len(by_id), "compiled package raw record IDs are not unique")
    resolved = {}
    for row in rows:
        video_id = row["video_id"]
        unit_id = f"video-{video_id}"
        unit = by_id.get(unit_id)
        require(unit is not None and unit.get("is_unit") is True, f"{video_id}: compiled unit missing")
        unit_provenance = unit.get("source_provenance") or {}
        require(unit_provenance.get("source_key") == source_key, f"{video_id}: wrong source key in unit provenance")
        require(unit_provenance.get("url") == row.get("url"), f"{video_id}: URL join mismatch")

        metadata_path = metadata_path_for(root, row)
        require(metadata_path.is_file(), f"{video_id}: retained metadata file missing")
        metadata_raw = metadata_path.read_bytes()
        metadata_identity = {"bytes": len(metadata_raw), "blake3": blake3.blake3(metadata_raw).hexdigest()}
        expected_meta = row.get("metadata_source_identity") or {}
        if expected_meta:
            require(metadata_identity["bytes"] == expected_meta.get("bytes") and metadata_identity["blake3"] == identity_digest(expected_meta), f"{video_id}: metadata source identity mismatch")
        unit_meta, metadata_reference_basis = normalize_metadata_reference(
            root, unit_provenance, row, metadata_path, metadata_identity, expected_meta, video_id)
        require(resolve_path(root, unit_meta.get("path", "")).resolve() == metadata_path.resolve(), f"{video_id}: unit metadata source path mismatch")
        unit_meta_identity = unit_meta.get("identity") or {}
        require(unit_meta_identity.get("bytes") == metadata_identity["bytes"] and identity_digest(unit_meta_identity) == metadata_identity["blake3"], f"{video_id}: unit metadata identity mismatch")
        metadata = json.loads(metadata_raw)
        ledger_channel_id = row.get("source_channel_id")
        require(isinstance(ledger_channel_id, str) and ledger_channel_id, f"{video_id}: ledger source channel ID missing")
        canonical_channel_id = unit_provenance.get("source_channel_id")
        if canonical_channel_id is not None:
            compiled_channel_id = canonical_channel_id
            require(isinstance(compiled_channel_id, str) and compiled_channel_id, f"{video_id}: compiled source channel ID is empty")
            if "channel_id" in unit_provenance:
                require(unit_provenance.get("channel_id") == compiled_channel_id, f"{video_id}: compiled source channel ID aliases conflict")
            require(compiled_channel_id == ledger_channel_id, f"{video_id}: source channel join mismatch")
            channel_join_basis = "source_channel_id"
        else:
            compiled_channel_id = unit_provenance.get("channel_id")
            require(isinstance(compiled_channel_id, str) and compiled_channel_id, f"{video_id}: compiled source channel ID missing")
            require(expected_meta and metadata_identity["bytes"] == expected_meta.get("bytes")
                    and metadata_identity["blake3"] == identity_digest(expected_meta),
                    f"{video_id}: legacy channel ID requires a verified metadata source identity")
            metadata_channel_id = metadata.get("channel_id")
            require(isinstance(metadata_channel_id, str) and metadata_channel_id, f"{video_id}: retained metadata channel ID missing")
            require(compiled_channel_id == ledger_channel_id == metadata_channel_id,
                    f"{video_id}: legacy source channel join mismatch")
            channel_join_basis = "channel_id+identity-pinned-metadata"
        title = row.get("metadata_title") or row.get("inventory_title")
        title_record = by_id.get(f"{video_id}.title")
        require(title_record is not None, f"{video_id}: compiled title record missing")
        title_fields = title_record.get("fields") or {}
        require(title_fields.get("title") == title, f"{video_id}: compiled title differs from source metadata")
        require(title_fields.get("metadata_title") == title, f"{video_id}: metadata_title compatibility alias missing or wrong")
        title_provenance = title_record.get("source_provenance") or {}
        require(title_provenance.get("video_id") == video_id, f"{video_id}: title source video mismatch")
        require(resolve_path(root, title_provenance.get("path", "")).resolve() == metadata_path.resolve(), f"{video_id}: title metadata path mismatch")
        title_identity = title_provenance.get("source_file_identity") or {}
        require(title_identity.get("bytes") == metadata_identity["bytes"] and identity_digest(title_identity) == metadata_identity["blake3"], f"{video_id}: title metadata identity mismatch")

        description = metadata.get("description")
        desc_record = by_id.get(f"{video_id}.description")
        if isinstance(description, str):
            require(desc_record is not None, f"{video_id}: metadata description record missing")
            require((desc_record.get("fields") or {}).get("description") == description, f"{video_id}: description differs from retained metadata")
            desc_provenance = desc_record.get("source_provenance") or {}
            require(desc_provenance.get("value_source") == "retained per-video extractor metadata description", f"{video_id}: description source provenance missing")
            require(identity_digest(desc_provenance.get("metadata_file_identity") or {}) == metadata_identity["blake3"], f"{video_id}: description metadata identity mismatch")
        else:
            require(desc_record is None, f"{video_id}: description record exists without source metadata description")

        image_path = image_path_for(root, row)
        require(image_path.is_file(), f"{video_id}: retained thumbnail image missing")
        image_identity = file_identity(image_path)
        require(image_identity["blake3"] == thumbnail_identity_from_row(row), f"{video_id}: thumbnail image BLAKE3 mismatch")
        items = (row.get("thumbnail_words") or {}).get("value") or []
        thumbnail_records = [record for record in records if record.get("unit") == unit_id and record.get("region") == "thumbnail" and record.get("id", "").startswith(f"{video_id}.thumbnail-text-")]
        thumbnail_records.sort(key=lambda record: int(record["id"].rsplit("-", 1)[1]))
        require(len(thumbnail_records) == len(items), f"{video_id}: thumbnail text record count mismatch")
        thumbnail_values = []
        for index, (record, item) in enumerate(zip(thumbnail_records, items), 1):
            expected_text, expected_provenance = thumbnail_text_and_provenance(item)
            fields = record.get("fields") or {}
            actual_text = fields.get("thumbnail_text")
            require(isinstance(actual_text, str), f"{video_id}: thumbnail_text #{index} is not a string")
            require(actual_text == expected_text, f"{video_id}: thumbnail_text #{index} differs from reviewed source")
            provenance = record.get("source_provenance") or {}
            require(resolve_path(root, provenance.get("path", "")).resolve() == image_path.resolve(), f"{video_id}: thumbnail text source path mismatch")
            require(provenance.get("blake3") == image_identity["blake3"] and provenance.get("bytes") == image_identity["bytes"], f"{video_id}: thumbnail text image identity mismatch")
            for field, value in expected_provenance.items():
                require(provenance.get(field) == value, f"{video_id}: thumbnail_text #{index} {field} provenance missing or wrong")
            thumbnail_values.append(actual_text)

        legacy_samples = row.get("opening_hook_evidence") or []
        expected_legacy = [sample for sample in legacy_samples if isinstance(sample, dict) and "text" in sample and sample.get("source_path")]
        legacy_refs = []
        for index, sample in enumerate(expected_legacy, 1):
            record_id = f"{video_id}.caption.opening.{index:03d}"
            record = by_id.get(record_id)
            require(record is not None, f"{record_id}: selected opening caption record missing")
            provenance = record.get("source_provenance") or {}
            source = resolve_path(root, sample["source_path"])
            identity = file_identity(source)
            if sample.get("source_blake3") is not None:
                require(identity["blake3"] == sample.get("source_blake3"), f"{record_id}: selected opening source hash changed")
            require(resolve_path(root, provenance.get("path", "")).resolve() == source.resolve(), f"{record_id}: selected opening source path changed")
            source_identity = provenance.get("source_file_identity") or {}
            require(source_identity.get("bytes") == identity["bytes"] and source_identity.get("blake3") == identity["blake3"], f"{record_id}: selected opening source identity mismatch")
            events = json.loads(source.read_text()).get("events", [])
            matches = [i for i, event in enumerate(events) if all(abs(a - b) <= 0.001 for a, b in zip(event_times(event), (sample["start_s"], sample["end_s"]))) ]
            require(len(matches) == 1, f"{record_id}: selected opening does not map uniquely to a canonical caption event")
            event_index = matches[0]
            start, end = event_times(events[event_index])
            require(provenance.get("source_event_index") == event_index, f"{record_id}: selected opening event index mismatch")
            require(abs(provenance.get("t0", -999) - start) <= 0.001 and abs(provenance.get("t1", -999) - end) <= 0.001, f"{record_id}: selected opening event times mismatch")
            require(record.get("fields") == {}, f"{record_id}: selected opening text copied into record fields")
            require(provenance.get("caption_text_copied") is False and "text" not in provenance, f"{record_id}: caption text-copy boundary missing")
            legacy_refs.append({"record_id": record_id, "path": str(source), "source_file_identity": identity, "source_event_index": event_index, "start_s": start, "end_s": end, "caption_text_copied": False})

        caption_refs = unit_provenance.get("caption_source_references") or []
        source_caption_paths = row.get("caption_sources") or []
        require(len(caption_refs) == len(source_caption_paths), f"{video_id}: caption source join count mismatch")
        caption_records = [record for record in records if record.get("unit") == unit_id and record.get("region") == "transcript-reference"]
        require(len(caption_records) == len(caption_refs), f"{video_id}: canonical transcript-reference record count mismatch")
        for ref, source_path in zip(caption_refs, source_caption_paths):
            path = resolve_path(root, source_path)
            identity = file_identity(path)
            ref_identity = ref.get("source_file_identity") or {}
            require(resolve_path(root, ref.get("path", "")).resolve() == path.resolve(), f"{video_id}: caption source path join mismatch")
            require(ref_identity.get("bytes") == identity["bytes"] and ref_identity.get("blake3") == identity["blake3"], f"{video_id}: caption source identity mismatch")
            require("text" not in ref and ref.get("caption_text_copied") is not True, f"{video_id}: canonical caption ref contains copied text")
        for record in caption_records:
            provenance = record.get("source_provenance") or {}
            require(provenance.get("caption_text_copied") is False and "text" not in provenance, f"{video_id}: canonical caption record copy boundary missing")

        analysis = row.get("thumbnail_analysis") if isinstance(row.get("thumbnail_analysis"), dict) else {}
        if not analysis:
            legacy_analysis = row.get("thumbnail_words") or {}
            analysis = {"composition": legacy_analysis.get("composition"), "title_thumbnail_role_relation": legacy_analysis.get("title_thumbnail_role_relation")}
        analysis_record = by_id.get(f"{video_id}.thumbnail-analysis")
        require(analysis_record is not None, f"{video_id}: thumbnail analysis record missing")
        analysis_fields = analysis_record.get("fields") or {}
        require(analysis_fields.get("composition") == analysis.get("composition"), f"{video_id}: thumbnail composition mismatch")
        require(analysis_fields.get("title_thumbnail_role_relation") == analysis.get("title_thumbnail_role_relation"), f"{video_id}: thumbnail title relation mismatch")

        hook_readback = {}
        for kind, prefix in (("opening", "opening_hook"), ("internal_hook", "internal_hook")):
            source_refs = row.get(f"{prefix}_evidence") or []
            interpretation = row.get(f"{prefix}_interpretation")
            analysis_id = f"{video_id}.{kind}-analysis"
            evidence_id = f"{video_id}.{kind}-evidence"
            if not source_refs or not interpretation:
                require(analysis_id not in by_id and evidence_id not in by_id, f"{video_id}: unsupported hook records were added")
                continue
            hook_analysis = by_id.get(analysis_id)
            hook_evidence = by_id.get(evidence_id)
            require(hook_analysis is not None and hook_evidence is not None, f"{video_id}: hook analysis/evidence records missing")
            analysis_fields = hook_analysis.get("fields") or {}
            evidence_fields = hook_evidence.get("fields") or {}
            require(analysis_fields.get("hook_analysis") == interpretation, f"{video_id}: hook interpretation mismatch")
            require(analysis_fields.get("hook_specific_failure_or_boundary") == row.get(f"{prefix}_qualification"), f"{video_id}: hook qualification mismatch")
            event_refs = json.loads(evidence_fields.get("hook_source_evidence", "[]"))
            require(event_refs == project_hook_references(source_refs), f"{video_id}: hook caption locators differ from projected source evidence")
            provenance = hook_evidence.get("source_provenance") or {}
            require(provenance.get("caption_text_copied") is False and provenance.get("speech_independently_verified") is False, f"{video_id}: hook evidence boundary missing")
            legacy_source_checks = []
            for sample, original_sample in zip(event_refs, source_refs):
                require("text" not in sample and sample.get("caption_text_copied") is False, f"{video_id}: hook locator contains copied text")
                if not sample.get("source_path"):
                    legacy_source_checks.append(validate_legacy_hook_reference(root, row, original_sample))
                    continue
                source = resolve_path(root, sample["source_path"])
                identity = file_identity(source)
                sample_identity = sample.get("source_file_identity") or {}
                require(sample_identity.get("bytes") == identity["bytes"] and identity_digest(sample_identity) == identity["blake3"], f"{video_id}: hook caption file identity mismatch")
                events = json.loads(source.read_text()).get("events", [])
                event_range = sample.get("event_index_range")
                if event_range is not None:
                    require(isinstance(event_range, list) and len(event_range) == 2
                            and all(isinstance(index, int) for index in event_range),
                            f"{video_id}: hook event index range is malformed")
                    first_index, last_index = event_range
                    require(0 <= first_index <= last_index < len(events), f"{video_id}: hook event index range is invalid")
                    start = event_times(events[first_index])[0]
                    end = event_times(events[last_index])[1]
                else:
                    event_index = sample.get("source_event_index")
                    require(isinstance(event_index, int) and 0 <= event_index < len(events), f"{video_id}: hook event index is invalid")
                    start, end = event_times(events[event_index])
                require(abs(start - sample.get("start_s", -999)) <= 0.001 and abs(end - sample.get("end_s", -999)) <= 0.001, f"{video_id}: hook event times mismatch")
            linked_observations = [sample["analysis_reference"] for sample in event_refs if isinstance(sample.get("analysis_reference"), dict)]
            hook_readback[kind] = {"candidate_function": interpretation, "sample_event_count": len(event_refs), "analysis_observation_references": linked_observations, "legacy_group_source_checks": legacy_source_checks, "caption_text_copied": False}

        resolved[video_id] = {
            "source_channel_id": ledger_channel_id,
            "channel_join_basis": channel_join_basis,
            "metadata_reference_basis": metadata_reference_basis,
            "title": title,
            "description_present": isinstance(description, str),
            "thumbnail_words": thumbnail_values,
            "thumbnail_identity": image_identity,
            "metadata_identity": metadata_identity,
            "caption_source_count": len(caption_refs),
            "legacy_opening_locator_count": len(legacy_refs),
            "legacy_opening_locators": legacy_refs,
            "hook_candidates": hook_readback,
        }

    preservation = None
    if bool(before_compiled) != bool(before_ledger):
        fail("--before-compiled and --before-ledger must be supplied together")
    if before_compiled and before_ledger:
        preservation = compare_legacy_package(root, before_compiled, before_ledger, all_rows, by_id)
    ledger_prefix = None
    if expected_new_ids:
        require(before_ledger is not None, "--before-ledger is required with --expected-new-video-id")
        ledger_prefix = check_ledger_prefix(ledger_path, before_ledger, expected_new_ids)
    return {
        "schema": "compiled-youtube-packaging-readback@2",
        "source_key": source_key,
        "compiled_path": str(compiled_path),
        "compiled_identity": {"bytes": compiled_path.stat().st_size, "blake3": blake3.blake3(compiled_path.read_bytes()).hexdigest()},
        "compiled_built_from": compiled.get("piece", {}).get("built_from"),
        "source_package_video_count": len(all_rows),
        "video_count": len(resolved),
        "video_id_selection": [row["video_id"] for row in rows],
        "record_count": len(records),
        "caption_text_copied": False,
        "legacy_preservation": preservation,
        "ledger_prefix": ledger_prefix,
        "resolved": resolved,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--source-key", required=True)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--compiled", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--video-id", action="append", help="Select exact videos while reading the complete compiled package.")
    parser.add_argument("--before-compiled", type=Path, help="Immutable pre-adoption compiled source-key package for preservation checking.")
    parser.add_argument("--before-ledger", type=Path, help="Byte-preserved pre-adoption ledger for preservation checking.")
    parser.add_argument("--expected-new-video-id", action="append", default=[], help="Declare one expected appended video ID; use once per new row.")
    args = parser.parse_args()
    try:
        result = validate(args.root, args.source_key, args.ledger, args.compiled, args.video_id,
                          args.before_compiled, args.before_ledger, args.expected_new_video_id)
    except (AssertionError, KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "rejected", "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": "pass", "videos": result["video_count"], "compiled_records": result["record_count"], "legacy_preservation": result["legacy_preservation"], "ledger_prefix": result["ledger_prefix"], "output": str(args.output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
