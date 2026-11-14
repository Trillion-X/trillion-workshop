import type { ReadSceneDescriptorReply, ReadSceneDescriptorRequest } from './scene-descriptor';
import { validateSceneDescriptor } from './validate-scene-descriptor';

export function readSceneDescriptor(request: ReadSceneDescriptorRequest): ReadSceneDescriptorReply {
  const issues = validateSceneDescriptor(request?.source);
  return issues.length ? { ok: false, issues } : { ok: true, descriptor: request.source as never };
}
