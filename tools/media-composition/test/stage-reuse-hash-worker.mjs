import { parentPort, workerData } from 'node:worker_threads';
import { createStageHashSession, stageIdentity } from '../do-work/stage-reuse.mjs';

parentPort.postMessage(stageIdentity(workerData, createStageHashSession()));
