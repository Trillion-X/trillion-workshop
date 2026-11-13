// src/workspace/mail-task.ts
//
// PURPOSE
//   The one task that carries an email's plan. Priority, time, deadline, duration, repeat and list are not fields of a
//   message; they are the same fields of the Calendar task for it (calendar-tasks.json), found or made once through the
//   task owner's from_source action. This file only asks that owner.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One task per email: the source id names the connection and the message, and the owner returns the same row each time.
//   2. A read never makes a task (find_source); only a plan verb does (from_source).
//   3. Nothing here decides a rule: the owner refuses a bad priority, time or deadline in its own words, which pass through.

import { postJson, readJson } from './api';

const TASKS = '/work/api/calendar/tasks';

export type MailTask = {
  id: string; title: string; priority: string | null; duration_minutes: number; due: string | null; starts_at: string | null;
  collection_id: string | null; recurrence?: unknown; status: string;
};
export type MailTaskChange = { priority?: string | null; duration_minutes?: number; due?: string | null; recurrence?: unknown; collection_id?: string | null; title?: string };

/** The id an email's task is found by. */
export const mailSourceId = (connectionId: string, messageId: string) => `gmail:${connectionId}:${messageId}`;

/** The task already made for this email, or null. */
export async function findMailTask(sourceId: string): Promise<MailTask | null> {
  return (await postJson<{ task: MailTask | null }>(TASKS, { action: 'find_source', source_id: sourceId })).task;
}

/** The task for this email, made the first time it is asked for. */
export async function ensureMailTask(source: { sourceId: string; title: string; url: string }): Promise<MailTask> {
  return (await postJson<{ task: MailTask }>(TASKS, { action: 'from_source', source_id: source.sourceId, title: source.title, source_url: source.url })).task;
}

export async function changeMailTask(taskId: string, change: MailTaskChange): Promise<MailTask> {
  return (await postJson<{ task: MailTask }>(TASKS, { action: 'update', task_id: taskId, ...change })).task;
}

export async function scheduleMailTask(taskId: string, startIso: string): Promise<MailTask> {
  return (await postJson<{ task: MailTask }>(TASKS, { action: 'schedule', task_id: taskId, start: startIso })).task;
}

export async function unscheduleMailTask(taskId: string): Promise<MailTask> {
  return (await postJson<{ task: MailTask }>(TASKS, { action: 'unschedule', task_id: taskId })).task;
}

export async function completeMailTask(taskId: string): Promise<MailTask> {
  return (await postJson<{ task: MailTask }>(TASKS, { action: 'complete', task_id: taskId })).task;
}

export async function duplicateMailTask(taskId: string, requestKey: string): Promise<MailTask> {
  return (await postJson<{ task: MailTask }>(TASKS, { action: 'duplicate', task_id: taskId, request_key: requestKey })).task;
}

/** The task lists a person can move the task to: the first page the task owner reads with its tasks. */
export async function readTaskLists(): Promise<{ id: string; title: string }[]> {
  return (await readJson<{ collections: { id: string; title: string }[] }>(`${TASKS}?sort=manual`)).collections;
}
