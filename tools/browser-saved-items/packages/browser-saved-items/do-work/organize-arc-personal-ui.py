#!/usr/bin/env python3
"""Organize every UI-relevant Arc Personal tab without deleting any saved item."""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
from urllib.parse import urlparse

ARC_PATH = Path.home() / "Library/Application Support/Arc/StorableSidebar.json"

TAXONOMY = {
    "Expansion patterns": [
        "Media libraries + creative workspaces",
        "Collections + filters + bulk actions",
        "Editors + timelines + canvases",
        "Chat + agent workspaces",
    ],
    "Reusable components": [
        "Open-source components",
        "Motion + visual assets",
        "Other component references",
    ],
    "Interface references": [
        "Product UI + native apps",
        "Web apps + marketing",
        "Design inspiration + brand",
    ],
    "Design tools + people": [],
}


def destination_for(category):
    top, leaf = category
    if top == "Use in Expansion":
        if leaf in {"Search + filters + dense collections", "Selection + bulk actions"}:
            return "Expansion patterns", "Collections + filters + bulk actions"
        return "Expansion patterns", leaf
    if top == "Reusable components":
        if leaf == "Open-source component libraries":
            return "Reusable components", "Open-source components"
        if leaf in {"Motion + interaction", "Icons + visual assets", "Layouts + navigation"}:
            return "Reusable components", "Motion + visual assets"
        return "Reusable components", "Other component references"
    if top == "Interface references":
        if leaf in {"Mac + native apps", "Mobile + touch apps"}:
            return "Interface references", "Product UI + native apps"
        return "Interface references", "Web apps + marketing"
    if top == "Reference libraries":
        if leaf == "Product UI galleries":
            return "Interface references", "Product UI + native apps"
        return "Interface references", "Design inspiration + brand"
    return "Design tools + people", None

EXCLUDED_HOSTS = {
    "chatgpt.com", "claude.ai", "chat.deepseek.com", "gemini.google.com",
    "google.com", "mail.google.com", "privateemail.com", "localhost",
}

KEYWORDS = re.compile(
    r"\b(ui|ux|design|interface|component|shadcn|tailwind|react|animation|motion|"
    r"gallery|inspiration|portfolio|studio|brand|editorial|dashboard|admin|canvas|"
    r"prototype|wireframe|layout|icon|typography|gradient|visual|creative|media|"
    r"video editor|asset|library|bookmark|finder|native app|mac app|ios app|"
    r"mobile app|landing page|website builder|design system|user flow)\b",
    re.I,
)


def pairs(values):
    return dict(zip(values[0::2], values[1::2]))


def title(node):
    tab = (node.get("data") or {}).get("tab") or {}
    return node.get("title") or tab.get("savedTitle") or "Untitled"


def url(node):
    return ((node.get("data") or {}).get("tab") or {}).get("savedURL") or ""


def host(value):
    try:
        return urlparse(value).hostname.lower().removeprefix("www.")
    except (AttributeError, ValueError):
        return ""


def is_kind(node, kind):
    return kind in (node.get("data") or {})


def load_catalog_context(design_root):
    known_hosts = set()
    licensed_hosts = set()
    component_hosts = set()
    host_groups = {}
    main_catalog_hosts = set()
    paths = [
        design_root / "source-discovery/2026-09-13-personal-design-sources/catalog.json",
        design_root / "source-discovery/2026-09-15-personal-product-design-sources/catalog.json",
    ]
    for path in paths:
        data = json.loads(path.read_text())
        for source in data.get("sources", []):
            source_host = (source.get("host") or host(source.get("source_url", ""))).removeprefix("www.")
            known_hosts.add(source_host)
            if source.get("browse_group"):
                host_groups[source_host] = source["browse_group"]
            elif source.get("categories"):
                host_groups.setdefault(source_host, " / ".join(source["categories"]))
    catalog = json.loads((design_root / "component-catalog/catalog.json").read_text())
    for source in catalog.get("sources", []):
        source_host = host(source.get("source_url", ""))
        if not source_host:
            continue
        known_hosts.add(source_host)
        main_catalog_hosts.add(source_host)
        if source.get("component_count", 0) and (source.get("coverage") or {}).get("status") != "reference_only":
            component_hosts.add(source_host)
        if source.get("component_count", 0) and (source.get("license") or {}).get("status") == "resolved":
            licensed_hosts.add(source_host)
    return known_hosts, licensed_hosts, component_hosts, host_groups, main_catalog_hosts


def category_for(text, item_host, licensed_hosts, component_hosts, host_groups):
    lower = text.lower()
    def has(*needles):
        return any(needle in lower for needle in needles)

    if item_host in licensed_hosts:
        return "Reusable components", "Open-source component libraries"
    if has("icon", "illustration", "mockup", "gradient", "typeface", "typography"):
        return "Reusable components", "Icons + visual assets"
    if has("gsap", "motion", "animation", "animated", "transition", "micro-interaction", "spring physics"):
        return "Reusable components", "Motion + interaction"
    if has("timeline", "video editor", "editing", "canvas", "node-based", "node based", "workflow editor"):
        return "Use in Expansion", "Editors + timelines + canvases"
    if has("media library", "asset", "creative workspace", "creative environment", "bookmark", "mymind", "flora", "sequence", "cosmos", "shotdeck", "visual library"):
        return "Use in Expansion", "Media libraries + creative workspaces"
    if has("finder", "raycast", "superlist", "atlas", "search", "filter", "data table", "file organizer", "dense", "gallery view"):
        return "Use in Expansion", "Search + filters + dense collections"
    if has("selection", "bulk action", "multi-select", "batch"):
        return "Use in Expansion", "Selection + bulk actions"
    if has("assistant ui", "agent interface", "agentic ui", "chat ui", "conversation", "ai work assistant"):
        return "Use in Expansion", "Chat + agent workspaces"
    if has("blueprint lifecycle", "declarative ui", "ui system architecture", "creative framework", "ui skill", "react doctor", "omni prompt"):
        return "Design tools", "Design systems + tokens"
    if item_host in {"grok.com", "chat.qwen.ai", "chatgpt.com", "claude.ai", "chat.deepseek.com", "gemini.google.com"}:
        return "Design tools", "Design systems + tokens"
    if has("social media", "media solutions", "content scheduler"):
        return "Use in Expansion", "Media libraries + creative workspaces"
    if has("ideogram", "profile pic"):
        return "Design tools", "AI design builders"
    if has("moma", "michael nowak"):
        return "Studios + people", "Individual designers"
    if has("future of software"):
        return "Interface references", "Web apps + dashboards"
    if item_host in component_hosts or has("component", "shadcn", "tailwind ui", "ui kit", "ui library", "blocks"):
        return "Reusable components", "Reference-only component sites"
    if has("macos", "mac app", "native app", "desktop app", "finder"):
        return "Interface references", "Mac + native apps"
    if has("ios", "mobile app", "app store", "swiftui", "touch"):
        return "Interface references", "Mobile + touch apps"
    if has("dashboard", "admin", "crm", "database", "analytics", "saas app", "web app"):
        return "Interface references", "Web apps + dashboards"
    if has("landing", "marketing", "homepage", "website", "saas", "conversion"):
        return "Interface references", "Marketing + landing pages"
    if has("brand", "logo", "editorial", "styleguide", "style guide", "deck", "email inspiration"):
        return "Reference libraries", "Brand + editorial"
    if has("motion gallery", "animation inspiration", "60fps"):
        return "Reference libraries", "Motion galleries"
    if has("mobbin", "refero", "collectui", "appshots", "pageflows", "game ui", "product ui", "screens design", "spotted in prod"):
        return "Reference libraries", "Product UI galleries"
    if has("inspiration", "gallery", "awwwards", "godly", "landingfolio", "one page", "web design"):
        return "Reference libraries", "Web design galleries"
    if has("ai designer", "ai design", "website builder", "app builder", "design copilot", "text to ui"):
        return "Design tools", "AI design builders"
    if has("figma", "prototype", "wireframe", "canvas", "framer", "spline", "webgl"):
        return "Design tools", "Prototyping + canvas"
    if has("design system", "tokens", "design.md", "ui guidelines", "responsive design"):
        return "Design tools", "Design systems + tokens"
    if has("portfolio", "designer", "design engineer"):
        return "Studios + people", "Individual designers"
    if has("studio", "agency", "design partner"):
        return "Studios + people", "Studios"
    group = host_groups.get(item_host, "").lower()
    if "creative and media" in group:
        return "Use in Expansion", "Media libraries + creative workspaces"
    if "mac and browser" in group:
        return "Interface references", "Mac + native apps"
    if "ai product" in group:
        return "Use in Expansion", "Chat + agent workspaces"
    if "product and business" in group:
        return "Interface references", "Web apps + dashboards"
    if "design resource" in group:
        return "Design tools", "Design systems + tokens"
    if "studios and portfolios" in group:
        return "Studios + people", "Studios"
    if any(label in group for label in ("ui inspo", "mobbin", "inspiration")):
        return "Reference libraries", "Product UI galleries"
    if any(label in group for label in ("ui libraries", "component", "design tools")):
        return "Reusable components", "Reference-only component sites"
    return "Interface references", "Web apps + dashboards"


def organize(source_path, report_path, design_root, apply=False):
    previous_report = json.loads(report_path.read_text()) if report_path.exists() else None
    document = json.loads(source_path.read_text())
    container = document["sidebar"]["containers"][1]
    item_list = container["items"]
    items = pairs(item_list)
    spaces = pairs(container["spaces"])
    personal_id, personal = next((key, value) for key, value in spaces.items() if value.get("title") == "Personal")
    container_ids = personal["containerIDs"]
    pinned_root = container_ids[container_ids.index("pinned") + 1]
    ui_root = next(child for child in items[pinned_root]["childrenIds"] if title(items[child]).lower() == "ui" and is_kind(items[child], "list"))

    parent = {item_id: node.get("parentID") for item_id, node in items.items()}
    paths = {}
    reachable = set()

    def visit(item_id, names):
        if item_id in reachable or item_id not in items:
            return
        reachable.add(item_id)
        paths[item_id] = names + [title(items[item_id])]
        for child in items[item_id].get("childrenIds", []):
            visit(child, paths[item_id])

    visit(pinned_root, ["Personal", "Pinned"])
    ui_descendants = set()

    def descendants(item_id):
        for child in items[item_id].get("childrenIds", []):
            ui_descendants.add(child)
            descendants(child)

    descendants(ui_root)
    known_hosts, licensed_hosts, component_hosts, host_groups, main_catalog_hosts = load_catalog_context(design_root)

    tab_decisions = []
    relevant_tabs = set()
    for item_id in sorted(reachable):
        node = items[item_id]
        if not is_kind(node, "tab"):
            continue
        item_url = url(node)
        item_host = host(item_url)
        text = " ".join([title(node), item_url, " / ".join(paths.get(item_id, []))])
        inside_ui = item_id in ui_descendants
        excluded = item_host in EXCLUDED_HOSTS and not inside_ui
        relevant = inside_ui or (not excluded and (item_host in known_hosts or bool(KEYWORDS.search(text))))
        source_classification = category_for(text, item_host, licensed_hosts, component_hosts, host_groups) if relevant else None
        classification = destination_for(source_classification) if source_classification else None
        if relevant:
            relevant_tabs.add(item_id)
        tab_decisions.append({
            "id": item_id,
            "title": title(node),
            "url": item_url,
            "host": item_host,
            "original_path": paths.get(item_id, []),
            "decision": "organize_in_ui" if relevant else "keep_in_place",
            "basis": "already_in_ui" if inside_ui else "catalog_or_design_match" if relevant else "not_a_ui_or_product_design_reference",
            "category": list(classification) if classification else None,
            "source_category": list(source_classification) if source_classification else None,
        })

    # A split view is moved as one unit so its relationship survives reorganization.
    units = {}
    for tab_id in relevant_tabs:
        unit_id = tab_id
        cursor = parent.get(tab_id)
        while cursor and cursor != pinned_root:
            if is_kind(items.get(cursor, {}), "splitView"):
                unit_id = cursor
                break
            cursor = parent.get(cursor)
        units.setdefault(unit_id, set()).add(tab_id)

    arc_epoch = time.time() - 978307200
    device = next((wrapper.get("lastChangedDevice") for wrapper in pairs(document["firebaseSyncState"]["syncData"]["items"]).values() if wrapper.get("lastChangedDevice")), None)
    changed = set()
    created = set()
    folder_pool = []
    def collect_folders(item_id):
        for child in items[item_id].get("childrenIds", []):
            if is_kind(items[child], "list"):
                folder_pool.append(child)
                collect_folders(child)
    collect_folders(ui_root)
    required_folder_count = len(TAXONOMY) + sum(map(len, TAXONOMY.values()))
    if len(folder_pool) != required_folder_count:
        raise RuntimeError(f"Arc's existing ui tree has {len(folder_pool)} reusable folders; this organization requires {required_folder_count}.")
    folder_ids = iter(folder_pool)

    def reuse_folder(folder_title, parent_id):
        item_id = next(folder_ids)
        items[item_id].update({"childrenIds": [], "parentID": parent_id, "title": folder_title})
        changed.add(item_id)
        return item_id

    top_ids = {}
    leaf_ids = {}
    for top, children in TAXONOMY.items():
        top_id = reuse_folder(top, ui_root)
        top_ids[top] = top_id
        for child_title in children:
            child_id = reuse_folder(child_title, top_id)
            items[top_id]["childrenIds"].append(child_id)
            items[child_id]["parentID"] = top_id
            leaf_ids[(top, child_title)] = child_id
            changed.update((top_id, child_id))

    # Remove moved units from old parents, then append them to their classified folder.
    moved_outside_ui = 0
    for unit_id, tab_ids in units.items():
        old_parent = items[unit_id].get("parentID")
        if old_parent in items:
            items[old_parent]["childrenIds"] = [child for child in items[old_parent].get("childrenIds", []) if child != unit_id]
            changed.add(old_parent)
        decisions = [row for row in tab_decisions if row["id"] in tab_ids]
        categories = [tuple(row["category"]) for row in decisions if row["category"]]
        category = max(set(categories), key=categories.count) if categories else ("Interface references", "Web apps + marketing")
        destination = top_ids[category[0]] if category[1] is None else leaf_ids[category]
        items[destination]["childrenIds"].append(unit_id)
        items[unit_id]["parentID"] = destination
        changed.update((destination, unit_id))
        if unit_id not in ui_descendants:
            moved_outside_ui += len(tab_ids)

    items[ui_root]["childrenIds"] = list(top_ids.values())
    for top_id in top_ids.values():
        items[top_id]["parentID"] = ui_root
    changed.add(ui_root)

    # Preserve the alternating key/value format used by Arc.
    original_order = item_list[0::2]
    container["items"] = [part for item_id in original_order + [item_id for item_id in created if item_id not in original_order] for part in (item_id, items[item_id])]

    sync_list = document["firebaseSyncState"]["syncData"]["items"]
    sync_items = pairs(sync_list)
    for item_id in changed | created:
        wrapper = sync_items.get(item_id, {})
        wrapper.update({"lastChangedDevice": device, "lastChangeDate": arc_epoch, "value": copy.deepcopy(items[item_id])})
        sync_items[item_id] = wrapper
    sync_order = sync_list[0::2]
    document["firebaseSyncState"]["syncData"]["items"] = [part for item_id in sync_order + [item_id for item_id in created if item_id not in sync_order] for part in (item_id, sync_items[item_id])]

    counts = {}
    for row in tab_decisions:
        if row["category"]:
            key = " / ".join(part for part in row["category"] if part)
            counts[key] = counts.get(key, 0) + 1
    report = {
        "schema": "design-systems.arc-personal-ui-organization/1",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": str(source_path),
        "personal_space_id": personal_id,
        "personal_tab_count": len(tab_decisions),
        "organized_tab_count": len(relevant_tabs),
        "moved_from_outside_ui": moved_outside_ui,
        "kept_in_place_count": len(tab_decisions) - len(relevant_tabs),
        "category_counts": dict(sorted(counts.items())),
        "taxonomy": TAXONOMY,
        "relevant_hosts": sorted({row["host"] for row in tab_decisions if row["decision"] == "organize_in_ui" and row["host"]}),
        "catalog_missing_hosts": sorted({row["host"] for row in tab_decisions if row["decision"] == "organize_in_ui" and row["host"] and row["host"] not in main_catalog_hosts}),
        "tabs": tab_decisions,
    }
    if previous_report and previous_report.get("applied"):
        report["first_applied_run"] = previous_report.get("first_applied_run") or {
            key: previous_report.get(key) for key in (
                "generated_at", "personal_tab_count", "organized_tab_count",
                "moved_from_outside_ui", "kept_in_place_count", "category_counts", "backup"
            )
        }
    report_path.write_text(json.dumps(report, indent=2) + "\n")

    if apply:
        backup = source_path.with_name(source_path.name + ".before-ui-organization-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
        shutil.copy2(source_path, backup)
        with tempfile.NamedTemporaryFile("w", dir=source_path.parent, delete=False) as handle:
            json.dump(document, handle, separators=(",", ":"))
            handle.write("\n")
            temporary = Path(handle.name)
        json.loads(temporary.read_text())
        os.replace(temporary, source_path)
        report["backup"] = str(backup)
        report["applied"] = True
        report_path.write_text(json.dumps(report, indent=2) + "\n")
    else:
        report["applied"] = False
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--source", type=Path, default=ARC_PATH)
    parser.add_argument("--restore-from", type=Path)
    parser.add_argument("--design-root", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.restore_from:
        restored = json.loads(args.restore_from.read_text())
        with tempfile.NamedTemporaryFile("w", dir=args.source.parent, delete=False) as handle:
            json.dump(restored, handle, separators=(",", ":"))
            handle.write("\n")
            temporary = Path(handle.name)
        os.replace(temporary, args.source)
        print(json.dumps({"restored": str(args.restore_from), "source": str(args.source)}))
        return
    result = organize(args.source, args.report, args.design_root, args.apply)
    print(json.dumps({key: result[key] for key in ("personal_tab_count", "organized_tab_count", "moved_from_outside_ui", "kept_in_place_count", "category_counts")}, indent=2))


if __name__ == "__main__":
    main()
