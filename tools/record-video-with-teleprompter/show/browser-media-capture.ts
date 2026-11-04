import recordVideoContract from '../things-to-store-and-run.json';
import {
  isCapabilityPermissionDenied,
  probeCapabilityPermission,
  readCapabilityPermissionDescriptor,
  requireCapabilityPermission,
  type CapabilityPermissionDescriptor,
  type CapabilityPermissionState,
  type DevicePick,
} from '../../permission-lease/read-data/capability-permission';
import type {
  CaptureDescriptorValue,
  CaptureSourceDescriptor,
} from '../do-work/record-video-requests';

export const recordVideoCapabilityPermission = readCapabilityPermissionDescriptor(
  recordVideoContract,
  'operation:record-video.capture',
);

export const recordVideoVoiceCapabilityPermission = readCapabilityPermissionDescriptor(
  recordVideoContract,
  'operation:record-video.capture-voice',
);

export function recordVideoCapabilityPermissionForMode(mode: CaptureDescriptorValue): CapabilityPermissionDescriptor | null {
  return mode === 'audio' ? recordVideoVoiceCapabilityPermission
    : mode === 'video' ? recordVideoCapabilityPermission : null;
}

function descriptor(mode: CaptureDescriptorValue): CapabilityPermissionDescriptor {
  const permission = recordVideoCapabilityPermissionForMode(mode);
  if (!permission) throw new Error(`The recording permission requirement for ${mode} is not configured.`);
  return permission;
}

export function mediaConstraintsForMode(mode: CaptureDescriptorValue): MediaStreamConstraints {
  return descriptor(mode).adapter_input.constraints as MediaStreamConstraints;
}

export function mediaConstraintsForSourceDescriptor(source: CaptureSourceDescriptor): MediaStreamConstraints {
  return mediaConstraintsForMode(source.value);
}

export function mediaCaptureAvailability(): string {
  return `permission-adapter=${descriptor('video').adapter_ref}`;
}

export function capturePermissionState(mode: CaptureDescriptorValue = 'video'): Promise<CapabilityPermissionState> {
  return probeCapabilityPermission(descriptor(mode));
}

export function mediaStreamForMode(mode: CaptureDescriptorValue, pick?: DevicePick): Promise<MediaStream> {
  return requireCapabilityPermission<MediaStream>(descriptor(mode), pick);
}

export const isPermissionError = isCapabilityPermissionDenied;
