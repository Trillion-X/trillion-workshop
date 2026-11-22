// Read image pixels from standard input and answer recognized text with normalized bounds.
// The caller owns the file and sends bytes only to this local process. Run by /usr/bin/osascript -l JavaScript, which
// every Mac has, so it starts inside a run's sandbox with no developer tools (the Swift helper needed Xcode's xcrun).
ObjC.import('Foundation');
ObjC.import('stdlib');
ObjC.import('AppKit');
ObjC.import('Vision');

const isNil = value => value === null || value === undefined || (typeof value.isNil === 'function' && value.isNil());

function fail(message) {
  $.NSFileHandle.fileHandleWithStandardError.writeData($(message + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  $.exit(2);
}

function run() {
  const bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const rep = $.NSBitmapImageRep.imageRepWithData(bytes);
  if (isNil(rep) || isNil(rep.CGImage)) fail('Could not decode image pixels');
  const image = rep.CGImage;
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = true;
  const handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(image, $({}));
  const error = Ref();
  if (!handler.performRequestsError($([request]), error)) fail('Could not read text from the image: ' + (isNil(error[0]) ? 'no reason given' : error[0].localizedDescription.js));
  const results = request.results;
  const lines = [];
  for (let index = 0; index < Number(results.count); index += 1) {
    const observation = results.objectAtIndex(index);
    const candidate = observation.topCandidates(1).firstObject;
    if (!candidate || candidate.isNil()) continue;
    const box = observation.boundingBox;
    lines.push({ text: candidate.string.js, confidence: Number(candidate.confidence),
      x: box.origin.x, y: box.origin.y, width: box.size.width, height: box.size.height });
  }
  const answer = JSON.stringify({ width: Number(rep.pixelsWide), height: Number(rep.pixelsHigh), lines });
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(answer).dataUsingEncoding($.NSUTF8StringEncoding));
  return '';
}
