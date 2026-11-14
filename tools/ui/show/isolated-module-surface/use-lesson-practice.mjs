import { useCallback, useEffect, useRef, useState } from 'react';
import { lessonPracticeIdentity, lessonPracticeLabel } from './module-surface-requests.mjs';

const PRACTICE_FIELDS = new Set([
  'step', 'result', 'alternative', 'prediction', 'observation', 'comparison', 'revision', 'zoom', 'transfer',
]);
const EMPTY_MESSAGES = {
  unavailable: 'Saving is unavailable for this lesson.',
  missing: 'Complete each practice field before saving.',
  length: 'Each practice answer must be at most 2,000 characters.',
  readFailure: 'Saved practice could not be loaded.',
  saved: 'Practice saved.',
  conflict: 'Practice changed elsewhere. Review your answers and save again.',
  readbackFailure: 'The save could not be confirmed. Retry to check it again.',
  saveFailure: 'The save is still uncertain. Retry to safely check it again.',
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plainObject = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function recordLabel(surfaceInput) {
  if (typeof surfaceInput?.practice_record_label === 'string' && surfaceInput.practice_record_label.trim()) {
    return surfaceInput.practice_record_label;
  }
  try {
    return lessonPracticeLabel(surfaceInput?.space_id, surfaceInput?.course_id, surfaceInput?.lesson_id);
  } catch {
    return null;
  }
}

function cleanRecord(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !PRACTICE_FIELDS.has(key)
    || typeof value[key] !== 'string' || value[key].length > 2000)) {
    throw new Error('Saved practice record is not readable.');
  }
  return { ...value };
}

function exactRecord(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && rightKeys.every(key => left[key] === right[key]);
}

function readIdentity(value, hasRecord) {
  if (!hasRecord) {
    if (value !== null) throw new Error('An absent practice record must have an explicit null identity.');
    return null;
  }
  if (!lessonPracticeIdentity(value)) throw new Error('Saved practice identity is not readable.');
  return value;
}

function safeAttempt(accepted, values, extras) {
  if (!plainObject(extras)) throw new Error('invalid-extras');
  const attempt = { ...accepted };
  for (const [key, value] of Object.entries(values)) {
    if (!PRACTICE_FIELDS.has(key)) throw new Error('invalid-field');
    if (typeof value !== 'string' || value.length > 2000) throw new Error('invalid-length');
    attempt[key] = value;
  }
  for (const [key, value] of Object.entries(extras)) {
    if (!PRACTICE_FIELDS.has(key) || own(values, key) || typeof value !== 'string' || value.length > 2000) {
      throw new Error(typeof value !== 'string' || (typeof value === 'string' && value.length > 2000) ? 'invalid-length' : 'invalid-extras');
    }
    attempt[key] = value;
  }
  return attempt;
}

/**
 * Reusable saved-practice state for isolated interactive lesson modules.
 * Reads and writes only the lesson's declared `read_practice` and
 * `keep_practice` capabilities through host.call.
 */
export function useLessonPractice({
  host,
  surfaceInput = {},
  fields = [],
  messages = {},
  requestPrefix = 'lesson-practice',
  onRestore,
} = {}) {
  if (!Array.isArray(fields) || new Set(fields).size !== fields.length
    || fields.some(key => typeof key !== 'string' || !PRACTICE_FIELDS.has(key))) {
    throw new TypeError('Lesson practice fields must be unique declared practice fields.');
  }
  if (typeof requestPrefix !== 'string' || !requestPrefix.trim() || requestPrefix.length > 163) {
    throw new TypeError('Lesson practice requestPrefix must be a non-empty string of at most 163 characters.');
  }

  const label = recordLabel(surfaceInput);
  const fieldList = fields.join('\u0000');
  const scope = `${label ?? ''}\u0000${fieldList}`;
  const texts = { ...EMPTY_MESSAGES, ...(plainObject(messages) ? messages : {}) };
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(key => [key, ''])));
  const [loading, setLoading] = useState(Boolean(host && label));
  const [saving, setSaving] = useState(false);
  const [locked, setLocked] = useState(false);
  const [status, setStatus] = useState('');
  const refs = useRef(null);
  const generation = useRef(0);
  const latest = useRef({ fields, texts, onRestore, scope });
  latest.current = { fields, texts, onRestore, scope };

  const setValue = useCallback((key, text) => {
    if (!latest.current.fields.includes(key) || typeof text !== 'string' || text.length > 2000) return;
    const state = refs.current;
    if (!state || state.scope !== latest.current.scope || state.pending) return;
    state.edited = true;
    state.restoreNotified = true;
    state.values = { ...state.values, [key]: text };
    setValues(state.values);
    setStatus('');
  }, []);

  const markEdited = useCallback(() => {
    if (refs.current?.scope === latest.current.scope) {
      refs.current.edited = true;
      refs.current.restoreNotified = true;
    }
  }, []);

  const save = useCallback(async (extra = {}) => {
    const state = refs.current;
    const operationGeneration = generation.current;
    const isCurrent = () => refs.current === state && generation.current === operationGeneration
      && state?.scope === scope && latest.current.scope === scope;
    if (!state || state.scope !== scope) return false;
    if (!host || !label || !state) {
      if (isCurrent()) setStatus(texts.unavailable);
      return false;
    }
    if (state.loading || state.busy || saving) return false;
    if (!latest.current.fields.length || latest.current.fields.some(key => !state.values[key]?.trim())) {
      if (isCurrent()) setStatus(latest.current.texts.missing);
      return false;
    }

    if (!state.pending) {
      let attempt;
      try {
        attempt = safeAttempt(state.accepted, state.values, extra);
      } catch (error) {
        if (isCurrent()) setStatus(error.message === 'invalid-length' ? latest.current.texts.length : latest.current.texts.unavailable);
        return false;
      }
      const randomUUID = globalThis.crypto?.randomUUID;
      if (typeof randomUUID !== 'function') {
        if (isCurrent()) setStatus(latest.current.texts.unavailable);
        return false;
      }
      const requestKey = `${requestPrefix}:${randomUUID.call(globalThis.crypto)}`;
      if (requestKey.length > 200) {
        if (isCurrent()) setStatus(latest.current.texts.unavailable);
        return false;
      }
      state.pending = { attempt, requestKey, expectedIdentity: state.identity };
      if (isCurrent()) {
        setLocked(true);
        setStatus('');
      }
    }

    const pending = state.pending;
    state.busy = true;
    if (isCurrent()) setSaving(true);

    const readBack = async () => {
      const response = await host.call('read_practice', {});
      if (!plainObject(response?.records) || !plainObject(response?.identities)) throw new Error('Practice readback was not readable.');
      const hasRecord = own(response.records, label);
      const record = hasRecord ? cleanRecord(response.records[label]) : {};
      const identity = readIdentity(response.identities[label], hasRecord);
      if (exactRecord(record, pending.attempt) && identity) return { state: 'saved', record, identity };
      if (identity !== state.identity || !exactRecord(record, state.accepted)) return { state: 'changed', record, identity };
      return { state: 'same', record, identity };
    };

    const reconcile = async () => {
      const result = await readBack();
      if (!isCurrent()) return 'stale';
      if (result.state === 'saved') {
        state.accepted = result.record;
        state.identity = result.identity;
        state.pending = null;
        state.edited = false;
        if (isCurrent()) {
          setLocked(false);
          setStatus(latest.current.texts.saved);
        }
        return result.state;
      }
      if (result.state === 'changed') {
        state.accepted = result.record;
        state.identity = result.identity;
        state.pending = null;
        if (isCurrent()) {
          setLocked(false);
          setStatus(latest.current.texts.conflict);
        }
        return result.state;
      }
      return result.state;
    };

    try {
      const response = await host.call('keep_practice', {
        attempt: pending.attempt,
        expected_identity: pending.expectedIdentity,
        request_key: pending.requestKey,
      });
      // A write acknowledgement is not delivery proof; exact scoped readback is.
      if (response?.written === 0 || response?.conflicts?.length) {
        const result = await reconcile();
        if (result === 'same' && isCurrent()) setStatus(latest.current.texts.readbackFailure);
        return result === 'saved';
      }
      const result = await reconcile();
      if (result === 'same' && isCurrent()) setStatus(latest.current.texts.readbackFailure);
      return result === 'saved';
    } catch {
      try {
        const result = await reconcile();
        if (result === 'saved') return true;
        if (result === 'changed') return false;
      } catch {
        // Preserve the exact payload and idempotency key so retry is safe.
      }
      if (isCurrent()) setStatus(latest.current.texts.saveFailure);
      return false;
    } finally {
      state.busy = false;
      if (isCurrent()) setSaving(false);
    }
  }, [host, label, requestPrefix, saving, scope, texts]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const isEffectCurrent = () => generation.current === currentGeneration;
    const currentFields = latest.current.fields;
    const sameScope = refs.current?.scope === scope;
    const state = sameScope ? refs.current : {
      scope,
      values: Object.fromEntries(currentFields.map(key => [key, ''])),
      accepted: {},
      identity: null,
      pending: null,
      edited: false,
      restoreNotified: false,
      loading: Boolean(host && label),
      busy: false,
    };
    state.loading = Boolean(host && label);
    refs.current = state;
    if (!sameScope) {
      setValues(state.values);
      setLocked(false);
      setSaving(false);
    }
    setLoading(state.loading);
    if (!sameScope) setStatus('');
    else setSaving(false);

    if (!host || !label) {
      state.loading = false;
      if (isEffectCurrent()) setLoading(false);
      return () => { if (generation.current === currentGeneration) generation.current += 1; };
    }

    let live = true;
    host.call('read_practice', {}).then(response => {
      if (!live || generation.current !== currentGeneration) return;
      if (!plainObject(response?.records) || !plainObject(response?.identities)) throw new Error('Practice read was not readable.');
      const hasRecord = own(response.records, label);
      const record = hasRecord ? cleanRecord(response.records[label]) : {};
      const identity = readIdentity(response.identities[label], hasRecord);
      const hadPending = Boolean(state.pending);
      if (state.pending && exactRecord(record, state.pending.attempt) && identity) {
        state.accepted = record;
        state.identity = identity;
        state.pending = null;
        state.edited = false;
        setLocked(false);
        setStatus(latest.current.texts.saved);
      } else if (state.pending && (identity !== state.identity || !exactRecord(record, state.accepted))) {
        state.accepted = record;
        state.identity = identity;
        state.pending = null;
        setLocked(false);
        setStatus(latest.current.texts.conflict);
      } else {
        state.accepted = record;
        state.identity = identity;
      }
      state.loading = false;
      setLoading(false);
      if (hadPending || state.edited || state.restoreNotified) return;
      const restoredValues = Object.fromEntries(currentFields.map(key => [key, record[key] ?? '']));
      state.values = restoredValues;
      setValues(restoredValues);
      state.restoreNotified = true;
      try { latest.current.onRestore?.(record); } catch { /* A consumer callback cannot turn a successful read into a failed read. */ }
    }).catch(() => {
      if (!live || generation.current !== currentGeneration) return;
      state.loading = false;
      setLoading(false);
      if (!state.edited) setStatus(latest.current.texts.readFailure);
    });

    return () => {
      live = false;
      if (generation.current === currentGeneration) generation.current += 1;
    };
  }, [host, label, fieldList, scope]);

  return { values, setValue, save, loading, saving, locked, status, markEdited };
}
