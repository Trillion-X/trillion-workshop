#!/usr/bin/env python3
# packages/node-tree-decoder/do-work/process-scripts/__tests__/test_encode_node_tree.py
#
# Proof for the write-back leg. The load-bearing test is the ROUND TRIP: decode
# a tree, write the unchanged projection straight back, decode again, and demand
# an identical projection. A writer that survives that cannot be quietly lossy,
# which is the failure mode that would cost somebody their data.
#
# Everything here is DATA-shaped. Nothing names the application the shape
# came from.
#
# Run: python3 test_encode_node_tree.py   (exit 0 = pass)

import copy
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..")
sys.path.insert(0, SCRIPTS)


def _load(name):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(SCRIPTS, name + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


D = _load("decode_node_tree")
E = _load("encode_node_tree")


SHAPE = {
    "collection_path": ["sidebar", "containers",
                        {"first_element_having_key": "items"}, "items"],
    "identity_key": "id",
    "parent_key": "parentID",
    "children_key": "childrenIds",
    "title_key": "title",
    "timestamp_key": "createdAt",
    "edge_authority": "children",
    "kind_locator": {"style": "map_single_key", "field": "data"},
    "known_kinds": ["tab", "list", "itemContainer", "splitView"],
    "role_map": {
        "tab": "leaf",
        "list": "group",
        "splitView": "paired",
        "itemContainer": "container",
    },
    "external_identity_path": ["data", "tab", "savedURL"],
}
DESCRIPTOR = {"tree_shape": SHAPE}
PROTECTED = {"tree_shape": dict(SHAPE, never_reparent_roles=["paired"])}


def node(node_id, kind, title=None, children=None, parent=None, url=None, extra=None):
    body = {"id": node_id, "data": {kind: {}}, "childrenIds": children or []}
    body["parentID"] = parent
    if title is not None:
        body["title"] = title
    if url is not None:
        body["data"] = {kind: {"savedURL": url}}
    if extra:
        body.update(extra)
    return body


def tree(*nodes):
    items = []
    for entry in nodes:
        items.append(entry["id"])
        items.append(entry)
    return {"sidebar": {"containers": [{"spaces": []}, {"items": items}]}}


def sample():
    """Root container holding two groups; three leaves spread across them."""
    return tree(
        node("root", "itemContainer", children=["books", "ui"]),
        node("books", "list", title="books", children=["t1"], parent="root"),
        node("ui", "list", title="ui", children=["t2", "t3"], parent="root"),
        node("t1", "tab", title="One", parent="books", url="https://one.example/a"),
        node("t2", "tab", title="Two", parent="ui", url="https://two.example/b"),
        node("t3", "tab", title="Three", parent="ui", url="https://three.example/c"),
    )


def nested_sample():
    """
    A physically NESTED tree: children live inside their parent and no node has
    a parent field. `roots` is an object whose values are the root nodes, which
    is how a bookmarks file is laid out.
    """
    payload = {
        "roots": {
            "bar": {
                "id": "bar", "name": "Bar", "type": "folder",
                "children": [
                    {"id": "work", "name": "work", "type": "folder", "children": [
                        {"id": "a", "name": "A", "type": "url", "url": "https://a/"},
                        {"id": "b", "name": "B", "type": "url", "url": "https://b/"},
                    ]},
                    {"id": "play", "name": "play", "type": "folder", "children": []},
                ],
            },
        }
    }
    descriptor = {"tree_shape": {
        "collection_path": ["roots"],
        "collection_layout": "nested",
        "identity_key": "id",
        "children_key": "children",
        "title_key": "name",
        "kind_locator": {"style": "scalar_field", "field": "type"},
        "known_kinds": ["url", "folder"],
        "role_map": {"url": "leaf", "folder": "group"},
        "external_identity_path": ["url"],
    }}
    return payload, descriptor


def projection(payload, descriptor=DESCRIPTOR):
    return D.decode_tree(payload, descriptor)["records"]


def edges(records):
    return sorted((r["node_id"], r["parent_id"], r["ordinal"]) for r in records)


class EncodeNodeTreeTest(unittest.TestCase):

    # ---- the load-bearing proof -------------------------------------------

    def test_round_trip_of_an_unchanged_projection_is_the_identity(self):
        payload = sample()
        before = projection(payload)
        receipt = E.apply_containment(payload, DESCRIPTOR, before)
        after = projection(payload)
        self.assertEqual(edges(before), edges(after))
        self.assertEqual(receipt["reparented_count"], 0)

    def test_round_trip_preserves_every_non_structural_field(self):
        payload = sample()
        payload["sidebar"]["containers"][1]["items"][7]["customField"] = {"keep": [1, 2]}
        original = copy.deepcopy(payload)
        E.apply_containment(payload, DESCRIPTOR, projection(payload))
        self.assertEqual(payload, original)

    def test_a_field_the_decoder_never_modelled_survives_a_reparent(self):
        payload = sample()
        target = payload["sidebar"]["containers"][1]["items"][7]
        target["unmodelled"] = "must survive"
        records = projection(payload)
        for record in records:
            if record["node_id"] == "t1":
                record["parent_id"] = "ui"
        E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(target["unmodelled"], "must survive")

    # ---- edges actually move ----------------------------------------------

    def test_reparenting_moves_the_node_in_both_representations(self):
        payload = sample()
        records = projection(payload)
        for record in records:
            if record["node_id"] == "t1":
                record["parent_id"] = "ui"
                record["ordinal"] = 99
        receipt = E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(receipt["reparented"], ["t1"])

        by_id = {r["node_id"]: r for r in projection(payload)}
        self.assertEqual(by_id["t1"]["parent_id"], "ui")

        nodes = {
            entry["id"]: entry
            for entry in payload["sidebar"]["containers"][1]["items"]
            if isinstance(entry, dict)
        }
        # E3: BOTH representations agree after the write.
        self.assertEqual(nodes["t1"]["parentID"], "ui")
        self.assertIn("t1", nodes["ui"]["childrenIds"])
        self.assertNotIn("t1", nodes["books"]["childrenIds"])

    def test_child_order_follows_the_ordinal_not_the_previous_order(self):
        payload = sample()
        records = projection(payload)
        for record in records:
            if record["node_id"] == "t2":
                record["ordinal"] = 50
            if record["node_id"] == "t3":
                record["ordinal"] = 10
        E.apply_containment(payload, DESCRIPTOR, records)
        nodes = {
            entry["id"]: entry
            for entry in payload["sidebar"]["containers"][1]["items"]
            if isinstance(entry, dict)
        }
        self.assertEqual(nodes["ui"]["childrenIds"], ["t3", "t2"])

    def test_emptying_a_group_leaves_it_present_with_no_children(self):
        payload = sample()
        records = projection(payload)
        for record in records:
            if record["node_id"] == "t1":
                record["parent_id"] = "ui"
        E.apply_containment(payload, DESCRIPTOR, records)
        nodes = {
            entry["id"]: entry
            for entry in payload["sidebar"]["containers"][1]["items"]
            if isinstance(entry, dict)
        }
        self.assertEqual(nodes["books"]["childrenIds"], [])

    def test_nesting_a_group_inside_another_group_is_written(self):
        payload = sample()
        records = projection(payload)
        for record in records:
            if record["node_id"] == "ui":
                record["parent_id"] = "books"
        E.apply_containment(payload, DESCRIPTOR, records)
        by_id = {r["node_id"]: r for r in projection(payload)}
        self.assertEqual(by_id["ui"]["parent_id"], "books")

    # ---- refusals: membership is conserved (E1) ---------------------------

    def test_refuses_a_projection_naming_a_node_the_tree_does_not_have(self):
        payload = sample()
        records = projection(payload)
        records.append(dict(records[0], node_id="ghost"))
        with self.assertRaises(E.EncodeRefusal) as caught:
            E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(
            caught.exception.reason, "projection_names_nodes_absent_from_the_tree"
        )

    def test_refuses_a_projection_that_silently_omits_a_node(self):
        payload = sample()
        records = [r for r in projection(payload) if r["node_id"] != "t3"]
        with self.assertRaises(E.EncodeRefusal) as caught:
            E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(
            caught.exception.reason, "projection_omits_nodes_present_in_the_tree"
        )

    def test_refuses_duplicate_identities_rather_than_writing_one_of_them(self):
        payload = sample()
        records = projection(payload)
        records.append(dict(records[0]))
        with self.assertRaises(E.EncodeRefusal) as caught:
            E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(
            caught.exception.reason, "projection_has_duplicate_identities"
        )

    def test_a_refusal_leaves_the_tree_completely_untouched(self):
        payload = sample()
        records = projection(payload)
        for record in records:
            if record["node_id"] == "t1":
                record["parent_id"] = "ui"
        records.append(dict(records[0], node_id="ghost"))
        original = copy.deepcopy(payload)
        with self.assertRaises(E.EncodeRefusal):
            E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(payload, original)

    # ---- refusals: protected roles (E5) -----------------------------------

    def test_refuses_to_pull_a_member_out_of_a_protected_role(self):
        payload = tree(
            node("root", "itemContainer", children=["pair"]),
            node("pair", "splitView", children=["a", "b"], parent="root"),
            node("a", "tab", title="A", parent="pair", url="https://a.example/"),
            node("b", "tab", title="B", parent="pair", url="https://b.example/"),
        )
        records = projection(payload, PROTECTED)
        for record in records:
            if record["node_id"] == "a":
                record["parent_id"] = "root"
        with self.assertRaises(E.EncodeRefusal) as caught:
            E.apply_containment(payload, PROTECTED, records)
        self.assertEqual(
            caught.exception.reason,
            "change_would_remove_a_member_from_a_protected_role",
        )

    def test_an_unchanged_protected_role_round_trips_without_refusal(self):
        payload = tree(
            node("root", "itemContainer", children=["pair"]),
            node("pair", "splitView", children=["a", "b"], parent="root"),
            node("a", "tab", title="A", parent="pair", url="https://a.example/"),
            node("b", "tab", title="B", parent="pair", url="https://b.example/"),
        )
        before = projection(payload, PROTECTED)
        E.apply_containment(payload, PROTECTED, before)
        self.assertEqual(edges(before), edges(projection(payload, PROTECTED)))

    def test_protection_is_data_so_without_the_row_the_same_move_is_allowed(self):
        payload = tree(
            node("root", "itemContainer", children=["pair"]),
            node("pair", "splitView", children=["a", "b"], parent="root"),
            node("a", "tab", title="A", parent="pair", url="https://a.example/"),
            node("b", "tab", title="B", parent="pair", url="https://b.example/"),
        )
        records = projection(payload, DESCRIPTOR)
        for record in records:
            if record["node_id"] == "a":
                record["parent_id"] = "root"
        receipt = E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(receipt["reparented"], ["a"])


    # ---- the orphan guard (E0) --------------------------------------------

    def test_refuses_a_collection_holding_a_node_it_cannot_identify(self):
        """
        The dangerous case, found on a real tree: some nodes stored flat as
        {id, ...} and others wrapped as {value: {id, ...}}. A shape describing
        only the flat form reads the wrapped one as "not a node" in BOTH
        directions, so membership conservation cannot see it, and rebuilding
        child lists from the projection alone would orphan it.
        """
        payload = sample()
        payload["sidebar"]["containers"][1]["items"].append({
            "value": {"id": "hidden", "title": "wrapped", "data": {"tab": {}},
                      "parentID": "books", "childrenIds": []},
            "lastChangeDate": 1.0,
        })
        with self.assertRaises(E.EncodeRefusal) as caught:
            E.apply_containment(payload, DESCRIPTOR, projection(payload))
        self.assertEqual(
            caught.exception.reason,
            "collection_holds_objects_this_shape_cannot_identify",
        )
        self.assertIn("value", caught.exception.detail["first_keys"])

    def test_the_orphan_guard_fires_before_anything_is_written(self):
        payload = sample()
        records = projection(payload)
        for record in records:
            if record["node_id"] == "t1":
                record["parent_id"] = "ui"
        payload["sidebar"]["containers"][1]["items"].append(
            {"value": {"id": "hidden"}},
        )
        original = copy.deepcopy(payload)
        with self.assertRaises(E.EncodeRefusal):
            E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(payload, original)

    def test_a_bare_identity_entry_is_not_mistaken_for_an_unidentifiable_node(self):
        """The flat alternating layout is LEGAL and must not trip the guard."""
        payload = sample()
        receipt = E.apply_containment(payload, DESCRIPTOR, projection(payload))
        self.assertEqual(receipt["reparented_count"], 0)

    # ---- declared creation (E1) -------------------------------------------

    def test_a_declared_new_group_is_created_and_decodes_back(self):
        payload = sample()
        records = projection(payload)
        records.append({
            "node_id": "shelf", "parent_id": "root", "ordinal": 5,
            "role": "group", "title": "shelf", "external_identity": None,
            "attributes": {}, "materialize": {"kind": "list"},
        })
        for record in records:
            if record["node_id"] == "books":
                record["parent_id"] = "shelf"
        receipt = E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(receipt["created"], ["shelf"])

        by_id = {r["node_id"]: r for r in projection(payload)}
        self.assertIn("shelf", by_id)
        self.assertEqual(by_id["shelf"]["role"], "group")
        self.assertEqual(by_id["shelf"]["title"], "shelf")
        self.assertEqual(by_id["books"]["parent_id"], "shelf")

    def test_a_created_node_appears_in_the_flat_alternating_layout(self):
        payload = sample()
        records = projection(payload)
        records.append({
            "node_id": "shelf", "parent_id": "root", "ordinal": 5,
            "role": "group", "title": "shelf", "external_identity": None,
            "attributes": {}, "materialize": {"kind": "list"},
        })
        E.apply_containment(payload, DESCRIPTOR, records)
        items = payload["sidebar"]["containers"][1]["items"]
        # The bare identity entry must be present, or the owner cannot see it.
        self.assertIn("shelf", [e for e in items if isinstance(e, str)])
        self.assertEqual(
            len([e for e in items if isinstance(e, dict) and e["id"] == "shelf"]), 1
        )

    def test_creating_then_round_tripping_again_is_stable(self):
        payload = sample()
        records = projection(payload)
        records.append({
            "node_id": "shelf", "parent_id": "root", "ordinal": 5,
            "role": "group", "title": "shelf", "external_identity": None,
            "attributes": {}, "materialize": {"kind": "list"},
        })
        E.apply_containment(payload, DESCRIPTOR, records)
        once = projection(payload)
        E.apply_containment(payload, DESCRIPTOR, once)
        self.assertEqual(edges(once), edges(projection(payload)))

    def test_refuses_to_materialize_over_an_identity_that_already_exists(self):
        payload = sample()
        records = projection(payload)
        for record in records:
            if record["node_id"] == "books":
                record["materialize"] = {"kind": "list"}
        with self.assertRaises(E.EncodeRefusal) as caught:
            E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(
            caught.exception.reason, "materialize_collides_with_an_existing_identity"
        )

    def test_refuses_a_materialize_spec_naming_an_undeclared_kind(self):
        payload = sample()
        records = projection(payload)
        records.append({
            "node_id": "shelf", "parent_id": "root", "ordinal": 5,
            "role": "group", "title": "shelf", "external_identity": None,
            "attributes": {}, "materialize": {"kind": "invented"},
        })
        with self.assertRaises(E.EncodeRefusal) as caught:
            E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(
            caught.exception.reason, "materialize_kind_is_not_a_declared_kind"
        )

    def test_an_undeclared_unknown_identity_is_still_refused(self):
        """Creation is opt-in. Without the spec the old refusal must still fire."""
        payload = sample()
        records = projection(payload)
        records.append({
            "node_id": "shelf", "parent_id": "root", "ordinal": 5,
            "role": "group", "title": "shelf", "external_identity": None,
            "attributes": {},
        })
        with self.assertRaises(E.EncodeRefusal) as caught:
            E.apply_containment(payload, DESCRIPTOR, records)
        self.assertEqual(
            caught.exception.reason, "projection_names_nodes_absent_from_the_tree"
        )

    def test_extra_fields_on_the_spec_land_on_the_created_node(self):
        payload = sample()
        records = projection(payload)
        records.append({
            "node_id": "shelf", "parent_id": "root", "ordinal": 5,
            "role": "group", "title": "shelf", "external_identity": None,
            "attributes": {},
            "materialize": {"kind": "list", "fields": {"createdAt": 12345}},
        })
        E.apply_containment(payload, DESCRIPTOR, records)
        node = [e for e in payload["sidebar"]["containers"][1]["items"]
                if isinstance(e, dict) and e["id"] == "shelf"][0]
        self.assertEqual(node["createdAt"], 12345)


    # ---- the second physical layout: nested ------------------------------

    def test_a_nested_tree_decodes_with_positional_parents(self):
        payload, descriptor = nested_sample()
        records = {r["node_id"]: r for r in D.decode_tree(payload, descriptor)["records"]}
        self.assertEqual(records["bar"]["parent_id"], None)
        self.assertEqual(records["work"]["parent_id"], "bar")
        self.assertEqual(records["a"]["parent_id"], "work")
        self.assertEqual(records["a"]["role"], "leaf")
        self.assertEqual(records["work"]["role"], "group")
        # Ordinal comes from POSITION, because there is no ordinal field.
        self.assertEqual(records["a"]["ordinal"], 0)
        self.assertEqual(records["b"]["ordinal"], 1)

    def test_a_nested_tree_needs_no_parent_key_at_all(self):
        payload, descriptor = nested_sample()
        self.assertNotIn("parent_key", descriptor["tree_shape"])
        self.assertEqual(D.decode_tree(payload, descriptor)["rejections"], [])

    def test_nested_round_trip_of_an_unchanged_projection_is_the_identity(self):
        payload, descriptor = nested_sample()
        before = D.decode_tree(payload, descriptor)["records"]
        E.apply_containment(payload, descriptor, before)
        after = D.decode_tree(payload, descriptor)["records"]
        self.assertEqual(edges(before), edges(after))

    def test_nested_reparent_physically_moves_the_node_object(self):
        payload, descriptor = nested_sample()
        records = D.decode_tree(payload, descriptor)["records"]
        for record in records:
            if record["node_id"] == "a":
                record["parent_id"] = "play"
        E.apply_containment(payload, descriptor, records)
        landed = {r["node_id"]: r for r in D.decode_tree(payload, descriptor)["records"]}
        self.assertEqual(landed["a"]["parent_id"], "play")
        roots = payload["roots"]
        work = roots["bar"]["children"][0]
        play = roots["bar"]["children"][1]
        self.assertEqual([c["id"] for c in work["children"]], ["b"])
        self.assertEqual([c["id"] for c in play["children"]], ["a"])

    def test_nested_refuses_to_reparent_a_named_root(self):
        payload, descriptor = nested_sample()
        records = D.decode_tree(payload, descriptor)["records"]
        for record in records:
            if record["node_id"] == "bar":
                record["parent_id"] = "work"
        with self.assertRaises(E.EncodeRefusal) as caught:
            E.apply_containment(payload, descriptor, records)
        self.assertEqual(caught.exception.reason, "change_would_reparent_a_named_root")

    def test_nested_refuses_a_created_node_with_no_reachable_parent(self):
        """A root is a NAMED SLOT in the file, not a node, so parent null is unreachable."""
        payload, descriptor = nested_sample()
        records = D.decode_tree(payload, descriptor)["records"]
        records.append({
            "node_id": "new", "parent_id": None, "ordinal": 9, "role": "group",
            "title": "new", "external_identity": None, "attributes": {},
            "materialize": {"kind": "folder"},
        })
        with self.assertRaises(E.EncodeRefusal) as caught:
            E.apply_containment(payload, descriptor, records)
        self.assertEqual(caught.exception.reason, "created_node_has_no_reachable_parent")

    def test_nested_creates_a_group_and_nests_under_it(self):
        payload, descriptor = nested_sample()
        records = D.decode_tree(payload, descriptor)["records"]
        records.append({
            "node_id": "new", "parent_id": "bar", "ordinal": 9, "role": "group",
            "title": "shelf", "external_identity": None, "attributes": {},
            "materialize": {"kind": "folder"},
        })
        for record in records:
            if record["node_id"] == "work":
                record["parent_id"] = "new"
        receipt = E.apply_containment(payload, descriptor, records)
        self.assertEqual(receipt["created"], ["new"])
        landed = {r["node_id"]: r for r in D.decode_tree(payload, descriptor)["records"]}
        self.assertEqual(landed["work"]["parent_id"], "new")
        self.assertEqual(landed["new"]["title"], "shelf")
        self.assertEqual(landed["a"]["parent_id"], "work")

    def test_nested_refuses_a_projection_that_omits_a_node(self):
        payload, descriptor = nested_sample()
        records = [r for r in D.decode_tree(payload, descriptor)["records"]
                   if r["node_id"] != "b"]
        with self.assertRaises(E.EncodeRefusal) as caught:
            E.apply_containment(payload, descriptor, records)
        self.assertEqual(
            caught.exception.reason, "projection_omits_nodes_present_in_the_tree")

    def test_a_nested_tree_read_as_flat_yields_only_what_it_can_see(self):
        """
        The reason layout is DECLARED and never sniffed: reading a nested tree
        with a flat descriptor is SILENT, not loud. It must not look like success.
        """
        payload, _ = nested_sample()
        flat_descriptor = {"tree_shape": {
            "collection_path": ["roots"],
            "identity_key": "id", "parent_key": "parentID",
            "children_key": "children", "title_key": "name",
            "edge_authority": "children",
            "kind_locator": {"style": "scalar_field", "field": "type"},
            "known_kinds": ["url", "folder"],
            "role_map": {"url": "leaf", "folder": "group"},
        }}
        result = D.decode_tree(payload, flat_descriptor)
        found = len(result["records"])
        nested_found = len(D.decode_tree(payload, nested_sample()[1])["records"])
        self.assertLess(found, nested_found,
                        "a flat read of a nested tree must not find every node")


if __name__ == "__main__":
    unittest.main(verbosity=2)
