// parts/ui/show/tuning-panel/index.ts
//
// Barrel for the shared tuning panel: setting rows (DATA) drawn as visual controls beside the real thing. See
// TuningPanel.tsx for the contract.

export {
  TuningPanel,
  TuningControl,
  TuningColorField,
  TuningSliderField,
  TuningSampleTile,
  TUNING_WIDGETS,
  TUNING_PLACEMENT,
  colourCode,
  type TuningPanelProps,
  type TuningControlProps,
  type TuningSection,
  type TuningSetting,
  type TuningSample,
  type TuningOption,
  type TuningValue,
} from './TuningPanel';

export {
  ScrubField,
  ShadowField,
  CurveField,
  SOFT_SHADOW,
  shadowCss,
  readShadowCss,
  curveCss,
  readCurveCss,
  curveOf,
  settingFromCss,
  settingToCss,
  type ScrubFieldProps,
  type TuningShadow,
  type TuningCurve,
} from './TuningFields';

export { TuningSplitPreview, type TuningSplitPreviewProps } from './TuningSplitPreview';
