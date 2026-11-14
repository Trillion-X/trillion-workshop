#!/usr/bin/env python3
"""
Fixtures for the node-tree decoder.

Every case the convergence review named as a way to lose membership silently is
a named test here. The point of these is not coverage, it is that the failure
modes are LOUD: a tree that cannot be projected honestly must report exactly
which ids failed, never return a plausible-looking short answer.
"""

import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    "decode_node_tree", os.path.join(HERE, "..", "decode_node_tree.py")
)
D = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D)


# The shape of a real sidebar tree, expressed entirely as DATA. Nothing below
# names the application it came from.
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
    "known_kinds": ["tab", "list", "itemContainer", "splitView", "easel"],
    "role_map": {
        "tab": "leaf",
        "list": "group",
        "splitView": "paired",
        "itemContainer": "container",
    },
    "external_identity_path": ["data", "tab", "savedURL"],
}
DESCRIPTOR = {"tree_shape": SHAPE}


def node(node_id, kind, title=None, children=None, parent=None, url=None):
    body = {"id": node_id, "data": {kind: {}}, "childrenIds": children or []}
    if title is not None:
        body["title"] = title
    if parent is not None:
        body["parentID"] = parent
    if url is not None:
        body["data"] = {kind: {"savedURL": url}}
    return body


def tree(*nodes):
    """Wrap nodes in the real nested, flat-alternating layout."""
    items = []
    for n in nodes:
        items.append(n["id"])   # the alternating identity entry
        items.append(n)
    return {"sidebar": {"containers": [{"spaces": []}, {"items": items}]}}


class NodeTreeDecoderTest(unittest.TestCase):

    def test_flat_alternating_array_does_not_halve_the_tree(self):
        """Identity strings interleaved with objects are a legal layout."""
        payload = tree(
            node("g", "list", "Group", children=["a", "b"]),
            node("a", "tab", "A", url="https://example.com/one"),
            node("b", "tab", "B", url="https://example.com/two"),
        )
        result = D.decode_tree(payload, DESCRIPTOR)
        self.assertEqual(result["rejections"], [])
        self.assertEqual(D.leaf_count(payload, DESCRIPTOR), 2)

    def test_address_is_preserved_verbatim(self):
        """Reduction destroys routing information permanently; it is routing's job."""
        payload = tree(
            node("g", "list", "G", children=["a"]),
            node("a", "tab", "A", url="https://www.github.com/org/repo/pull/42?x=1"),
        )
        result = D.decode_tree(payload, DESCRIPTOR)
        leaf = [r for r in result["records"] if r["node_id"] == "a"][0]
        self.assertEqual(leaf["external_identity"],
                         "https://www.github.com/org/repo/pull/42?x=1")

    def test_paired_role_survives_as_an_opaque_label(self):
        """The discarded contract dropped this silently, so a split pair could break."""
        payload = tree(
            node("s", "splitView", "Split", children=["a"]),
            node("a", "tab", "A", url="https://example.com/"),
        )
        result = D.decode_tree(payload, DESCRIPTOR)
        roles = {r["node_id"]: r["role"] for r in result["records"]}
        self.assertEqual(roles["s"], "paired")

    def test_unknown_kind_carries_its_own_name_as_role(self):
        """An open role map means a new kind costs zero code."""
        shape = dict(SHAPE)
        shape["known_kinds"] = SHAPE["known_kinds"] + ["separator"]
        payload = tree(node("x", "separator", "Sep"))
        result = D.decode_tree(payload, {"tree_shape": shape})
        self.assertEqual(result["records"][0]["role"], "separator")

    def test_empty_group_survives(self):
        """The conversation contract deleted groups with no atoms."""
        payload = tree(node("g", "list", "Empty", children=[]))
        result = D.decode_tree(payload, DESCRIPTOR)
        self.assertEqual([r["node_id"] for r in result["records"]], ["g"])

    def test_untitled_leaf_survives(self):
        """The conversation contract dropped leaves with no text."""
        payload = tree(
            node("g", "list", "G", children=["a"]),
            node("a", "tab", None, url="https://example.com/"),
        )
        self.assertEqual(D.leaf_count(payload, DESCRIPTOR), 1)

    def test_nesting_is_representable(self):
        """A group inside a group; the flat contract could not express this."""
        payload = tree(
            node("outer", "list", "Outer", children=["inner"]),
            node("inner", "list", "Inner", children=["a"]),
            node("a", "tab", "A", url="https://example.com/"),
        )
        result = D.decode_tree(payload, DESCRIPTOR)
        parents = {r["node_id"]: r["parent_id"] for r in result["records"]}
        self.assertEqual(parents["inner"], "outer")
        self.assertEqual(parents["a"], "inner")

    def test_sibling_order_is_preserved(self):
        payload = tree(
            node("g", "list", "G", children=["b", "a", "c"]),
            node("a", "tab", "A"), node("b", "tab", "B"), node("c", "tab", "C"),
        )
        result = D.decode_tree(payload, DESCRIPTOR)
        ordinals = {r["node_id"]: r["ordinal"] for r in result["records"]}
        self.assertEqual((ordinals["b"], ordinals["a"], ordinals["c"]), (0, 1, 2))

    def test_identity_is_the_source_id_not_position(self):
        """Positional identity would churn every record on every regroup."""
        payload = tree(node("g", "list", "G", children=["z"]), node("z", "tab", "Z"))
        result = D.decode_tree(payload, DESCRIPTOR)
        self.assertIn("z", [r["node_id"] for r in result["records"]])

    # ---- the anomaly cases the review named ----

    def test_multi_parent_is_reported_not_silently_dropped(self):
        payload = tree(
            node("g1", "list", "One", children=["a"]),
            node("g2", "list", "Two", children=["a"]),
            node("a", "tab", "A"),
        )
        result = D.decode_tree(payload, DESCRIPTOR)
        kinds = [f["kind"] for f in result["findings"]]
        self.assertIn("multi_parent", kinds)

    def test_dangling_child_is_reported_and_does_not_discard_the_tree(self):
        """materialize discards a batch on ANY rejection, so this must be a finding."""
        payload = tree(
            node("g", "list", "G", children=["a", "ghost"]),
            node("a", "tab", "A"),
        )
        result = D.decode_tree(payload, DESCRIPTOR)
        self.assertEqual(result["rejections"], [])
        self.assertIn("dangling_child", [f["kind"] for f in result["findings"]])
        self.assertEqual(D.leaf_count(payload, DESCRIPTOR), 1)

    def test_self_parent_terminates_under_parent_authority(self):
        shape = dict(SHAPE)
        shape["edge_authority"] = "parent"
        payload = tree(node("a", "tab", "A", parent="a"))
        result = D.decode_tree(payload, {"tree_shape": shape})
        self.assertIn("self_parent", [f["kind"] for f in result["findings"]])

    def test_dangling_parent_is_reported_under_parent_authority(self):
        shape = dict(SHAPE)
        shape["edge_authority"] = "parent"
        payload = tree(node("a", "tab", "A", parent="missing"))
        result = D.decode_tree(payload, {"tree_shape": shape})
        self.assertIn("dangling_parent", [f["kind"] for f in result["findings"]])

    def test_orphan_is_found_and_marked_not_lost(self):
        """Index-first enumeration is why an unreachable node still appears."""
        payload = tree(node("lonely", "tab", "Lonely"))
        result = D.decode_tree(payload, DESCRIPTOR)
        self.assertEqual(result["records"][0]["attributes"].get("unattached"), True)
        self.assertEqual(D.leaf_count(payload, DESCRIPTOR), 1)

    def test_edge_disagreement_is_reported(self):
        """Two representations of one edge set need a declared owner."""
        payload = tree(
            node("g", "list", "G", children=["a"]),
            node("a", "tab", "A", parent="somewhere-else"),
        )
        result = D.decode_tree(payload, DESCRIPTOR)
        self.assertIn("parent_disagreement", [f["kind"] for f in result["findings"]])

    def test_missing_edge_authority_is_a_rejection(self):
        shape = {k: v for k, v in SHAPE.items() if k != "edge_authority"}
        result = D.decode_tree(tree(node("a", "tab", "A")), {"tree_shape": shape})
        self.assertTrue(result["rejections"])
        self.assertEqual(result["records"], [])

    def test_absent_collection_is_a_rejection_not_a_crash(self):
        result = D.decode_tree({"sidebar": {}}, DESCRIPTOR)
        self.assertTrue(result["rejections"])

    def test_non_object_payload_is_a_rejection_not_a_crash(self):
        self.assertTrue(D.decode_tree("not a tree", DESCRIPTOR)["rejections"])

    def test_scalar_kind_grammar_is_supported(self):
        """A second kind grammar must be DATA, not code."""
        shape = dict(SHAPE)
        shape["kind_locator"] = {"style": "scalar_field", "field": "kind"}
        payload = {"sidebar": {"containers": [{"items": [
            "a", {"id": "a", "kind": "tab", "title": "A", "childrenIds": []},
        ]}]}}
        result = D.decode_tree(payload, {"tree_shape": shape})
        self.assertEqual(result["records"][0]["role"], "leaf")

    def test_tag_membership_kind_grammar_is_supported(self):
        shape = dict(SHAPE)
        shape["kind_locator"] = {"style": "tag_membership", "field": "tags"}
        payload = {"sidebar": {"containers": [{"items": [
            "a", {"id": "a", "tags": ["tab"], "title": "A", "childrenIds": []},
        ]}]}}
        result = D.decode_tree(payload, {"tree_shape": shape})
        self.assertEqual(result["records"][0]["role"], "leaf")


if __name__ == "__main__":
    unittest.main()
