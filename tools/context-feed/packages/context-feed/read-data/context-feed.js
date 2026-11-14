import { projectRecords } from "./record-projection-lens.js";

export function projectContextFeed(records, lens, options = {}) {
  return projectRecords(records, lens, options);
}

export { projectOwnerActionHandoffs, projectRecords } from "./record-projection-lens.js";
