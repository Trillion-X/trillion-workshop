#!/usr/bin/env python3
"""Expand provider-neutral source templates over usable service connections.

The source row owns provider knowledge as DATA. This transform only understands
the canonical service-connection record and ``${connection.*}`` bindings. It is
pure: two JSON inputs become one JSON output, with no network, vault, or file
discovery side effects.
"""

import copy
import json
import pathlib
import re
import sys


ENVELOPE_KEYS = ("payload", "sources", "records", "rows", "items", "results", "output")
TOKEN = re.compile(r"\$\{connection\.([a-zA-Z0-9_.]+)\}")


def _peel(value):
    while isinstance(value, dict):
        found = False
        for key in ENVELOPE_KEYS:
            nested = value.get(key)
            if isinstance(nested, (list, dict)):
                value = nested
                found = True
                break
        if not found:
            break
    return value if isinstance(value, list) else [value]


def _source_specs(value):
    for row in _peel(value):
        if not isinstance(row, dict):
            continue
        inner = row.get("value_json", row)
        if isinstance(inner, str):
            try:
                inner = json.loads(inner)
            except ValueError:
                continue
        for spec in inner if isinstance(inner, list) else [inner]:
            if isinstance(spec, dict):
                yield spec


def _connections(value):
    for row in _peel(value):
        if not isinstance(row, dict):
            continue
        connection_id = row.get("id")
        vendor = row.get("serviceVendor", row.get("service_vendor"))
        if not isinstance(connection_id, str) or not isinstance(vendor, str):
            continue
        refs = row.get("credential_handle_refs", row.get("credentialHandleRefs", []))
        resource_refs = row.get("resource_refs", row.get("resourceRefs", []))
        scopes = row.get("scopes", [])
        if isinstance(refs, str):
            try:
                refs = json.loads(refs)
            except ValueError:
                refs = []
        if isinstance(scopes, str):
            try:
                scopes = json.loads(scopes)
            except ValueError:
                scopes = []
        if isinstance(resource_refs, str):
            try:
                resource_refs = json.loads(resource_refs)
            except ValueError:
                resource_refs = []
        yield {
            **row,
            "id": connection_id,
            "service_vendor": vendor,
            "serviceVendor": vendor,
            "account_label": row.get("accountLabel", row.get("account_label", "")),
            "credential_handle_refs": refs if isinstance(refs, list) else [],
            "resource_refs": resource_refs if isinstance(resource_refs, list) else [],
            "resourceRefs": resource_refs if isinstance(resource_refs, list) else [],
            "scopes": scopes if isinstance(scopes, list) else [],
            "status_ref": row.get("statusRef", row.get("status_ref", "")),
            "id_utf8_hex": connection_id.encode("utf-8").hex(),
        }


def _at_path(value, path):
    current = value
    for part in path.split("."):
        if isinstance(current, list) and part.isdigit():
            index = int(part)
            if index >= len(current):
                return None
            current = current[index]
        elif isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


def _bind(value, connection):
    if isinstance(value, list):
        return [_bind(item, connection) for item in value]
    if isinstance(value, dict):
        return {key: _bind(item, connection) for key, item in value.items()}
    if not isinstance(value, str):
        return value
    exact = TOKEN.fullmatch(value)
    if exact:
        return copy.deepcopy(_at_path(connection, exact.group(1)))
    return TOKEN.sub(
        lambda match: "" if _at_path(connection, match.group(1)) is None
        else str(_at_path(connection, match.group(1))),
        value,
    )


def _matches(connection, selector):
    requested_vendor = selector.get("service_vendor")
    if not isinstance(requested_vendor, str) or not requested_vendor.strip() or connection["service_vendor"].casefold() != requested_vendor.casefold():
        return False
    requested_account = selector.get("account_label")
    if "account_label" in selector:
        if not isinstance(requested_account, str) or not requested_account.strip():
            return False
        if str(connection["account_label"]).strip().casefold() != requested_account.strip().casefold():
            return False
    statuses = selector.get("required_status_refs", ["connection-status:connected"])
    if statuses and connection["status_ref"] not in statuses:
        return False
    required_scopes = set(selector.get("required_scope_refs", []))
    if not required_scopes.issubset(set(connection["scopes"])):
        return False
    if selector.get("require_credential_refs", True) and not connection["credential_handle_refs"]:
        return False
    requested_resource = selector.get("resource_ref")
    if "resource_ref" in selector:
        if not isinstance(requested_resource, str) or not requested_resource.strip():
            return False
        if requested_resource not in connection["resource_refs"]:
            return False
    required_resources = selector.get("required_resource_refs", [])
    if not isinstance(required_resources, list):
        return False
    if not set(required_resources).issubset(set(connection["resource_refs"])):
        return False
    return True


def expand(source_rows, connection_rows):
    connections = sorted(_connections(connection_rows), key=lambda item: item["id"])
    expanded = []
    seen_refs = set()
    for spec in _source_specs(source_rows):
        selector = spec.get("connection_instance_template")
        if isinstance(selector, dict):
            candidates = [item for item in connections if _matches(item, selector)]
            # An explicit account/resource selector is an addressing request,
            # not a fan-out request. Ambiguity must yield no source instead of
            # selecting by insertion order or duplicating downstream work.
            if ("account_label" in selector or "resource_ref" in selector) and len(candidates) != 1:
                candidates = []
        else:
            candidates = [None]
        for connection in candidates:
            if connection is not None:
                connection = copy.deepcopy(connection)
                connection["selected_resource_ref"] = selector.get("resource_ref", "")
            descriptor = copy.deepcopy(spec)
            descriptor.pop("connection_instance_template", None)
            descriptor = _bind(descriptor, connection) if connection is not None else descriptor
            source_ref = descriptor.get("source_ref")
            if not isinstance(source_ref, str) or not source_ref:
                continue
            if source_ref in seen_refs:
                raise ValueError(f"duplicate expanded source_ref: {source_ref}")
            seen_refs.add(source_ref)
            expanded.append(descriptor)
    return {"sources": expanded}


def main(argv):
    if len(argv) != 4:
        raise SystemExit("usage: expand-connected-source-descriptors.py <sources.json> <connections.json> <out.json>")
    source_rows = json.loads(pathlib.Path(argv[1]).read_text(encoding="utf-8"))
    connection_rows = json.loads(pathlib.Path(argv[2]).read_text(encoding="utf-8"))
    pathlib.Path(argv[3]).write_text(json.dumps(expand(source_rows, connection_rows)), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv)
