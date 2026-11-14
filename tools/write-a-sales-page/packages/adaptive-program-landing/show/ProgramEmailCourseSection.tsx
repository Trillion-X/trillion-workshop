'use client';

import React from 'react';
import { Form } from '@/packages/ui/show/form/Form';
import { Input } from '@/packages/ui/show/input/Input';
import { Checkbox } from '@/packages/ui/show/coss/ui/checkbox';
import { Button, SectionShell } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { useProgramLandingData } from './ProgramLandingData';
import styles from '@/packages/screen-look/show/adaptive-program-landing/ProgramLandingSurface.module.css';

type EmailCoursePreview = {
  eyebrow: string;
  title: string;
  intro: string;
  consentText: string;
  submitLabel: string;
  successText: string;
  lessons: readonly string[];
  deliveryMode?: 'updates' | 'lessons';
};

export function ProgramEmailCourseSection() {
  const data = useProgramLandingData() as ReturnType<typeof useProgramLandingData> & { emailCourse?: EmailCoursePreview };
  const course = data.emailCourse;
  const [email, setEmail] = React.useState('');
  const [consent, setConsent] = React.useState(false);
  const [website, setWebsite] = React.useState('');
  const [state, setState] = React.useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [error, setError] = React.useState('');
  if (!course) return null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consent || state === 'submitting') return;
    setState('submitting');
    setError('');
    try {
      const sendingLessons = course?.deliveryMode === 'lessons';
      const response = await fetch(sendingLessons ? '/email-course/enroll' : '/email-course/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, consent, website }),
      });
      const result = await response.json() as { error?: string; status?: string };
      if (!response.ok || result.status !== (sendingLessons ? 'enrolled' : 'interest_saved')) {
        throw new Error(result.error || 'Your request could not be saved. Please try again.');
      }
      setState('success');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your request could not be saved. Please try again.');
      setState('error');
    }
  }

  return (
    <SectionShell id="email-course" size="wide" paddingY="default">
      <div className={styles.emailCourse}>
        <div className={styles.emailCourseCopy}>
          <p className={styles.emailCourseEyebrow}>{course.eyebrow}</p>
          <h2>{course.title}</h2>
          <p>{course.intro}</p>
          <ol>{course.lessons.map((lesson, index) => <li key={`${index}-${lesson}`}>{lesson}</li>)}</ol>
        </div>
        <div className={styles.emailCourseFormCard}>
          {state === 'success' ? <p className={styles.emailCourseSuccess} role="status">{course.successText}</p> : (
            <Form onSubmit={submit} className={styles.emailCourseForm}>
              <Input
                autoComplete="email"
                className={styles.emailCourseInput}
                label="Email address"
                placeholder="Enter your email address"
                maxLength={254}
                onChange={(event) => setEmail(event.currentTarget.value)}
                required
                type="email"
                value={email}
              />
              <div aria-hidden="true" className={styles.emailCourseHoneypot}>
                <Input autoComplete="off" onChange={(event) => setWebsite(event.currentTarget.value)} tabIndex={-1} value={website} />
              </div>
              <label className={styles.emailCourseConsent}>
                <Checkbox checked={consent} onCheckedChange={(checked) => setConsent(checked === true)} />
                <span>{course.consentText}</span>
              </label>
              <Button disabled={!consent || state === 'submitting'} fullWidth size="lg" type="submit" variant="hardware">
                {state === 'submitting' ? (course.deliveryMode === 'lessons' ? 'Sending your first lesson…' : 'Saving your request…') : course.submitLabel}
              </Button>
              {state === 'error' ? <p className={styles.emailCourseError} role="alert">{error}</p> : null}
            </Form>
          )}
        </div>
      </div>
    </SectionShell>
  );
}
