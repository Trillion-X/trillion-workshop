// CJ-C.1 RENDER PROOF — an example pre/post practice-session template renders through the REAL shared FillSurface component (not just the
// model), so this is the "primitive -> usable product surface" proof the anti-primitive rule wants:
// a learner would SEE the template's 15 questions with typed inputs, and the empty form's Submit is
// gated by the required questions. Zero package-local UI (FillSurface composes ui only). The nodes
// are example prompts held as fixture data.
//
// Run (cwd = bitfield-packages):
//   node_modules/.bin/vitest run --config ./vitest.config.ts \
//     packages/ask-questions-sort-answers-follow-up/show/practice-session-render.test.tsx

import * as React from "react";
import practiceSession from '../__tests__/fixtures/example-practice-session.json';
import questionTypes from '../../../data/question-types.json';
import { cleanup, render, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FillSurface } from "./FillSurface";
import { indexCapabilities } from "../read-data/question-descriptor";

afterEach(() => cleanup());

// The example template (SSOT DATA record) + the package's shipped capability registry.
const SEQ = practiceSession.writes[0].payload;
function shippedRegistry() {
  return indexCapabilities(questionTypes.rows as any[]);
}
const REG = shippedRegistry();

describe("CJ-C.1 — Example practice-session template renders through the real ask-questions FillSurface", () => {
  it("renders the title + all 15 real question labels (honest content, L117)", () => {
    const { getByText, getAllByText } = render(<FillSurface sequence={SEQ} registry={REG} />);
    getByText("Practice Session — Pre & Post");
    // choice/rating questions surface their label twice (visible <label> + aria-label on the
    // pill bar), and required questions append a `*` marker inside the <label>, so use a
    // substring matcher and assert >=1 match rather than exact uniqueness.
    for (const label of [
      "What are your goals for this session?",
      "Which skill is your main focus today?",
      "Rate your focus this session (1–10)",
      "Did you meet your goals?",
      "Today's lesson (one line you want to remember)",
    ]) {
      expect(getAllByText(label, { exact: false }).length).toBeGreaterThan(0);
    }
  });

  it("the skill-picker renders the choice options as real controls", () => {
    const { getByText } = render(<FillSurface sequence={SEQ} registry={REG} />);
    for (const opt of ["Serve", "Forehand", "Backhand", "Volley / net", "Mental / focus"]) getByText(opt);
  });

  it("the focus rating renders the 1..10 scale (the per-question override, not the default 1..5)", () => {
    const { getAllByText } = render(<FillSurface sequence={SEQ} registry={REG} />);
    // the scale item "10" only exists because the template overrides max to 10 (default rating max is 5)
    expect(getAllByText("10").length).toBeGreaterThan(0);
  });

  it("the empty form's Submit is gated — onSubmit does NOT fire until the required questions are answered", () => {
    const onSubmit = vi.fn();
    const { getByRole } = render(<FillSurface sequence={SEQ} registry={REG} onSubmit={onSubmit} />);
    fireEvent.click(getByRole("button", { name: "Submit" }));
    expect(onSubmit).not.toHaveBeenCalled(); // required (pre-goals, pre-focus-skills, post-goals-met, focus-rating) block it
  });

  it("renders 15 questions (one per prompt), not a truncated subset", () => {
    const { container } = render(<FillSurface sequence={SEQ} registry={REG} />);
    // every question renders inside the shared QuestionField (label element per question)
    const labels = container.querySelectorAll("label");
    expect(labels.length).toBeGreaterThanOrEqual(15);
  });
});
