from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

RULES = Path(__file__).resolve().parent / "reader-knowledge.json"


def load_rules(path: Path = RULES) -> dict:
    return json.loads(path.read_text())


def blocks_from_markdown(text: str) -> list[dict]:
    """Headings and paragraphs in order. A paragraph is a run of non-blank lines, joined with spaces."""
    blocks, lines, start = [], [], None

    def close():
        if lines:
            blocks.append({"kind": "paragraph", "text": " ".join(line.strip() for line in lines), "line": start})
            lines.clear()
    for number, raw in enumerate(text.split("\n"), 1):
        heading = re.match(r"^\s*#{1,6}\s+(.+?)\s*#*\s*$", raw)
        if heading:
            close()
            blocks.append({"kind": "heading", "text": heading.group(1), "line": number})
        elif not raw.strip():
            close()
        else:
            if not lines:
                start = number
            lines.append(re.sub(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", "", raw))
    close()
    return blocks


def blocks_from_units(units: list[dict]) -> list[dict]:
    return [{"kind": unit.get("kind", "voiceover"), "text": unit["text"], "line": unit.get("where")} for unit in units]


def plain(text: str) -> str:
    """Markdown emphasis removed, so **Name** parses as Name."""
    return re.sub(r"(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\1", r"\2", text)


def span_of(sentence, token) -> str:
    return sentence.doc[token.left_edge.i: token.right_edge.i + 1].text


class Checker:
    def __init__(self, rules: dict):
        import spacy
        self.rules = {rule["id"]: rule for rule in rules["rules"]}
        self.nlp = spacy.load(rules["parser"]["model"])
        if self.nlp.meta["version"] != rules["parser"]["version"]:
            raise SystemExit(f"reader-knowledge: {rules['parser']['model']} is {self.nlp.meta['version']}, the DATA pins {rules['parser']['version']}")
        self.words = {name: set(values) for name, values in rules["word_classes"].items()}
        self.headings = set(rules["heading_kinds"])

    def check(self, blocks: list[dict]) -> list[dict]:
        parsed = [self.nlp(plain(block["text"])) for block in blocks]
        defined = set().union(*(self.defined_here(sentence) for block, doc in zip(blocks, parsed) if block["kind"] not in self.headings for sentence in doc.sents))
        findings, read, section_start = [], set(), True    # read: lemmas of every noun and proper noun already read

        def found(rule, block, sentence, span, why):
            findings.append({"rule": rule, "outcome": self.rules[rule]["outcome"], "line": block["line"], "kind": block["kind"],
                             "sentence": sentence.text, "span": span, "why": why})
        for block, doc in zip(blocks, parsed):
            if block["kind"] in self.headings:
                read |= self.lemmas(doc)
                section_start = True
                continue
            sentences = list(doc.sents)
            if section_start and sentences and self.on(block, "section-opens-with-a-label"):
                label = self.opening_label(sentences[0])
                if label:
                    found("section-opens-with-a-label", block, sentences[0], label,
                          f'the section opens by calling "{sentences[0][0].text.lower()}" {label!r} before the text has said anything it could refer to')
            if self.on(block, "label-colon-command"):
                shape = self.label_colon_command(sentences)
                if shape:
                    found("label-colon-command", block, shape[1], shape[1].text,
                          f'{shape[0]!r} is credited with an abstract result, then a command ends in a colon instead of an explanation of how it works')
            for sentence in sentences:
                if self.on(block, "unintroduced-reference"):
                    for chunk in self.unintroduced(sentence, read):
                        found("unintroduced-reference", block, sentence, chunk,
                              f'"{chunk}" names a specific thing from the writer\'s own past that the text has not mentioned before')
                if self.on(block, "label-assigned-not-defined"):
                    for term in self.assigned_labels(sentence):
                        if term not in defined:
                            found("label-assigned-not-defined", block, sentence, term,
                                  f'"{term}" is assigned as a label, but the text never says what "{term}" means')
                read |= self.lemmas(sentence)
            section_start = False
        return findings

    def on(self, block: dict, rule: str) -> bool:
        return block["kind"] in self.rules[rule]["applies_to_kinds"]

    @staticmethod
    def lemmas(tokens) -> set[str]:
        """Nouns, names and the words that modify a noun ("a popcorn brand" mentions popcorn, whatever its tag)."""
        return {token.lemma_.lower() for token in tokens
                if token.pos_ in ("NOUN", "PROPN") or (token.dep_ in ("amod", "compound") and token.head.pos_ == "NOUN")}

    def clause_of(self, token):
        """The verb whose clause holds this token: the nearest head with a subject of its own (or the root)."""
        head = token.head
        while head.head.i != head.i and not any(child.dep_ in ("nsubj", "nsubjpass") for child in head.children):
            head = head.head
        return head

    def own_past(self, verb) -> bool:
        """A clause in the writer's own past: a first-person subject of a past-tense verb ("I was working", "we tried")."""
        subject = next((child for child in verb.children if child.dep_ in ("nsubj", "nsubjpass")), None)
        return subject is not None and subject.lower_ in self.words["first_person"] and (
            verb.tag_ == "VBD" or any(child.dep_ in ("aux", "auxpass") and child.tag_ == "VBD" for child in verb.children))

    def unintroduced(self, sentence, read: set[str]) -> list[str]:
        out = []
        for chunk in sentence.noun_chunks:
            root = chunk.root
            if root.pos_ != "NOUN" or chunk[0].lower_ != "the" or root.dep_ == "appos" or not self.own_past(self.clause_of(root)):
                continue
            before = read | self.lemmas(sentence.doc[sentence.start: chunk.start])
            if any(token.lemma_.lower() in before for token in chunk if token.pos_ in ("NOUN", "PROPN")):
                continue                     # mentioned before (the noun or one of its words): introduced, if not explained
            if any(token.lower_ in self.words["not_a_specific_thing"] for token in chunk[1:]):
                continue
            after = sentence.doc[chunk.end] if chunk.end < len(sentence.doc) else None
            if after is not None and (after.lower_ in self.words["restricting_followers"] or after.tag_ == "POS"):
                continue                     # "the domain I'm claiming", "the screen in front of me": the phrase says which one
            out.append(chunk.text)
        return out

    def assigned_labels(self, sentence) -> list[str]:
        """Definite role labels assigned to a particular thing: "the ball is the target", "you're the agent"."""
        out = []
        for token in sentence:
            verb = token.head
            if token.dep_ != "attr" or token.pos_ != "NOUN" or verb.lemma_ != "be" or any(child.dep_ == "neg" for child in verb.children):
                continue
            subject = next((child for child in verb.children if child.dep_ in ("nsubj", "nsubjpass")), None)
            if subject is None or subject.lower_ in self.words["pointing_back"] or any(
                    child.dep_ == "det" and child.lower_ in self.words["pointing_back"] for child in subject.children):
                continue                     # "These limits ... are constraints", "That mismatch is the crack": names what was just described
            if any(child.dep_ in ("prep", "relcl", "acl") for child in subject.children):
                continue                     # "The corner you want to hit it into is the destination": the subject describes it
            if not any(child.dep_ == "det" and child.lower_ == "the" for child in token.children):
                continue                     # "a bystander" classifies; "the target" assigns a role
            if any(child.dep_ in ("prep", "relcl", "acl") for child in token.children) or any(t.dep_ == "appos" for t in sentence):
                continue                     # "the instrument you use to strike the ball", "the entities, the things taking part"
            out.append(token.lemma_.lower())
        return out

    def defined_here(self, sentence) -> set[str]:
        """Terms a sentence defines: the term itself is the subject of "is/means" ("An agent is an entity ...", "The target
        is what ..."), or it follows a naming phrase ("By reality, I mean", "what I call", "That's what I mean by a ...")."""
        out = set()
        for token in sentence:
            if token.dep_ == "nsubj" and token.pos_ == "NOUN" and token.head.lemma_ in self.words["defining_verbs"]:
                if any(child.dep_ == "det" and child.lower_ in ("a", "an", "the") for child in token.children):
                    out.add(token.lemma_.lower())
        lowered = [token.lower_ for token in sentence]
        for phrase in self.words["naming_phrases"]:
            words = phrase.split()
            for at in range(len(lowered) - len(words) + 1):
                if lowered[at: at + len(words)] == words:
                    rest = [token for token in sentence[at + len(words):] if token.pos_ in ("NOUN", "PROPN", "ADJ")]
                    if rest:
                        noun = next((token for token in rest if token.pos_ in ("NOUN", "PROPN")), rest[0])
                        out.add(noun.lemma_.lower())
        return out

    def opening_label(self, sentence) -> str | None:
        """ "This is a school of thought.": the subject points back at nothing yet, the predicate is a category."""
        root = sentence.root
        subject = next((child for child in root.children if child.dep_ == "nsubj"), None)
        attr = next((child for child in root.children if child.dep_ == "attr"), None)
        if root.lemma_ != "be" or subject is None or attr is None or subject.lower_ not in self.words["pointing_back"]:
            return None
        if attr.pos_ != "NOUN" or not any(child.dep_ == "det" and child.lower_ in ("a", "an") for child in attr.children):
            return None
        return span_of(sentence, attr)

    def label_colon_command(self, sentences):
        """A named concept credited with an abstract result, then, in the same paragraph, a command that ends in a colon."""
        if len(sentences) < 2:
            return None
        first = sentences[0]
        subject = next((child for child in first.root.children if child.dep_ == "nsubj"), None)
        if subject is None or first.root.lemma_ in self.words["defining_verbs"]:
            return None
        if not any(token.pos_ == "PROPN" for token in first.doc[subject.left_edge.i: subject.right_edge.i + 1]):
            return None
        for sentence in sentences[1:]:
            if ":" not in sentence.text:
                continue
            clause = self.nlp(sentence.text.split(":", 1)[0])
            root = clause[:].root
            if root.i == 0 and root.tag_ == "VB" and not any(child.dep_ in ("nsubj", "nsubjpass") for child in root.children):
                return span_of(first, subject), sentence
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    sub = parser.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("check")
    run.add_argument("file")
    run.add_argument("--units", action="store_true", help="the file is a JSON list of {text, kind, where} in reading order")
    run.add_argument("--json", help="write the findings here")
    args = parser.parse_args()
    path = Path(args.file)
    try:
        text = path.read_text()
        blocks = blocks_from_units(json.loads(text)) if args.units else blocks_from_markdown(text)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"reader-knowledge: cannot read {path}: {exc}", file=sys.stderr)
        return 2
    findings = Checker(load_rules()).check(blocks)
    if args.json:
        Path(args.json).write_text(json.dumps({"file": str(path), "blocks": len(blocks), "findings": findings}, indent=1, ensure_ascii=False) + "\n")
    for finding in findings:
        print(f"{finding['outcome']:9} {finding['rule']}  {finding['line']}: {finding['why']}\n    {finding['sentence']}")
    print(f"{len(findings)} finding(s) in {len(blocks)} block(s)")
    outcomes = {finding["outcome"] for finding in findings}
    return 1 if "fail" in outcomes else 3 if outcomes else 0


if __name__ == "__main__":
    sys.exit(main())
