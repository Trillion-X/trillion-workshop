// packages/ui/show/control-target/control-target.ts
//
// One geometry contract for every actionable control. Consumers select the
// interaction role; they never repeat pointer-media utilities themselves.
// Fine-pointer density remains compact. Coarse input expands the two controls
// that require direct manipulation precision (reorder and reference picking)
// to 44×44px. Every other action retains a 24×24px minimum target.

export type ControlTargetRole = 'action' | 'reference' | 'reorder';

const ACTION_TARGET_CLASS = 'min-h-6 min-w-6';
const DIRECT_MANIPULATION_TARGET_CLASS =
  `${ACTION_TARGET_CLASS} [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11`;

export function controlTargetClass(role: ControlTargetRole = 'action'): string {
  return role === 'action' ? ACTION_TARGET_CLASS : DIRECT_MANIPULATION_TARGET_CLASS;
}

export function controlTargetAttributes(role: ControlTargetRole = 'action'): {
  'data-control-target-role': ControlTargetRole;
  'data-target-size-min': '24';
  'data-target-size-coarse'?: '44';
} {
  return {
    'data-control-target-role': role,
    'data-target-size-min': '24',
    ...(role === 'action' ? {} : { 'data-target-size-coarse': '44' as const }),
  };
}
