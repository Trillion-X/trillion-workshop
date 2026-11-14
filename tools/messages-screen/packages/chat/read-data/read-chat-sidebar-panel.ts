export interface ChatSidebarPanelSettings {
  collapsed: boolean;
  width: number;
  /** Collapse state of the LEFT sources rail (Agents/People). Persisted in the
   *  same single-row panel feed (one pipeline, N panels) so the rail collapse
   *  survives reload without a second action/publish/sink. Both writers spread
   *  the full settings object, so this field round-trips untouched. */
  railCollapsed: boolean;
}

export const DEFAULT_CHAT_SIDEBAR_PANEL: ChatSidebarPanelSettings = {
  collapsed: false,
  width: 260,
  railCollapsed: false,
};

interface ChatSidebarPanelRow {
  collapsed?: unknown;
  width?: unknown;
  railCollapsed?: unknown;
}

function asChatSidebarPanel(record: ChatSidebarPanelRow): ChatSidebarPanelSettings {
  const width = typeof record.width === 'number'
    ? record.width
    : typeof record.width === 'string'
      ? Number(record.width)
      : NaN;
  return {
    collapsed: typeof record.collapsed === 'boolean'
      ? record.collapsed
      : DEFAULT_CHAT_SIDEBAR_PANEL.collapsed,
    width: Number.isFinite(width) ? width : DEFAULT_CHAT_SIDEBAR_PANEL.width,
    railCollapsed: typeof record.railCollapsed === 'boolean'
      ? record.railCollapsed
      : DEFAULT_CHAT_SIDEBAR_PANEL.railCollapsed,
  };
}

export function readChatSidebarPanelFeed(raw: unknown): ChatSidebarPanelSettings {
  const rows = Array.isArray(raw) ? raw : [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    return asChatSidebarPanel(entry as ChatSidebarPanelRow);
  }
  return DEFAULT_CHAT_SIDEBAR_PANEL;
}
