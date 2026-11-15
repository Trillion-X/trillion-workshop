// Marketplace calls used by the browser notification host. This adapter keeps
// the Workshop wire names and payloads in one small, directly testable owner.
export const NOTIFICATION_TOOLS = Object.freeze({
  publicKey: 'tool:my-browser-push-application-key',
  register: 'tool:register-my-notification-device',
  list: 'tool:my-device-notices',
  markRead: 'tool:mark-my-notices-read',
  act: 'tool:act-on-my-notice',
});

export const browserDeviceRegistration = ({ address, label }) => ({ route: 'web-push', address, label });

export const browserNoticeList = ({ deviceId, after = 0, limit = 100 }) => ({
  device_id: deviceId, channel: 'web-push', after, limit,
});

export const browserNoticeRead = ({ id, deviceId, read = true }) => ({
  ids: [id], read, on: { channel: 'browser', device_id: deviceId },
});

export const browserNoticeAction = ({ id, action, text, submissionId }) => ({
  id, action, ...(text ? { text } : {}), ...(submissionId ? { submission_id: submissionId } : {}),
});
