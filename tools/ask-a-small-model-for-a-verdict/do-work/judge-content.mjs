#!/usr/bin/env node
// Generic DATA driven semantic review for content and other supplied material.
// The rubric defines the question, answer shape, known calibration cases, and
// which answers satisfy the caller's gate. Providers are adapter configuration
// only; no creator, product, or topic is embedded here.

// tools/ask-a-small-model-for-a-verdict/do-work/judge-content.mjs
import {judge, VerdictRefused, blake3Material, judgeSourceIdentity} from './ask-for-a-verdict.mjs'
import {classifiersFrom} from './who-can-be-asked.mjs'
const sameAnswer = Object.is

// Review only plain DATA. JSON's lossy coercions (undefined, accessors, toJSON,
// holes, cycles, nonfinite numbers) must not identify different input as equal.
function snapshot(value, active = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value
  if (!value || typeof value !== 'object' || active.has(value)
      || !(Array.isArray(value) ? Object.getPrototypeOf(value) === Array.prototype
        : [Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw new VerdictRefused('review inputs must be complete plain JSON DATA')
  }
  active.add(value)
  const array = Array.isArray(value), copy = array ? [] : Object.create(null)
  if (array && 'toJSON' in value) {
    throw new VerdictRefused('review arrays cannot inherit custom JSON serialization')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) {
    throw new VerdictRefused('review inputs cannot contain symbol fields')
  }
  if (array && (keys.length !== value.length + 1 || !keys.includes('length')
      || keys.some(key => key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) {
    throw new VerdictRefused('review arrays must contain every element and no extra fields')
  }
  for (const key of array ? keys.filter(key => key !== 'length') : keys.sort()) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !field.enumerable || !Object.hasOwn(field, 'value')) {
      throw new VerdictRefused('review inputs cannot contain accessors or hidden fields')
    }
    Object.defineProperty(copy, key, {value: snapshot(field.value, active), enumerable: true})
  }
  active.delete(value)
  return Object.freeze(copy)
}

/** Supplied material identity, not filesystem provenance or reviewer attestation.
 * The effect owner must reread its actual current material and compare this
 * identity before using a verdict. Addressed parts identify descriptors only.
 */
function ownInput(input, name, fallback) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new VerdictRefused('review invocation must be plain DATA with explicit fields')
  }
  const field = Object.getOwnPropertyDescriptor(input, name)
  if (!field) return fallback
  if (!field.enumerable || !Object.hasOwn(field, 'value')) {
    throw new VerdictRefused('review invocation fields cannot be accessors or hidden')
  }
  return field.value === undefined ? fallback : field.value
}

function reviewMaterial(input) {
  return snapshot({rubric: ownInput(input, 'rubric'), content: ownInput(input, 'content'),
    content_parts: ownInput(input, 'content_parts', []), passes: ownInput(input, 'passes', 2),
    sureAt: ownInput(input, 'sureAt', null)})
}

export function contentReviewIdentity(input) {
  const material = reviewMaterial(input)
  return `blake3:${blake3Material(JSON.stringify(['content-review-input/v1', material]))}`
}

/**
 * Callable interface. Returns a fail-closed `accepted` bit alongside
 * the complete auditable verdict. The caller chooses acceptance in rubric DATA.
 */
export async function judgeContent(input) {
  // Capture before provider discovery/calibration can yield to another writer.
  const material = reviewMaterial(input)
  if (typeof material.content !== 'string' || !material.content.trim()) {
    throw new VerdictRefused('content must be a non-empty string')
  }
  if (!Array.isArray(material.content_parts)) throw new VerdictRefused('content_parts must be an array')
  if (!Array.isArray(material.rubric?.accept_when_answer_in) || material.rubric.accept_when_answer_in.length === 0) {
    throw new VerdictRefused('rubric must declare non-empty accept_when_answer_in DATA for a fail-closed gate')
  }
  const inputIdentity = contentReviewIdentity(material)
  const sourceSnapshot = judgeSourceIdentity()
  const ask = ownInput(input, 'ask'), candidates = ownInput(input, 'candidates')
  const providers = ownInput(input, 'providers')
  const configured = candidates && typeof ask === 'function'
    ? {candidates: snapshot(candidates), ask}
    : await classifiersFrom({ask_in_order: providers === undefined ? undefined : snapshot(providers)})
  // Where calibration is kept, and whether this call may calibrate, change no verdict's meaning, so they stay out of
  // the input identity.
  const verdict = await judge({...material, ...configured, remember: ownInput(input, 'remember', null),
    calibrate: ownInput(input, 'calibrate', true)})
  if (contentReviewIdentity(material) !== inputIdentity) {
    throw new VerdictRefused('review serialization changed during review; no current verdict is available')
  }
  if (judgeSourceIdentity() !== sourceSnapshot) {
    throw new VerdictRefused('judge source changed during review; no current content verdict is available')
  }
  // No inherited array method may redefine acceptance while a provider awaits.
  let accepted = false
  for (let at = 0; at < material.rubric.accept_when_answer_in.length; at++) {
    if (sameAnswer(material.rubric.accept_when_answer_in[at], verdict.answer)) accepted = true
  }
  return {
    accepted,
    reason: accepted ? null : 'answer_not_accepted_by_rubric',
    ...verdict,
    review_binding: {schema: 'content-review-input/v1', input_identity: inputIdentity,
      judge_source_snapshot: sourceSnapshot,
      scope: 'Supplied text, part descriptors and rubric/decision DATA only; not file completeness, current effect bytes or independent reviewer attestation.'},
  }
}

// Engine/package callers use the same callable contract as direct imports.
export const run = judgeContent

function ownFunction(owner, name, optional = false) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name)
  if (!descriptor) {
    if (optional) return undefined
    throw new VerdictRefused('release owner is not configured')
  }
  if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new VerdictRefused('release owner callbacks must be own data-property functions')
  }
  return descriptor.value
}

function ownData(value, name) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new VerdictRefused('release owner returned incomplete plain DATA')
  }
  return descriptor.value
}

function releaseSnapshot(current) {
  let captured
  try {
    captured = snapshot(current)
  } catch {
    throw new VerdictRefused('current release material is unavailable')
  }
  if (!captured || ![Object.prototype, null].includes(Object.getPrototypeOf(captured))
      || Reflect.ownKeys(captured).length !== 2
      || !Object.hasOwn(captured, 'review') || !Object.hasOwn(captured, 'context')) {
    throw new VerdictRefused('current release material is unavailable')
  }
  const review = ownData(captured, 'review')
  const context = ownData(captured, 'context')
  const capturedReview = snapshot(review)
  const capturedContext = snapshot(context)
  if (!capturedReview || ![Object.prototype, null].includes(Object.getPrototypeOf(capturedReview))
      || !capturedContext || ![Object.prototype, null].includes(Object.getPrototypeOf(capturedContext))) {
    throw new VerdictRefused('current release material is unavailable')
  }
  for (const field of ['task', 'skills', 'procedures', 'selection', 'independent_selection', 'evaluation', 'route']) {
    const value = Object.getOwnPropertyDescriptor(capturedContext, field)?.value
    if (!value || typeof value !== 'object') throw new VerdictRefused('current release context is incomplete')
  }
  const allowedReviewFields = new Set(['rubric', 'content', 'content_parts', 'passes', 'sureAt'])
  if (Reflect.ownKeys(capturedReview).some(key => typeof key !== 'string' || !allowedReviewFields.has(key))
      || !Object.hasOwn(capturedReview, 'rubric') || !Object.hasOwn(capturedReview, 'content')) {
    throw new VerdictRefused('current review material is incomplete')
  }
  if (typeof capturedReview.content !== 'string' || !capturedReview.content.trim()) {
    throw new VerdictRefused('current review material is incomplete')
  }
  const material = snapshot({context: capturedContext, review: capturedReview})
  const binding = `blake3:${blake3Material(JSON.stringify(['content-release-input/v1', material]))}`
  return {material, binding}
}

function validAdmission(value, binding) {
  let captured
  try {
    captured = snapshot(value)
  } catch {
    return null
  }
  if (!captured || ![Object.prototype, null].includes(Object.getPrototypeOf(captured))
      || Reflect.ownKeys(captured).length !== 3) return null
  const status = Object.getOwnPropertyDescriptor(captured, 'status')
  const admittedBinding = Object.getOwnPropertyDescriptor(captured, 'binding')
  const receipt = Object.getOwnPropertyDescriptor(captured, 'receipt')
  if (!status?.enumerable || !Object.hasOwn(status, 'value') || status.value !== 'admitted'
      || !admittedBinding?.enumerable || !Object.hasOwn(admittedBinding, 'value') || admittedBinding.value !== binding
      || !receipt?.enumerable || !Object.hasOwn(receipt, 'value')
      || typeof receipt.value !== 'string' || !receipt.value.trim()) return null
  return receipt.value
}

function unknownReleaseEffect() {
  const error = new Error('release effect outcome is unknown; do not retry')
  error.code = 'content_release_effect_unknown'
  return error
}

/**
 * Install a bounded release consumer into an existing owner's trusted runtime.
 * The callbacks are fixed at installation; callers can provide only an opaque
 * owner reference. The effect owner must atomically fence current rights, source
 * and admission evidence and return only a bounded nonsecret receipt reference;
 * this wrapper does not create admission or atomicity evidence.
 */
export function contentReleaseFor(owner) {
  if (!owner || ![Object.prototype, null].includes(Object.getPrototypeOf(owner))) {
    throw new VerdictRefused('release owner must be plain install-time configuration')
  }
  const readCurrent = ownFunction(owner, 'readCurrent')
  const admit = ownFunction(owner, 'admit')
  const effect = ownFunction(owner, 'effect')
  const configure = ownFunction(owner, 'configureClassifiers', true)

  return async function release(reference) {
    if (typeof reference !== 'string' || !reference.trim() || reference.length > 1024) {
      throw new VerdictRefused('release requires a bounded opaque owner reference')
    }
    let captured
    try {
      captured = releaseSnapshot(await readCurrent(reference))
    } catch {
      throw new VerdictRefused('current release material is unavailable')
    }
    const {material, binding} = captured
    const sourceSnapshot = judgeSourceIdentity()
    let beforeReview
    try {
      beforeReview = validAdmission(await admit({reference, binding, material, stage: 'before-review'}), binding)
    } catch {
      beforeReview = null
    }
    if (!beforeReview) throw new VerdictRefused('current independent release admission is unavailable')

    let review
    try {
      let classifierOptions = {}
      if (configure) {
        const configured = await configure({reference, binding, material})
        if (!configured || ![Object.prototype, null].includes(Object.getPrototypeOf(configured))) {
          throw new VerdictRefused('fixed classifier configuration is unavailable')
        }
        const candidates = ownData(configured, 'candidates')
        const ask = ownData(configured, 'ask')
        if (typeof ask !== 'function') throw new VerdictRefused('fixed classifier configuration is unavailable')
        classifierOptions = {candidates, ask}
      }
      const contextText = JSON.stringify(material.context)
      const preReviewCurrent = releaseSnapshot(await readCurrent(reference))
      if (preReviewCurrent.binding !== binding || judgeSourceIdentity() !== sourceSnapshot) {
        throw new VerdictRefused('current release material changed before review')
      }
      review = snapshot(await judgeContent({...material.review,
        content: `${material.review.content}\n\n--- SOURCE-OWNED METHOD CONTEXT (JSON) ---\n${contextText}\n--- END SOURCE-OWNED METHOD CONTEXT ---`,
        ...classifierOptions}))
    } catch {
      throw new VerdictRefused('content review is unavailable')
    }
    if (review.accepted !== true) throw new VerdictRefused('content review did not satisfy its declared rubric')

    let afterReview
    try {
      afterReview = releaseSnapshot(await readCurrent(reference))
    } catch {
      throw new VerdictRefused('current release material changed or is unavailable')
    }
    if (afterReview.binding !== binding || afterReview.binding !== captured.binding) {
      throw new VerdictRefused('current release material changed during review')
    }
    const currentSourceSnapshot = judgeSourceIdentity()
    if (currentSourceSnapshot !== sourceSnapshot
        || review.review_binding?.judge_source_snapshot !== sourceSnapshot) {
      throw new VerdictRefused('judge source changed during release review')
    }

    let effectAdmission
    try {
      effectAdmission = validAdmission(await admit({reference, binding, material, stage: 'before-effect', review}), binding)
    } catch {
      effectAdmission = null
    }
    if (!effectAdmission) throw new VerdictRefused('current release effect admission is unavailable')
    let finalCurrent
    try {
      finalCurrent = releaseSnapshot(await readCurrent(reference))
    } catch {
      throw new VerdictRefused('current release material changed or is unavailable')
    }
    if (finalCurrent.binding !== binding || judgeSourceIdentity() !== sourceSnapshot) {
      throw new VerdictRefused('current release material changed before effect')
    }

    let delivered
    try {
      delivered = await effect({reference, binding, admission_receipt: effectAdmission, review})
    } catch {
      throw unknownReleaseEffect()
    }
    let effectReceipt
    try {
      const safeResult = snapshot(delivered)
      const status = safeResult && Object.getOwnPropertyDescriptor(safeResult, 'status')
      const effectBinding = safeResult && Object.getOwnPropertyDescriptor(safeResult, 'binding')
      const receipt = safeResult && Object.getOwnPropertyDescriptor(safeResult, 'receipt')
      if (!safeResult || ![Object.prototype, null].includes(Object.getPrototypeOf(safeResult))
          || Reflect.ownKeys(safeResult).length !== 3
          || !status?.enumerable || !Object.hasOwn(status, 'value') || status.value !== 'delivered'
          || !effectBinding?.enumerable || !Object.hasOwn(effectBinding, 'value') || effectBinding.value !== binding
          || !receipt?.enumerable || !Object.hasOwn(receipt, 'value')
          || typeof receipt.value !== 'string' || !receipt.value.trim() || receipt.value.length > 1024) {
        throw unknownReleaseEffect()
      }
      effectReceipt = receipt.value
    } catch {
      throw unknownReleaseEffect()
    }
    return {status: 'delivered', binding,
      review_binding: review.review_binding,
      receipt: effectReceipt}
  }
}
