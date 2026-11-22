// Reads the Mac's screen structure and dispatches primitive input, for tools/drive-the-screen/read-data/drive-the-screen.mjs.
// One JSON request on standard input, one JSON answer on standard output. Nothing here names an app, a control or a
// flow: `read` lists the displays and the accessibility tree of one running app; `act` runs primitive events in order
// and stops at the first that fails. What an action IS (click, type, press) is DATA in tools/drive-the-screen/read-data/drive-the-screen.json.
// Coordinates crossing the JSON boundary are global points from the top left of the main display. AX frames are
// already in this space; Core Graphics pointer points use this space directly.
// Run by /usr/bin/osascript -l JavaScript (JavaScript for Automation and its Objective-C bridge), which every Mac has,
// so it starts inside a run's sandbox with no developer tools (the Swift helper it replaces needed Xcode's xcrun).
ObjC.import('Foundation');
ObjC.import('stdlib');
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.import('Carbon');

// Accessibility calls take and give objects, so their answers arrive as objects (arrays, strings, numbers, elements).
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id *']]);
ObjC.bindFunction('AXUIElementCopyActionNames', ['int', ['id', 'id *']]);
ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
ObjC.bindFunction('AXUIElementSetMessagingTimeout', ['int', ['id', 'float']]);
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CGSessionCopyCurrentDictionary', ['id', []]);
ObjC.bindFunction('IsSecureEventInputEnabled', ['bool', []]);
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void *', 'unsigned long', 'void *']]);

// Core Graphics numbers (CGEventTypes.h, CGEventSource.h): event types, buttons, taps and fields.
const TYPE = { leftMouseDown: 1, leftMouseUp: 2, rightMouseDown: 3, rightMouseUp: 4, mouseMoved: 5, leftMouseDragged: 6,
  rightMouseDragged: 7, otherMouseDown: 25, otherMouseUp: 26, otherMouseDragged: 27 };
const BUTTON = { left: 0, right: 1, other: 2 };
const HID_EVENT_TAP = 0;
const FIELD_CLICK_STATE = 1;
const FIELD_KEYCODE = 9;
const FIELD_SOURCE_USER_DATA = 42;
const SCROLL_UNITS_PIXEL = 0;
const FLAG = { shift: 0x20000, control: 0x40000, option: 0x80000, command: 0x100000, function: 0x800000 };

function say(handle, text) { handle.writeData($(text).dataUsingEncoding($.NSUTF8StringEncoding)); }
function fail(message) { say($.NSFileHandle.fileHandleWithStandardError, message + '\n'); $.exit(2); }
function write(value) { say($.NSFileHandle.fileHandleWithStandardOutput, JSON.stringify(value)); }
function sleepMs(ms) { if (ms > 0) $.NSThread.sleepForTimeInterval(ms / 1000); }
/** Lets the run loop deliver what it holds (the stop key's monitor, a pasteboard read, a panel) for `ms`. */
function pump(ms) { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(Math.max(0, ms) / 1000)); }
const isNil = value => value === null || value === undefined || (typeof value.isNil === 'function' && value.isNil());
const int = (value, fallback) => (Number.isInteger(value) ? value : fallback);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function attribute(element, name) {
  const value = Ref();
  return $.AXUIElementCopyAttributeValue(element, $(name), value) === 0 && !isNil(value[0]) ? value[0] : null;
}

function text(value) {
  if (isNil(value)) return null;
  if (value.isKindOfClass($.NSString)) return value.js;
  if (value.isKindOfClass($.NSNumber)) return value.stringValue.js;
  return null;
}

function bool(value) {
  if (isNil(value) || !value.isKindOfClass($.NSNumber)) return null;
  return Boolean(value.boolValue);
}

function list(value) {
  if (isNil(value) || !value.isKindOfClass($.NSArray)) return [];
  const rows = [];
  for (let index = 0; index < Number(value.count); index += 1) rows.push(value.objectAtIndex(index));
  return rows;
}

// An AXValue says its point or size in its description ("x:12.000000 y:34.000000", "w:56.000000 h:78.000000").
function axNumbers(value, first, second) {
  if (isNil(value)) return null;
  const match = new RegExp(`${first}:(-?[0-9.]+) ${second}:(-?[0-9.]+)`).exec(value.description.js);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function frameOf(element) {
  const at = axNumbers(attribute(element, 'AXPosition'), 'x', 'y');
  const extent = axNumbers(attribute(element, 'AXSize'), 'w', 'h');
  if (!at || !extent) return null;
  // AXPosition is already in the global top-left coordinate space used by Quartz events and OCR.
  return { x: at[0], y: at[1], width: extent[0], height: extent[1] };
}

function childrenOf(element, isRoot) {
  // Only list answers are walked at the root, as the Swift helper did: an app whose menu bar answers as one element
  // keeps the same element paths it always had.
  if (isRoot) return ['AXWindows', 'AXMenuBar'].flatMap(name => list(attribute(element, name)));
  return list(attribute(element, 'AXChildren'));
}

function runningApps() { return list($.NSWorkspace.sharedWorkspace.runningApplications); }

function appFor(source) {
  if (Number.isInteger(source.pid)) {
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(source.pid);
    return isNil(app) ? null : app;
  }
  if (typeof source.app === 'string') {
    const wanted = source.app.toLowerCase();
    return runningApps().find(app => [app.localizedName, app.bundleIdentifier, isNil(app.executableURL) ? null : app.executableURL.lastPathComponent]
      .map(text).filter(Boolean).map(name => name.toLowerCase()).includes(wanted)) ?? null;
  }
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return isNil(front) ? null : front;
}

function appFacts(app) {
  if (!app) return {};
  return { name: text(app.localizedName) ?? '', bundle_id: text(app.bundleIdentifier) ?? '', pid: Number(app.processIdentifier) };
}

function session() {
  const info = $.CGSessionCopyCurrentDictionary();
  return isNil(info) ? {} : ObjC.deepUnwrap(info) ?? {};
}

/** True while the login window or screen saver has the screen: input would go to the lock, never to the app. */
function screenIsLocked() {
  const locked = session().CGSSessionScreenIsLocked;
  return locked === true || locked === 1;
}

// Secure Input is the system's own mode in which a password field hides what is typed from other programs. The session
// names the process that turned it on, so the person can be told who is holding it.
function secureInput() {
  if (!$.IsSecureEventInputEnabled()) return { enabled: false };
  const answer = { enabled: true };
  const pid = session().kCGSSessionSecureInputPID;
  if (Number.isInteger(pid)) {
    const holder = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    if (!isNil(holder)) answer.app = appFacts(holder);
  }
  return answer;
}

function rootFor(app) {
  const root = $.AXUIElementCreateApplication(Number(app.processIdentifier));
  $.AXUIElementSetMessagingTimeout(root, 1.0);
  return root;
}

function elementAt(root, path) {
  let current = root;
  for (let depth = 0; depth < path.length; depth += 1) {
    const rows = childrenOf(current, depth === 0);
    const index = path[depth];
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) return null;
    current = rows[index];
  }
  return current;
}

function screens() { return list($.NSScreen.screens); }

/** Every display's frame in the global top-left space (AppKit's frames start at the bottom left of the main display). */
function displayFrames() {
  const all = screens();
  if (all.length === 0) return [];
  const top = all[0].frame.origin.y + all[0].frame.size.height;
  return all.map(screen => ({ x: screen.frame.origin.x, y: top - (screen.frame.origin.y + screen.frame.size.height),
    width: screen.frame.size.width, height: screen.frame.size.height, scale: Number(screen.backingScaleFactor) }));
}

function read(request) {
  const maxNodes = int(request.max_nodes, 600);
  const maxDepth = int(request.max_depth, 12);
  const trusted = $.AXIsProcessTrusted();
  const readiness = { ax_trusted: trusted, screen_capture: $.CGPreflightScreenCaptureAccess(), screen_locked: screenIsLocked() };
  const displays = displayFrames().map((frame, index) => ({ index, x: frame.x, y: frame.y, width: frame.width, height: frame.height,
    scale: frame.scale, main: index === 0 }));
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const answer = { readiness, secure_input: secureInput(), displays, frontmost: appFacts(isNil(front) ? null : front) };
  const app = appFor(request);
  if (!app) return { ...answer, app: {}, elements: [], truncated: false };
  answer.app = appFacts(app);
  const elements = [];
  let truncated = false;
  if (trusted) {
    const visit = (element, path, depth) => {
      if (elements.length >= maxNodes) { truncated = true; return; }
      if (path.length > 0) {
        const row = { path, depth };
        for (const [field, name] of [['role', 'AXRole'], ['subrole', 'AXSubrole'], ['title', 'AXTitle'], ['description', 'AXDescription'],
          ['value', 'AXValue'], ['help', 'AXHelp'], ['identifier', 'AXIdentifier']]) {
          const value = text(attribute(element, name));
          if (value !== null) row[field] = field === 'value' ? value.slice(0, 400) : value;
        }
        const enabled = bool(attribute(element, 'AXEnabled'));
        if (enabled !== null) row.enabled = enabled;
        const focused = bool(attribute(element, 'AXFocused'));
        if (focused !== null) row.focused = focused;
        const frame = frameOf(element);
        if (frame) row.frame = frame;
        const names = Ref();
        if ($.AXUIElementCopyActionNames(element, names) === 0) {
          const actions = list(names[0]).map(text).filter(Boolean);
          if (actions.length > 0) row.actions = actions;
        }
        elements.push(row);
      }
      if (depth >= maxDepth) return;
      childrenOf(element, path.length === 0).forEach((child, index) => visit(child, [...path, index], depth + 1));
    };
    visit(rootFor(app), [], 0);
  }
  return { ...answer, elements, truncated };
}

function point(event) {
  const x = event.x, y = event.y;
  // The JSON boundary is already in the global top-left coordinate space expected by Core Graphics events.
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function flags(names) { return (names ?? []).reduce((mask, name) => mask | (FLAG[name] ?? 0), 0); }

function act(request) {
  const events = request.events;
  if (!Array.isArray(events)) fail('Events are needed.');
  // Nothing is dispatched into a locked screen; the caller is told so in a field of its own.
  if (screenIsLocked()) return { events: [], completed: false, refused: 'screen_locked' };
  const targetPID = request.pid;
  if (!Number.isInteger(targetPID) || targetPID <= 0) fail('A target app process is needed.');
  $.NSApplication.sharedApplication;
  $.NSApp.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

  // The person's stop key: while events are posted, a monitor of the key presses the system delivers to every other app
  // ends the drive at the next event (checked before each event and through every wait, as the run loop is pumped). Events
  // this program posts itself carry `marker` in their source data, so the agent's own presses of the key never stop it.
  // The monitor is the system's own global key monitor, open to a program the person allowed Accessibility, which a
  // drive already needs; an event tap's callback cannot be written in this language.
  const stop = request.stop ?? {};
  const stopMarker = int(stop.marker, 0);
  let stopPressed = false;
  let stopWatched = false;
  let monitor = null;
  if (stop.enabled === true && Number.isInteger(stop.key_code)) {
    monitor = $.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler($.NSEventMaskKeyDown, seen => {
      const posted = seen.CGEvent;
      if (Number(seen.keyCode) === stop.key_code && Number($.CGEventGetIntegerValueField(posted, FIELD_SOURCE_USER_DATA)) !== stopMarker) stopPressed = true;
    });
    stopWatched = !isNil(monitor);
  }
  const wait = ms => { const until = Date.now() + ms; do { pump(Math.min(20, Math.max(0, until - Date.now()))); } while (Date.now() < until && !stopPressed); };

  const unhidden = [];
  const done = [];
  // Buttons this run pressed and has not let go of yet, with where: a run that ends early (the person's stop key, a failed
  // event, a lost focus) lets each of them go before it answers, so no button stays held when control passes on.
  const pressed = {};
  let stoppedByPerson = false;
  let typed = false;
  const failsafeSize = typeof request.failsafe?.corner_px === 'number' ? request.failsafe.corner_px : 0;
  // `deliver: "app"` on the request (a background drive) delivers every event to the process itself, so the app is driven
  // where it is, on any display, and never has to be in front: the person's foreground app keeps their keyboard and pointer.
  const toProcess = request.deliver === 'app';
  const targetApp = () => { const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(targetPID); return isNil(app) ? null : app; };
  const hasFocus = () => { const front = $.NSWorkspace.sharedWorkspace.frontmostApplication; return !isNil(front) && Number(front.processIdentifier) === targetPID; };

  // `deliver` "app" posts straight to the driven process (public CGEventPostToPid), so a background app is driven without
  // taking the foreground; the default posts to the HID stream, which only the frontmost app receives.
  const postEvent = (made, deliver) => {
    if (isNil(made)) return false;
    if (deliver === 'app') { $.CGEventPostToPid(targetPID, made); return true; }
    // HID events are routed by WindowServer, so they enter the global event stream. The caller checks the observed PID
    // is still frontmost immediately before each event, including each chord/text unit.
    $.CGEventSetIntegerValueField(made, FIELD_SOURCE_USER_DATA, stopMarker);
    $.CGEventPost(HID_EVENT_TAP, made);
    return true;
  };

  // The person's own stop: the pointer thrown into a corner of the displays ends the run before the next event. The size
  // of the corner is DATA (`failsafe.corner_px`); zero is off.
  const pointerInCorner = size => {
    if (!(size > 0)) return false;
    const at = $.CGEventGetLocation($.CGEventCreate(null));
    const frames = displayFrames();
    if (frames.length === 0) return false;
    const box = frames.reduce((all, frame) => ({ minX: Math.min(all.minX, frame.x), minY: Math.min(all.minY, frame.y),
      maxX: Math.max(all.maxX, frame.x + frame.width), maxY: Math.max(all.maxY, frame.y + frame.height) }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    return (at.x <= box.minX + size || at.x >= box.maxX - size) && (at.y <= box.minY + size || at.y >= box.maxY - size);
  };

  // A caption and a dot at a point, in a window that takes no focus and no mouse, shown for `ms` so the person sees where
  // the program is looking or about to act. Global points from the top left, like every other point.
  const showCaption = event => {
    const at = point(event);
    if (!at) return [false, 'A point is needed.'];
    const ms = clamp(int(event.ms, 1500), 0, 10000);
    const caption = typeof event.text === 'string' ? event.text : '';
    const frames = screens();
    const top = frames.length > 0 ? frames[0].frame.origin.y + frames[0].frame.size.height : 0;
    const dot = 18;
    const label = $.NSTextField.labelWithString($(caption));
    label.font = $.NSFont.systemFontOfSizeWeight(14, $.NSFontWeightMedium);
    label.textColor = $.NSColor.whiteColor;
    label.sizeToFit;
    const labelWidth = label.frame.size.width, labelHeight = label.frame.size.height;
    const width = caption === '' ? dot : dot + 8 + labelWidth + 16;
    const height = Math.max(dot, labelHeight + 8);
    const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(at.x - dot / 2, top - at.y - height / 2, width, height),
      $.NSWindowStyleMaskBorderless | $.NSWindowStyleMaskNonactivatingPanel, $.NSBackingStoreBuffered, false);
    panel.level = $.NSScreenSaverWindowLevel;
    panel.opaque = false;
    panel.backgroundColor = $.NSColor.clearColor;
    panel.hasShadow = false;
    panel.ignoresMouseEvents = true;
    panel.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorFullScreenAuxiliary | $.NSWindowCollectionBehaviorStationary;
    const content = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, width, height));
    content.wantsLayer = true;
    const ring = $.NSView.alloc.initWithFrame($.NSMakeRect(0, (height - dot) / 2, dot, dot));
    ring.wantsLayer = true;
    ring.layer.cornerRadius = dot / 2;
    ring.layer.backgroundColor = $.NSColor.systemBlueColor.colorWithAlphaComponent(0.85).CGColor;
    content.addSubview(ring);
    if (caption !== '') {
      const pill = $.NSView.alloc.initWithFrame($.NSMakeRect(dot + 8, 0, width - dot - 8, height));
      pill.wantsLayer = true;
      pill.layer.cornerRadius = height / 2;
      pill.layer.backgroundColor = $.NSColor.blackColor.colorWithAlphaComponent(0.78).CGColor;
      label.setFrameOrigin($.NSMakePoint(8, (height - labelHeight) / 2));
      pill.addSubview(label);
      content.addSubview(pill);
    }
    panel.contentView = content;
    panel.orderFrontRegardless;
    wait(ms);
    panel.orderOut(null);
    return [true, ''];
  };

  const keyEvent = (code, down, held) => {
    const made = $.CGEventCreateKeyboardEvent(null, code, down);
    $.CGEventSetFlags(made, held);
    return made;
  };

  for (const event of events) {
    const kind = event?.event;
    if (typeof kind !== 'string') { done.push({ ok: false, detail: 'An event needs its kind.' }); break; }
    pump(0);
    if (stopPressed) { done.push({ event: kind, ok: false, detail: 'The person pressed the stop key.' }); stoppedByPerson = true; break; }
    // HID input goes to the foreground app, regardless of the app whose tree was read. Check at each event, including
    // within a text/chord burst, so switching apps cannot redirect the rest of the input. Input posted to the process
    // itself cannot be redirected by a change of the front app.
    const deliver = toProcess ? 'app' : (typeof event.deliver === 'string' ? event.deliver : 'hid');
    const needsFocus = !toProcess && (deliver !== 'app' || ['ax_action', 'ax_set'].includes(kind));
    if (['mouse_move', 'mouse_drag', 'mouse_button', 'scroll', 'chord', 'text', 'paste', 'ax_action', 'ax_set'].includes(kind) && needsFocus && !hasFocus()) {
      done.push({ event: kind, ok: false, detail: 'The app being driven is no longer frontmost.' }); break;
    }
    if (['mouse_move', 'mouse_drag', 'mouse_button', 'scroll', 'chord', 'text'].includes(kind) && pointerInCorner(failsafeSize)) {
      done.push({ event: kind, ok: false, code: 'failsafe', detail: 'The pointer was thrown into a corner of the screen, which ends the run.' }); break;
    }
    if (deliver === 'app') {
      const app = targetApp();
      if (!app || app.terminated) { done.push({ event: kind, ok: false, detail: 'The selected app is no longer running.' }); break; }
    }
    if (['chord', 'text'].includes(kind)) typed = true;
    let ok = false, detail = '';
    switch (kind) {
      case 'app_activate': {
        const app = targetApp();
        if (app && !app.terminated) {
          if (app.hidden) { unhidden.push(targetPID); app.unhide; }
          const requested = app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
          // A background program can request activation without WindowServer moving focus. Use the same observed app's
          // Accessibility owner to raise it.
          const raised = hasFocus() ? 0 : $.AXUIElementSetAttributeValue(rootFor(app), $('AXFrontmost'), $.NSNumber.numberWithBool(true));
          const until = Date.now() + clamp(int(event.timeout_ms, 1000), 0, 2000);
          while (!hasFocus() && Date.now() < until) pump(20);
          ok = hasFocus();
          if (!ok) detail = requested || raised === 0 ? 'The selected app did not become frontmost.' : 'The selected app could not be activated.';
        } else detail = 'The selected app is no longer running.';
        break;
      }
      case 'caption':
        [ok, detail] = showCaption(event);
        break;
      case 'pause':
        wait(clamp(int(event.ms, 0), 0, 5000)); ok = !stopPressed;
        if (!ok) detail = 'The person pressed the stop key.';
        break;
      case 'mouse_move': {
        const at = point(event);
        if (at) ok = postEvent($.CGEventCreateMouseEvent(null, TYPE.mouseMoved, at, BUTTON.left), deliver); else detail = 'A point is needed.';
        break;
      }
      case 'mouse_drag': {
        const at = point(event);
        if (!at) { detail = 'A point is needed.'; break; }
        const row = { left: [TYPE.leftMouseDragged, BUTTON.left], right: [TYPE.rightMouseDragged, BUTTON.right], other: [TYPE.otherMouseDragged, BUTTON.other] }[event.button ?? 'left'];
        if (!row) { detail = 'Unknown button.'; break; }
        const made = $.CGEventCreateMouseEvent(null, row[0], at, row[1]);
        $.CGEventSetIntegerValueField(made, FIELD_CLICK_STATE, 1);
        if (Array.isArray(event.modifiers)) $.CGEventSetFlags(made, flags(event.modifiers));
        ok = postEvent(made, deliver);
        break;
      }
      case 'mouse_button': {
        const at = point(event);
        if (!at) { detail = 'A point is needed.'; break; }
        const button = event.button ?? 'left';
        const down = event.phase !== 'up';
        const row = { left: [TYPE.leftMouseDown, TYPE.leftMouseUp, BUTTON.left], right: [TYPE.rightMouseDown, TYPE.rightMouseUp, BUTTON.right],
          other: [TYPE.otherMouseDown, TYPE.otherMouseUp, BUTTON.other] }[button];
        if (!row) { detail = 'Unknown button.'; break; }
        const made = $.CGEventCreateMouseEvent(null, down ? row[0] : row[1], at, row[2]);
        $.CGEventSetIntegerValueField(made, FIELD_CLICK_STATE, int(event.click_count, 1));
        if (Array.isArray(event.modifiers)) $.CGEventSetFlags(made, flags(event.modifiers));
        ok = postEvent(made, deliver);
        if (ok) { if (down) pressed[button] = at; else delete pressed[button]; }
        break;
      }
      case 'scroll':
        ok = postEvent($.CGEventCreateScrollWheelEvent2(null, SCROLL_UNITS_PIXEL, 2, int(event.dy, 0), int(event.dx, 0), 0), deliver);
        break;
      case 'chord': {
        const codes = Array.isArray(event.keys) ? event.keys.filter(Number.isInteger) : [];
        const held = flags(event.modifiers);
        ok = codes.length > 0;
        outer: for (const code of codes) {
          for (const down of [true, false]) {
            if (needsFocus && !hasFocus()) { ok = false; detail = 'The app being driven is no longer frontmost.'; break outer; }
            ok = postEvent(keyEvent(code, down, held), deliver) && ok;
            sleepMs(8);
          }
        }
        break;
      }
      case 'text': {
        // A scalar's UTF-16 units must stay in one event, including a surrogate pair at a chunk boundary.
        const chunks = [];
        let pending = '';
        for (const scalar of typeof event.text === 'string' ? event.text : '') {
          if (pending.length + scalar.length > 16) { chunks.push(pending); pending = ''; }
          pending += scalar;
        }
        if (pending !== '') chunks.push(pending);
        ok = chunks.length > 0;
        for (const chunk of chunks) {
          if (needsFocus && !hasFocus()) { ok = false; detail = 'The app being driven is no longer frontmost.'; break; }
          const units = $(chunk).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
          for (const down of [true, false]) {
            const made = $.CGEventCreateKeyboardEvent(null, 0, down);
            $.CGEventKeyboardSetUnicodeString(made, chunk.length, units.bytes);
            ok = postEvent(made, deliver) && ok;
          }
          sleepMs(8);
        }
        break;
      }
      case 'paste': {
        // Save the pasteboard, promise the text, press the paste chord, wait until the target app asks for the bytes, restore.
        const board = $.NSPasteboard.generalPasteboard;
        const saved = list(board.pasteboardItems).map(item => list(item.types).map(type => [type, item.dataForType(type)]).filter(([, data]) => !isNil(data)));
        const promised = { text: typeof event.text === 'string' ? event.text : '', delivered: false };
        const provider = PromisedText.alloc.init;
        currentPromise = promised;
        const item = $.NSPasteboardItem.alloc.init;
        item.setDataProviderForTypes(provider, $([$.NSPasteboardTypeString]));
        board.clearContents;
        board.writeObjects($([item]));
        for (const down of [true, false]) { postEvent(keyEvent(9, down, FLAG.command), deliver); sleepMs(8); }
        const until = Date.now() + clamp(int(event.timeout_ms, 1500), 100, 5000);
        while (!promised.delivered && Date.now() < until) pump(20);
        ok = promised.delivered;
        board.clearContents;
        for (const entry of saved) {
          const restored = $.NSPasteboardItem.alloc.init;
          for (const [type, data] of entry) restored.setDataForType(data, type);
          board.writeObjects($([restored]));
        }
        detail = ok ? `The app read the pasted text; the clipboard was put back (${saved.length} item(s)).`
          : `The app did not read the pasted text in time; the clipboard was put back (${saved.length} item(s)).`;
        break;
      }
      case 'ax_action':
      case 'ax_set': {
        // The element is found again by its path and must still be what the caller located; a changed screen refuses.
        const app = appFor(event);
        if (!app || !Array.isArray(event.path)) { detail = 'An app and an element path are needed.'; break; }
        if (!$.AXIsProcessTrusted()) { detail = 'Accessibility is not allowed for this program.'; break; }
        const element = elementAt(rootFor(app), event.path);
        if (!element) { detail = 'That element is gone.'; break; }
        const expect = event.expect && typeof event.expect === 'object' ? event.expect : {};
        const now = { role: text(attribute(element, 'AXRole')), title: text(attribute(element, 'AXTitle')),
          description: text(attribute(element, 'AXDescription')), value: text(attribute(element, 'AXValue')) };
        const moved = Object.entries(expect).find(([key, value]) => (now[key] ?? null) !== value);
        if (moved) { detail = `That element changed (${moved[0]}).`; break; }
        if (kind === 'ax_action') {
          const result = $.AXUIElementPerformAction(element, $(typeof event.action === 'string' ? event.action : 'AXPress'));
          ok = result === 0; if (!ok) detail = `The element refused the action (${result}).`;
        } else {
          const result = $.AXUIElementSetAttributeValue(element, $(typeof event.attribute === 'string' ? event.attribute : 'AXValue'), $(typeof event.value === 'string' ? event.value : ''));
          ok = result === 0; if (!ok) detail = `The element refused the value (${result}).`;
        }
        break;
      }
      default:
        detail = 'Unknown event.';
    }
    done.push({ event: kind, ok, detail });
    if (!ok) break;
  }
  const ups = { left: [TYPE.leftMouseUp, BUTTON.left], right: [TYPE.rightMouseUp, BUTTON.right], other: [TYPE.otherMouseUp, BUTTON.other] };
  const released = [];
  for (const button of Object.keys(pressed).sort()) {
    const row = ups[button];
    if (row && postEvent($.CGEventCreateMouseEvent(null, row[0], pressed[button], row[1]), toProcess ? 'app' : 'hid')) released.push(button);
  }
  for (const pid of unhidden) { const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid); if (!isNil(app)) app.hide; }
  if (monitor && !isNil(monitor)) $.NSEvent.removeMonitor(monitor);
  const answer = { events: done, released, completed: done.length === events.length && done.every(row => row.ok === true),
    stopped_by_person: stoppedByPerson, stop_key_watched: stopWatched, rehidden: unhidden };
  if (typed) answer.secure_input = secureInput();
  return answer;
}

// A pasteboard item whose bytes are produced only when a reader asks: it tells us the target app really read the paste.
// One paste runs at a time, so the promise being read is the one this drive made last.
let currentPromise = null;
ObjC.registerSubclass({
  name: 'ScreenDriverPromisedText',
  superclass: 'NSObject',
  protocols: ['NSPasteboardItemDataProvider'],
  methods: {
    'pasteboard:item:provideDataForType:': {
      types: ['void', ['id', 'id', 'id']],
      implementation: function (pasteboard, item, type) {
        const promised = currentPromise;
        if (!promised) return;
        promised.delivered = true;
        item.setStringForType($(promised.text), type);
      },
    },
  },
});
const PromisedText = $.ScreenDriverPromisedText;

function run() {
  const input = $.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding);
  let request;
  try { request = JSON.parse(isNil(input) ? '' : input.js); } catch { fail('A command is needed.'); }
  if (!request || typeof request !== 'object' || typeof request.command !== 'string') fail('A command is needed.');
  if (request.command === 'read') write(read(request));
  else if (request.command === 'act') write(act(request));
  else fail('Unknown command.');
  return '';
}
