import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
export function refreshGroupPages() { return sendRequestToBitfieldTarget({ target: 'slot::workflow', payload: { operation: 'execute_definition', definition_id: 'action:group-page.refresh-group-pages', include_steps: false, include_output: false, input: {} } }); }
