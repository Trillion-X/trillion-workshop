// tools/record-the-screen/do-work/track-pointer.swift
//
// PURPOSE
//   Prints the pointer as JSON lines {"x":..,"y":..,"down":bool} in global points from the top left of the main display,
//   `hz` times a second (argument 1) until it is ended. tools/record-the-screen/do-work/capture-session.mjs normalises these to the recorded source
//   and notes them beside the recording.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Position and the primary button only. No key, no text and no other input is read, so it needs no Accessibility or
//      Input Monitoring permission.
//   2. It polls the system's current state; it installs no event tap and no monitor.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import AppKit
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let hz = max(1.0, min(240.0, Double(CommandLine.arguments.dropFirst().first ?? "60") ?? 60))
let mainHeight = NSScreen.screens.first?.frame.height ?? 0
while true {
    let place = NSEvent.mouseLocation
    let down = NSEvent.pressedMouseButtons & 1 == 1
    print("{\"x\":\(place.x),\"y\":\(mainHeight - place.y),\"down\":\(down)}")
    Thread.sleep(forTimeInterval: 1.0 / hz)
}
