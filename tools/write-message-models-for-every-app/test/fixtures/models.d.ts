// generated from src/device-bridge-models.json by scripts/device-bridge-models.mjs; change the rows there and run the script, never this file

/** The reply field an action offers: its placeholder and the title of its send button. */
export interface NoticeActionInput {
  placeholder?: string;
  button?: string;
}

/** One action a notice offers: a reply field (`input`), a press that opens the workspace (`opens`), or a plain press. */
export interface NoticeAction {
  id: string;
  label: string;
  input?: NoticeActionInput;
  opens?: boolean;
  destructive?: boolean;
}

/** One notice as the account sends it to a device. */
export interface Notice {
  id: string;
  seq: number;
  kind?: string;
  title: string;
  body?: string;
  open?: string;
  at?: string;
  level?: string;
  group?: string;
  actions?: NoticeAction[];
  read?: boolean;
}
