// tools/record-the-screen/do-work/capture-display.swift
//
// PURPOSE
//   The screen-recording helper process tools/record-the-screen/do-work/capture-session.mjs runs: records ONE display or ONE window with
//   ScreenCaptureKit into a movie file. Its only input is the JSON config on its command line (source, file, fps, and the
//   apps and window titles to leave out) and the verbs `pause`, `resume` and `stop`, one per line on standard input.
//   It prints JSON lines on standard output: {"event":"started"} once frames are really flowing, then
//   {"event":"ended","reason":"stopped"|"source-gone"|"failed"} (or {"event":"failed","why":".."} if it never started).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Exactly the chosen source is recorded; a display recording leaves out every window of an app (bundle id or name) and
//      every window whose title contains a listed title, so the person's list is honoured in the picture itself.
//   2. A pause leaves no gap in the movie: frames after a resume are re-timed to follow the last one written.
//   3. A source that goes away ends the recording and the file written so far is finished and playable.
//   4. The file is created by this program with the writer's own exclusive create (it must not exist), in the folder the
//      caller made private.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

struct Config: Decodable {
    struct Source: Decodable { let kind: String; let id: String }
    struct Leave: Decodable { let apps: [String]; let titles: [String] }
    let source: Source
    let file: String
    let fps: Int
    let exclude: Leave
}

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) }
}

final class Recorder: NSObject, @unchecked Sendable, SCStreamOutput, SCStreamDelegate {
    private let writer: AVAssetWriter
    private var input: AVAssetWriterInput?
    private let queue = DispatchQueue(label: "ai.gettrillion.capture-display")
    private var stream: SCStream?
    private var paused = false
    private var resumed = false
    private var offset = CMTime.zero
    private var lastPTS = CMTime.invalid
    private var sessionStarted = false
    private var finished = false
    private let fps: Int
    private let size: (Int, Int)

    init(file: String, fps: Int, size: (Int, Int)) throws {
        writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: file), fileType: .mov)
        self.fps = max(1, fps)
        self.size = size
    }

    func begin(filter: SCContentFilter) async throws {
        let configuration = SCStreamConfiguration()
        configuration.width = size.0
        configuration.height = size.1
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = true
        configuration.queueDepth = 6
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: size.0, AVVideoHeightKey: size.1])
        video.expectsMediaDataInRealTime = true
        guard writer.canAdd(video) else { throw NSError(domain: "capture", code: 1, userInfo: [NSLocalizedDescriptionKey: "the movie writer would not take a video track"]) }
        writer.add(video)
        input = video
        guard writer.startWriting() else { throw writer.error ?? NSError(domain: "capture", code: 2) }
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
        try await stream.startCapture()
    }

    func pause() { queue.async { self.paused = true } }
    func resume() { queue.async { if self.paused { self.paused = false; self.resumed = true } } }

    func stop(reason: String) {
        queue.async {
            guard !self.finished else { return }
            self.finished = true
            Task {
                try? await self.stream?.stopCapture()
                self.input?.markAsFinished()
                await self.writer.finishWriting()
                emit(["event": "ended", "reason": reason])
                exit(0)
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { stop(reason: "source-gone") }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferDataIsReady(buffer), !paused, let input,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        var pts = CMSampleBufferGetPresentationTimeStamp(buffer)
        if resumed {
            // The movie carries on from the last frame written, one frame later, not from where the clock now is.
            if lastPTS.isValid { offset = CMTimeAdd(offset, CMTimeSubtract(CMTimeSubtract(pts, lastPTS), CMTime(value: 1, timescale: CMTimeScale(fps)))) }
            resumed = false
        }
        pts = CMTimeSubtract(pts, offset)
        if !sessionStarted { writer.startSession(atSourceTime: pts); sessionStarted = true; emit(["event": "started"]) }
        guard input.isReadyForMoreMediaData else { return }
        var timing = CMSampleTimingInfo(duration: CMSampleBufferGetDuration(buffer), presentationTimeStamp: pts, decodeTimeStamp: .invalid)
        var retimed: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: buffer, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &retimed)
        if let retimed, input.append(retimed) { lastPTS = CMTimeAdd(pts, offset) }
    }
}

guard CommandLine.arguments.count > 1, let data = CommandLine.arguments[1].data(using: .utf8), let config = try? JSONDecoder().decode(Config.self, from: data) else {
    emit(["event": "failed", "why": "no usable config was given"]); exit(2)
}

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        CGGetActiveDisplayList(16, &ids, &count)
        let filter: SCContentFilter
        var points = CGSize(width: 1280, height: 720)
        var scale: CGFloat = 2
        if config.source.kind == "window" {
            guard let number = UInt32(config.source.id), let window = content.windows.first(where: { $0.windowID == number }) else { emit(["event": "failed", "why": "that window is not there"]); exit(3) }
            filter = SCContentFilter(desktopIndependentWindow: window)
            points = window.frame.size
        } else {
            guard let number = Int(config.source.id), number >= 1, number <= Int(count), let display = content.displays.first(where: { $0.displayID == ids[number - 1] }) else { emit(["event": "failed", "why": "that display is not there"]); exit(3) }
            let leave = content.windows.filter { window in
                let app = window.owningApplication
                let byApp = config.exclude.apps.contains { $0 == app?.bundleIdentifier || $0 == app?.applicationName }
                let byTitle = config.exclude.titles.contains { title in !title.isEmpty && (window.title ?? "").localizedCaseInsensitiveContains(title) }
                return byApp || byTitle
            }
            filter = SCContentFilter(display: display, excludingWindows: leave)
            points = CGSize(width: display.width, height: display.height)
        }
        if #available(macOS 14.0, *) { scale = CGFloat(filter.pointPixelScale) }
        let size = (Int(points.width * scale) & ~1, Int(points.height * scale) & ~1)
        let recorder = try Recorder(file: config.file, fps: config.fps, size: size)
        try await recorder.begin(filter: filter)
        Thread.detachNewThread {
            while let line = readLine() {
                switch line.trimmingCharacters(in: .whitespaces) {
                case "pause": recorder.pause()
                case "resume": recorder.resume()
                case "stop": recorder.stop(reason: "stopped")
                default: break
                }
            }
            recorder.stop(reason: "stopped")
        }
    } catch {
        emit(["event": "failed", "why": error.localizedDescription]); exit(4)
    }
}
RunLoop.main.run()
