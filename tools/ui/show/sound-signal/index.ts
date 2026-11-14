// parts/ui/show/sound-signal/index.ts
//
// The one shared reading of the sound around the person, what moves with it, and what follows it.

export { listenTo, onSoundFrame, onSoundState, soundSources, soundState, stopListening } from './sound-signal';
export type { SoundFrame, SoundSource, SoundState, SoundStatus } from './sound-signal';
export { soundPainters } from './sound-painters';
export type { Painter, SoundLook } from './sound-painters';
export { keepSoundLook, readSoundLook, sameSoundLook, soundLooks } from './sound-looks';
export { OWN_SOUND_LOOKS, saveOwnSoundLook, useOwnSoundLooks } from './own-sound-looks';
export { followSound, listSoundTargets, onTargetAnswers, paintFor, registerSoundTargets } from './sound-targets';
export type { SoundTarget, TargetAnswer, TargetPaint } from './sound-targets';
export { SoundCanvas } from './SoundCanvas';
export type { FrameSource, SoundCanvasProps } from './SoundCanvas';
export { SoundLayer } from './SoundLayer';
export { SoundControls, SoundFollowers, SoundLookPicker, SoundLookTuning, SoundSourcePicker } from './SoundControls';
