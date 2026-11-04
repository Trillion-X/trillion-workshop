// tools/record-a-job-shown-once/do-work/demonstration-recorder.swift (moved from Trillion computer/demonstration-recorder.swift)
// Records what the person does for a short, bounded time, for read-data/demonstration.mjs. One JSON request on standard
// input ({ seconds, max_events, stop_key_code }), one JSON answer on standard output ({ events, ended, ... }).
// Listen-only: nothing is posted, blocked or changed. It needs Input Monitoring (and Accessibility to name what was
// clicked); without it the answer says which, in a field of its own, and records nothing. Text typed into a secure field
// is never recorded (only that a secret was typed). The stop key (Escape by default) ends it early.
import Cocoa
import ApplicationServices

let input = FileHandle.standardInput.readDataToEndOfFile()
let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] ?? [:]
let seconds = max(1, min(600, (request["seconds"] as? Int) ?? 30))
let mostEvents = max(1, min(5000, (request["max_events"] as? Int) ?? 400))
let stopKey = Int64((request["stop_key_code"] as? Int) ?? 53)

func write(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value) else { exit(2) }
  FileHandle.standardOutput.write(data)
}

func attribute(_ element: AXUIElement, _ name: String) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  if let string = value as? String { return string }
  return nil
}

func frontApp() -> String { NSWorkspace.shared.frontmostApplication?.localizedName ?? "" }

/// What is under the pointer: its role and title, when Accessibility allows asking.
func elementAt(_ point: CGPoint) -> [String: String] {
  guard AXIsProcessTrusted() else { return [:] }
  var found: AXUIElement?
  guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &found) == .success, let element = found else { return [:] }
  var row: [String: String] = [:]
  for (key, name) in [("role", kAXRoleAttribute), ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute)] {
    if let text = attribute(element, name as String), !text.isEmpty { row[key] = String(text.prefix(120)) }
  }
  return row
}

func focusedIsSecret() -> Bool {
  guard AXIsProcessTrusted() else { return false }
  let system = AXUIElementCreateSystemWide()
  var focused: CFTypeRef?
  guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success, let element = focused else { return false }
  let subrole = attribute(element as! AXUIElement, kAXSubroleAttribute as String)
  return subrole == "AXSecureTextField"
}

final class Recording {
  var events: [[String: Any]] = []
  var secrets = 0
  var ended = "time"
  let started = Date()
}
let recording = Recording()

let mask = CGEventMask((1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.rightMouseDown.rawValue) | (1 << CGEventType.keyDown.rawValue))
let callback: CGEventTapCallBack = { _, type, event, _ in
  let at = Date().timeIntervalSince(recording.started)
  switch type {
  case .leftMouseDown, .rightMouseDown:
    var row: [String: Any] = ["event": type == .leftMouseDown ? "click" : "right_click", "app": frontApp(), "at": at]
    for (key, value) in elementAt(event.location) { row[key] = value }
    if recording.events.count < mostEvents { recording.events.append(row) }
  case .keyDown:
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    if code == stopKey { recording.ended = "stop_key"; CFRunLoopStop(CFRunLoopGetMain()); break }
    if focusedIsSecret() { recording.secrets += 1; break }
    var length = 0
    var buffer = [UniChar](repeating: 0, count: 8)
    event.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &length, unicodeString: &buffer)
    let flags = event.flags
    let chord = flags.contains(.maskCommand) || flags.contains(.maskControl)
    var row: [String: Any] = ["event": chord ? "chord" : "key", "app": frontApp(), "at": at, "key_code": code]
    if length > 0 { row["text"] = String(utf16CodeUnits: buffer, count: length) }
    if chord { row["modifiers"] = ["command": flags.contains(.maskCommand), "control": flags.contains(.maskControl), "option": flags.contains(.maskAlternate), "shift": flags.contains(.maskShift)].filter { $0.value }.map { $0.key }.sorted() }
    if recording.events.count < mostEvents { recording.events.append(row) }
  default: break
  }
  if recording.events.count >= mostEvents { recording.ended = "most_events"; CFRunLoopStop(CFRunLoopGetMain()) }
  return Unmanaged.passUnretained(event)
}

guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: callback, userInfo: nil) else {
  write(["events": [], "ended": "needs_input_monitoring", "ax_trusted": AXIsProcessTrusted()])
  exit(0)
}
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
Timer.scheduledTimer(withTimeInterval: Double(seconds), repeats: false) { _ in recording.ended = "time"; CFRunLoopStop(CFRunLoopGetMain()) }
CFRunLoopRun()
write(["events": recording.events, "ended": recording.ended, "secrets_skipped": recording.secrets, "ax_trusted": AXIsProcessTrusted(), "seconds": Date().timeIntervalSince(recording.started)])
