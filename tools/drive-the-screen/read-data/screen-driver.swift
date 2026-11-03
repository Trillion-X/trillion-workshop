// Reads the Mac's screen structure and dispatches primitive input, for tools/drive-the-screen/read-data/drive-the-screen.mjs.
// One JSON request on standard input, one JSON answer on standard output. Nothing here names an app, a control or a
// flow: `read` lists the displays and the accessibility tree of one running app; `act` runs primitive events in order
// and stops at the first that fails. What an action IS (click, type, press) is DATA in tools/drive-the-screen/read-data/drive-the-screen.json.
// Coordinates crossing the JSON boundary are global points from the top left of the main display. AX frames are
// converted from AppKit's bottom-origin frame to this space; Core Graphics pointer points use this space directly.
import Cocoa
import ApplicationServices
import Carbon

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(2)
}


// A pasteboard item whose bytes are produced only when a reader asks: it tells us the target app really read the paste.
final class PromisedText: NSObject, NSPasteboardItemDataProvider {
  let text: String
  var delivered = false
  init(_ text: String) { self.text = text }
  func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
    delivered = true
    item.setString(text, forType: type)
  }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any],
      let command = request["command"] as? String else { fail("A command is needed.") }

func write(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value) else { fail("Could not encode the answer.") }
  FileHandle.standardOutput.write(data)
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func text(_ value: AnyObject?) -> String? {
  if let string = value as? String { return string }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}

func frameOf(_ element: AXUIElement) -> [String: Double]? {
  guard let position = attribute(element, kAXPositionAttribute as String), let size = attribute(element, kAXSizeAttribute as String) else { return nil }
  var point = CGPoint.zero, extent = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
  // AXPosition is already in the global top-left coordinate space used by Quartz events and OCR.
  return ["x": Double(point.x), "y": Double(point.y), "width": Double(extent.width), "height": Double(extent.height)]
}

func childrenOf(_ element: AXUIElement, isRoot: Bool) -> [AXUIElement] {
  if isRoot {
    var rows: [AXUIElement] = []
    for name in ["AXWindows", "AXMenuBar"] { rows += (attribute(element, name) as? [AXUIElement]) ?? [] }
    return rows
  }
  return (attribute(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func appFor(_ request: [String: Any]) -> NSRunningApplication? {
  if let pid = request["pid"] as? Int { return NSRunningApplication(processIdentifier: pid_t(pid)) }
  if let name = request["app"] as? String {
    let wanted = name.lowercased()
    return NSWorkspace.shared.runningApplications.first {
      [$0.localizedName, $0.bundleIdentifier, $0.executableURL?.lastPathComponent].compactMap { $0?.lowercased() }.contains(wanted)
    }
  }
  return NSWorkspace.shared.frontmostApplication
}

func appFacts(_ app: NSRunningApplication?) -> [String: Any] {
  guard let app = app else { return [:] }
  return ["name": app.localizedName ?? "", "bundle_id": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier)]
}

/// True while the login window or screen saver has the screen: input would go to the lock, never to the app.
func screenIsLocked() -> Bool {
  guard let info = CGSessionCopyCurrentDictionary() as? [String: Any], let locked = info["CGSSessionScreenIsLocked"] else { return false }
  return (locked as? Bool) ?? ((locked as? Int) == 1)
}

// Secure Input is the system's own mode in which a password field hides what is typed from other programs. The session
// names the process that turned it on, so the person can be told who is holding it.
func secureInput() -> [String: Any] {
  guard IsSecureEventInputEnabled() else { return ["enabled": false] }
  var answer: [String: Any] = ["enabled": true]
  if let session = CGSessionCopyCurrentDictionary() as? [String: Any], let pid = session["kCGSSessionSecureInputPID"] as? Int,
     let holder = NSRunningApplication(processIdentifier: pid_t(pid)) { answer["app"] = appFacts(holder) }
  return answer
}

func rootFor(_ app: NSRunningApplication) -> AXUIElement {
  let root = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(root, 1.0)
  return root
}

func elementAt(_ root: AXUIElement, _ path: [Int]) -> AXUIElement? {
  var current = root
  for (depth, index) in path.enumerated() {
    let rows = childrenOf(current, isRoot: depth == 0)
    if index < 0 || index >= rows.count { return nil }
    current = rows[index]
  }
  return current
}

if command == "read" {
  let maxNodes = request["max_nodes"] as? Int ?? 600
  let maxDepth = request["max_depth"] as? Int ?? 12
  let readiness: [String: Any] = ["ax_trusted": AXIsProcessTrusted(), "screen_capture": CGPreflightScreenCaptureAccess(), "screen_locked": screenIsLocked()]
  let secure = secureInput()
  let displays: [[String: Any]] = NSScreen.screens.enumerated().map { index, screen in
    let top = NSScreen.screens[0].frame.maxY
    return ["index": index, "x": Double(screen.frame.minX), "y": Double(top - screen.frame.maxY), "width": Double(screen.frame.width),
            "height": Double(screen.frame.height), "scale": Double(screen.backingScaleFactor), "main": index == 0]
  }
  var answer: [String: Any] = ["readiness": readiness, "secure_input": secure, "displays": displays, "frontmost": appFacts(NSWorkspace.shared.frontmostApplication)]
  guard let app = appFor(request) else { answer["app"] = [:]; answer["elements"] = []; answer["truncated"] = false; write(answer); exit(0) }
  answer["app"] = appFacts(app)
  var elements: [[String: Any]] = []
  var truncated = false
  if AXIsProcessTrusted() {
    func visit(_ element: AXUIElement, _ path: [Int], _ depth: Int) {
      if elements.count >= maxNodes { truncated = true; return }
      if !path.isEmpty {
        var row: [String: Any] = ["path": path, "depth": depth]
        if let role = text(attribute(element, kAXRoleAttribute as String)) { row["role"] = role }
        if let subrole = text(attribute(element, kAXSubroleAttribute as String)) { row["subrole"] = subrole }
        if let title = text(attribute(element, kAXTitleAttribute as String)) { row["title"] = title }
        if let description = text(attribute(element, kAXDescriptionAttribute as String)) { row["description"] = description }
        if let value = text(attribute(element, kAXValueAttribute as String)) { row["value"] = String(value.prefix(400)) }
        if let help = text(attribute(element, kAXHelpAttribute as String)) { row["help"] = help }
        if let identifier = text(attribute(element, "AXIdentifier")) { row["identifier"] = identifier }
        if let enabled = attribute(element, kAXEnabledAttribute as String) as? Bool { row["enabled"] = enabled }
        if let focused = attribute(element, kAXFocusedAttribute as String) as? Bool { row["focused"] = focused }
        if let frame = frameOf(element) { row["frame"] = frame }
        var names: CFArray?
        if AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String], !list.isEmpty { row["actions"] = list }
        elements.append(row)
      }
      if depth >= maxDepth { return }
      for (index, child) in childrenOf(element, isRoot: path.isEmpty).enumerated() { visit(child, path + [index], depth + 1) }
    }
    visit(rootFor(app), [], 0)
  }
  answer["elements"] = elements
  answer["truncated"] = truncated
  write(answer)
  exit(0)
}

if command != "act" { fail("Unknown command.") }
guard let events = request["events"] as? [[String: Any]] else { fail("Events are needed.") }

// Nothing is dispatched into a locked screen; the caller is told so in a field of its own.
if screenIsLocked() { write(["events": [], "completed": false, "refused": "screen_locked"]); exit(0) }

// The person's stop key: while events are posted, a listen-only tap on this key ends the drive at the next event. Events
// this program posts itself carry `marker` in their source data, so the agent's own presses of the key never stop it.
final class StopWatch {
  let keyCode: Int64, marker: Int64
  private let lock = NSLock()
  private var on = false
  init(keyCode: Int64, marker: Int64) { self.keyCode = keyCode; self.marker = marker }
  var pressed: Bool { lock.lock(); defer { lock.unlock() }; return on }
  func press() { lock.lock(); on = true; lock.unlock() }
}
let stopSettings = request["stop"] as? [String: Any] ?? [:]
let stopMarker = Int64((stopSettings["marker"] as? Int) ?? 0)
var stopWatch: StopWatch?
var stopTapMade = false
if (stopSettings["enabled"] as? Bool) == true, let code = stopSettings["key_code"] as? Int {
  let watch = StopWatch(keyCode: Int64(code), marker: stopMarker)
  let callback: CGEventTapCallBack = { _, type, event, info in
    if type == .keyDown, let info = info {
      let watch = Unmanaged<StopWatch>.fromOpaque(info).takeUnretainedValue()
      if event.getIntegerValueField(.keyboardEventKeycode) == watch.keyCode, event.getIntegerValueField(.eventSourceUserData) != watch.marker { watch.press() }
    }
    return Unmanaged.passUnretained(event)
  }
  if let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
                                 callback: callback, userInfo: Unmanaged.passRetained(watch).toOpaque()) {
    stopWatch = watch
    stopTapMade = true
    let thread = Thread {
      let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
      CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
      CGEvent.tapEnable(tap: tap, enable: true)
      CFRunLoopRun()
    }
    thread.start()
  }
}

// Apps this drive un-hid are hidden again at the end, so the person's screen is as it was.
var unhidden: [pid_t] = []

func point(_ event: [String: Any]) -> CGPoint? {
  guard let x = (event["x"] as? NSNumber)?.doubleValue, let y = (event["y"] as? NSNumber)?.doubleValue else { return nil }
  // The JSON boundary is already in the global top-left coordinate space expected by CGEvent.
  return CGPoint(x: x, y: y)
}

func flags(_ names: [String]) -> CGEventFlags {
  var result: CGEventFlags = []
  for name in names {
    switch name {
    case "shift": result.insert(.maskShift)
    case "control": result.insert(.maskControl)
    case "option": result.insert(.maskAlternate)
    case "command": result.insert(.maskCommand)
    case "function": result.insert(.maskSecondaryFn)
    default: break
    }
  }
  return result
}

// `deliver` "app" posts straight to the driven process (public CGEvent.postToPid), so a background app is driven without
// taking the foreground; the default posts to the HID stream, which only the frontmost app receives.
func postEvent(_ event: CGEvent?, _ deliver: String, _ pid: Int) -> Bool {
  guard let event = event else { return false }
  if deliver == "app" { event.postToPid(pid_t(pid)); return true }
  // HID events are routed by WindowServer, so they enter the global event stream. The caller checks
  // the observed PID is still frontmost immediately before each event, including each chord/text unit.
  event.setIntegerValueField(.eventSourceUserData, value: stopMarker)
  event.post(tap: .cghidEventTap)
  return true
}

// The person's own stop: the pointer thrown into a corner of the displays ends the run before the next event. The size
// of the corner is DATA (`failsafe.corner_px`); zero is off.
func pointerInCorner(_ size: Double) -> Bool {
  guard size > 0 else { return false }
  let at = CGEvent(source: nil)?.location ?? .zero
  let top = NSScreen.screens.first?.frame.maxY ?? 0
  let frames = NSScreen.screens.map { CGRect(x: $0.frame.minX, y: top - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) }
  guard let first = frames.first else { return false }
  let box = frames.dropFirst().reduce(first) { $0.union($1) }
  return (at.x <= box.minX + size || at.x >= box.maxX - size) && (at.y <= box.minY + size || at.y >= box.maxY - size)
}

// A caption and a dot at a point, in a window that takes no focus and no mouse, shown for `ms` so the person sees where the
// program is looking or about to act. Global points from the top left, like every other point.
func showCaption(_ event: [String: Any]) -> (Bool, String) {
  guard let at = point(event) else { return (false, "A point is needed.") }
  let ms = max(0, min(10000, (event["ms"] as? Int) ?? 1500))
  let caption = (event["text"] as? String) ?? ""
  _ = NSApplication.shared
  NSApp.setActivationPolicy(.accessory)
  let top = NSScreen.screens.first?.frame.maxY ?? 0
  let dot: CGFloat = 18
  let label = NSTextField(labelWithString: caption)
  label.font = NSFont.systemFont(ofSize: 14, weight: .medium)
  label.textColor = .white
  label.sizeToFit()
  let width = caption.isEmpty ? dot : dot + 8 + label.frame.width + 16
  let height = max(dot, label.frame.height + 8)
  let panel = NSPanel(contentRect: NSRect(x: at.x - dot / 2, y: top - at.y - height / 2, width: width, height: height),
                      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
  panel.level = .screenSaver
  panel.isOpaque = false
  panel.backgroundColor = .clear
  panel.hasShadow = false
  panel.ignoresMouseEvents = true
  panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
  let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
  content.wantsLayer = true
  let ring = NSView(frame: NSRect(x: 0, y: (height - dot) / 2, width: dot, height: dot))
  ring.wantsLayer = true
  ring.layer?.cornerRadius = dot / 2
  ring.layer?.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.85).cgColor
  content.addSubview(ring)
  if !caption.isEmpty {
    let pill = NSView(frame: NSRect(x: dot + 8, y: 0, width: width - dot - 8, height: height))
    pill.wantsLayer = true
    pill.layer?.cornerRadius = height / 2
    pill.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.78).cgColor
    label.frame.origin = NSPoint(x: 8, y: (height - label.frame.height) / 2)
    pill.addSubview(label)
    content.addSubview(pill)
  }
  panel.contentView = content
  panel.orderFrontRegardless()
  RunLoop.current.run(until: Date().addingTimeInterval(Double(ms) / 1000))
  panel.orderOut(nil)
  return (true, "")
}

var done: [[String: Any]] = []
// Buttons this run pressed and has not let go of yet, with where: a run that ends early (the person's stop key, a failed
// event, a lost focus) lets each of them go before it answers, so no button stays held when control passes on.
var pressed: [String: CGPoint] = [:]
var stoppedByPerson = false
var typed = false
let failsafeSize = ((request["failsafe"] as? [String: Any])?["corner_px"] as? NSNumber)?.doubleValue ?? 0
guard let targetPID = request["pid"] as? Int, targetPID > 0 else { fail("A target app process is needed.") }
// `deliver: "app"` on the request (a background drive) delivers every event to the process itself, so the app is driven
// where it is, on any display, and never has to be in front: the person's foreground app keeps their keyboard and pointer.
let toProcess = (request["deliver"] as? String) == "app"
for event in events {
  guard let kind = event["event"] as? String else { done.append(["ok": false, "detail": "An event needs its kind."]); break }
  if stopWatch?.pressed == true { done.append(["event": kind, "ok": false, "detail": "The person pressed the stop key."]); stoppedByPerson = true; break }
  // HID input goes to the foreground app, regardless of the app whose tree was read. Check at each event,
  // including within a text/chord burst, so switching apps cannot redirect the rest of the input. Input posted to
  // the process itself cannot be redirected by a change of the front app.
  func hasFocus() -> Bool {
    NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(targetPID)
  }
  let deliver = toProcess ? "app" : (event["deliver"] as? String) ?? "hid"
  let needsFocus = !toProcess && (deliver != "app" || ["ax_action", "ax_set"].contains(kind))
  if ["mouse_move", "mouse_drag", "mouse_button", "scroll", "chord", "text", "paste", "ax_action", "ax_set"].contains(kind) && needsFocus && !hasFocus() {
    done.append(["event": kind, "ok": false, "detail": "The app being driven is no longer frontmost."]); break
  }
  if ["mouse_move", "mouse_drag", "mouse_button", "scroll", "chord", "text"].contains(kind) && pointerInCorner(failsafeSize) {
    done.append(["event": kind, "ok": false, "code": "failsafe", "detail": "The pointer was thrown into a corner of the screen, which ends the run."]); break
  }
  if deliver == "app" && NSRunningApplication(processIdentifier: pid_t(targetPID))?.isTerminated != false {
    done.append(["event": kind, "ok": false, "detail": "The selected app is no longer running."]); break
  }
  if ["chord", "text"].contains(kind) { typed = true }
  var ok = false, detail = ""
  switch kind {
  case "app_activate":
    if let app = NSRunningApplication(processIdentifier: pid_t(targetPID)), !app.isTerminated {
      if app.isHidden { unhidden.append(app.processIdentifier); app.unhide() }
      let requested: Bool
      if #available(macOS 14.0, *) { requested = app.activate() } else { requested = app.activate(options: [.activateIgnoringOtherApps]) }
      // A background CLI can request activation without WindowServer moving
      // focus. Use the same observed app's Accessibility owner to raise it.
      let raised = hasFocus() ? AXError.success : AXUIElementSetAttributeValue(rootFor(app), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
      let deadline = Date().addingTimeInterval(Double(max(0, min(2000, (event["timeout_ms"] as? Int) ?? 1000))) / 1000)
      while !hasFocus() && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
      }
      ok = hasFocus()
      if !ok { detail = requested || raised == .success ? "The selected app did not become frontmost." : "The selected app could not be activated." }
    } else { detail = "The selected app is no longer running." }
  case "caption":
    (ok, detail) = showCaption(event)
  case "pause":
    usleep(UInt32(max(0, min(5000, (event["ms"] as? Int) ?? 0)) * 1000)); ok = true
  case "mouse_move":
    if let at = point(event) { ok = postEvent(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: .left), deliver, targetPID) } else { detail = "A point is needed." }
  case "mouse_drag":
    if let at = point(event) {
      let button = (event["button"] as? String) ?? "left"
      let types: [String: (CGEventType, CGMouseButton)] = ["left": (.leftMouseDragged, .left), "right": (.rightMouseDragged, .right), "other": (.otherMouseDragged, .center)]
      if let row = types[button] {
        let made = CGEvent(mouseEventSource: nil, mouseType: row.0, mouseCursorPosition: at, mouseButton: row.1)
        made?.setIntegerValueField(.mouseEventClickState, value: 1)
        if let names = event["modifiers"] as? [String] { made?.flags = flags(names) }
        ok = postEvent(made, deliver, targetPID)
      } else { detail = "Unknown button." }
    } else { detail = "A point is needed." }
  case "mouse_button":
    if let at = point(event) {
      let button = (event["button"] as? String) ?? "left"
      let down = (event["phase"] as? String) != "up"
      let types: [String: (CGEventType, CGEventType, CGMouseButton)] = ["left": (.leftMouseDown, .leftMouseUp, .left), "right": (.rightMouseDown, .rightMouseUp, .right), "other": (.otherMouseDown, .otherMouseUp, .center)]
      if let row = types[button] {
        let made = CGEvent(mouseEventSource: nil, mouseType: down ? row.0 : row.1, mouseCursorPosition: at, mouseButton: row.2)
        made?.setIntegerValueField(.mouseEventClickState, value: Int64((event["click_count"] as? Int) ?? 1))
        if let names = event["modifiers"] as? [String] { made?.flags = flags(names) }
        ok = postEvent(made, deliver, targetPID)
        if ok { if down { pressed[button] = at } else { pressed[button] = nil } }
      } else { detail = "Unknown button." }
    } else { detail = "A point is needed." }
  case "scroll":
    let made = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32((event["dy"] as? Int) ?? 0), wheel2: Int32((event["dx"] as? Int) ?? 0), wheel3: 0)
    ok = postEvent(made, deliver, targetPID)
  case "chord":
    let codes = (event["keys"] as? [Int]) ?? []
    let held = flags((event["modifiers"] as? [String]) ?? [])
    ok = !codes.isEmpty
    for code in codes {
      for down in [true, false] {
        if needsFocus && !hasFocus() { ok = false; detail = "The app being driven is no longer frontmost."; break }
        let made = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down)
        made?.flags = held
        ok = postEvent(made, deliver, targetPID) && ok
        usleep(8000)
      }
    }
  case "text":
    // A scalar's UTF-16 units must stay in one event, including a surrogate pair at a chunk boundary.
    var chunks: [[UniChar]] = [], pending: [UniChar] = []
    for scalar in ((event["text"] as? String) ?? "").unicodeScalars {
      let units = Array(String(scalar).utf16)
      if pending.count + units.count > 16 { chunks.append(pending); pending = [] }
      pending += units
    }
    if !pending.isEmpty { chunks.append(pending) }
    ok = !chunks.isEmpty
    for chunk in chunks {
      if needsFocus && !hasFocus() { ok = false; detail = "The app being driven is no longer frontmost."; break }
      for down in [true, false] {
        let made = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
        made?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        ok = postEvent(made, deliver, targetPID) && ok
      }
      usleep(8000)
    }
  case "paste":
    // Save the pasteboard, promise the text, press the paste chord, wait until the target app asks for the bytes, restore.
    let board = NSPasteboard.general
    let saved: [[(NSPasteboard.PasteboardType, Data)]] = (board.pasteboardItems ?? []).map { item in item.types.compactMap { type in item.data(forType: type).map { (type, $0) } } }
    let promised = PromisedText((event["text"] as? String) ?? "")
    let item = NSPasteboardItem()
    item.setDataProvider(promised, forTypes: [.string])
    board.clearContents()
    board.writeObjects([item])
    let held = flags(["command"])
    for down in [true, false] {
      let made = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(9), keyDown: down)
      made?.flags = held
      _ = postEvent(made, deliver, targetPID)
      usleep(8000)
    }
    let deadline = Date().addingTimeInterval(Double(max(100, min(5000, (event["timeout_ms"] as? Int) ?? 1500))) / 1000)
    while !promised.delivered && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
    ok = promised.delivered
    board.clearContents()
    for entry in saved {
      let restored = NSPasteboardItem()
      for (type, data) in entry { restored.setData(data, forType: type) }
      board.writeObjects([restored])
    }
    detail = ok ? "The app read the pasted text; the clipboard was put back (\(saved.count) item(s))." : "The app did not read the pasted text in time; the clipboard was put back (\(saved.count) item(s))."
  case "ax_action", "ax_set":
    // The element is found again by its path and must still be what the caller located; a changed screen refuses.
    guard let app = appFor(event), let path = event["path"] as? [Int] else { detail = "An app and an element path are needed."; break }
    guard AXIsProcessTrusted() else { detail = "Accessibility is not allowed for this program."; break }
    guard let element = elementAt(rootFor(app), path) else { detail = "That element is gone."; break }
    let expect = (event["expect"] as? [String: String]) ?? [:]
    let now: [String: String?] = ["role": text(attribute(element, kAXRoleAttribute as String)), "title": text(attribute(element, kAXTitleAttribute as String)),
                                  "description": text(attribute(element, kAXDescriptionAttribute as String)), "value": text(attribute(element, kAXValueAttribute as String))]
    if let moved = expect.first(where: { now[$0.key].flatMap { $0 } != $0.value }) { detail = "That element changed (\(moved.key))."; break }
    if kind == "ax_action" {
      let result = AXUIElementPerformAction(element, ((event["action"] as? String) ?? "AXPress") as CFString)
      ok = result == .success; if !ok { detail = "The element refused the action (\(result.rawValue))." }
    } else {
      let result = AXUIElementSetAttributeValue(element, ((event["attribute"] as? String) ?? "AXValue") as CFString, ((event["value"] as? String) ?? "") as CFTypeRef)
      ok = result == .success; if !ok { detail = "The element refused the value (\(result.rawValue))." }
    }
  default:
    detail = "Unknown event."
  }
  done.append(["event": kind, "ok": ok, "detail": detail])
  if !ok { break }
}
let ups: [String: (CGEventType, CGMouseButton)] = ["left": (.leftMouseUp, .left), "right": (.rightMouseUp, .right), "other": (.otherMouseUp, .center)]
var released: [String] = []
for (button, at) in pressed.sorted(by: { $0.key < $1.key }) {
  if let row = ups[button], postEvent(CGEvent(mouseEventSource: nil, mouseType: row.0, mouseCursorPosition: at, mouseButton: row.1), toProcess ? "app" : "hid", targetPID) { released.append(button) }
}
for pid in unhidden { NSRunningApplication(processIdentifier: pid)?.hide() }
var answer: [String: Any] = ["events": done, "released": released, "completed": done.count == events.count && done.allSatisfy { ($0["ok"] as? Bool) == true },
                             "stopped_by_person": stoppedByPerson, "stop_key_watched": stopTapMade, "rehidden": unhidden.map { Int($0) }]
if typed { answer["secure_input"] = secureInput() }
write(answer)
