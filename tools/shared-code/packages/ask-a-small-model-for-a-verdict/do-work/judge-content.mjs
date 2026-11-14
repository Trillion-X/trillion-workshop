#!/usr/bin/env node
// Generic DATA driven semantic review for content and other supplied material.
// The rubric defines the question, answer shape, known calibration cases, and
// which answers satisfy the caller's gate. Providers are adapter configuration
// only; no creator, product, or topic is embedded here.

import {judge, VerdictRefused} from './ask-for-a-verdict.mjs'

const ADAPTERS = {
  'locally-served': () => import('./ask-a-locally-served-model.mjs'),
  'hosted-classifier': () => import('./ask-a-hosted-classifier.mjs'),
  'model-response': () => import('./ask-through-model-response.mjs'),
}

export async function configuredClassifiers(providers = [{via: 'locally-served'}]) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new VerdictRefused('at least one declared classifier provider is required')
  }
  const available = []
  for (const provider of providers) {
    if (!provider || typeof provider.via !== 'string' || !ADAPTERS[provider.via]) continue
    try {
      const adapter = await ADAPTERS[provider.via]()
      adapter.configure?.(provider)
      for (const candidate of await adapter.candidates(provider)) {
        available.push({candidate, ask: adapter.ask})
      }
    } catch {
      // An unavailable adapter contributes no candidates. The judge refuses if
      // no candidate passes rubric calibration; it never falls back unscored.
    }
  }
  return {
    candidates: available.map(row => row.candidate),
    ask: args => {
      const selected = available.find(row => row.candidate.name === args.candidate.name)
      if (!selected) throw new VerdictRefused('the selected calibrated classifier is no longer available')
      return selected.ask(args)
    },
  }
}

/**
 * Callable package interface. Returns a fail-closed `accepted` bit alongside
 * the complete auditable verdict. The caller chooses acceptance in rubric DATA.
 */
export async function judgeContent({rubric, content, providers, passes = 2, sureAt = null, candidates, ask}) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new VerdictRefused('content must be a non-empty string')
  }
  if (!Array.isArray(rubric?.accept_when_answer_in) || rubric.accept_when_answer_in.length === 0) {
    throw new VerdictRefused('rubric must declare non-empty accept_when_answer_in DATA for a fail-closed gate')
  }
  const configured = candidates && typeof ask === 'function'
    ? {candidates, ask}
    : await configuredClassifiers(providers)
  const verdict = await judge({rubric, content, ...configured, passes, sureAt})
  const accepted = rubric.accept_when_answer_in.some(answer => Object.is(answer, verdict.answer))
  return {
    accepted,
    reason: accepted ? null : 'answer_not_accepted_by_rubric',
    ...verdict,
  }
}

// Engine/package callers use the same callable contract as direct imports.
export const run = judgeContent
