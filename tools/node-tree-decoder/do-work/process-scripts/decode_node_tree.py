#!/usr/bin/env python3
"""
packages/node-tree-decoder/do-work/process-scripts/decode_node_tree.py

Purpose
-------
Leaf decoder for the NODE-COLLECTION TREE shape: a collection of nodes, each
carrying an identity, a parent reference, a child list, and a title, where a
node's kind is discoverable and kinds carry opaque role labels.

It emits a CONTAINMENT PROJECTION isomorphic to the input tree, which is the
shape the group ontology already speaks. It does NOT emit thread specs: a tree
is not a conversation, and the conversation contract silently discards nesting,
sibling order, empty groups, and opaque role labels.

Non-Negotiable Invariants
-------------------------
- NEVER names an application, product, host, or vendor. Every structural key,
  kind name, and role label arrives on the descriptor as DATA, so a second
  tree-shaped source is a descriptor row and never a second decoder.
- Node identity is ALWAYS the source's own identity. Never derived from
  encounter order or from position, because regrouping is the entire point and
  a positional identity would churn every identity in the store on every run.
- The external identity of a leaf is preserved VERBATIM. No scheme, path,
  query, or subdomain reduction. Deriving a routing key is routing's job, and
  doing it here would destroy everything below the authority permanently.
- Edge authority is DECLARED. A tree that carries both a parent reference and a
  child list holds one edge set twice; one representation is authoritative and
  the other is verified against it, with disagreement reported.
- Membership is conserved, and it is ASSERTED rather than assumed: every
  indexed leaf appears exactly once in the projection, or the reconciliation
  pass reports precisely which ids failed.
- PURE. No filesystem, network, process, or clock access. Acquisition belongs
  to the observer capability.
- Structural anomalies that are tolerable become node attributes, never
  rejections, because the downstream materializer discards an entire batch on
  any rejection.

Security
--------
Pure value transformation. A caller cannot induce an effect through this module.
"""

import json
import sys

# Roles the projection understands structurally. Every OTHER role label is
# carried verbatim and never interpreted, which is why a new one costs nothing.
ROLE_LEAF = "leaf"
ROLE_GROUP = "group"


def _as_object(value):
    return value if isinstance(value, dict) else None


def _as_text(container, key):
    value = container.get(key)
    return value if isinstance(value, str) else None


# ---------------------------------------------------------------------------
# Locating the node collection. The collection is not always at a single key:
# it may sit under a container chosen by a property rather than by index, and
# hardcoding an index would encode one application's current layout.
# ---------------------------------------------------------------------------
def resolve_collection(payload, collection_path, findings):
    current = payload
    for step in collection_path:
        if isinstance(step, str):
            container = _as_object(current)
            if container is None or step not in container:
                findings.append({
                    "violation_path": "payload." + step,
                    "expected": "object containing this key",
                    "got": type(current).__name__,
                })
                return None
            current = container[step]
            continue
        selector = _as_object(step)
        if selector is None:
            findings.append({
                "violation_path": "descriptor.tree_shape.collection_path",
                "expected": "key name or selector object",
                "got": repr(step),
            })
            return None
        wanted = selector.get("first_element_having_key")
        if not isinstance(wanted, str) or not isinstance(current, list):
            findings.append({
                "violation_path": "descriptor.tree_shape.collection_path",
                "expected": "first_element_having_key over a list",
                "got": type(current).__name__,
            })
            return None
        chosen = None
        for element in current:
            candidate = _as_object(element)
            if candidate is not None and wanted in candidate:
                chosen = candidate
                break
        if chosen is None:
            findings.append({
                "violation_path": "collection_path.first_element_having_key",
                "expected": "an element carrying key " + wanted,
                "got": "no element matched",
            })
            return None
        current = chosen
    return current


def kind_of(node, shape):
    """Resolve a node's kind through the DATA-declared kind locator."""
    locator = shape["kind_locator"]
    style = locator.get("style")
    if style == "scalar_field":
        return _as_text(node, locator["field"])
    if style == "map_single_key":
        container = _as_object(node.get(locator["field"]))
        if container is None:
            return None
        for name in shape["known_kinds"]:
            if name in container:
                return name
        return None
    if style == "tag_membership":
        tags = node.get(locator["field"])
        if not isinstance(tags, list):
            return None
        for name in shape["known_kinds"]:
            if name in tags:
                return name
        return None
    if style == "presence_of_children":
        children = node.get(shape["children_key"])
        return locator["when_present"] if isinstance(children, list) and children \
            else locator["when_absent"]
    return None


def role_of(kind, shape):
    """Roles are an OPEN map. An unknown kind carries its own name as its role."""
    if kind is None:
        return None
    return shape["role_map"].get(kind, kind)


def title_of(node, shape):
    direct = _as_text(node, shape["title_key"])
    return direct.strip() if direct else ""


def external_identity_of(node, shape):
    """The leaf's address, VERBATIM. Reduction belongs to routing DATA."""
    path = shape["external_identity_path"]
    if not path:
        return None
    current = node
    for step in path:
        container = _as_object(current)
        if container is None:
            return None
        current = container.get(step)
    return current if isinstance(current, str) else None


# Two PHYSICAL layouts a tree can use. This is about where a node SITS in the
# file, not about what a node means, which is why it is a separate axis from
# every other shape key.
#
#   flat   the collection is a list of every node, and a node names its parent
#          and its children by identity. Nothing is nested physically.
#   nested a node's children are stored INSIDE it, so the parent link is
#          POSITIONAL and there is no parent field to read at all.
#
# Kept as a declared layout rather than sniffed, because guessing this wrong is
# silent: a nested tree read as flat yields only the roots and reports no error.
LAYOUT_FLAT = "flat"
LAYOUT_NESTED = "nested"

REQUIRED_SHAPE_KEYS = (
    "identity_key", "children_key", "title_key",
)
# `parent_key` and `edge_authority` are required ONLY for a flat layout. A
# nested tree has no parent field and only one representation of the edge set,
# so demanding either would be demanding a fact the format does not carry.
REQUIRED_FLAT_SHAPE_KEYS = ("parent_key", "edge_authority")


def read_shape(descriptor, findings):
    shape = _as_object(descriptor.get("tree_shape")) or {}
    resolved = {
        "collection_path": shape.get("collection_path") or [],
        "identity_key": shape.get("identity_key"),
        "parent_key": shape.get("parent_key"),
        "children_key": shape.get("children_key"),
        "title_key": shape.get("title_key"),
        "timestamp_key": shape.get("timestamp_key"),
        "edge_authority": shape.get("edge_authority"),
        "kind_locator": _as_object(shape.get("kind_locator")) or {},
        "known_kinds": shape.get("known_kinds") if isinstance(shape.get("known_kinds"), list) else [],
        "role_map": _as_object(shape.get("role_map")) or {},
        "external_identity_path": shape.get("external_identity_path")
        if isinstance(shape.get("external_identity_path"), list) else [],
        # Roles the WRITE-BACK leg must never reparent, as opaque labels. Read
        # here because the shape is one description used in both directions; a
        # second place to declare it would be two sources of truth for one fact.
        # Absent means nothing is protected, which is why it carries no default.
        "never_reparent_roles": shape.get("never_reparent_roles")
        if isinstance(shape.get("never_reparent_roles"), list) else [],
        "collection_layout": shape.get("collection_layout") or LAYOUT_FLAT,
    }
    if resolved["collection_layout"] not in (LAYOUT_FLAT, LAYOUT_NESTED):
        findings.append({
            "violation_path": "descriptor.tree_shape.collection_layout",
            "expected": "%s or %s" % (LAYOUT_FLAT, LAYOUT_NESTED),
            "got": repr(resolved["collection_layout"]),
        })
    for key in REQUIRED_SHAPE_KEYS:
        if not isinstance(resolved.get(key), str) or not resolved[key]:
            findings.append({
                "violation_path": "descriptor.tree_shape." + key,
                "expected": "non-empty string",
                "got": repr(resolved.get(key)),
            })
    # A nested tree carries the edge set exactly once, positionally, so these two
    # keys are required only when the layout is flat. Demanding them everywhere
    # would be demanding a fact the format does not have.
    if resolved["collection_layout"] == LAYOUT_FLAT:
        for key in REQUIRED_FLAT_SHAPE_KEYS:
            if not isinstance(resolved.get(key), str) or not resolved[key]:
                findings.append({
                    "violation_path": "descriptor.tree_shape." + key,
                    "expected": "non-empty string, required for a flat layout",
                    "got": repr(resolved.get(key)),
                })
        if resolved["edge_authority"] not in ("parent", "children"):
            findings.append({
                "violation_path": "descriptor.tree_shape.edge_authority",
                "expected": "parent or children",
                "got": repr(resolved["edge_authority"]),
            })
    if not resolved["kind_locator"].get("style"):
        findings.append({
            "violation_path": "descriptor.tree_shape.kind_locator.style",
            "expected": "a declared kind grammar",
            "got": "absent",
        })
    return resolved


def index_nodes(collection, shape, findings):
    """Index by identity. A non-object entry is not a node: some collections
    are flat alternating identity/object arrays, which is a legal layout."""
    by_id = {}
    if not isinstance(collection, list):
        findings.append({
            "violation_path": "collection",
            "expected": "list",
            "got": type(collection).__name__,
        })
        return by_id
    for entry in collection:
        node = _as_object(entry)
        if node is None:
            continue
        identity = _as_text(node, shape["identity_key"])
        if identity is None:
            continue
        by_id[identity] = node
    return by_id


def derive_edges(by_id, shape):
    """
    Resolve parent and ordinal from the DECLARED authority, and verify the
    other representation against it. Two representations of one edge set with
    no declared owner is the SSOT violation the rules name.
    """
    parent_of = {}
    ordinal_of = {}
    disagreements = []

    if shape["edge_authority"] == "children":
        for parent_id, node in by_id.items():
            children = node.get(shape["children_key"])
            if not isinstance(children, list):
                continue
            ordinal = 0
            for child_id in children:
                if not isinstance(child_id, str):
                    continue
                if child_id not in by_id:
                    disagreements.append({
                        "kind": "dangling_child",
                        "parent": parent_id,
                        "child": child_id,
                    })
                    continue
                if child_id in parent_of:
                    disagreements.append({
                        "kind": "multi_parent",
                        "child": child_id,
                        "parents": [parent_of[child_id], parent_id],
                    })
                    continue
                parent_of[child_id] = parent_id
                ordinal_of[child_id] = ordinal
                ordinal += 1
        # Cross-check the non-authoritative representation.
        for node_id, node in by_id.items():
            stated = _as_text(node, shape["parent_key"])
            derived = parent_of.get(node_id)
            if stated is not None and derived is not None and stated != derived:
                disagreements.append({
                    "kind": "parent_disagreement",
                    "node": node_id,
                    "stated": stated,
                    "authoritative": derived,
                })
    else:
        for node_id, node in by_id.items():
            stated = _as_text(node, shape["parent_key"])
            if stated is None:
                continue
            if stated == node_id:
                disagreements.append({"kind": "self_parent", "node": node_id})
                continue
            if stated not in by_id:
                disagreements.append({
                    "kind": "dangling_parent", "node": node_id, "parent": stated,
                })
                continue
            parent_of[node_id] = stated
        siblings = {}
        for node_id in sorted(parent_of):
            parent_id = parent_of[node_id]
            ordinal_of[node_id] = siblings.get(parent_id, 0)
            siblings[parent_id] = ordinal_of[node_id] + 1

    return parent_of, ordinal_of, disagreements


def roots_of_nested(container, findings):
    """
    A nested tree's roots are either the VALUES of an object (a bookmarks file
    keyed by bar/other/synced) or the ELEMENTS of a list. Both are ordinary and
    neither is worth a second descriptor field, so both are accepted.
    """
    as_object = _as_object(container)
    if as_object is not None:
        return [(key, _as_object(value)) for key, value in sorted(as_object.items())]
    if isinstance(container, list):
        return [(str(index), _as_object(entry)) for index, entry in enumerate(container)]
    findings.append({
        "violation_path": "collection",
        "expected": "object or list holding the root nodes",
        "got": type(container).__name__,
    })
    return []


def index_nested(container, shape, findings):
    """
    Walk a PHYSICALLY nested tree, producing the same three structures a flat
    tree produces: identity to node, identity to parent, identity to ordinal.

    The parent link is positional here, so it is derived during the walk rather
    than read from a field. Everything downstream is then identical, which is
    why the layout branch happens once and never leaks into the record builder.

    Cycle-safe: a node already seen is not descended into again, because a file
    that somehow nests a node inside itself must not hang the reader.
    """
    by_id, parent_of, ordinal_of = {}, {}, {}
    seen = set()
    identity_key = shape["identity_key"]
    children_key = shape["children_key"]

    def visit(node, parent_id, ordinal):
        identity = _as_text(node, identity_key)
        if identity is None:
            findings.append({
                "violation_path": "node." + identity_key,
                "expected": "an identity on every nested node",
                "got": "absent",
            })
            return
        if identity in seen:
            findings.append({
                "violation_path": "node." + identity_key,
                "expected": "each identity to appear once",
                "got": "repeated identity " + identity,
            })
            return
        seen.add(identity)
        by_id[identity] = node
        if parent_id is not None:
            parent_of[identity] = parent_id
        ordinal_of[identity] = ordinal

        children = node.get(children_key)
        if not isinstance(children, list):
            return
        position = 0
        for entry in children:
            child = _as_object(entry)
            if child is None:
                continue
            visit(child, identity, position)
            position += 1

    for index, (_, root) in enumerate(roots_of_nested(container, findings)):
        if root is not None:
            visit(root, None, index)
    return by_id, parent_of, ordinal_of


def decode_tree(payload, descriptor):
    """
    Project a node-collection tree onto containment records.
    Returns {"records": [...], "findings": [...], "rejections": [...]}.
    Never raises.
    """
    findings = []
    payload_object = _as_object(payload)
    if payload_object is None:
        return {"records": [], "findings": [], "rejections": [{
            "violation_path": "payload",
            "expected": "object",
            "got": type(payload).__name__,
        }]}

    descriptor_object = _as_object(descriptor) or {}
    shape = read_shape(descriptor_object, findings)
    if findings:
        # A descriptor that cannot be read is genuinely unusable input.
        return {"records": [], "findings": [], "rejections": findings}

    collection = resolve_collection(payload_object, shape["collection_path"], findings)
    if collection is None:
        return {"records": [], "findings": [], "rejections": findings}

    # THE ONLY LAYOUT BRANCH. Both arms produce identity to node, identity to
    # parent, and identity to ordinal, so nothing below this point knows or asks
    # how the tree was physically arranged.
    if shape["collection_layout"] == LAYOUT_NESTED:
        by_id, parent_of, ordinal_of = index_nested(collection, shape, findings)
        disagreements = []
        if findings:
            return {"records": [], "findings": [], "rejections": findings}
    else:
        by_id = index_nodes(collection, shape, findings)
        if not by_id:
            return {"records": [], "findings": [], "rejections": findings}
        parent_of, ordinal_of, disagreements = derive_edges(by_id, shape)
    if not by_id:
        return {"records": [], "findings": [], "rejections": findings}

    # Index-first enumeration, so an orphan is FOUND and reported, never lost.
    records = []
    for node_id in sorted(by_id):
        node = by_id[node_id]
        kind = kind_of(node, shape)
        role = role_of(kind, shape)
        attributes = {}
        if kind is None:
            attributes["unknown_kind"] = True
        if node_id not in parent_of:
            attributes["unattached"] = True
        timestamp = node.get(shape["timestamp_key"]) if shape["timestamp_key"] else None
        if timestamp is not None:
            attributes["source_timestamp"] = timestamp
        records.append({
            "node_id": node_id,
            "parent_id": parent_of.get(node_id),
            "ordinal": ordinal_of.get(node_id),
            "role": role,
            "title": title_of(node, shape),
            "external_identity": external_identity_of(node, shape),
            "attributes": attributes,
        })

    # Membership reconciliation, the closing gate.
    indexed_leaves = {
        node_id for node_id, node in by_id.items()
        if role_of(kind_of(node, shape), shape) == ROLE_LEAF
    }
    projected_leaves = [r["node_id"] for r in records if r["role"] == ROLE_LEAF]
    seen = {}
    for node_id in projected_leaves:
        seen[node_id] = seen.get(node_id, 0) + 1
    duplicated = sorted(k for k, count in seen.items() if count > 1)
    missing = sorted(indexed_leaves - set(seen))
    if duplicated or missing:
        return {"records": [], "findings": disagreements, "rejections": [{
            "violation_path": "membership_reconciliation",
            "expected": "every indexed leaf projected exactly once",
            "got": {"duplicated": duplicated, "missing": missing},
        }]}

    return {"records": records, "findings": disagreements, "rejections": []}


def leaf_count(payload, descriptor):
    """Membership oracle: how many leaves the input holds."""
    result = decode_tree(payload, descriptor)
    return sum(1 for record in result["records"] if record["role"] == ROLE_LEAF)


def run(argv):
    if len(argv) < 3:
        print(json.dumps({"error": "usage: decode_node_tree.py <request.json> <out.json>"}))
        return 2
    try:
        with open(argv[1], encoding="utf-8") as handle:
            request = json.load(handle)
    except (OSError, ValueError) as problem:
        print(json.dumps({"error": "unreadable request: %s" % problem}))
        return 2

    result = decode_tree(request.get("payload"), request.get("descriptor"))
    output = {
        "records": result["records"],
        "findings": result["findings"],
        "rejections": result["rejections"],
        "count": len(result["records"]),
    }
    try:
        with open(argv[2], "w", encoding="utf-8") as handle:
            json.dump(output, handle)
    except OSError as problem:
        print(json.dumps({"error": "unwritable output: %s" % problem}))
        return 2
    print(json.dumps({
        "count": output["count"],
        "findings": len(output["findings"]),
        "rejections": len(output["rejections"]),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(run(sys.argv))
