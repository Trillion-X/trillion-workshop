// tools/connected-drives/read-data/drive-identity.mjs
//
// What one mounted volume is: its real mount, whether it is internal, its kind (USB, SSD, disk image, phone) and
// whether it may be ejected, from diskutil's plist and the real paths of the mount and of /Volumes.
import fs from 'node:fs';
import path from 'node:path';

export function classifyDevice(device) {
  const text = `${device.name || ''} ${device.protocol || ''} ${device.content || ''} ${device.vendor || ''}`.toLowerCase();
  if (device.internal === true || device.mount === '/') return 'Internal';
  if (/simulator|disk.?image/.test(text)) return 'Disk image';
  if (/iphone|ipad/.test(text)) return 'iPhone';
  if (device.kind) return device.kind;
  if (device.solid_state === true || /\bssd\b/.test(text)) return 'External SSD';
  if (/usb|flash|thumb/.test(text)) return 'USB';
  return 'Storage device';
}

export function parseDiskIdentity(plist) {
  const string = key => {
    const match = String(plist).match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return match ? match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") : null;
  };
  const bool = key => {
    const match = String(plist).match(new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`));
    return match ? match[1] === 'true' : null;
  };
  return { internal: bool('Internal'), solid_state: bool('SolidState'), mount: string('MountPoint'), device_identifier: string('DeviceIdentifier'), protocol: string('BusProtocol') };
}

// This check precedes both process termination and eject, including for aliases.
export async function resolveDriveIdentity(device, { volumesRoot, realpath = value => fs.promises.realpath(value), readDiskInfo, fixture = false }) {
  let canonical = null, root = null, info = {};
  if (device.mount) {
    try { [canonical, root] = await Promise.all([realpath(device.mount), realpath(volumesRoot)]); } catch {}
    if (canonical && !fixture && readDiskInfo) {
      try { info = await readDiskInfo(canonical) || {}; } catch {}
    }
  }
  const internal = device.internal === true || info.internal === true || canonical === '/' || canonical?.startsWith('/System/Volumes/') || false;
  const directlyMounted = Boolean(canonical && root && path.dirname(canonical) === root);
  let reportedMountMatches = fixture;
  if (!fixture && info.mount && canonical) {
    try { reportedMountMatches = await realpath(info.mount) === canonical; } catch {}
  }
  const resolved = { ...device, canonical_mount: canonical, internal, solid_state: info.solid_state ?? device.solid_state, protocol: info.protocol || device.protocol, device_identifier: info.device_identifier || device.device_identifier };
  return { ...resolved, kind: classifyDevice(resolved), ejectable: Boolean(device.mount && directlyMounted && !internal && device.ejectable !== false && reportedMountMatches && (fixture || info.internal === false)) };
}
