import recordAudioContract from '../things-to-store-and-run.json';
import {
  probeCapabilityPermission,
  readCapabilityPermissionDescriptor,
  requireCapabilityPermission,
  type CapabilityPermissionDescriptor,
  type CapabilityPermissionState,
  type DevicePick,
} from '../../permission-lease/read-data/capability-permission';
import type { CaptureDescriptorValue } from '../do-work/record-audio-requests';

export const recordAudioCapabilityPermission = readCapabilityPermissionDescriptor(
  recordAudioContract,
  'operation:record-audio.capture',
);

function descriptor(): CapabilityPermissionDescriptor {
  if (!recordAudioCapabilityPermission) throw new Error('The recording permission requirement is not configured.');
  return recordAudioCapabilityPermission;
}

export function mediaCaptureAvailability(): string {
  return recordAudioCapabilityPermission
    ? `permission-adapter=${recordAudioCapabilityPermission.adapter_ref}`
    : 'permission-adapter=missing';
}

export function capturePermissionState(): Promise<CapabilityPermissionState> {
  return probeCapabilityPermission(descriptor());
}

export function mediaStreamForMode(_mode: CaptureDescriptorValue, pick?: DevicePick): Promise<MediaStream> {
  return requireCapabilityPermission<MediaStream>(descriptor(), pick);
}
