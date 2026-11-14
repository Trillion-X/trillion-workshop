#!/usr/bin/env python3
"""Add public Arc design/product sources to the component catalog as references."""

import argparse
import json
from pathlib import Path
import subprocess
from urllib.parse import urlparse

EXCLUDED = {
    "127.0.0.1", "alabamadl.alea.gov", "app.liner.com", "apps.apple.com",
    "artsandculture.google.com", "chat.deepseek.com", "chat.qwen.ai",
    "chatgpt.com", "claude.ai", "docs.quiver.ai", "figma.com",
    "flat-quiver-544.notion.site", "gemini.google.com", "github.com",
    "google.com", "grok.com", "reddit.com", "t.co", "x.com",
}


def slug(host):
    return host.replace(".", "-")


def blake3(path):
    return subprocess.check_output(["/opt/homebrew/bin/b3sum", str(path)], text=True).split()[0]


def clean_json(value):
    if isinstance(value, str):
        return value.encode("utf-8", "replace").decode("utf-8")
    if isinstance(value, list):
        return [clean_json(item) for item in value]
    if isinstance(value, dict):
        return {clean_json(key): clean_json(item) for key, item in value.items()}
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--arc-report", type=Path, required=True)
    parser.add_argument("--catalog-root", type=Path, required=True)
    parser.add_argument("--discovery-root", type=Path, required=True)
    args = parser.parse_args()
    report = json.loads(args.arc_report.read_text())
    catalog = json.loads((args.catalog_root / "catalog.json").read_text())
    source_count_before = catalog["source_count"]
    catalog_hosts = {urlparse(source["source_url"]).hostname.removeprefix("www.") for source in catalog["sources"]}
    rows_by_host = {}
    for row in report["tabs"]:
        if row.get("decision") == "organize_in_ui" and row.get("host"):
            rows_by_host.setdefault(row["host"], []).append(row)
    selected = sorted(set(rows_by_host) - catalog_hosts - EXCLUDED)
    args.discovery_root.mkdir(parents=True, exist_ok=True)
    additions_path = args.catalog_root / "additional-sources.json"
    additions = json.loads(additions_path.read_text())
    by_id = {row["id"]: row for row in additions}
    new_slugs = set()
    for source_host in selected:
        source_slug = slug(source_host)
        new_slugs.add(source_slug)
        rows = rows_by_host[source_host]
        source_url = f"https://{source_host}/"
        evidence_path = args.discovery_root / f"{source_slug}.json"
        evidence = {
            "schema": "design-systems.arc-saved-source-reference/1",
            "host": source_host,
            "source_url": source_url,
            "selection_basis": "Public product or design source saved in Arc Personal and organized under ui.",
            "saved_tabs": [{key: row[key] for key in ("title", "url", "category", "original_path")} for row in rows],
            "license_status": "unresolved",
            "component_index_status": "reference_only",
        }
        evidence_path.write_text(json.dumps(evidence, indent=2) + "\n")
        identity = blake3(evidence_path)
        by_id[source_host] = {
            "id": source_host,
            "urls": [source_url],
            "observed_in": ["Arc Personal organized UI references, 2026-09-17"],
            "components": [],
            "reuse_status": "not_reviewed",
            "license_status": "unresolved",
        }
        shard = {
            "schema": "design-systems.source-component-inventory/1",
            "source_slug": source_slug,
            "source_url": source_url,
            "enumerated_at": "2026-09-17",
            "discovery_method": "Saved public product/design reference in Arc Personal; homepage normalized without claiming code reuse.",
            "upstream_revision": None,
            "license": {"status": "unresolved", "spdx": None, "evidence": None},
            "coverage": {
                "status": "reference_only",
                "basis": "Saved-site reference only; no component inventory or reuse right is claimed.",
                "unresolved": ["Live component inventory and reuse rights have not been verified."],
            },
            "evidence": [{"path": str(evidence_path), "blake3": identity}],
            "components": [{
                "id": f"{source_slug}/saved-site",
                "name": rows[0]["title"],
                "kind": "reference",
                "url": rows[0]["url"],
                "tags": [part for part in rows[0]["category"] if part],
                "evidence_path": str(evidence_path),
            }],
        }
        (args.catalog_root / "shards" / f"{source_slug}.json").write_text(json.dumps(shard, indent=2) + "\n")
    additions_path.write_text(json.dumps(sorted(by_id.values(), key=lambda row: row["id"]), indent=2) + "\n")

    # Merge only the new reference shards into the existing bounded catalog.
    # The full builder remains authoritative for its older inventories.
    sources = [source for source in catalog["sources"] if (source.get("source_slug") or source.get("slug")) not in new_slugs]
    components = [component for component in catalog["components"] if component.get("source_slug") not in new_slugs]
    for source_host in selected:
        source_slug = slug(source_host)
        shard_path = args.catalog_root / "shards" / f"{source_slug}.json"
        shard = json.loads(shard_path.read_text())
        shard_components = shard.pop("components")
        sources.append({**shard, "component_count": len(shard_components), "shard_path": str(shard_path)})
        for component in shard_components:
            components.append({
                **component,
                "source_slug": source_slug,
                "source_home": shard["source_url"],
                "source_license": shard["license"],
                "coverage": shard["coverage"]["status"],
            })
    catalog["sources"] = sorted(sources, key=lambda source: source.get("source_slug") or source.get("slug") or "")
    catalog["components"] = sorted(components, key=lambda component: component["id"])
    catalog["source_count"] = len(catalog["sources"])
    catalog["component_count"] = len(catalog["components"])
    catalog = clean_json(catalog)
    (args.catalog_root / "catalog.json").write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
    (args.catalog_root / "components.jsonl").write_text("\n".join(json.dumps(component, ensure_ascii=False) for component in catalog["components"]) + "\n")
    coverage = clean_json([{
        "source_slug": source.get("source_slug") or source.get("slug"),
        "source_url": source["source_url"],
        "component_count": source.get("component_count", 0),
        "coverage": source.get("coverage"),
    } for source in catalog["sources"]])
    (args.catalog_root / "coverage.json").write_text(json.dumps(coverage, indent=2, ensure_ascii=False) + "\n")
    result = {
        "added_hosts": selected,
        "excluded_generic_or_private_hosts": sorted((set(rows_by_host) - catalog_hosts) & EXCLUDED),
        "source_count_before": source_count_before,
        "source_count_after": catalog["source_count"],
        "component_count_after": catalog["component_count"],
    }
    (args.discovery_root / "catalog-additions.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
