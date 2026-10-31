#!/usr/bin/env python3
"""Organize a person's saved browser tabs into folders by rules they wrote, and undo it.

Reads the browser's sidebar file (the Arc layout: a space's pinned tabs and folders), decides for every saved
tab whether a rule covers it and which folder it belongs in, and, only when asked to apply, rewrites the file.

Run: python3 organize-saved-browser-items.py <granted folder>   with the request on standard input:
  { "file": "StorableSidebar.json",           the sidebar file, a plain name inside the granted folder
    "rules": { ... },                          see RULES below
    "apply": false }                           true writes the file (after a backup); false only reports
or
  { "file": "StorableSidebar.json", "restore_from": "<backup name in the same folder>" }

RULES (all given by the person; this program names no category, no site and no word):
  space           title of the space whose pinned tabs are organized
  root_folder     title of the pinned folder that holds the organized tree
  folders         { "<top folder>": ["<sub folder>", ...] } the tree to make; a top folder with no sub folders
                  is itself a destination. The root folder must already hold exactly one existing folder for
                  every folder named here (the browser makes folders; this program reuses them).
  fallback        ["<top folder>", "<sub folder>"?] where a covered tab goes when no rule picks a folder
  skip_hosts      sites never touched unless the tab is already inside the root folder
  relevant_hosts  sites whose tabs are covered
  relevant_words  words that, in a tab's title, address or folder path, cover the tab
  rules           [{ "put_in": ["<top>", "<sub>"?], "hosts": [...], "words": [...] }] first match wins
Tabs inside the root folder are always covered. A split view moves as one unit. Nothing is deleted: before a
file is written, every tab must still be reachable and the set of items must be unchanged.
"""

from __future__ import annotations

import copy
import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

APPLE_EPOCH_OFFSET = 978307200  # the browser stamps changes in seconds since 2001-01-01


class Refusal(Exception):
    """The request cannot be carried out honestly; the message says what to change."""


def pairs(values):
    return dict(zip(values[0::2], values[1::2]))


def title(node):
    tab = (node.get("data") or {}).get("tab") or {}
    return node.get("title") or tab.get("savedTitle") or "Untitled"


def address(node):
    return ((node.get("data") or {}).get("tab") or {}).get("savedURL") or ""


def host_of(value):
    try:
        return urlparse(value).hostname.lower().removeprefix("www.")
    except (AttributeError, ValueError):
        return ""


def is_kind(node, kind):
    return kind in (node.get("data") or {})


def plain_name(value, what):
    if not isinstance(value, str) or not value or value in (".", "..") or "/" in value or "\\" in value or "\0" in value:
        raise Refusal(f"{what} must be a plain file name inside the granted folder")
    return value


def file_in(folder, name, what):
    path = Path(os.path.realpath(folder)) / plain_name(name, what)
    if path.is_symlink() or not path.is_file():
        raise Refusal(f"{what} {name!r} is not a regular file in the granted folder")
    return path


def string_list(value, label):
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise Refusal(f"{label} must be a list of non-empty text")
    return value


def read_rules(rules):
    if not isinstance(rules, dict):
        raise Refusal("rules must be an object")
    for key in ("space", "root_folder"):
        if not isinstance(rules.get(key), str) or not rules[key]:
            raise Refusal(f"rules.{key} must be the title of the {key.replace('_', ' ')}")
    folders = rules.get("folders")
    if not isinstance(folders, dict) or not folders:
        raise Refusal("rules.folders must name at least one top folder")
    for top, leaves in folders.items():
        string_list(leaves, f"rules.folders[{top!r}]")
    destinations = {(top, leaf) for top, leaves in folders.items() for leaf in leaves}
    destinations |= {(top, None) for top, leaves in folders.items() if not leaves}

    def destination(value, label):
        value = string_list(value, label)
        key = (value[0], value[1] if len(value) > 1 else None) if 1 <= len(value) <= 2 else None
        if key not in destinations:
            raise Refusal(f"{label} {value!r} is not a destination in rules.folders (a top folder with sub folders is not itself a destination)")
        return key

    parsed = {
        "space": rules["space"],
        "root": rules["root_folder"].lower(),
        "folders": folders,
        "fallback": destination(rules.get("fallback"), "rules.fallback"),
        "skip_hosts": {h.lower() for h in string_list(rules.get("skip_hosts", []), "rules.skip_hosts")},
        "relevant_hosts": {h.lower() for h in string_list(rules.get("relevant_hosts", []), "rules.relevant_hosts")},
        "relevant_words": [w.lower() for w in string_list(rules.get("relevant_words", []), "rules.relevant_words")],
        "rules": [],
    }
    for index, rule in enumerate(rules.get("rules", [])):
        if not isinstance(rule, dict):
            raise Refusal(f"rules.rules[{index}] must be an object")
        hosts = {h.lower() for h in string_list(rule.get("hosts", []), f"rules.rules[{index}].hosts")}
        words = [w.lower() for w in string_list(rule.get("words", []), f"rules.rules[{index}].words")]
        if not hosts and not words:
            raise Refusal(f"rules.rules[{index}] needs hosts or words, or it would cover every tab")
        parsed["rules"].append({"put_in": destination(rule.get("put_in"), f"rules.rules[{index}].put_in"), "hosts": hosts, "words": words})
    return parsed


def choose_destination(rules, text, item_host):
    lower = text.lower()
    for rule in rules["rules"]:
        if item_host in rule["hosts"] or any(word in lower for word in rule["words"]):
            return rule["put_in"]
    return rules["fallback"]


def write_atomically(destination, document):
    with tempfile.NamedTemporaryFile("w", dir=destination.parent, delete=False, prefix=".organizing-", suffix=".tmp") as handle:
        json.dump(document, handle, separators=(",", ":"))
        handle.write("\n")
        staged = Path(handle.name)
    try:
        json.loads(staged.read_text())
        os.replace(staged, destination)
    except BaseException:
        staged.unlink(missing_ok=True)
        raise


def organize(document, rules, stamp):
    """Reorganize `document` in place; returns the decisions. Raises Refusal before anything is half changed."""
    container = next((c for c in document.get("sidebar", {}).get("containers", []) if isinstance(c, dict) and "items" in c and "spaces" in c), None)
    if container is None:
        raise Refusal("the file has no sidebar container with items and spaces, so it is not a sidebar file this tool reads")
    item_list = container["items"]
    items = pairs(item_list)
    spaces = pairs(container["spaces"])
    space = next(((key, value) for key, value in spaces.items() if value.get("title") == rules["space"]), None)
    if space is None:
        raise Refusal(f"there is no space titled {rules['space']!r}")
    space_id, space_node = space
    container_ids = space_node.get("containerIDs", [])
    if "pinned" not in container_ids or container_ids.index("pinned") + 1 >= len(container_ids):
        raise Refusal(f"the space {rules['space']!r} has no pinned area")
    pinned_root = container_ids[container_ids.index("pinned") + 1]
    if pinned_root not in items:
        raise Refusal("the pinned area names an item the file does not hold")
    roots = [c for c in items[pinned_root].get("childrenIds", []) if c in items and is_kind(items[c], "list") and title(items[c]).lower() == rules["root"]]
    if len(roots) != 1:
        raise Refusal(f"the pinned area must hold exactly one folder titled {rules['root']!r}; it holds {len(roots)}")
    root = roots[0]

    parent = {item_id: node.get("parentID") for item_id, node in items.items()}
    paths, order = {}, []

    def visit(item_id, names):
        if item_id in paths or item_id not in items:
            return
        paths[item_id] = names + [title(items[item_id])]
        order.append(item_id)
        for child in items[item_id].get("childrenIds", []):
            visit(child, paths[item_id])

    visit(pinned_root, [rules["space"], "Pinned"])
    inside_root, root_folders = set(), []

    def descend(item_id):
        for child in items[item_id].get("childrenIds", []):
            inside_root.add(child)
            if is_kind(items[child], "list"):
                root_folders.append(child)
            elif not (is_kind(items[child], "tab") or is_kind(items[child], "splitView")):
                raise Refusal(f"{title(items[child])!r} in the root folder is neither a folder, a tab nor a split view, so it could not be kept")
            descend(child)

    descend(root)
    wanted = len(rules["folders"]) + sum(len(leaves) for leaves in rules["folders"].values())
    if len(root_folders) != wanted:
        raise Refusal(f"the root folder holds {len(root_folders)} folders but rules.folders needs exactly {wanted}: make that many in the browser first, empty or not")

    tabs_before = {i for i in order if is_kind(items[i], "tab")}
    decisions, covered = [], []
    for item_id in order:
        node = items[item_id]
        if not is_kind(node, "tab"):
            continue
        item_address, item_host = address(node), host_of(address(node))
        text = " ".join([title(node), item_address, " / ".join(paths[item_id])])
        already = item_id in inside_root
        skipped = item_host in rules["skip_hosts"] and not already
        word_hit = any(word in text.lower() for word in rules["relevant_words"])
        relevant = already or (not skipped and (item_host in rules["relevant_hosts"] or word_hit))
        destination = choose_destination(rules, text, item_host) if relevant else None
        if relevant:
            covered.append(item_id)
        decisions.append({
            "id": item_id, "title": title(node), "url": item_address, "host": item_host, "original_path": paths[item_id],
            "decision": "organize" if relevant else "keep_in_place",
            "basis": "already_in_root_folder" if already else "covered_by_rules" if relevant else "skipped_site" if skipped else "not_covered",
            "category": list(destination) if destination else None,
        })

    # A split view moves as one unit so the relationship between its tabs survives.
    units = {}
    for tab_id in covered:
        unit_id, cursor = tab_id, parent.get(tab_id)
        while cursor and cursor != pinned_root:
            if is_kind(items.get(cursor, {}), "splitView"):
                unit_id = cursor
                break
            cursor = parent.get(cursor)
        units.setdefault(unit_id, []).append(tab_id)

    changed, folder_ids = set(), iter(root_folders)

    def reuse_folder(name, parent_id):
        item_id = next(folder_ids)
        items[item_id].update({"childrenIds": [], "parentID": parent_id, "title": name})
        changed.add(item_id)
        return item_id

    tops, leaves_by_key = {}, {}
    for top, leaves in rules["folders"].items():
        top_id = reuse_folder(top, root)
        tops[top] = top_id
        for leaf in leaves:
            leaf_id = reuse_folder(leaf, top_id)
            items[top_id]["childrenIds"].append(leaf_id)
            leaves_by_key[(top, leaf)] = leaf_id
    moved_in, organized = 0, len(covered)
    for unit_id, tab_ids in units.items():
        old_parent = items[unit_id].get("parentID")
        if old_parent in items:
            items[old_parent]["childrenIds"] = [c for c in items[old_parent].get("childrenIds", []) if c != unit_id]
            changed.add(old_parent)
        votes = [tuple(row["category"]) for row in decisions if row["id"] in tab_ids]
        category = max(sorted(set(votes)), key=votes.count)
        target = tops[category[0]] if category[1] is None else leaves_by_key[category]
        items[target]["childrenIds"].append(unit_id)
        items[unit_id]["parentID"] = target
        changed.update((target, unit_id))
        # A split view carries its other tabs along; the report says so instead of calling them kept in place.
        carried = [c for c in items[unit_id].get("childrenIds", []) if is_kind(items[c], "tab") and c not in tab_ids]
        for row in decisions:
            if row["id"] in carried:
                row.update({"decision": "organize", "basis": "moves_with_split_view", "category": list(category)})
        organized += len(carried)
        if unit_id not in inside_root:
            moved_in += len(tab_ids) + len(carried)
    items[root]["childrenIds"] = list(tops.values())
    changed.add(root)

    # The same tabs must be reachable, and no item may have appeared or gone.
    after, stack = set(), [pinned_root]
    while stack:
        item_id = stack.pop()
        if item_id in after:
            continue
        after.add(item_id)
        stack.extend(items[item_id].get("childrenIds", []))
    if {i for i in after if is_kind(items[i], "tab")} != tabs_before:
        raise Refusal("the reorganization would lose or invent a tab, so nothing was changed")

    container["items"] = [part for item_id in item_list[0::2] for part in (item_id, items[item_id])]
    sync_list = document.get("firebaseSyncState", {}).get("syncData", {}).get("items")
    if sync_list is not None:
        sync_items = pairs(sync_list)
        device = next((w.get("lastChangedDevice") for w in sync_items.values() if w.get("lastChangedDevice")), None)
        for item_id in changed:
            wrapper = sync_items.get(item_id, {})
            wrapper.update({"lastChangedDevice": device, "lastChangeDate": stamp - APPLE_EPOCH_OFFSET, "value": copy.deepcopy(items[item_id])})
            sync_items[item_id] = wrapper
        document["firebaseSyncState"]["syncData"]["items"] = [part for item_id in sync_list[0::2] for part in (item_id, sync_items[item_id])]

    counts = {}
    for row in decisions:
        if row["category"]:
            key = " / ".join(part for part in row["category"] if part)
            counts[key] = counts.get(key, 0) + 1
    return {
        "space_id": space_id,
        "tab_count": len(decisions),
        "organized_tab_count": organized,
        "moved_from_outside_root": moved_in,
        "kept_in_place_count": len(decisions) - organized,
        "category_counts": dict(sorted(counts.items())),
        "tabs": decisions,
    }


def run(folder, request):
    if not isinstance(request, dict):
        raise Refusal("the request must be an object: { file, rules, apply? } or { file, restore_from }")
    source = file_in(folder, request.get("file"), "file")
    now = time.time()
    if "restore_from" in request:
        backup = file_in(folder, request["restore_from"], "restore_from")
        restored = json.loads(backup.read_text())
        safety = source.with_name(f"{source.name}.before-restore-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(source, safety)
        write_atomically(source, restored)
        return {"restored_from": backup.name, "kept_current_as": safety.name, "file": source.name}
    rules = read_rules(request.get("rules"))
    document = json.loads(source.read_text())
    report = organize(document, rules, now)
    report.update({"file": source.name, "applied": False, "backup": None})
    if request.get("apply") is True:
        backup = source.with_name(f"{source.name}.before-organization-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(source, backup)
        write_atomically(source, document)
        report.update({"applied": True, "backup": backup.name})
    return report


def main():
    try:
        if len(sys.argv) != 2 or not Path(sys.argv[1]).is_dir():
            raise Refusal("the granted folder was not given as a path to a folder")
        try:
            request = json.loads(sys.stdin.read() or "null")
        except json.JSONDecodeError:
            raise Refusal("standard input must be JSON")
        print(json.dumps({"result": run(sys.argv[1], request)}))
    except Refusal as refusal:
        print(json.dumps({"error": str(refusal)}))
        sys.exit(2)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"error": f"could not organize: {type(error).__name__}: {error}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
