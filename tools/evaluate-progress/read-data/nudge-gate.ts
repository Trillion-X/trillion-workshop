// tools/evaluate-progress/read-data/nudge-gate.ts
// Whether a person may be nudged. The person's opt-out is honoured first, then the caller's rate limit, then the risk: no nudge unless the risk is a number at or over the caller's threshold.
// An unknown risk, a missing context or a threshold that is not a number means no nudge. The tone and framing the nudge carries are the caller's words; when the caller lists allowed tones, a nudge in any other tone (or in no tone) is not sent.

export type NudgeContext = {
  risk: number | null;
  rate_limit_ok: boolean;
  opted_out?: boolean;
};

export type NudgeConfig = {
  riskThreshold: number;
  framingRef?: string | null;
  tone?: string | null;
  allowedTones?: ReadonlyArray<string>;
};

export type NudgeVerdict = {
  nudge: boolean;
  tone: string | null;
  framing_ref: string | null;
  reason: string;
};

function noNudge(reason: string): NudgeVerdict {
  return { nudge: false, tone: null, framing_ref: null, reason };
}

export function decideNudge(context: NudgeContext | null | undefined, config: NudgeConfig): NudgeVerdict {
  if (!context) return noNudge('no context: no nudge');
  if (context.opted_out === true) return noNudge('the person opted out: no nudge');
  if (context.rate_limit_ok !== true) return noNudge('the rate limit is reached: no nudge');
  if (context.risk == null || !Number.isFinite(context.risk) || !Number.isFinite(config?.riskThreshold)) {
    return noNudge('the risk or the threshold is not a number: no nudge');
  }
  if (context.risk >= config.riskThreshold) {
    if (config.allowedTones !== undefined && (typeof config.tone !== 'string' || !config.allowedTones.includes(config.tone))) {
      return noNudge(`the tone ${JSON.stringify(config.tone ?? null)} is not one of the allowed tones: no nudge`);
    }
    return { nudge: true, tone: config.tone ?? null, framing_ref: config.framingRef ?? null, reason: 'the risk is at or above the threshold' };
  }
  return noNudge('the risk is below the threshold: no nudge');
}
