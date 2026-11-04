// Read image pixels from standard input and answer recognized text with normalized bounds.
// The caller owns the file and sends bytes only to this local process.
import Foundation
import Vision
import ImageIO

let bytes = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  FileHandle.standardError.write(Data("Could not decode image pixels\n".utf8))
  exit(2)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
try VNImageRequestHandler(cgImage: image).perform([request])
let lines: [[String: Any]] = (request.results ?? []).compactMap { observation in
  guard let candidate = observation.topCandidates(1).first else { return nil }
  let box = observation.boundingBox
  return ["text": candidate.string, "confidence": Double(candidate.confidence),
          "x": box.minX, "y": box.minY, "width": box.width, "height": box.height]
}
let data = try JSONSerialization.data(withJSONObject: ["width": image.width, "height": image.height, "lines": lines])
FileHandle.standardOutput.write(data)
