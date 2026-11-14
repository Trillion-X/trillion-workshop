// package-set://bitfield-studio/packages/training-plan/read-data/training-plan.ts

export interface TrainingLoadIntent {
  id: string;
  label: string;
  data: Record<string, unknown>;
}

export interface TrainingGoal {
  id: string;
  name: string;
  domain: string;
}

export interface TrainingPhase {
  id: string;
  goalId: string;
  name: string;
  intent: string;
  sequence: number;
}

export interface TrainingWeekBlock {
  id: string;
  phaseId: string;
  sequence: number;
  loadIntent: TrainingLoadIntent;
}

export interface TrainingSessionPrescription {
  id: string;
  weekBlockId: string;
  title: string;
  activity: string;
  dose: Record<string, unknown>;
  intensity: Record<string, unknown>;
  scheduledTaskRef?: string;
}

export interface TrainingPlan {
  goals: TrainingGoal[];
  phases: TrainingPhase[];
  weeks: TrainingWeekBlock[];
  sessions: TrainingSessionPrescription[];
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function decodeLoadIntent(value: unknown): TrainingLoadIntent {
  if (typeof value === 'string') return { id: value, label: value, data: {} };
  const row = readObject(value);
  const id = readString(row.id) || readString(row.key) || readString(row.name);
  const label = readString(row.label) || readString(row.name) || id;
  return { id, label, data: row };
}

export function decodeTrainingPlan(raw: unknown): TrainingPlan {
  const root = readObject(raw);
  return {
    goals: readArray(root.goals).map((entry) => {
      const row = readObject(entry);
      return { id: readString(row.id), name: readString(row.name), domain: readString(row.domain) };
    }).filter((goal) => goal.id),
    phases: readArray(root.phases).map((entry) => {
      const row = readObject(entry);
      return { id: readString(row.id), goalId: readString(row.goalId), name: readString(row.name), intent: readString(row.intent), sequence: readNumber(row.sequence) };
    }).filter((phase) => phase.id),
    weeks: readArray(root.weeks).map((entry) => {
      const row = readObject(entry);
      return { id: readString(row.id), phaseId: readString(row.phaseId), sequence: readNumber(row.sequence), loadIntent: decodeLoadIntent(row.loadIntent ?? row.load_intent) };
    }).filter((week) => week.id),
    sessions: readArray(root.sessions).map((entry) => {
      const row = readObject(entry);
      const scheduledTaskRef = readString(row.scheduledTaskRef);
      return {
        id: readString(row.id),
        weekBlockId: readString(row.weekBlockId),
        title: readString(row.title),
        activity: readString(row.activity),
        dose: readObject(row.dose),
        intensity: readObject(row.intensity),
        ...(scheduledTaskRef ? { scheduledTaskRef } : {}),
      };
    }).filter((session) => session.id),
  };
}

export function sessionsForWeek(plan: TrainingPlan, weekId: string): TrainingSessionPrescription[] {
  return plan.sessions.filter((session) => session.weekBlockId === weekId);
}

export function trainingPlanSummary(plan: TrainingPlan): { goals: number; phases: number; weeks: number; sessions: number } {
  return {
    goals: plan.goals.length,
    phases: plan.phases.length,
    weeks: plan.weeks.length,
    sessions: plan.sessions.length,
  };
}
