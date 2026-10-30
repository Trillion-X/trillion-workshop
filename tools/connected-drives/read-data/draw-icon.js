// tools/connected-drives/read-data/draw-icon.js
//
// The icon Finder shows for one path, drawn by macOS (NSWorkspace iconForFile) into a square PNG. Run by
// drives.mjs as `osascript -l JavaScript draw-icon.js <path> <size> <out.png>`; the path is an argument, never part of
// the script text.
ObjC.import('AppKit');
function run(argv) {
  const size = Number(argv[1]);
  const icon = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationCopy, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  const data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  if (!data.writeToFileAtomically(argv[2], true)) throw new Error('The drive icon could not be written.');
}
