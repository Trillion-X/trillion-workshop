//
// PURPOSE
//   The public door to one tour step's card for anything that draws a step outside the running tour (the canvas that
//   lays a tour out as its steps): the card's body, the step's buttons, its paper, its way out and each button's look,
//   the step as the person's rules leave it, and the default content and progress registries. The running tour draws
//   from the same functions, so a step drawn here is the card the tour shows.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { createStepContentRegistry } from '../../ui/show/step-content-renderer/step-content-renderer';
import { createStepProgressRegistry } from '../../ui/show/step-progress/step-progress';
import { FallbackContent, registerDefaultContentRenderers } from '../../tours-screen/show/default-content-renderers';
import { FallbackProgress, registerDefaultProgressVisuals } from '../../tours-screen/show/default-progress-visuals';

export { StepCardBody, type StepCardBodyProps } from '../../tours-screen/show/StepCardBody';
export { stepButtonsOf, paperOf, paperStyle, exitControlOf, type Paper } from '../../tours-screen/show/WalkthroughSurface';
export { buttonLooksOf, lookOfRole, type ButtonLook, type ButtonLooks } from '../../tours-screen/show/NavButtons';
export { STEP_SUBJECT, stepAsChanged, stepFacts, tourAsChanged, tourBy } from '../../tours-screen/show/changed-tour';

/** The content kinds and progress styles a tour step draws with, as the running tour has them. */
export const defaultStepRegistries = () => ({
  content: registerDefaultContentRenderers(createStepContentRegistry(FallbackContent)),
  progress: registerDefaultProgressVisuals(createStepProgressRegistry(FallbackProgress)),
});
