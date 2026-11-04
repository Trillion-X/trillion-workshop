// tools/record-the-screen/do-work/list-capture-sources.swift
//
// PURPOSE
//   Lists what can be recorded on this Mac right now, as JSON on standard output: the displays (id is the 1-based number
//   `screencapture -D` takes) and the on-screen windows of apps (id is the window number `-l` takes), each with its frame in
//   global points from the top left of the main display, the same space the pointer is read in. Used by
//   tools/record-the-screen/do-work/capture-session.mjs to check a source exists, to end a recording whose source has gone and to normalise the pointer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. It only reads window geometry and names; it needs no permission beyond what the system shows without one (a window
//      title is empty until Screen Recording is allowed).
//   2. Only ordinary app windows (layer 0) with a size are listed; menu bars, the desktop and tiny helpers are not.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import CoreGraphics
import Foundation

var ids = [CGDirectDisplayID](repeating: 0, count: 16)
var count: UInt32 = 0
CGGetActiveDisplayList(16, &ids, &count)
let displays: [[String: Any]] = (0..<Int(count)).map { index in
    let bounds = CGDisplayBounds(ids[index])
    return ["id": index + 1, "x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.size.width, "height": bounds.size.height, "main": CGDisplayIsMain(ids[index]) != 0]
}

let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
let windows: [[String: Any]] = info.compactMap { window in
    guard (window[kCGWindowLayer as String] as? Int) == 0,
          let number = window[kCGWindowNumber as String] as? Int,
          let boundsDict = window[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsDict), bounds.width >= 40, bounds.height >= 40 else { return nil }
    return ["id": number, "app": window[kCGWindowOwnerName as String] as? String ?? "", "title": window[kCGWindowName as String] as? String ?? "",
            "x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.size.width, "height": bounds.size.height]
}

let data = try JSONSerialization.data(withJSONObject: ["displays": displays, "windows": windows])
FileHandle.standardOutput.write(data)
