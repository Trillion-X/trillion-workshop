// Runs one program as its own Mac-permission holder: `disclaim-exec <program> [arguments...]`.
// macOS decides which app a program's Screen Recording, Accessibility and similar permissions belong to by the "responsible"
// process above it. A program started through here is detached from its parent in that sense, so what it asks the Mac for is
// asked, and granted or refused, for the program itself and not as the Trillion app. Standard input, output and error pass
// straight through; the exit status is the program's own. Used only for a computer-reader.json child whose row says
// "disclaim": true (computer/ChildProcess in macos/App/ComputerReader.swift).
import Foundation

let words = Array(CommandLine.arguments.dropFirst())
guard let program = words.first else {
  FileHandle.standardError.write(Data("disclaim-exec needs a program to run.\n".utf8))
  exit(64)
}

var attributes: posix_spawnattr_t? = nil
posix_spawnattr_init(&attributes)
var disclaimed = false
if let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") {
  typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
  disclaimed = unsafeBitCast(symbol, to: Disclaim.self)(&attributes, 1) == 0
}
if ProcessInfo.processInfo.environment["TRILLION_DISCLAIM_REPORT"] != nil {
  FileHandle.standardError.write(Data("disclaim-exec: disclaimed=\(disclaimed)\n".utf8))
}

var childID: pid_t = 0
let argv: [UnsafeMutablePointer<CChar>?] = words.map { strdup($0) } + [nil]
let started = posix_spawnp(&childID, program, nil, &attributes, argv, environ)
if started != 0 {
  FileHandle.standardError.write(Data("disclaim-exec: could not start \(program): \(String(cString: strerror(started)))\n".utf8))
  exit(127)
}

// A stop sent to this wrapper is a stop for the program.
for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
  signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
  source.setEventHandler { kill(childID, signalNumber) }
  source.resume()
}
DispatchQueue.global().async {
  var status: Int32 = 0
  while waitpid(childID, &status, 0) < 0 && errno == EINTR {}
  let code: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
  exit(code)
}
dispatchMain()
