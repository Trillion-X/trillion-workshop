// computer/drive-tools/drive-icon.mjs (carried over unchanged from an earlier standalone app)
//
// Purpose: the icon Finder shows for one connected drive, as a PNG, so the web screen can show the person the drive
// they recognise. macOS draws it (NSWorkspace iconForFile), which covers a custom .VolumeIcon.icns on the drive and the
// media icon of the device itself (a card, an SSD, a phone).
//
//   const icons = createDriveIcons({ folder });
//   await icons.png({ mount, key, size })  -> Buffer (PNG bytes)
//
// Each drawing is kept in `folder` under <key>-<size>.png, where the caller's key names the exact volume (its device
// identifier and the mount folder's device and inode numbers), so asking again is one file read and a different drive
// mounted at the same place is drawn afresh.
//
// Invariants:
// - `size` is a whole number of pixels from 32 to 512; anything else is refused before anything runs.
// - The drawing runs as its own osascript process with the path as an argument, never inside the script text.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const DRAW = `ObjC.import('AppKit');
function run(argv) {
  const size = Number(argv[1]);
  const icon = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationCopy, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  const data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  if (!data.writeToFileAtomically(argv[2], true)) throw new Error('not written');
}`;

export const iconSize = value => {
  const size = value === null || value === undefined || value === '' ? 256 : Number(value);
  return Number.isInteger(size) && size >= 32 && size <= 512 ? size : null;
};

const drawIcon = (file, size, out) => new Promise((resolve, reject) => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DRAW, file, String(size), out], { timeout: 20000 }, error => error ? reject(new Error('The drive icon could not be drawn.')) : resolve()));

export function createDriveIcons({ folder, draw = drawIcon }) {
  async function png({ mount, key, size }) {
    const cached = path.join(folder, `${String(key).replace(/[^A-Za-z0-9._-]/g, '-')}-${size}.png`);
    try { return await fsp.readFile(cached); } catch {}
    fs.mkdirSync(folder, { recursive: true });
    const partial = `${cached}.${process.pid}.partial.png`;
    await draw(mount, size, partial);
    await fsp.rename(partial, cached);
    return fsp.readFile(cached);
  }
  return { png };
}
