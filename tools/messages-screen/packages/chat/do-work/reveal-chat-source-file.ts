import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import chatRecordsContract from '../../../../chat/things-to-store-and-run.json';
import { readConfiguredTimedTarget } from '../../../../process-session/read-data/read-process-session-launch';

const CHAT_SOURCE_FILE_REVEAL_ROUTE = readConfiguredTimedTarget(chatRecordsContract, 'source-file-reveal');

export async function revealChatSourceFile(filePath: string): Promise<unknown> {

  return sendRequestToBitfieldTarget({
    target: CHAT_SOURCE_FILE_REVEAL_ROUTE.target,
    payload: {
      argv: ['open', '-R', filePath],
      timeout_ms: CHAT_SOURCE_FILE_REVEAL_ROUTE.timeoutMs,
    },
  });
}
