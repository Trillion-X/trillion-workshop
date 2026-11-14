// One universal application shell primitive: a flat, ordered scene-root set plus
// open owner contributions. screen-arrangement owns only scene/app-shell physics.
// Themes, onboarding, surfaces, and app-open remain opaque contributions routed
// to their addressed owners.
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ApplicationMaterialRef {
  component_ref: string;
  package_name?: string;
  entry_name?: string;
}

export interface ApplicationRoot {
  id: string;
  order_key: string;
  state_epoch: number;
  material_ref: ApplicationMaterialRef;
  instance_props?: Record<string, JsonValue>;
  chrome_zone?: string;
}

export interface ApplicationContribution {
  id: string;
  order_key: string;
  state_epoch: number;
  owner_ref: string;
  config: JsonValue;
}

export interface ApplicationComposition {
  schema: 'bitfield.application-composition/ordered-scene-owner-contributions';
  kind: 'application-composition';
  id: string;
  revision: number;
  presentation?: Record<string, JsonValue>;
  superseded_scene_ids?: string[];
  scene: {
    id: string;
    chrome?: Record<string, JsonValue>;
    required_chrome?: string[];
  };
  roots: ApplicationRoot[];
  contributions: ApplicationContribution[];
}

export interface ApplicationContributionOwnerDescriptor {
  schema: 'bitfield.application-contribution-owner/positive-write-authority';
  owner_ref: string;
  target_ref: string;
  write_authority: {
    thing_types: string[];
    exact_addresses: string[];
    address_prefixes: string[];
  };
}

export interface ApplicationCompositionSelection {
  schema: 'bitfield.application-composition-selection/admitted-owner-refs';
  kind: 'application-composition-selection';
  package_set: string;
  partition: string;
  activation_marker_ref: string;
  previous_composition_ref: string | null;
  next_composition_ref: string;
  projector_template_ref: string;
  previous_owner_descriptor_refs: string[];
  next_owner_descriptor_refs: string[];
  selection_policy_ref?: string;
  /// Address key space for every named ref, captured by the same publisher that binds content.
  /// A label is not an engine address until its mode is known; trying one mode and then another
  /// lets a stale alternate-mode record shadow the admitted record.
  ref_address_modes: Readonly<Record<string, 'label_hash' | 'identity_text'>>;
}

export interface ApplicationContributionOperation {
  operation: 'upsert' | 'retract';
  composition_id: string;
  contribution_id: string;
  owner_ref: string;
  target_ref: string;
  state_epoch: number;
  config?: JsonValue;
}

export type ApplicationCompositionTransitionOperation =
  | {
    phase: 'retract' | 'upsert';
    kind: 'local-thing';
    thing: Record<string, unknown>;
  }
  | {
    phase: 'retract' | 'upsert';
    kind: 'owner-contribution';
    target_ref: string;
    contribution: ApplicationContributionOperation;
  };

export interface ApplicationCompositionTransition {
  schema: 'bitfield.application-composition-transition/retract-before-upsert';
  previous_composition_id?: string;
  next_composition_id?: string;
  local_write_set: {
    upserts: Record<string, unknown>[];
    retractions: Record<string, unknown>[];
  };
  contribution_set: {
    upserts: ApplicationContributionOperation[];
    retractions: ApplicationContributionOperation[];
  };
  ordered_operations: ApplicationCompositionTransitionOperation[];
}

export class ApplicationCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicationCompositionError';
  }
}

const COMPOSITION_SCHEMA = 'bitfield.application-composition/ordered-scene-owner-contributions';
const COMPOSITION_KIND = 'application-composition';
const OWNER_DESCRIPTOR_SCHEMA = 'bitfield.application-contribution-owner/positive-write-authority';
const SELECTION_SCHEMA = 'bitfield.application-composition-selection/admitted-owner-refs';
const SELECTION_KIND = 'application-composition-selection';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApplicationCompositionError(`${path} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new ApplicationCompositionError(`${path} must be a non-negative integer`);
  }
  return Number(value);
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new ApplicationCompositionError(`${path} must be an array`);
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function stringArray(value: unknown, path: string): string[] {
  const decoded = stringList(value, path);
  if (decoded.some((item) => item.trim().length === 0)) {
    throw new ApplicationCompositionError(`${path} must not contain empty strings`);
  }
  return decoded;
}

function jsonValue(value: unknown, path: string, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApplicationCompositionError(`${path} must contain finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`, seen));
  if (!isRecord(value)) throw new ApplicationCompositionError(`${path} must be JSON data`);
  if (seen.has(value)) throw new ApplicationCompositionError(`${path} must not contain cycles`);
  seen.add(value);
  const decoded: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) decoded[key] = jsonValue(item, `${path}.${key}`, seen);
  seen.delete(value);
  return decoded;
}

function optionalJsonRecord(value: unknown, path: string): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined;
  const decoded = jsonValue(value, path);
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new ApplicationCompositionError(`${path} must be an object`);
  }
  return decoded;
}

function presentationRequiredRootIds(presentation: Record<string, JsonValue> | undefined): string[] | undefined {
  if (presentation?.required_root_ids === undefined) return undefined;
  return stringList(presentation.required_root_ids, 'presentation.required_root_ids');
}

function materialRef(value: unknown, path: string): ApplicationMaterialRef {
  if (!isRecord(value)) throw new ApplicationCompositionError(`${path} must be an object`);
  const packageName = value.package_name === undefined ? undefined : text(value.package_name, `${path}.package_name`);
  const entryName = value.entry_name === undefined ? undefined : text(value.entry_name, `${path}.entry_name`);
  if ((packageName && !entryName) || (!packageName && entryName)) {
    throw new ApplicationCompositionError(`${path} package_name and entry_name must be supplied together`);
  }
  return {
    component_ref: text(value.component_ref, `${path}.component_ref`),
    ...(packageName && entryName ? { package_name: packageName, entry_name: entryName } : {}),
  };
}

function root(value: unknown, index: number): ApplicationRoot {
  const path = `roots[${index}]`;
  if (!isRecord(value)) throw new ApplicationCompositionError(`${path} must be an object`);
  const instanceProps = optionalJsonRecord(value.instance_props, `${path}.instance_props`);
  return {
    id: text(value.id, `${path}.id`),
    order_key: text(value.order_key, `${path}.order_key`),
    state_epoch: integer(value.state_epoch, `${path}.state_epoch`),
    material_ref: materialRef(value.material_ref, `${path}.material_ref`),
    ...(instanceProps ? { instance_props: instanceProps } : {}),
    ...(value.chrome_zone === undefined ? {} : { chrome_zone: text(value.chrome_zone, `${path}.chrome_zone`) }),
  };
}

function contribution(value: unknown, index: number): ApplicationContribution {
  const path = `contributions[${index}]`;
  if (!isRecord(value)) throw new ApplicationCompositionError(`${path} must be an object`);
  if (!Object.hasOwn(value, 'config')) throw new ApplicationCompositionError(`${path}.config is required`);
  return {
    id: text(value.id, `${path}.id`),
    order_key: text(value.order_key, `${path}.order_key`),
    state_epoch: integer(value.state_epoch, `${path}.state_epoch`),
    owner_ref: text(value.owner_ref, `${path}.owner_ref`),
    config: jsonValue(value.config, `${path}.config`),
  };
}

function unique(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new ApplicationCompositionError(`${path} contains duplicate id ${value}`);
    seen.add(value);
  }
}

function byOrderThenId<T extends { order_key: string; id: string }>(left: T, right: T): number {
  return left.order_key.localeCompare(right.order_key) || left.id.localeCompare(right.id);
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
}

export function decodeApplicationComposition(value: unknown): ApplicationComposition {
  if (!isRecord(value)) throw new ApplicationCompositionError('application composition must be an object');
  if (value.schema !== COMPOSITION_SCHEMA) throw new ApplicationCompositionError(`schema must be ${COMPOSITION_SCHEMA}`);
  if (value.kind !== COMPOSITION_KIND) throw new ApplicationCompositionError(`kind must be ${COMPOSITION_KIND}`);
  if (value.remove !== undefined) throw new ApplicationCompositionError('remove is not supported; delete the DATA row');
  if (!isRecord(value.scene)) throw new ApplicationCompositionError('scene must be an object');
  if (!Array.isArray(value.roots) || value.roots.length === 0) {
    throw new ApplicationCompositionError('roots must be a non-empty array');
  }
  if (value.roots.length > 1024) throw new ApplicationCompositionError('roots exceeds the 1024-root budget');
  if (value.contributions !== undefined && !Array.isArray(value.contributions)) {
    throw new ApplicationCompositionError('contributions must be an array');
  }
  if (Array.isArray(value.contributions) && value.contributions.length > 4096) {
    throw new ApplicationCompositionError('contributions exceeds the 4096-item budget');
  }
  const roots = value.roots.map(root).sort(byOrderThenId);
  const contributions = (value.contributions ?? []).map(contribution).sort(byOrderThenId);
  unique(roots.map((item) => item.id), 'roots');
  unique(contributions.map((item) => item.id), 'contributions');
  const chrome = optionalJsonRecord(value.scene.chrome, 'scene.chrome');
  const presentation = optionalJsonRecord(value.presentation, 'presentation');
  return {
    schema: COMPOSITION_SCHEMA,
    kind: COMPOSITION_KIND,
    id: text(value.id, 'id'),
    revision: integer(value.revision, 'revision'),
    ...(presentation ? { presentation } : {}),
    ...(value.superseded_scene_ids === undefined
      ? {}
      : { superseded_scene_ids: stringList(value.superseded_scene_ids, 'superseded_scene_ids') }),
    scene: {
      id: text(value.scene.id, 'scene.id'),
      ...(chrome ? { chrome } : {}),
      ...(value.scene.required_chrome === undefined
        ? {}
        : { required_chrome: stringList(value.scene.required_chrome, 'scene.required_chrome') }),
    },
    roots,
    contributions,
  };
}

export function foldApplicationCompositions(values: readonly unknown[]): Map<string, ApplicationComposition> {
  const folded = new Map<string, ApplicationComposition>();
  for (const value of values) {
    const next = decodeApplicationComposition(value);
    const current = folded.get(next.id);
    if (current && current.revision === next.revision) {
      if (canonicalJson(current as unknown as JsonValue) !== canonicalJson(next as unknown as JsonValue)) {
        throw new ApplicationCompositionError(`composition ${next.id} conflicts at revision ${next.revision}`);
      }
      continue;
    }
    if (!current || next.revision > current.revision) folded.set(next.id, next);
  }
  return folded;
}

export function decodeApplicationContributionOwnerDescriptor(
  value: unknown,
): ApplicationContributionOwnerDescriptor {
  if (!isRecord(value)) throw new ApplicationCompositionError('owner descriptor must be an object');
  if (value.schema !== OWNER_DESCRIPTOR_SCHEMA) {
    throw new ApplicationCompositionError(`owner descriptor schema must be ${OWNER_DESCRIPTOR_SCHEMA}`);
  }
  if (!isRecord(value.write_authority)) {
    throw new ApplicationCompositionError('owner descriptor write_authority must be an object');
  }
  const thingTypes = stringList(value.write_authority.thing_types, 'owner descriptor write_authority.thing_types');
  const exactAddresses = stringList(
    value.write_authority.exact_addresses,
    'owner descriptor write_authority.exact_addresses',
  );
  const addressPrefixes = stringList(
    value.write_authority.address_prefixes,
    'owner descriptor write_authority.address_prefixes',
  );
  if (thingTypes.length === 0) {
    throw new ApplicationCompositionError('owner descriptor write_authority.thing_types must not be empty');
  }
  if (exactAddresses.length === 0 && addressPrefixes.length === 0) {
    throw new ApplicationCompositionError('owner descriptor must declare exact_addresses or address_prefixes');
  }
  unique(thingTypes, 'owner descriptor write_authority.thing_types');
  unique(exactAddresses, 'owner descriptor write_authority.exact_addresses');
  unique(addressPrefixes, 'owner descriptor write_authority.address_prefixes');
  return {
    schema: OWNER_DESCRIPTOR_SCHEMA,
    owner_ref: text(value.owner_ref, 'owner descriptor owner_ref'),
    target_ref: text(value.target_ref, 'owner descriptor target_ref'),
    write_authority: {
      thing_types: thingTypes,
      exact_addresses: exactAddresses,
      address_prefixes: addressPrefixes,
    },
  };
}

export function decodeApplicationContributionOwnerDescriptors(
  values: readonly unknown[],
): ApplicationContributionOwnerDescriptor[] {
  const descriptors = values.map(decodeApplicationContributionOwnerDescriptor);
  unique(descriptors.map((descriptor) => descriptor.owner_ref), 'owner descriptors');
  return descriptors;
}

export function decodeApplicationCompositionSelection(value: unknown): ApplicationCompositionSelection {
  if (!isRecord(value)) throw new ApplicationCompositionError('application composition selection must be an object');
  if (value.schema !== SELECTION_SCHEMA) {
    throw new ApplicationCompositionError(`selection schema must be ${SELECTION_SCHEMA}`);
  }
  if (value.kind !== SELECTION_KIND) {
    throw new ApplicationCompositionError(`selection kind must be ${SELECTION_KIND}`);
  }
  if (Object.hasOwn(value, 'ref_content_hashes')) {
    throw new ApplicationCompositionError(
      'selection ref_content_hashes is retired; current ref identities are read and bound by the atomic materialization owner',
    );
  }
  if (value.remove !== undefined) throw new ApplicationCompositionError('selection remove is not supported');
  const packageSet = text(value.package_set, 'selection package_set');
  const partition = text(value.partition, 'selection partition');
  const activationMarkerRef = text(value.activation_marker_ref, 'selection activation_marker_ref');
  if (activationMarkerRef !== `package-set-runtime-state::${packageSet}::${partition}`) {
    throw new ApplicationCompositionError('selection activation marker ref must match its package set and partition');
  }
  const previousRef = value.previous_composition_ref === null || value.previous_composition_ref === undefined
    ? null
    : text(value.previous_composition_ref, 'selection previous_composition_ref');
  const decoded = {
    schema: SELECTION_SCHEMA,
    kind: SELECTION_KIND,
    package_set: packageSet,
    partition,
    activation_marker_ref: activationMarkerRef,
    previous_composition_ref: previousRef,
    next_composition_ref: text(value.next_composition_ref, 'selection next_composition_ref'),
    projector_template_ref: text(value.projector_template_ref, 'selection projector_template_ref'),
    previous_owner_descriptor_refs: stringArray(
      value.previous_owner_descriptor_refs,
      'selection previous_owner_descriptor_refs',
    ),
    next_owner_descriptor_refs: stringArray(
      value.next_owner_descriptor_refs,
      'selection next_owner_descriptor_refs',
    ),
    ...(value.selection_policy_ref === undefined
      ? {}
      : { selection_policy_ref: text(value.selection_policy_ref, 'selection selection_policy_ref') }),
  } as const;
  return {
    ...decoded,
    ref_address_modes: decodeRefAddressModes(value, decoded),
  };
}

function namedSelectionRefs(decoded: {
  previous_composition_ref: string | null;
  next_composition_ref: string;
  projector_template_ref: string;
  previous_owner_descriptor_refs: string[];
  next_owner_descriptor_refs: string[];
  selection_policy_ref?: string;
}): string[] {
  return [
    decoded.previous_composition_ref,
    decoded.next_composition_ref,
    decoded.projector_template_ref,
    decoded.selection_policy_ref ?? null,
    ...decoded.previous_owner_descriptor_refs,
    ...decoded.next_owner_descriptor_refs,
  ].filter((ref): ref is string => typeof ref === 'string');
}

function decodeRefAddressModes(
  value: Record<string, unknown>,
  decoded: Parameters<typeof namedSelectionRefs>[0],
): Readonly<Record<string, 'label_hash' | 'identity_text'>> {
  const supplied = value.ref_address_modes;
  if (!isRecord(supplied)) {
    throw new ApplicationCompositionError(
      'selection ref_address_modes must bind every ref to the address mode used when it was admitted',
    );
  }
  const bound: Record<string, 'label_hash' | 'identity_text'> = Object.create(null);
  for (const ref of namedSelectionRefs(decoded)) {
    if (!Object.hasOwn(supplied, ref)) {
      throw new ApplicationCompositionError(`selection names ref ${ref} with no bound address mode`);
    }
    const mode = supplied[ref];
    if (mode !== 'label_hash' && mode !== 'identity_text') {
      throw new ApplicationCompositionError(`selection ref_address_modes[${ref}] is not recognized`);
    }
    bound[ref] = mode;
  }
  for (const ref of Object.keys(supplied)) {
    if (!Object.hasOwn(bound, ref)) {
      throw new ApplicationCompositionError(
        `selection binds an address mode for ${ref}, which the selection does not name`,
      );
    }
  }
  return bound;
}

function record(
  address: string,
  payload: Record<string, JsonValue>,
  path: string[] = ['current-item', 'published-record'],
): Record<string, unknown> {
  return {
    type: 'record',
    address,
    address_mode: 'identity_text',
    path,
    payload,
    payload_text: null,
    payload_base64: null,
    remove: false,
  };
}

function cloneJsonRecord(value: Record<string, JsonValue>): Record<string, unknown> {
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
}

export function compileApplicationComposition(
  value: unknown,
  projectorTemplate: Record<string, JsonValue>,
): Record<string, unknown>[] {
  const composition = decodeApplicationComposition(value);
  const projector = cloneJsonRecord(projectorTemplate);
  if (!isRecord(projector.payload)) throw new ApplicationCompositionError('projector_template.payload must be an object');
  projector.payload.source = `attribute_fact|${composition.scene.id}|prop:scene:roots|type:scene`;
  const requiredRootIds = presentationRequiredRootIds(composition.presentation);
  if (requiredRootIds !== undefined) {
    unique(requiredRootIds, 'presentation.required_root_ids');
    const knownRootIds = new Set(composition.roots.map((item) => item.id));
    const unknown = requiredRootIds.filter((id) => !knownRootIds.has(id));
    if (unknown.length > 0) {
      throw new ApplicationCompositionError(
        `presentation.required_root_ids names roots that the scene does not project: ${unknown.join(', ')}`,
      );
    }
  }
  const requiredRootIdSet = new Set(requiredRootIds ?? []);
  const roots = composition.roots.map((item) => ({
    id: item.id,
    component_id: item.material_ref.component_ref,
    ...(item.chrome_zone ? { chrome_zone: item.chrome_zone } : {}),
    ...((item.instance_props || requiredRootIdSet.has(item.id)) ? {
      // The existing projector carries instance_props into the rendered scene unchanged.
      // This keeps first-paint policy in application DATA, without giving the browser a
      // product-specific list or changing the projector's native/WASM ABI.
      instance_props: {
        ...(item.instance_props ?? {}),
        ...(requiredRootIdSet.has(item.id) ? {
          __bitfield_presentation: { required_for_first_paint: true },
        } : {}),
      },
    } : {}),
  })) as unknown as JsonValue[];
  // `required_chrome` was decoded and emitted as a fact but never checked against the roots it
  // describes, so a composition could declare that it requires a chrome component and then ship
  // without it. That is not hypothetical, it happened: two required widgets vanished silently, and
  // the guard written for it matched on two startup manifests that no longer exist. Scene roots are
  // generated per application now, so the invariant belongs here, on the output, where the roots and
  // the requirement are both in hand.
  //
  // The two widgets are deliberately not named, and the omission is the point rather than tidiness.
  // This file is the universal composition engine: it must not know any product, package or widget
  // by name, and a name in a COMMENT is still a name a reader will reach for when they extend the
  // code beneath it. The package's own guard enforces exactly that by lowercasing this source and
  // refusing a list of identities, and it cannot tell prose from code, which is correct here: the
  // rule is about the file, not about the expression. The example loses nothing by being anonymous,
  // because its whole weight is "this really happened", never which two it happened to.
  const requiredChrome = composition.scene.required_chrome;
  if (requiredChrome !== undefined) {
    const present = new Set(composition.roots.map((item) => item.material_ref.component_ref));
    const missing = requiredChrome.filter((component) => !present.has(component));
    if (missing.length > 0) {
      throw new ApplicationCompositionError(
        `scene ${composition.scene.id} requires chrome that its roots do not project: ${missing.join(', ')}`,
      );
    }
  }
  const things: Record<string, unknown>[] = [
    projector,
    record(
      `package::screen-arrangement::application-composition::${composition.id}`,
      composition as unknown as Record<string, JsonValue>,
    ),
    record(`entity|${composition.scene.id}`, { table: 'entity', id: composition.scene.id }, []),
    record(`entity_types|${composition.scene.id}|type:scene`, {
      table: 'entity_types',
      entity_id: composition.scene.id,
      type_id: 'type:scene',
    }, ['type:scene']),
    record(`attribute_fact|${composition.scene.id}|prop:scene:roots|type:scene`, {
      table: 'attribute_fact',
      subject_id: composition.scene.id,
      property_id: 'prop:scene:roots',
      type_id: 'type:scene',
      value_json: roots,
    }, ['prop:scene:roots']),
  ];
  for (const supersededSceneId of composition.superseded_scene_ids ?? []) {
    things.push(record(`attribute_fact|${supersededSceneId}|prop:scene:roots|type:scene`, {
      table: 'attribute_fact',
      subject_id: supersededSceneId,
      property_id: 'prop:scene:roots',
      type_id: 'type:scene',
      value_json: [],
    }, ['prop:scene:roots']));
  }
  if (composition.scene.chrome !== undefined) {
    things.push(record(`attribute_fact|${composition.scene.id}|prop:scene:chrome|type:scene`, {
      table: 'attribute_fact',
      subject_id: composition.scene.id,
      property_id: 'prop:scene:chrome',
      type_id: 'type:scene',
      value_json: composition.scene.chrome,
    }, ['prop:scene:chrome']));
  }
  if (composition.scene.required_chrome !== undefined) {
    things.push(record(`attribute_fact|${composition.scene.id}|prop:scene:required-chrome|type:scene`, {
      table: 'attribute_fact',
      subject_id: composition.scene.id,
      property_id: 'prop:scene:required-chrome',
      type_id: 'type:scene',
      value_json: composition.scene.required_chrome,
    }, ['prop:scene:required-chrome']));
  }
  return things;
}

function thingKey(thing: Record<string, unknown>): string {
  const address = typeof thing.address === 'string' ? thing.address : undefined;
  const name = typeof thing.name === 'string' ? thing.name : undefined;
  if (!address && !name) throw new ApplicationCompositionError('compiled thing needs address or name');
  return `${String(thing.type)}:${address ?? name}`;
}

function thingMap(things: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  return new Map(things.map((thing) => [thingKey(thing), thing]));
}

function retractionFor(thing: Record<string, unknown>): Record<string, unknown> {
  return {
    type: thing.type,
    ...(typeof thing.address === 'string' ? { address: thing.address } : {}),
    ...(typeof thing.name === 'string' ? { name: thing.name } : {}),
    ...(Array.isArray(thing.path) ? { path: thing.path } : {}),
    remove: true,
  };
}

function contributionMap(items: ApplicationContribution[]): Map<string, ApplicationContribution> {
  return new Map(items.map((item) => [item.id, item]));
}

function contributionOwnerMap(
  descriptors: ApplicationContributionOwnerDescriptor[],
): Map<string, ApplicationContributionOwnerDescriptor> {
  return new Map(descriptors.map((descriptor) => [descriptor.owner_ref, descriptor]));
}

function descriptorFor(
  ownerRef: string,
  descriptors: Map<string, ApplicationContributionOwnerDescriptor>,
): ApplicationContributionOwnerDescriptor {
  const descriptor = descriptors.get(ownerRef);
  if (!descriptor) throw new ApplicationCompositionError(`no owner descriptor for owner_ref ${ownerRef}`);
  return descriptor;
}

function compareCompositionRevisions(
  previous: ApplicationComposition | undefined,
  next: ApplicationComposition | undefined,
): void {
  if (!previous || !next || previous.id !== next.id) return;
  if (next.revision < previous.revision) {
    throw new ApplicationCompositionError(
      `composition ${next.id} revision regressed from ${previous.revision} to ${next.revision}`,
    );
  }
  if (next.revision === previous.revision
    && canonicalJson(previous as unknown as JsonValue) !== canonicalJson(next as unknown as JsonValue)) {
    throw new ApplicationCompositionError(`composition ${next.id} conflicts at revision ${next.revision}`);
  }
}

export function planApplicationCompositionTransition(
  previousCompositionValue: unknown | undefined,
  nextCompositionValue: unknown | undefined,
  projectorTemplate: Record<string, JsonValue>,
  previousOwnerDescriptorValues: readonly unknown[],
  nextOwnerDescriptorValues: readonly unknown[] = previousOwnerDescriptorValues,
): ApplicationCompositionTransition {
  const previous = previousCompositionValue === undefined
    ? undefined
    : decodeApplicationComposition(previousCompositionValue);
  const next = nextCompositionValue === undefined
    ? undefined
    : decodeApplicationComposition(nextCompositionValue);
  if (!previous && !next) throw new ApplicationCompositionError('previous or next composition is required');
  compareCompositionRevisions(previous, next);
  const previousThings = thingMap(previous ? compileApplicationComposition(previous, projectorTemplate) : []);
  const nextThings = thingMap(next ? compileApplicationComposition(next, projectorTemplate) : []);
  const upserts = [...nextThings].flatMap(([key, thing]) => {
    const prior = previousThings.get(key);
    return prior && canonicalJson(prior as unknown as JsonValue) === canonicalJson(thing as unknown as JsonValue)
      ? []
      : [thing];
  });
  const retractions = [...previousThings].flatMap(([key, thing]) => (
    nextThings.has(key) ? [] : [retractionFor(thing)]
  ));

  const previousContributions = contributionMap(previous?.contributions ?? []);
  const nextContributions = contributionMap(next?.contributions ?? []);
  const sameComposition = previous !== undefined && next !== undefined && previous.id === next.id;
  const previousOwners = contributionOwnerMap(
    decodeApplicationContributionOwnerDescriptors(previousOwnerDescriptorValues),
  );
  const nextOwners = contributionOwnerMap(
    decodeApplicationContributionOwnerDescriptors(nextOwnerDescriptorValues),
  );
  const contributionUpserts: ApplicationContributionOperation[] = [];
  const contributionRetractions: ApplicationContributionOperation[] = [];
  for (const [id, item] of nextContributions) {
    const prior = sameComposition ? previousContributions.get(id) : undefined;
    if (prior && canonicalJson(prior as unknown as JsonValue) === canonicalJson(item as unknown as JsonValue)) continue;
    if (prior) {
      contributionRetractions.push({
        operation: 'retract',
        composition_id: previous!.id,
        contribution_id: prior.id,
        owner_ref: prior.owner_ref,
        target_ref: descriptorFor(prior.owner_ref, previousOwners).target_ref,
        state_epoch: prior.state_epoch,
        config: prior.config,
      });
    }
    contributionUpserts.push({
      operation: 'upsert',
      composition_id: next!.id,
      contribution_id: item.id,
      owner_ref: item.owner_ref,
      target_ref: descriptorFor(item.owner_ref, nextOwners).target_ref,
      state_epoch: item.state_epoch,
      config: item.config,
    });
  }
  for (const [id, item] of previousContributions) {
    if (sameComposition && nextContributions.has(id)) continue;
    contributionRetractions.push({
      operation: 'retract',
      composition_id: previous!.id,
      contribution_id: item.id,
      owner_ref: item.owner_ref,
      target_ref: descriptorFor(item.owner_ref, previousOwners).target_ref,
      state_epoch: item.state_epoch,
      config: item.config,
    });
  }

  const orderedOperations: ApplicationCompositionTransitionOperation[] = [
    ...retractions
      .sort((left, right) => thingKey(left).localeCompare(thingKey(right)))
      .map((thing): ApplicationCompositionTransitionOperation => ({ phase: 'retract', kind: 'local-thing', thing })),
    ...contributionRetractions
      .sort((left, right) => left.owner_ref.localeCompare(right.owner_ref)
        || left.contribution_id.localeCompare(right.contribution_id))
      .map((operation): ApplicationCompositionTransitionOperation => ({
        phase: 'retract',
        kind: 'owner-contribution',
        target_ref: operation.target_ref,
        contribution: operation,
      })),
    ...upserts
      .sort((left, right) => thingKey(left).localeCompare(thingKey(right)))
      .map((thing): ApplicationCompositionTransitionOperation => ({ phase: 'upsert', kind: 'local-thing', thing })),
    ...contributionUpserts
      .sort((left, right) => left.owner_ref.localeCompare(right.owner_ref)
        || left.contribution_id.localeCompare(right.contribution_id))
      .map((operation): ApplicationCompositionTransitionOperation => ({
        phase: 'upsert',
        kind: 'owner-contribution',
        target_ref: operation.target_ref,
        contribution: operation,
      })),
  ];

  return {
    schema: 'bitfield.application-composition-transition/retract-before-upsert',
    ...(previous ? { previous_composition_id: previous.id } : {}),
    ...(next ? { next_composition_id: next.id } : {}),
    local_write_set: { upserts, retractions },
    contribution_set: {
      upserts: contributionUpserts,
      retractions: contributionRetractions,
    },
    ordered_operations: orderedOperations,
  };
}
