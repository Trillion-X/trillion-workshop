// tools/read-what-is-on-screen/do-work/read.swift
//
// What the person is doing on this Mac, read as text from the front window's accessibility tree (never a screenshot),
// so their AIs keep continuity across the day. Runs for `--watch-seconds`, reads when the front app or its window
// title changes and at least every `--tick-seconds`, and prints one JSON line: { captures: [...] },
// { needs_access: "accessibility", said } or { error }.
//
//   swift read.swift --rules <rules.json> --watch-seconds 50 --tick-seconds 60
//   swift read.swift --rules <rules.json> --scrub          (text on standard input, scrubbed text out; reads no window)
//
// Invariants:
// - Every rule is DATA in the rules file: never-read apps, never-read title words, secret patterns, limits. This file
//   names no app.
// - Never-read apps and titles are skipped before any text is read; a page whose address holds a never-read word is
//   dropped before anything is kept.
// - Secrets matching the rules' secret_patterns are replaced on this Mac before the text leaves this program. A
//   pattern that does not compile stops the run, because it would let that kind of secret through.
// - The same text for the same window is kept once per run. After a window's first capture, later captures of it carry
//   only the lines added and removed since, so a long watch costs what changed, not the whole window again.
// - Apps that build their accessibility tree only when asked (Electron, Chromium) are asked with the rules' wake_attributes.
// - Reading is bounded: the rules' limits cap depth, nodes and characters, so a huge window cannot stall the Mac.
import AppKit
import ApplicationServices
import Foundation

struct Rules: Decodable {
  struct Limits: Decodable { let depth: Int; let nodes: Int; let characters: Int; let poll_ms: Int }
  struct Words: Decodable { let needs_access: String }
  let never_read_bundles: [String]
  let never_read_title_words: [String]
  let never_read_url_words: [String]
  let secret_patterns: [String]
  let text_roles: [String]
  let text_attributes: [String]
  let url_attributes: [String]
  let wake_attributes: [String]
  let limits: Limits
  let words: Words
}

let args = CommandLine.arguments.dropFirst()
func option(_ name: String) -> String? {
  guard let index = args.firstIndex(of: "--\(name)"), args.index(after: index) < args.endIndex else { return nil }
  return args[args.index(after: index)]
}
func number(_ name: String, _ fallback: Double) -> Double { option(name).flatMap { Double($0) } ?? fallback }

func emit(_ value: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: value)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

guard let rulesPath = option("rules") else { emit(["error": "--rules <rules.json> is required"]); exit(2) }
let rules: Rules
do { rules = try JSONDecoder().decode(Rules.self, from: Data(contentsOf: URL(fileURLWithPath: rulesPath))) }
catch { emit(["error": "rules file cannot be read: \(error)"]); exit(2) }
let watchSeconds = number("watch-seconds", 50)
let tickSeconds = number("tick-seconds", 60)

let secrets: [NSRegularExpression] = rules.secret_patterns.map { pattern in
  guard let compiled = try? NSRegularExpression(pattern: pattern) else {
    emit(["error": "rules secret pattern does not compile: \(pattern)"]); exit(2)
  }
  return compiled
}
func scrub(_ text: String) -> String {
  var out = text
  for pattern in secrets {
    out = pattern.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: "[removed]")
  }
  return out
}

if args.contains("--scrub") {
  let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
  emit(["text": scrub(input)])
  exit(0)
}

guard AXIsProcessTrusted() else {
  emit(["needs_access": "accessibility", "said": rules.words.needs_access])
  exit(0)
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

// Walks the window's tree depth first, collecting the text of text-bearing roles, within the limits.
func textOf(_ root: AXUIElement) -> (String, String?) {
  var lines: [String] = [], seen = Set<String>(), url: String? = nil
  var count = 0, characters = 0
  var stack: [(AXUIElement, Int)] = [(root, 0)]
  while let (element, depth) = stack.popLast(), count < rules.limits.nodes, characters < rules.limits.characters {
    count += 1
    if url == nil {
      for name in rules.url_attributes {
        if let value = attribute(element, name) {
          if let link = value as? URL { url = link.absoluteString } else if let text = value as? String, text.hasPrefix("http") { url = text }
        }
      }
    }
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    if rules.text_roles.contains(role) {
      for name in rules.text_attributes {
        if let text = attribute(element, name) as? String {
          let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
          if !line.isEmpty, !seen.contains(line) { seen.insert(line); lines.append(line); characters += line.count }
        }
      }
    }
    if depth < rules.limits.depth, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
      for child in children.reversed() { stack.append((child, depth + 1)) }
    }
  }
  return (String(lines.joined(separator: "\n").prefix(rules.limits.characters)), url)
}

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
var captures: [[String: Any]] = []
var keptTexts = Set<String>()
var previousLines: [String: [String]] = [:]
var last: (Int32, String)? = nil
var lastRead = Date.distantPast
let end = Date().addingTimeInterval(watchSeconds)

while Date() < end {
  if let app = NSWorkspace.shared.frontmostApplication {
    let bundle = app.bundleIdentifier ?? ""
    let element = AXUIElementCreateApplication(app.processIdentifier)
    if last?.0 != app.processIdentifier { for name in rules.wake_attributes { AXUIElementSetAttributeValue(element, name as CFString, kCFBooleanTrue) } }
    let window = attribute(element, kAXFocusedWindowAttribute).map { $0 as! AXUIElement }
    let title = window.flatMap { attribute($0, kAXTitleAttribute) as? String } ?? ""
    let changed = last == nil || last!.0 != app.processIdentifier || last!.1 != title
    let skipped = rules.never_read_bundles.contains(bundle) ||
      rules.never_read_title_words.contains { title.localizedCaseInsensitiveContains($0) }
    if !skipped, let window, changed || Date().timeIntervalSince(lastRead) >= tickSeconds {
      let (raw, url) = textOf(window)
      if let url, rules.never_read_url_words.contains(where: { url.localizedCaseInsensitiveContains($0) }) { last = (app.processIdentifier, title); lastRead = Date(); Thread.sleep(forTimeInterval: Double(rules.limits.poll_ms) / 1000); continue }
      let text = scrub(raw)
      let key = "\(bundle)\u{1f}\(title)\u{1f}\(text)"
      if !text.isEmpty, !keptTexts.contains(key) {
        keptTexts.insert(key)
        let windowKey = "\(bundle)\u{1f}\(title)"
        let lines = text.components(separatedBy: "\n")
        var capture: [String: Any] = ["at": iso.string(from: Date()), "app": app.localizedName ?? bundle,
                                      "bundle_id": bundle, "window": scrub(title),
                                      "reason": changed ? "changed" : "tick"]
        if let before = previousLines[windowKey] {
          let had = Set(before), has = Set(lines)
          capture["added"] = lines.filter { !had.contains($0) }
          capture["removed"] = before.filter { !has.contains($0) }
        } else {
          capture["text"] = text
        }
        previousLines[windowKey] = lines
        if let url { capture["url"] = scrub(url) }
        captures.append(capture)
      }
      lastRead = Date()
    }
    last = (app.processIdentifier, title)
  }
  Thread.sleep(forTimeInterval: Double(rules.limits.poll_ms) / 1000)
}
emit(["captures": captures])
