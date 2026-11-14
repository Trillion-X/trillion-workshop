#!/usr/bin/env python3
# packages/node-tree-decoder/do-work/process-scripts/encode_node_tree.py
#
# PURPOSE
# The INVERSE of decode_node_tree.py: take a containment projection whose edges
# have been changed by whatever owns grouping, and write those edges back into
# the tree's own shape, leaving everything else exactly as it was found.
#
# Decoding alone is half a capability. A tree that can be read but not written
# is a report, and the job here is regrouping. Both directions are driven by the
# SAME `tree_shape` DATA row, which is the whole reason this belongs beside the
# decoder rather than in a separate package: the shape is one description, and a
# second description of the same shape would be the SSOT violation the rules
# name. A new tree-shaped source gains write-back for free, with no code.
#
# NON-NEGOTIABLE INVARIANTS
#   E1. NEVER INVENT BY ACCIDENT, NEVER DROP. The projection's node set and the
#       tree's node set must be identical, except for nodes the projection
#       explicitly asks to materialize. A mismatch is REFUSED rather than
#       reconciled, because silently reconciling a mismatch is how a regrouping
#       loses somebody's data. Regrouping into a group that does not exist yet
#       is the ordinary case, so creation is supported, but it is DECLARED per
#       node through a `materialize` spec. An undeclared unknown identity is
#       still a refusal. Dropping is never supported: this owner has no delete,
#       so a defect here cannot destroy a node.
#   E2. ONLY EDGES CHANGE. Exactly two keys are written: the parent key and the
#       children key. Every other field of every node is left untouched, so a
#       field this decoder never modelled cannot be destroyed by writing.
#   E3. BOTH REPRESENTATIONS STAY TRUE. The source carries the edge set twice.
#       Decoding declares one authoritative; WRITING must update both, or the
#       file is left internally inconsistent and the owning application will
#       believe whichever one this did not write.
#   E4. ORDER IS THE ORDINAL. Children are written in ascending ordinal, because
#       in this shape array position IS the order.
#   E5. PROTECTED ROLES ARE NOT REPARENTED. Roles named by DATA (a split pair,
#       for example) are structural to the owning application. A change touching
#       one is refused, never silently applied.
#   E6. IN-PLACE ON A CALLER'S COPY. This mutates the payload it is given. The
#       caller owns backup and atomic replacement; this owns correctness.
#
# SECURITY
# Pure in-memory transformation. No filesystem, network, process or clock access.

import json
import sys

_HERE = __file__.rsplit("/", 1)[0]
sys.path.insert(0, _HERE)

from decode_node_tree import (  # noqa: E402
    _as_object,
    _as_text,
    index_nodes,
    read_shape,
    resolve_collection,
    role_of,
    kind_of,
)


class EncodeRefusal(Exception):
    """Raised when writing would violate an invariant. Carries structured detail."""

    def __init__(self, reason, detail):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail

    def as_dict(self):
        return {"refused": self.reason, "detail": self.detail}


def apply_containment(payload, descriptor, records):
    """
    Write a containment projection back into `payload`.

    `records` carry `node_id`, `parent_id` and `ordinal`. Any other field a
    record holds is ignored here: this owns edges and nothing else (E2).

    Returns a receipt describing exactly what changed.
    """
    findings = []
    shape = read_shape(descriptor, findings)
    if shape is None:
        raise EncodeRefusal("shape_unreadable", findings)

    collection = resolve_collection(payload, shape["collection_path"], findings)
    if collection is None:
        raise EncodeRefusal("collection_unresolvable", findings)

    # A nested tree stores children INSIDE their parent, so writing it back means
    # rebuilding the nesting rather than rewriting two id lists. Same invariants,
    # different physical move, so it branches once here.
    if shape["collection_layout"] == "nested":
        return _apply_nested(collection, shape, records, findings)

    by_id = index_nodes(collection, shape, findings)

    # E0. AN OBJECT THIS CANNOT IDENTIFY IS THE MOST DANGEROUS THING IN THE
    # COLLECTION, so it is refused before anything else is considered.
    #
    # `index_nodes` skips any object without the identity key, which is correct
    # for reading: a flat alternating array legitimately holds bare identity
    # entries. But WRITING rebuilds each parent's child list from the projection
    # alone, so a real node that was skipped would silently disappear from its
    # parent's children and be orphaned. Membership conservation cannot catch it,
    # because the skipped node never entered either side of that comparison.
    #
    # This happens for real: a tree can store some nodes as `{id, ...}` and
    # others wrapped as `{value: {id, ...}}`, and a shape describing only the
    # first reads the second as "not a node" in both directions.
    unidentifiable = [
        entry for entry in collection
        if _as_object(entry) is not None
        and _as_text(_as_object(entry), shape["identity_key"]) is None
    ]
    if unidentifiable:
        raise EncodeRefusal(
            "collection_holds_objects_this_shape_cannot_identify",
            {
                "count": len(unidentifiable),
                "identity_key": shape["identity_key"],
                "first_keys": sorted(list(_as_object(unidentifiable[0]).keys()))[:12],
                "why": "writing would rebuild child lists without them and orphan them",
            },
        )

    # E1. Membership conservation, checked in BOTH directions before any write.
    projected = [r["node_id"] for r in records]
    duplicates = sorted({n for n in projected if projected.count(n) > 1})
    if duplicates:
        raise EncodeRefusal("projection_has_duplicate_identities", duplicates[:20])

    projected_set = set(projected)
    tree_set = set(by_id)
    declared_new = {
        r["node_id"] for r in records
        if _as_object(r.get("materialize")) is not None
    }
    invented = sorted(projected_set - tree_set - declared_new)
    dropped = sorted(tree_set - projected_set)
    if invented:
        raise EncodeRefusal("projection_names_nodes_absent_from_the_tree", invented[:20])
    if dropped:
        raise EncodeRefusal("projection_omits_nodes_present_in_the_tree", dropped[:20])

    # A declaration to materialize an identity the tree ALREADY holds is a
    # collision, not a creation. Writing it would silently overwrite a real node.
    colliding = sorted(declared_new & tree_set)
    if colliding:
        raise EncodeRefusal("materialize_collides_with_an_existing_identity",
                            colliding[:20])

    created = []
    for record in records:
        spec = _as_object(record.get("materialize"))
        if spec is None:
            continue
        node = _materialize(record, spec, shape, collection)
        by_id[record["node_id"]] = node
        created.append(record["node_id"])

    parent_key = shape["parent_key"]
    children_key = shape["children_key"]
    protected = set(shape.get("never_reparent_roles") or [])

    # E5. Refuse before writing anything, so a refusal never leaves a half-write.
    if protected:
        for record in records:
            node = by_id[record["node_id"]]
            current_parent = _as_text(node, parent_key)
            desired_parent = record.get("parent_id")
            if current_parent == desired_parent:
                continue
            role = role_of(kind_of(node, shape), shape)
            if role in protected:
                raise EncodeRefusal(
                    "change_would_reparent_a_protected_role",
                    {"node_id": record["node_id"], "role": role},
                )
            parent_node = _as_object(by_id.get(current_parent)) if current_parent else None
            if parent_node is not None:
                parent_role = role_of(kind_of(parent_node, shape), shape)
                if parent_role in protected:
                    raise EncodeRefusal(
                        "change_would_remove_a_member_from_a_protected_role",
                        {"node_id": record["node_id"], "held_by_role": parent_role},
                    )

    # Build the desired child lists, ordered by ordinal (E4).
    children_of = {}
    reparented = []
    reordered = []
    for record in records:
        node = by_id[record["node_id"]]
        desired_parent = record.get("parent_id")
        if _as_text(node, parent_key) != desired_parent:
            reparented.append(record["node_id"])
        if desired_parent is None:
            continue
        ordinal = record.get("ordinal")
        children_of.setdefault(desired_parent, []).append(
            (ordinal if isinstance(ordinal, int) else 1 << 62, record["node_id"])
        )

    for parent_id in children_of:
        children_of[parent_id].sort(key=lambda pair: (pair[0], pair[1]))

    # E3. Write BOTH representations. Parent first, then the child lists.
    for record in records:
        node = by_id[record["node_id"]]
        if parent_key in node or record.get("parent_id") is not None:
            node[parent_key] = record.get("parent_id")

    for node_id, node in by_id.items():
        if children_key not in node:
            continue
        desired = [child for _, child in children_of.get(node_id, [])]
        if list(node.get(children_key) or []) != desired:
            reordered.append(node_id)
        node[children_key] = desired

    return {
        "nodes_in_tree": len(by_id),
        "nodes_in_projection": len(records),
        "created": sorted(created),
        "created_count": len(created),
        "reparented": sorted(set(reparented)),
        "parents_whose_child_order_changed": sorted(set(reordered)),
        "reparented_count": len(set(reparented)),
        "findings": findings,
    }


def _apply_nested(collection, shape, records, findings):
    """
    Write a projection back into a PHYSICALLY nested tree.

    The move is different from the flat case: instead of rewriting two id lists,
    each parent's children array is rebuilt from the node objects themselves, so
    a node changes parent by being placed in a different array. The node objects
    are reused by reference, which is what preserves every field this decoder
    never modelled.

    The same invariants hold. E1: the node sets must match exactly, except for
    declared creations. E4: children land in ordinal order. E5: a protected role
    is never reparented. A root cannot be reparented into the tree here, because
    the roots of a nested tree are named slots in the file rather than nodes with
    a parent, and quietly turning a root into a child would restructure the file
    in a way no projection asked for.
    """
    from decode_node_tree import index_nested, roots_of_nested  # noqa: E402

    by_id, parent_of, _ = index_nested(collection, shape, findings)
    if findings:
        raise EncodeRefusal("nested_tree_unreadable", findings[:5])

    projected = [r["node_id"] for r in records]
    duplicates = sorted({n for n in projected if projected.count(n) > 1})
    if duplicates:
        raise EncodeRefusal("projection_has_duplicate_identities", duplicates[:20])

    declared_new = {
        r["node_id"] for r in records
        if _as_object(r.get("materialize")) is not None
    }
    invented = sorted(set(projected) - set(by_id) - declared_new)
    dropped = sorted(set(by_id) - set(projected))
    if invented:
        raise EncodeRefusal("projection_names_nodes_absent_from_the_tree", invented[:20])
    if dropped:
        raise EncodeRefusal("projection_omits_nodes_present_in_the_tree", dropped[:20])

    protected = set(shape.get("never_reparent_roles") or [])
    root_ids = {
        _as_text(root, shape["identity_key"])
        for _, root in roots_of_nested(collection, [])
        if root is not None
    }

    created = []
    for record in records:
        spec = _as_object(record.get("materialize"))
        if spec is None:
            continue
        if record["node_id"] in by_id:
            raise EncodeRefusal("materialize_collides_with_an_existing_identity",
                                [record["node_id"]])
        by_id[record["node_id"]] = _new_nested_node(record, spec, shape)
        created.append(record["node_id"])

    reparented = []
    for record in records:
        node_id = record["node_id"]
        desired = record.get("parent_id")
        current = parent_of.get(node_id)
        if desired == current:
            continue
        if node_id in root_ids:
            raise EncodeRefusal("change_would_reparent_a_named_root",
                                {"node_id": node_id})
        if protected:
            for candidate in (current, desired):
                holder = by_id.get(candidate) if candidate else None
                if holder is not None and role_of(kind_of(holder, shape), shape) in protected:
                    raise EncodeRefusal(
                        "change_would_move_a_member_across_a_protected_role",
                        {"node_id": node_id, "role_holder": candidate},
                    )
        reparented.append(node_id)

    # Rebuild every children array from the projection, ordinal ordered.
    children_of = {}
    for record in records:
        parent_id = record.get("parent_id")
        if parent_id is None:
            continue
        ordinal = record.get("ordinal")
        children_of.setdefault(parent_id, []).append(
            (ordinal if isinstance(ordinal, int) else 1 << 62, record["node_id"])
        )
    for parent_id in children_of:
        children_of[parent_id].sort(key=lambda pair: (pair[0], pair[1]))

    children_key = shape["children_key"]
    for node_id, node in by_id.items():
        wanted = [by_id[child] for _, child in children_of.get(node_id, [])
                  if child in by_id]
        if wanted or isinstance(node.get(children_key), list):
            node[children_key] = wanted

    # A created node has to be REACHABLE, so attach it to its parent's array.
    for node_id in created:
        record = next(r for r in records if r["node_id"] == node_id)
        parent_id = record.get("parent_id")
        if parent_id is None or parent_id not in by_id:
            raise EncodeRefusal("created_node_has_no_reachable_parent",
                                {"node_id": node_id, "parent_id": parent_id})

    return {
        "nodes_in_tree": len(by_id),
        "nodes_in_projection": len(records),
        "created": sorted(created),
        "created_count": len(created),
        "reparented": sorted(set(reparented)),
        "parents_whose_child_order_changed": sorted(children_of),
        "reparented_count": len(set(reparented)),
        "findings": findings,
    }


def _new_nested_node(record, spec, shape):
    """Build a node in a nested tree's own shape. Structural keys only."""
    kind = spec.get("kind")
    known = shape.get("known_kinds") or []
    if not isinstance(kind, str) or not kind:
        raise EncodeRefusal("materialize_spec_missing_kind", {"node_id": record["node_id"]})
    if known and kind not in known:
        raise EncodeRefusal("materialize_kind_is_not_a_declared_kind",
                            {"node_id": record["node_id"], "kind": kind})
    locator = shape["kind_locator"]
    node = {shape["identity_key"]: record["node_id"]}
    if locator.get("style") == "scalar_field":
        node[locator["field"]] = kind
    elif locator.get("style") == "map_single_key":
        node[locator["field"]] = {kind: {}}
    else:
        raise EncodeRefusal("materialize_cannot_write_this_kind_grammar",
                            {"style": locator.get("style")})
    if shape.get("title_key") and record.get("title") is not None:
        node[shape["title_key"]] = record["title"]
    node[shape["children_key"]] = []
    for key, value in (_as_object(spec.get("fields")) or {}).items():
        node.setdefault(key, value)
    return node


def _materialize(record, spec, shape, collection):
    """
    Build a new node in the tree's own shape and append it to the collection.

    Everything application-specific arrives in `spec`: the kind name, and any
    extra fields under `fields`. This function knows only the STRUCTURAL keys the
    shape already declares, so creating a node in a different tree costs no code.

    The collection layout is mirrored rather than assumed. Some trees store a
    flat alternating identity/object array, and appending only the object to one
    of those produces a node the owning application cannot see.
    """
    kind = spec.get("kind")
    if not isinstance(kind, str) or not kind:
        raise EncodeRefusal("materialize_spec_missing_kind",
                            {"node_id": record["node_id"]})
    known = shape.get("known_kinds") or []
    if known and kind not in known:
        raise EncodeRefusal("materialize_kind_is_not_a_declared_kind",
                            {"node_id": record["node_id"], "kind": kind,
                             "known_kinds": known})

    locator = shape["kind_locator"]
    style = locator.get("style")
    node = {shape["identity_key"]: record["node_id"]}

    if style == "map_single_key":
        node[locator["field"]] = {kind: {}}
    elif style == "scalar_field":
        node[locator["field"]] = kind
    else:
        raise EncodeRefusal("materialize_cannot_write_this_kind_grammar",
                            {"style": style})

    title = record.get("title")
    if shape.get("title_key") and title is not None:
        node[shape["title_key"]] = title
    node[shape["parent_key"]] = record.get("parent_id")
    node[shape["children_key"]] = []

    extra = _as_object(spec.get("fields")) or {}
    for key, value in extra.items():
        node.setdefault(key, value)

    # Mirror the collection's layout. A flat alternating array carries a bare
    # identity entry before each object, and omitting it hides the new node.
    identity_key = shape["identity_key"]
    alternating = any(
        isinstance(entry, str) for entry in collection
    ) and any(
        _as_object(entry) is not None and identity_key in (_as_object(entry) or {})
        for entry in collection
    )
    if alternating:
        collection.append(record["node_id"])
    collection.append(node)
    return node


def run(argv):
    """
    usage: encode_node_tree.py <descriptor.json> <tree.json> <records.json> [<out.json>]

    Writes to <out.json> when given, otherwise to stdout. Never overwrites the
    input tree: choosing what to replace, and backing it up, is the caller's job.
    """
    if len(argv) < 4:
        sys.stderr.write(run.__doc__ or "")
        return 2
    with open(argv[1], encoding="utf-8") as handle:
        descriptor = json.load(handle)
    with open(argv[2], encoding="utf-8") as handle:
        payload = json.load(handle)
    with open(argv[3], encoding="utf-8") as handle:
        records = json.load(handle)
    if isinstance(records, dict):
        records = records.get("records", [])

    try:
        receipt = apply_containment(payload, descriptor, records)
    except EncodeRefusal as refusal:
        sys.stderr.write(json.dumps(refusal.as_dict(), indent=2) + "\n")
        return 1

    if len(argv) >= 5:
        with open(argv[4], "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        sys.stderr.write(json.dumps(receipt, indent=2) + "\n")
    else:
        json.dump(payload, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(run(sys.argv))
