import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProgramLandingData } from '../read-data/program-landing-data';
import { ProgramLandingDataProvider } from './ProgramLandingData';
import { ProgramEmailCourseSection } from './ProgramEmailCourseSection';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  { mode: undefined, path: '/email-course/capture', status: 'interest_saved' },
  { mode: 'lessons', path: '/email-course/enroll', status: 'enrolled' },
] as const)('submits $path only after consent and reports its actual result', async ({ mode, path, status }) => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status }) });
  vi.stubGlobal('fetch', fetch);
  const data = {
    emailCourse: {
      eyebrow: 'Free lessons', title: 'Three practice lessons', intro: 'Learn each skill.',
      lessons: ['Setup', 'Movement', 'Practice'], consentText: 'Email me the lessons.',
      submitLabel: 'Send lessons', successText: 'Your request was saved.',
      ...(mode ? { deliveryMode: mode } : {}),
    },
  } as unknown as ProgramLandingData;

  render(<ProgramLandingDataProvider data={data}><ProgramEmailCourseSection /></ProgramLandingDataProvider>);
  const submit = screen.getByRole('button', { name: 'Send lessons' });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Email address' }), { target: { value: 'test@example.com' } });
  fireEvent.click(screen.getByRole('checkbox'));
  expect((submit as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(submit);

  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(fetch.mock.calls[0][0]).toBe(path);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ email: 'test@example.com', consent: true });
  expect((await screen.findByRole('status')).textContent).toBe('Your request was saved.');
});
