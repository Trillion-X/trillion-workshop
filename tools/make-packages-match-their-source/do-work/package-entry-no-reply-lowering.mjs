import { blake3 } from '@noble/hashes/blake3.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const publicSenderName = 'sendRequestToBitfieldTarget';
const supportedSourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
const writerNamePrefix = 'bitfieldGeneratedNoReplyWrite';

export function createNoReplyCallLoweringState(binding) {
  const plans = noReplyTargetWritePlans(binding);
  const writers = [];
  const writersByKey = new Map();
  return {
    plans,
    writers,
    writerFor(match) {
      const inputObjectFields = match.inputObjectFields ?? null;
      const inputObjectKeys = inputObjectFields?.map((field) => field.key) ?? null;
      const key = JSON.stringify({
        target: match.plan.target,
        definition: match.fixedDefinition ?? null,
        dynamicDefinition: match.fixedDefinition === null,
        inputObjectFields: inputObjectFields?.map((field) => field.fixed
          ? { key: field.key, fixed: true, value: field.value }
          : {
            key: field.key,
            fixed: false,
            sourceChildKey: field.sourceChild?.key ?? null,
            sourceOwnerSlot: field.sourceOwnerSlot ?? null,
          }),
      });
      const existing = writersByKey.get(key);
      if (existing) return existing;
      const writer = {
        name: noReplyWriterNameForKey(key),
        key,
        target: match.plan.target,
        fixedDefinition: match.fixedDefinition,
        inputObjectKeys,
        inputObjectFields,
      };
      writers.push(writer);
      writersByKey.set(key, writer);
      return writer;
    },
  };
}

export function createNoReplyCallLoweringPlugin({ root, state }) {
  const sourceRoot = `${path.resolve(root)}${path.sep}`;
  return {
    name: 'bitfield-package-entry-no-reply-lowering',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        const absolutePath = path.resolve(args.path);
        if (!absolutePath.startsWith(sourceRoot)) return null;
        if (absolutePath.includes(`${path.sep}node_modules${path.sep}`)) return null;
        if (absolutePath.includes(`${path.sep}generated${path.sep}`)) return null;
        if (!supportedSourceExtensions.has(path.extname(absolutePath))) return null;
        const source = await readFile(absolutePath, 'utf8');
        const lowered = lowerNoReplyTargetCalls(source, state);
        if (lowered === source) return null;
        return {
          contents: lowered,
          loader: loaderForPath(absolutePath),
        };
      });
    },
  };
}

export function lowerNoReplyTargetCalls(source, state) {
  if (state.plans.length === 0 || !source.includes(publicSenderName)) {
    return source;
  }
  const stringConstants = topLevelStringConstants(source);
  const payloadBuilders = topLevelNoReplyPayloadBuilders(source, state.plans, stringConstants);
  const requestBuilders = topLevelNoReplyRequestBuilders(source, state.plans, stringConstants, payloadBuilders);
  const replacements = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const nameIndex = source.indexOf(publicSenderName, searchFrom);
    if (nameIndex < 0) break;
    searchFrom = nameIndex + publicSenderName.length;
    if (!isIdentifierBoundary(source, nameIndex - 1) ||
      !isIdentifierBoundary(source, nameIndex + publicSenderName.length)) {
      continue;
    }
    const openParen = skipWhitespace(source, nameIndex + publicSenderName.length);
    if (source[openParen] !== '(') continue;
    const call = readBalanced(source, openParen, '(', ')');
    if (!call) continue;
    const args = splitTopLevel(call.body);
    if (args.length < 1 || args.length > 2) continue;
    const constObjects = sameScopeConstObjectBindings(source, nameIndex);
    const match =
      matchNoReplyCall(args[0].text, state.plans, stringConstants, payloadBuilders, constObjects) ??
      matchNoReplyRequestBuilderCall(args[0].text, requestBuilders);
    if (!match) continue;
    const inputPlan = noReplyInputArgumentPlan(match.inputObjectFields, match.inputExpression);
    const writer = state.writerFor({
      ...match,
      inputObjectFields: inputPlan.inputObjectFields,
    });
    const inputArgs = inputPlan.args;
    const loweredArgs = match.fixedDefinition === null
      ? [match.definitionExpression, ...inputArgs]
      : inputArgs;
    if (args[1]?.text.trim()) loweredArgs.push(args[1].text.trim());
    replacements.push({
      start: nameIndex,
      end: call.end + 1,
      text: `${writer.name}(${loweredArgs.join(', ')})`,
    });
    searchFrom = call.end + 1;
  }
  if (replacements.length === 0) return source;
  let output = '';
  let cursor = 0;
  for (const replacement of replacements) {
    output += source.slice(cursor, replacement.start);
    output += replacement.text;
    cursor = replacement.end;
  }
  output += source.slice(cursor);
  return output;
}

function noReplyInputArgumentPlan(inputObjectFields, inputExpression) {
  if (!inputObjectFields) {
    return {
      inputObjectFields: null,
      args: [inputExpression],
    };
  }
  const sourceOwnerSlotsByExpression = new Map();
  const sourceOwnerExpressions = [];
  const plannedFields = inputObjectFields.map((field) => {
    if (field.fixed || !field.sourceChild) return field;
    let sourceOwnerSlot = sourceOwnerSlotsByExpression.get(field.sourceChild.parentExpression);
    if (sourceOwnerSlot === undefined) {
      sourceOwnerSlot = sourceOwnerExpressions.length;
      sourceOwnerSlotsByExpression.set(field.sourceChild.parentExpression, sourceOwnerSlot);
      sourceOwnerExpressions.push(field.sourceChild.parentExpression);
    }
    return {
      ...field,
      sourceOwnerSlot,
    };
  });
  const emittedSourceOwnerSlots = new Set();
  const args = [];
  for (const field of plannedFields) {
    if (field.fixed) continue;
    if (field.sourceChild) {
      if (!emittedSourceOwnerSlots.has(field.sourceOwnerSlot)) {
        emittedSourceOwnerSlots.add(field.sourceOwnerSlot);
        args.push(sourceOwnerExpressions[field.sourceOwnerSlot]);
      }
      continue;
    }
    args.push(field.expression);
  }
  return {
    inputObjectFields: plannedFields,
    args,
  };
}

/**
 * The runtime functions the generated writers call by name.
 *
 * The writers are prepended to the bundle as text, so they can only reach what
 * the bundle itself defines. When EVERY send in an entry is rewritten, nothing
 * else in the entry uses the runtime kit, the bundler drops it as unused, and the
 * writers call names that do not exist. That shipped once and failed on the
 * first call with "getConnectionManager is not defined".
 */
export const NO_REPLY_RUNTIME_NAMES = Object.freeze([
  'getConnectionManager',
  'bindNoReplyBytesToBitfieldTarget',
  'bindNoReplyByteRangesToBitfieldTarget',
]);

/** Runtime names the writers for this entry call that `bundleSource` never defines. */
export function noReplyRuntimeNamesMissingFrom(writers, bundleSource) {
  if (writers.length === 0) return [];
  const prefix = generatedNoReplyWriterPrefix(writers);
  return NO_REPLY_RUNTIME_NAMES.filter((name) =>
    new RegExp(`\\b${name}\\b`).test(prefix)
    && !new RegExp(`\\b(?:function\\*?|var|let|const|class)\\s+${name}\\b`).test(bundleSource)
    && !new RegExp(`\\b(?:var|let|const)\\s+(?:[A-Za-z_$][\\w$]*\\s*,\\s*)+${name}\\s*(?:,|;|=)`).test(bundleSource));
}

export function generatedNoReplyWriterPrefix(writers) {
  if (writers.length === 0) return '';
  const orderedWriters = stableWriterOrder(writers);
  return `${commonWriterPrefix(orderedWriters)}${orderedWriters.map(writerPrefix).join('')}`;
}

function noReplyWriterNameForKey(key) {
  return `${writerNamePrefix}${Buffer.from(blake3(new Uint8Array(Buffer.from(key)))).toString('hex')}`;
}

function stableWriterOrder(writers) {
  return [...writers].sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function commonWriterPrefix(writers) {
  if (writers.every(writerUsesOnlyStaticBytes)) {
    return `var bitfieldGeneratedNoReplyPayload = new Uint8Array();
var bitfieldGeneratedNoReplyResult = Promise.resolve({ payload: bitfieldGeneratedNoReplyPayload });
`;
  }
  const dynamicDefinitionTextRange = writers.some((writer) => writer.fixedDefinition === null)
    ? `function bitfieldGeneratedNoReplyTextRange(value, scratch) {
  return bitfieldGeneratedNoReplyTextScratchRange(value === undefined ? "" : String(value), scratch);
}
`
    : '';
  return `var bitfieldGeneratedNoReplyPayload = new Uint8Array();
var bitfieldGeneratedNoReplyResult = Promise.resolve({ payload: bitfieldGeneratedNoReplyPayload });
var bitfieldGeneratedNoReplyUnset = {};
var bitfieldGeneratedNoReplyTextEncoder = new TextEncoder();
var bitfieldGeneratedNoReplyFalseBytes = new Uint8Array([0]);
var bitfieldGeneratedNoReplyTrueBytes = new Uint8Array([1]);
function bitfieldGeneratedNoReplyWriteUint16(output, offset, value) {
  output[offset] = value & 255;
  output[offset + 1] = (value >>> 8) & 255;
}
${dynamicDefinitionTextRange}function bitfieldGeneratedNoReplyUtf8ScratchRange(text, scratch, minimumByteLength) {
  var bytes = scratch.bytes;
  if (bytes.byteLength < minimumByteLength) {
    bytes = new Uint8Array(minimumByteLength);
    scratch.bytes = bytes;
  }
  var encoded = bitfieldGeneratedNoReplyTextEncoder.encodeInto(text, bytes);
  while (encoded.read < text.length) {
    bytes = new Uint8Array(Math.max(bytes.byteLength * 2, text.length * 3, 1));
    scratch.bytes = bytes;
    encoded = bitfieldGeneratedNoReplyTextEncoder.encodeInto(text, bytes);
  }
  scratch.byteOffset = 0;
  scratch.byteLength = encoded.written;
  return scratch;
}
function bitfieldGeneratedNoReplyTextScratchRange(text, scratch) {
  var byteLength = text.length;
  var bytes = scratch.bytes;
  if (bytes.byteLength < byteLength) {
    bytes = new Uint8Array(byteLength);
    scratch.bytes = bytes;
  }
  for (var index = 0; index < byteLength; index += 1) {
    var code = text.charCodeAt(index);
    if (code > 127) {
      return bitfieldGeneratedNoReplyUtf8ScratchRange(text, scratch, byteLength);
    }
    bytes[index] = code;
  }
  scratch.byteOffset = 0;
  scratch.byteLength = byteLength;
  return scratch;
}
function bitfieldGeneratedNoReplyWritePathValuePrefix(prefix, offset, fieldType, valueBytes) {
  var byteLength = valueBytes.byteLength;
  prefix[offset] = fieldType;
  prefix[offset + 3] = byteLength & 255;
  prefix[offset + 4] = (byteLength >>> 8) & 255;
  prefix[offset + 5] = (byteLength >>> 16) & 255;
  prefix[offset + 6] = (byteLength >>> 24) & 255;
}
var bitfieldGeneratedNoReplyValueSourceByteChildren = Symbol.for("bitfield.value.source_byte_children");
var bitfieldGeneratedNoReplyValueSourceByteCacheKey = Symbol.for("bitfield.value.source_byte_cache_key");
var bitfieldGeneratedNoReplyValueSourceByteCacheKeyTrusted = Symbol.for("bitfield.value.source_byte_cache_key_trusted");
var bitfieldGeneratedNoReplyValueSourceByteStable = Symbol.for("bitfield.value.source_byte_stable");
var bitfieldGeneratedNoReplyValueSourceBytes = Symbol.for("bitfield.value.source_bytes");
function bitfieldGeneratedNoReplyIsByteArray(value) {
  return value !== null &&
    typeof value === "object" &&
    typeof value.byteLength === "number" &&
    typeof value.subarray === "function";
}
function bitfieldGeneratedNoReplySnapshotSegment(segment) {
  if (
    segment !== null &&
    typeof segment === "object" &&
    segment[bitfieldGeneratedNoReplyValueSourceByteStable] === true
  ) return segment;
  if (bitfieldGeneratedNoReplyIsByteArray(segment)) return segment.slice();
  if (
    segment !== null &&
    typeof segment === "object" &&
    bitfieldGeneratedNoReplyIsByteArray(segment.bytes) &&
    typeof segment.byteOffset === "number" &&
    typeof segment.byteLength === "number"
  ) {
    return segment.bytes.slice(segment.byteOffset, segment.byteOffset + segment.byteLength);
  }
  return bitfieldGeneratedNoReplyPayload;
}
function bitfieldGeneratedNoReplySnapshotSegments(segments) {
  var snapshot = new Array(segments.length);
  for (var index = 0; index < segments.length; index += 1) {
    snapshot[index] = bitfieldGeneratedNoReplySnapshotSegment(segments[index]);
  }
  return snapshot;
}
function bitfieldGeneratedNoReplySourceByteSegment(value) {
  if (bitfieldGeneratedNoReplyIsByteArray(value)) return value;
  if (value === null || typeof value !== "object") return undefined;
  if (
    value.bytes !== undefined &&
    typeof value.byteOffset === "number" &&
    typeof value.byteLength === "number"
  ) {
    return value;
  }
  if (typeof value.byteLength === "number" && typeof value.subarray === "function") {
    return {
      bytes: value,
      byteOffset: value.byteOffset || 0,
      byteLength: value.byteLength,
    };
  }
  return undefined;
}
function bitfieldGeneratedNoReplyReadValueSourceBytes(value) {
  if (value === null || typeof value !== "object") return undefined;
  var sourceBytes = value[bitfieldGeneratedNoReplyValueSourceBytes];
  return bitfieldGeneratedNoReplySourceByteSegment(sourceBytes);
}
function bitfieldGeneratedNoReplyReadSourceByteChild(value, key) {
  return bitfieldGeneratedNoReplyPrepareSourceByteChild(
    bitfieldGeneratedNoReplySourceByteChildReader(value),
    key
  );
}
function bitfieldGeneratedNoReplySourceByteChildReader(value) {
  if (value === null || typeof value !== "object") return undefined;
  var readChild = value[bitfieldGeneratedNoReplyValueSourceByteChildren];
  return typeof readChild === "function" ? readChild : undefined;
}
function bitfieldGeneratedNoReplySourceByteCacheKey(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  var cacheKey = value[bitfieldGeneratedNoReplyValueSourceByteCacheKey];
  return cacheKey !== null &&
    typeof cacheKey === "object" &&
    (
      cacheKey[bitfieldGeneratedNoReplyValueSourceByteCacheKeyTrusted] === true ||
      (
        Number.isSafeInteger(cacheKey.revision) &&
        Number.isSafeInteger(cacheKey.rowIndex)
      )
    )
    ? cacheKey
    : undefined;
}
function bitfieldGeneratedNoReplyPrepareSourceByteChild(readChild, sourceKey) {
  if (readChild === undefined) return undefined;
  return bitfieldGeneratedNoReplySourceByteSegment(readChild(sourceKey));
}
function bitfieldGeneratedNoReplyPreparePathValueFromSourceChildReader(readChild, sourceKey, prefix, offset) {
  if (readChild === undefined) return undefined;
  var sourceBytes = readChild(sourceKey);
  if (sourceBytes === undefined) return undefined;
  var fieldType = sourceBytes.fieldType;
  if (
    fieldType === (fieldType | 0) &&
    fieldType >= 0 &&
    fieldType <= 255 &&
    sourceBytes !== null &&
    typeof sourceBytes === "object" &&
    sourceBytes.bytes !== undefined &&
    typeof sourceBytes.byteOffset === "number" &&
    typeof sourceBytes.byteLength === "number"
  ) {
    bitfieldGeneratedNoReplyWritePathValuePrefix(prefix, offset, fieldType, sourceBytes);
    return sourceBytes;
  }
  sourceBytes = bitfieldGeneratedNoReplySourceByteSegment(sourceBytes);
  if (sourceBytes === undefined) return undefined;
  fieldType = sourceBytes.fieldType;
  if (fieldType !== (fieldType | 0) || fieldType < 0 || fieldType > 255) return undefined;
  bitfieldGeneratedNoReplyWritePathValuePrefix(prefix, offset, fieldType, sourceBytes);
  return sourceBytes;
}
function bitfieldGeneratedNoReplyPreparePathValueFromSourceChild(sourceParent, sourceKey, prefix, offset) {
  return bitfieldGeneratedNoReplyPreparePathValueFromSourceChildReader(
    bitfieldGeneratedNoReplySourceByteChildReader(sourceParent),
    sourceKey,
    prefix,
    offset
  );
}
function bitfieldGeneratedNoReplyPrepareJsonPathValue(value, prefix, offset, textBytes) {
  var jsonText = JSON.stringify(value) ?? "";
  var jsonBytes = bitfieldGeneratedNoReplyTextScratchRange(jsonText, textBytes);
  bitfieldGeneratedNoReplyWritePathValuePrefix(prefix, offset, 3, jsonBytes);
  return jsonBytes;
}
function bitfieldGeneratedNoReplyPreparePathValue(value, prefix, offset, numberView, numberBytes, textBytes) {
  var valueType = typeof value;
  if (valueType === "object" && value !== null) {
    var sourceBytes = bitfieldGeneratedNoReplyReadValueSourceBytes(value);
    if (sourceBytes !== undefined) {
      bitfieldGeneratedNoReplyWritePathValuePrefix(prefix, offset, 3, sourceBytes);
      return sourceBytes;
    }
  }
  if (valueType === "string") {
    var stringBytes = bitfieldGeneratedNoReplyTextScratchRange(value, textBytes);
    bitfieldGeneratedNoReplyWritePathValuePrefix(prefix, offset, 2, stringBytes);
    return stringBytes;
  }
  if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
    return false;
  }
  if (value === null) {
    bitfieldGeneratedNoReplyWritePathValuePrefix(prefix, offset, 5, bitfieldGeneratedNoReplyPayload);
    return bitfieldGeneratedNoReplyPayload;
  }
  if (valueType === "boolean") {
    var booleanBytes = value ? bitfieldGeneratedNoReplyTrueBytes : bitfieldGeneratedNoReplyFalseBytes;
    bitfieldGeneratedNoReplyWritePathValuePrefix(prefix, offset, 4, booleanBytes);
    return booleanBytes;
  }
  if (valueType === "number" && Number.isFinite(value)) {
    numberView.setFloat64(0, value, true);
    bitfieldGeneratedNoReplyWritePathValuePrefix(prefix, offset, 6, numberBytes);
    return numberBytes;
  }
  return bitfieldGeneratedNoReplyPrepareJsonPathValue(value, prefix, offset, textBytes);
}
`;
}

function writerPrefix(writer) {
  if (writer.inputObjectKeys) return inputObjectWriterPrefix(writer);
  return inputValueWriterPrefix(writer);
}

function writerUsesOnlyStaticBytes(writer) {
  return writer.fixedDefinition !== null &&
    Array.isArray(writer.inputObjectKeys) &&
    normalizedInputObjectFields(writer).every((field) => field.fixed);
}

function inputValueWriterPrefix(writer) {
  const name = writer.name;
  const target = JSON.stringify(writer.target);
  const dynamicDefinition = writer.fixedDefinition === null;
  const definitionBytes = dynamicDefinition ? null : bitfieldGeneratedNoReplyUtf8Bytes(writer.fixedDefinition);
  const definitionPrefix = dynamicDefinition
    ? null
    : pathValuePrefixBytes(['definition_id'], 2, definitionBytes.length);
  const inputPrefix = pathValuePrefixBytes(['input'], 3, 0);
  const staticPrefix = dynamicDefinition
    ? null
    : [66, 70, 78, 49, 2, 0, ...definitionPrefix, ...definitionBytes, ...inputPrefix];
  const inputPrefixOffset = staticPrefix ? staticPrefix.length - inputPrefix.length : 0;
  const valueNames = dynamicDefinition ? ['value0', 'value1'] : ['value0'];
  const signature = [...valueNames, 'signal'].join(', ');
  const inputValueName = dynamicDefinition ? 'value1' : 'value0';
  const compareLast = valueNames.map((valueName) => `${valueName} === ${name}Last${capitalized(valueName)}`).join(' && ');
  const primitiveGuard = valueNames
    .map((valueName) => `typeof ${valueName} !== "object" && typeof ${valueName} !== "function"`)
    .join(' && ');
  const lastDeclarations = valueNames
    .map((valueName) => `var ${name}Last${capitalized(valueName)} = bitfieldGeneratedNoReplyUnset;`)
    .join('\n');
  const rememberLastValues = valueNames
    .map((valueName) => `    ${name}Last${capitalized(valueName)} = ${valueName};`)
    .join('\n');
  const dynamicDeclarations = dynamicDefinition
    ? `var ${name}DefinitionPrefix = new Uint8Array([${pathValuePrefixBytesLiteral(['definition_id'])}]);
var ${name}DefinitionTextBytes = { bytes: bitfieldGeneratedNoReplyPayload, byteOffset: 0, byteLength: 0 };
var ${name}DefinitionLastValue = bitfieldGeneratedNoReplyUnset;
var ${name}DefinitionLastBytes = bitfieldGeneratedNoReplyPayload;
var ${name}Header = new Uint8Array([66, 70, 78, 49, 2, 0]);
var ${name}Segments = [${name}Header, ${name}DefinitionPrefix, bitfieldGeneratedNoReplyPayload, ${name}InputPrefix, bitfieldGeneratedNoReplyPayload];`
    : `var ${name}StaticPrefix = new Uint8Array([${staticPrefix.join(', ')}]);
var ${name}Segments = [${name}StaticPrefix, bitfieldGeneratedNoReplyPayload];`;
  const inputPrefixDeclaration = dynamicDefinition
    ? `var ${name}InputPrefix = new Uint8Array([${pathValuePrefixBytesLiteral(['input'])}]);`
    : '';
  const definitionWrite = dynamicDefinition
    ? `  var definitionCacheable = value0 === null || (typeof value0 !== "object" && typeof value0 !== "function");
  var definitionBytes;
  if (definitionCacheable && value0 === ${name}DefinitionLastValue) {
    definitionBytes = ${name}DefinitionLastBytes;
  } else {
    definitionBytes = bitfieldGeneratedNoReplyTextRange(value0, ${name}DefinitionTextBytes);
    bitfieldGeneratedNoReplyWritePathValuePrefix(${name}DefinitionPrefix, 0, 2, definitionBytes);
    if (definitionCacheable) {
      ${name}DefinitionLastValue = value0;
      ${name}DefinitionLastBytes = definitionBytes;
    } else {
      ${name}DefinitionLastValue = bitfieldGeneratedNoReplyUnset;
      ${name}DefinitionLastBytes = bitfieldGeneratedNoReplyPayload;
    }
  }
  ${name}Segments[2] = definitionBytes;
`
    : '';
  const inputPrefixTarget = dynamicDefinition ? `${name}InputPrefix` : `${name}StaticPrefix`;
  const inputPrefixOffsetLiteral = dynamicDefinition ? 0 : inputPrefixOffset;
  const inputSegmentIndex = dynamicDefinition ? 4 : 1;
  return `${inputPrefixDeclaration}
${dynamicDeclarations}
var ${name}InputTextBytes = { bytes: bitfieldGeneratedNoReplyPayload, byteOffset: 0, byteLength: 0 };
var ${name}InputNumberBytes = new Uint8Array(8);
var ${name}InputNumberView = new DataView(${name}InputNumberBytes.buffer);
${lastDeclarations}
var ${name}LastSegments;
${writerSegmentsSenderPrefix(name, target)}
function ${name}(${signature}) {
  if (${name}LastSegments && ${compareLast}) {
    ${name}SendSegments(${name}LastSegments, signal);
    return bitfieldGeneratedNoReplyResult;
  }
${definitionWrite}  var inputBytes = bitfieldGeneratedNoReplyPreparePathValue(${inputValueName}, ${inputPrefixTarget}, ${inputPrefixOffsetLiteral}, ${name}InputNumberView, ${name}InputNumberBytes, ${name}InputTextBytes);
  if (inputBytes === false) {
    bitfieldGeneratedNoReplyWritePathValuePrefix(${inputPrefixTarget}, ${inputPrefixOffsetLiteral}, 3, bitfieldGeneratedNoReplyPayload);
    inputBytes = bitfieldGeneratedNoReplyPayload;
  }
  ${name}Segments[${inputSegmentIndex}] = inputBytes;
  if (${primitiveGuard}) {
${rememberLastValues}
    ${name}LastSegments = ${name}Segments;
  } else {
    ${name}LastSegments = undefined;
  }
  ${name}SendSegments(${name}Segments, signal);
  return bitfieldGeneratedNoReplyResult;
}
`;
}

function inputObjectWriterPrefix(writer) {
  const name = writer.name;
  const target = JSON.stringify(writer.target);
  const inputFields = normalizedInputObjectFields(writer);
  const dynamicInputFields = inputFields.filter((field) => !field.fixed);
  const dynamicDefinition = writer.fixedDefinition === null;
  if (!dynamicDefinition && dynamicInputFields.length === 0) {
    return fixedStaticInputObjectWriterPrefix(writer, inputFields);
  }
  if (!dynamicDefinition && dynamicInputFields.length === 1) {
    return singleDynamicInputObjectWriterPrefix(writer, inputFields);
  }
  const valueNames = [];
  const cacheValueNames = [];
  const cacheGuardExpressions = [];
  const sourceOwnerPrimitiveCacheValueNames = [];
  let nextValueNameIndex = 0;
  if (dynamicDefinition) {
    const definitionValueName = `value${nextValueNameIndex++}`;
    valueNames.push(definitionValueName);
    cacheValueNames.push(definitionValueName);
    sourceOwnerPrimitiveCacheValueNames.push(definitionValueName);
    cacheGuardExpressions.push(
      `typeof ${definitionValueName} !== "object" && typeof ${definitionValueName} !== "function"`,
    );
  }
  const inputValueNamesByFieldIndex = new Map();
  const sourceParentNamesByFieldIndex = new Map();
  const sourceOwnerValueNamesBySlot = new Map();
  const sourceChildReaderNamesByParentName = new Map();
  inputFields.forEach((field, index) => {
    if (field.fixed) return;
    if (field.sourceChild) {
      let sourceParentName = sourceOwnerValueNamesBySlot.get(field.sourceOwnerSlot);
      if (!sourceParentName) {
        sourceParentName = `value${nextValueNameIndex++}`;
        valueNames.push(sourceParentName);
        sourceOwnerValueNamesBySlot.set(field.sourceOwnerSlot, sourceParentName);
        sourceChildReaderNamesByParentName.set(
          sourceParentName,
          `${name}SourceChildReader${field.sourceOwnerSlot}`,
        );
      }
      const sourceChildCacheValueName = `${name}SourceChildCacheValue${index}`;
      cacheValueNames.push(sourceChildCacheValueName);
      cacheGuardExpressions.push(`${sourceChildCacheValueName} !== bitfieldGeneratedNoReplyUnset`);
      inputValueNamesByFieldIndex.set(index, sourceChildCacheValueName);
      sourceParentNamesByFieldIndex.set(index, sourceParentName);
    } else {
      const valueName = `value${nextValueNameIndex++}`;
      valueNames.push(valueName);
      cacheValueNames.push(valueName);
      sourceOwnerPrimitiveCacheValueNames.push(valueName);
      cacheGuardExpressions.push(
        `typeof ${valueName} !== "object" && typeof ${valueName} !== "function"`,
      );
      inputValueNamesByFieldIndex.set(index, valueName);
    }
  });
  const signature = [...valueNames, 'signal'].join(', ');
  const fullFieldCount = 1 + inputFields.length;
  const fixedDefinitionBytes = dynamicDefinition ? null : bitfieldGeneratedNoReplyUtf8Bytes(writer.fixedDefinition);
  const fixedDefinitionPrefix = dynamicDefinition
    ? null
    : pathValuePrefixBytes(['definition_id'], 2, fixedDefinitionBytes.length);
  const fullStart = dynamicDefinition
    ? null
    : [66, 70, 78, 49, fullFieldCount & 255, (fullFieldCount >>> 8) & 255, ...fixedDefinitionPrefix, ...fixedDefinitionBytes];
  const compactStart = dynamicDefinition
    ? null
    : [66, 70, 78, 49, 0, 0, ...fixedDefinitionPrefix, ...fixedDefinitionBytes];
  const fullSegments = dynamicDefinition
    ? [`${name}Header`, `${name}DefinitionPrefix`, 'bitfieldGeneratedNoReplyPayload']
    : [`${name}StaticStart`];
  const valueSegmentIndexes = new Map();
  inputFields.forEach((field, index) => {
    if (field.fixed) {
      fullSegments.push(`${name}StaticInputCell${index}`);
    } else {
      fullSegments.push(`${name}InputPrefix${index}`);
      valueSegmentIndexes.set(index, fullSegments.length);
      fullSegments.push('bitfieldGeneratedNoReplyPayload');
    }
  });
  const compareLast = cacheValueNames.map((valueName) => `${valueName} === ${name}Last${capitalized(valueName)}`).join(' && ') || 'true';
  const primitiveGuard = cacheGuardExpressions.join(' && ') || 'true';
  const lastDeclarations = cacheValueNames
    .map((valueName) => `var ${name}Last${capitalized(valueName)} = bitfieldGeneratedNoReplyUnset;`)
    .join('\n');
  const rememberLastValues = cacheValueNames
    .map((valueName) => `    ${name}Last${capitalized(valueName)} = ${valueName};`)
    .join('\n');
  const dynamicDefinitionPrefix = dynamicDefinition
    ? `var ${name}DefinitionPrefix = new Uint8Array([${pathValuePrefixBytesLiteral(['definition_id'])}]);
var ${name}DefinitionTextBytes = { bytes: bitfieldGeneratedNoReplyPayload, byteOffset: 0, byteLength: 0 };
var ${name}DefinitionLastValue = bitfieldGeneratedNoReplyUnset;
var ${name}DefinitionLastBytes = bitfieldGeneratedNoReplyPayload;
var ${name}Header = new Uint8Array([66, 70, 78, 49, ${fullFieldCount & 255}, ${(fullFieldCount >>> 8) & 255}]);
var ${name}CompactHeader = new Uint8Array([66, 70, 78, 49, 0, 0]);`
    : `var ${name}StaticStart = new Uint8Array([${fullStart.join(', ')}]);
var ${name}CompactStart = new Uint8Array([${compactStart.join(', ')}]);`;
  const inputDeclarations = inputFields.map((field, index) => field.fixed
    ? `var ${name}StaticInputCell${index} = new Uint8Array([${literalPathValueCellBytes(['input', field.key], field.value).join(', ')}]);`
    : `var ${name}InputPrefix${index} = new Uint8Array([${pathValuePrefixBytesLiteral(['input', field.key])}]);
var ${name}TextBytes${index} = { bytes: bitfieldGeneratedNoReplyPayload, byteOffset: 0, byteLength: 0 };
var ${name}NumberBytes${index} = new Uint8Array(8);
var ${name}NumberView${index} = new DataView(${name}NumberBytes${index}.buffer);`).join('\n');
  const definitionWrite = dynamicDefinition
    ? `  var definitionCacheable = value0 === null || (typeof value0 !== "object" && typeof value0 !== "function");
  var definitionBytes;
  if (definitionCacheable && value0 === ${name}DefinitionLastValue) {
    definitionBytes = ${name}DefinitionLastBytes;
  } else {
    definitionBytes = bitfieldGeneratedNoReplyTextRange(value0, ${name}DefinitionTextBytes);
    bitfieldGeneratedNoReplyWritePathValuePrefix(${name}DefinitionPrefix, 0, 2, definitionBytes);
    if (definitionCacheable) {
      ${name}DefinitionLastValue = value0;
      ${name}DefinitionLastBytes = definitionBytes;
    } else {
      ${name}DefinitionLastValue = bitfieldGeneratedNoReplyUnset;
      ${name}DefinitionLastBytes = bitfieldGeneratedNoReplyPayload;
    }
  }
  ${name}Segments[2] = definitionBytes;
`
    : '';
  const sourceChildReaderDeclarations = [...sourceChildReaderNamesByParentName]
    .map(([sourceParentName, sourceChildReaderName]) =>
      `  if (${sourceChildReaderName} === undefined) {
    ${sourceChildReaderName} = bitfieldGeneratedNoReplySourceByteChildReader(${sourceParentName});
  }`)
    .join('\n');
  const sourceOwnerNames = [...sourceChildReaderNamesByParentName.keys()];
  const sourceOwnerCacheKeyNames = sourceOwnerNames.map((_, index) =>
    `${name}SourceOwnerCacheKey${index}`);
  const sourceOwnerCacheKeyDeclarations = [...sourceChildReaderNamesByParentName]
    .map(([sourceParentName, sourceChildReaderName], index) =>
      `  var ${sourceChildReaderName};
  var ${sourceOwnerCacheKeyNames[index]} = bitfieldGeneratedNoReplySourceByteCacheKey(${sourceParentName});
  if (${sourceOwnerCacheKeyNames[index]} === undefined) {
    ${sourceChildReaderName} = bitfieldGeneratedNoReplySourceByteChildReader(${sourceParentName});
    ${sourceOwnerCacheKeyNames[index]} = bitfieldGeneratedNoReplySourceByteCacheKey(${sourceChildReaderName});
  }`)
    .join('\n');
  const sourceOwnerCacheArgs = [
    ...sourceOwnerCacheKeyNames,
    ...sourceOwnerPrimitiveCacheValueNames,
  ];
  const sourceOwnerCacheKeyGuard = sourceOwnerCacheKeyNames
    .map((keyName) => `${keyName} !== undefined`);
  const sourceOwnerPrimitiveGuard = sourceOwnerPrimitiveCacheValueNames
    .map((valueName) => `typeof ${valueName} !== "object" && typeof ${valueName} !== "function"`)
    .join(' && ');
  const sourceOwnerCacheReadGuard = [
    ...sourceOwnerCacheKeyGuard,
    sourceOwnerPrimitiveGuard,
  ].filter(Boolean).join(' && ') || 'false';
  const sourceOwnerCacheRememberGuard = [
    ...sourceOwnerCacheKeyGuard,
    primitiveGuard,
  ].filter(Boolean).join(' && ') || 'false';
  const sourceOwnerCacheRead = sourceOwnerCacheKeyNames.length === 0
    ? ''
    : `${sourceOwnerCacheKeyDeclarations}
  if (${sourceOwnerCacheReadGuard}) {
    var ${name}CachedSourceOwnerSegments = ${name}ReadSourceOwnerFrameCache(${sourceOwnerCacheArgs.join(', ')});
    if (${name}CachedSourceOwnerSegments !== undefined) {
      ${name}SendSegments(${name}CachedSourceOwnerSegments, signal);
      return bitfieldGeneratedNoReplyResult;
    }
  }`;
  const sourceOwnerCacheRemember = sourceOwnerCacheKeyNames.length === 0
    ? ''
    : `  if (${sourceOwnerCacheRememberGuard}) {
    ${name}RememberSourceOwnerFrameCache(${[...sourceOwnerCacheArgs, 'activeSegments'].join(', ')});
  }
`;
  const sourceChildInputPreparations = inputFields.map((field, index) => {
    const sourceParentName = sourceParentNamesByFieldIndex.get(index);
    if (!sourceParentName) return '';
    const sourceChildReaderName = sourceChildReaderNamesByParentName.get(sourceParentName);
    const inputBytesName = `${name}InputBytes${index}`;
    const cacheValueName = inputValueNamesByFieldIndex.get(index);
    const sourceChildValueName = `${name}SourceChildValue${index}`;
    const fallbackValue = sourceChildValueExpression(sourceParentName, field.sourceChild.key);
    return `  var ${inputBytesName} = bitfieldGeneratedNoReplyPreparePathValueFromSourceChildReader(${sourceChildReaderName}, ${JSON.stringify(field.sourceChild.key)}, ${name}InputPrefix${index}, 0);
  var ${cacheValueName} = ${inputBytesName};
  if (${inputBytesName} === undefined) {
    var ${sourceChildValueName} = ${fallbackValue};
    ${cacheValueName} = typeof ${sourceChildValueName} !== "object" && typeof ${sourceChildValueName} !== "function" ? ${sourceChildValueName} : bitfieldGeneratedNoReplyUnset;
    ${inputBytesName} = bitfieldGeneratedNoReplyPreparePathValue(${sourceChildValueName}, ${name}InputPrefix${index}, 0, ${name}NumberView${index}, ${name}NumberBytes${index}, ${name}TextBytes${index});
  }`;
  }).filter(Boolean).join('\n');
  const inputWrites = inputFields.map((field, index) => {
    if (field.fixed) return '';
    const inputValueName = inputValueNamesByFieldIndex.get(index);
    const sourceParentName = sourceParentNamesByFieldIndex.get(index);
    if (sourceParentName) {
      return `  ${name}Segments[${valueSegmentIndexes.get(index)}] = ${name}InputBytes${index};`;
    }
    const prepareInput = `bitfieldGeneratedNoReplyPreparePathValue(${inputValueName}, ${name}InputPrefix${index}, 0, ${name}NumberView${index}, ${name}NumberBytes${index}, ${name}TextBytes${index})`;
    return `  var ${name}InputBytes${index} = ${prepareInput};
  ${name}Segments[${valueSegmentIndexes.get(index)}] = ${name}InputBytes${index};`;
  }).join('\n');
  const fullFrameExpression = inputFields
    .map((field, index) => field.fixed ? '' : `${name}InputBytes${index} !== false`)
    .filter(Boolean)
    .join(' && ') || 'true';
  const staticInputCount = inputFields.filter((field) => field.fixed).length;
  const compactStartSegments = dynamicDefinition
    ? `    ${name}CompactSegments[segmentIndex++] = ${name}CompactHeader;
    ${name}CompactSegments[segmentIndex++] = ${name}DefinitionPrefix;
    ${name}CompactSegments[segmentIndex++] = definitionBytes;`
    : `    ${name}CompactSegments[segmentIndex++] = ${name}CompactStart;`;
  const compactStaticSegments = inputFields.map((field, index) => field.fixed
    ? `    ${name}CompactSegments[segmentIndex++] = ${name}StaticInputCell${index};`
    : '').filter(Boolean).join('\n');
  const compactDynamicSegments = inputFields.map((field, index) => field.fixed ? '' : `    if (${name}InputBytes${index} !== false) {
      fieldCount += 1;
      ${name}CompactSegments[segmentIndex++] = ${name}InputPrefix${index};
      ${name}CompactSegments[segmentIndex++] = ${name}InputBytes${index};
    }`).join('\n');
  const compactCountWrite = dynamicDefinition
    ? `    bitfieldGeneratedNoReplyWriteUint16(${name}CompactHeader, 4, fieldCount);`
    : `    bitfieldGeneratedNoReplyWriteUint16(${name}CompactStart, 4, fieldCount);`;
  return `${dynamicDefinitionPrefix}
${inputDeclarations}
var ${name}Segments = [${fullSegments.join(', ')}];
var ${name}CompactSegments = [];
${sourceOwnerFrameCacheDeclarations(name, sourceOwnerCacheKeyNames, sourceOwnerPrimitiveCacheValueNames)}${lastDeclarations ? `${lastDeclarations}\n` : ''}var ${name}LastSegments;
${writerSegmentsSenderPrefix(name, target)}
function ${name}(${signature}) {
${sourceOwnerCacheRead ? `${sourceOwnerCacheRead}\n` : ''}${sourceChildReaderDeclarations ? `${sourceChildReaderDeclarations}\n` : ''}${sourceChildInputPreparations ? `${sourceChildInputPreparations}\n` : ''}  if (${name}LastSegments && ${compareLast}) {
    ${name}SendSegments(${name}LastSegments, signal);
    return bitfieldGeneratedNoReplyResult;
  }
${definitionWrite}${inputWrites ? `${inputWrites}\n` : ''}  var activeSegments = ${name}Segments;
  if (!(${fullFrameExpression})) {
    var segmentIndex = 0;
    var fieldCount = ${1 + staticInputCount};
${compactStartSegments}
${compactStaticSegments ? `${compactStaticSegments}\n` : ''}${compactDynamicSegments ? `${compactDynamicSegments}\n` : ''}${compactCountWrite}
    ${name}CompactSegments.length = segmentIndex;
    activeSegments = ${name}CompactSegments;
  }
${sourceOwnerCacheRemember}  if (${primitiveGuard}) {
${rememberLastValues ? `${rememberLastValues}\n` : ''}    ${name}LastSegments = activeSegments;
  } else {
    ${name}LastSegments = undefined;
  }
  ${name}SendSegments(activeSegments, signal);
  return bitfieldGeneratedNoReplyResult;
}
`;
}

function singleDynamicInputObjectWriterPrefix(writer, inputFields) {
  const name = writer.name;
  const target = JSON.stringify(writer.target);
  const dynamicFieldIndex = inputFields.findIndex((field) => !field.fixed);
  const dynamicField = inputFields[dynamicFieldIndex];
  if (!dynamicField) {
    throw new TypeError('single dynamic generated writer requires one dynamic field');
  }
  const definitionBytes = bitfieldGeneratedNoReplyUtf8Bytes(writer.fixedDefinition);
  const definitionCell = [
    ...pathValuePrefixBytes(['definition_id'], 2, definitionBytes.length),
    ...definitionBytes,
  ];
  const dynamicPrefix = pathValuePrefixBytes(['input', dynamicField.key], 3, 0);
  const fixedCellsBeforeDynamic = inputFields
    .slice(0, dynamicFieldIndex)
    .filter((field) => field.fixed)
    .flatMap((field) => literalPathValueCellBytes(['input', field.key], field.value));
  const fixedCellsAfterDynamic = inputFields
    .slice(dynamicFieldIndex + 1)
    .filter((field) => field.fixed)
    .flatMap((field) => literalPathValueCellBytes(['input', field.key], field.value));
  const fixedCellsWithoutDynamic = inputFields
    .filter((field) => field.fixed)
    .flatMap((field) => literalPathValueCellBytes(['input', field.key], field.value));
  const fullFieldCount = 1 + inputFields.length;
  const omittedFieldCount = 1 + inputFields.filter((field) => field.fixed).length;
  const directPrefix = [
    66,
    70,
    78,
    49,
    fullFieldCount & 255,
    (fullFieldCount >>> 8) & 255,
    ...definitionCell,
    ...fixedCellsBeforeDynamic,
    ...dynamicPrefix,
  ];
  const omittedFrame = [
    66,
    70,
    78,
    49,
    omittedFieldCount & 255,
    (omittedFieldCount >>> 8) & 255,
    ...definitionCell,
    ...fixedCellsWithoutDynamic,
  ];
  const dynamicPrefixOffset = directPrefix.length - dynamicPrefix.length;
  const sourceParentName = dynamicField.sourceChild ? 'value0' : null;
  const inputValueName = sourceParentName ? `${name}SourceChildCacheValue0` : 'value0';
  const signature = 'value0, signal';
  const sourceOwnerCacheKeyName = `${name}SourceOwnerCacheKey0`;
  const sourceOwnerCacheRead = sourceParentName
    ? `  var ${name}SourceChildReader0;
  var ${sourceOwnerCacheKeyName} = bitfieldGeneratedNoReplySourceByteCacheKey(${sourceParentName});
  if (${sourceOwnerCacheKeyName} === undefined) {
    ${name}SourceChildReader0 = bitfieldGeneratedNoReplySourceByteChildReader(${sourceParentName});
    ${sourceOwnerCacheKeyName} = bitfieldGeneratedNoReplySourceByteCacheKey(${name}SourceChildReader0);
  }
  if (${sourceOwnerCacheKeyName} !== undefined) {
    var ${name}CachedSourceOwnerSegments = ${name}ReadSourceOwnerFrameCache(${sourceOwnerCacheKeyName});
    if (${name}CachedSourceOwnerSegments !== undefined) {
      ${name}SendSegments(${name}CachedSourceOwnerSegments, signal);
      return bitfieldGeneratedNoReplyResult;
    }
  }
`
    : '';
  const sourceOwnerCacheRemember = sourceParentName
    ? `  if (${sourceOwnerCacheKeyName} !== undefined && ${inputValueName} !== bitfieldGeneratedNoReplyUnset) {
    ${name}RememberSourceOwnerFrameCache(${sourceOwnerCacheKeyName}, activeSegments);
  }
`
    : '';
  const sourceChildReaderDeclaration = sourceParentName
    ? `  if (${name}SourceChildReader0 === undefined) {
    ${name}SourceChildReader0 = bitfieldGeneratedNoReplySourceByteChildReader(${sourceParentName});
  }
`
    : '';
  const sourceChildInputPreparation = sourceParentName
    ? `  var inputBytes = bitfieldGeneratedNoReplyPreparePathValueFromSourceChildReader(${name}SourceChildReader0, ${JSON.stringify(dynamicField.sourceChild.key)}, ${name}DirectPrefix, ${dynamicPrefixOffset});
  var ${inputValueName} = inputBytes;
  if (inputBytes === undefined) {
    var ${name}SourceChildValue0 = ${sourceChildValueExpression(sourceParentName, dynamicField.sourceChild.key)};
    ${inputValueName} = typeof ${name}SourceChildValue0 !== "object" && typeof ${name}SourceChildValue0 !== "function" ? ${name}SourceChildValue0 : bitfieldGeneratedNoReplyUnset;
    inputBytes = bitfieldGeneratedNoReplyPreparePathValue(${name}SourceChildValue0, ${name}DirectPrefix, ${dynamicPrefixOffset}, ${name}NumberView, ${name}NumberBytes, ${name}TextBytes);
  }
`
    : '';
  const prepareInput = sourceParentName
    ? ''
    : `  var inputBytes = bitfieldGeneratedNoReplyPreparePathValue(${inputValueName}, ${name}DirectPrefix, ${dynamicPrefixOffset}, ${name}NumberView, ${name}NumberBytes, ${name}TextBytes);
`;
  const cacheGuard = sourceParentName
    ? `${inputValueName} !== bitfieldGeneratedNoReplyUnset`
    : `typeof ${inputValueName} !== "object" && typeof ${inputValueName} !== "function"`;
  const suffixDeclaration = fixedCellsAfterDynamic.length > 0
    ? `var ${name}DirectSuffix = new Uint8Array([${fixedCellsAfterDynamic.join(', ')}]);
var ${name}DirectSegments = [${name}DirectPrefix, bitfieldGeneratedNoReplyPayload, ${name}DirectSuffix];`
    : `var ${name}DirectSegments = [${name}DirectPrefix, bitfieldGeneratedNoReplyPayload];`;
  return `var ${name}DirectPrefix = new Uint8Array([${directPrefix.join(', ')}]);
${suffixDeclaration}
var ${name}OmittedFrame = new Uint8Array([${omittedFrame.join(', ')}]);
var ${name}OmittedSegments = [${name}OmittedFrame];
var ${name}TextBytes = { bytes: bitfieldGeneratedNoReplyPayload, byteOffset: 0, byteLength: 0 };
var ${name}NumberBytes = new Uint8Array(8);
var ${name}NumberView = new DataView(${name}NumberBytes.buffer);
${sourceParentName ? sourceOwnerFrameCacheDeclarations(name, [sourceOwnerCacheKeyName], []) : ''}var ${name}LastValue0 = bitfieldGeneratedNoReplyUnset;
var ${name}LastSegments;
${writerSegmentsSenderPrefix(name, target)}
function ${name}(${signature}) {
${sourceOwnerCacheRead}${sourceChildReaderDeclaration}${sourceChildInputPreparation}  if (${name}LastSegments && ${inputValueName} === ${name}LastValue0) {
    ${name}SendSegments(${name}LastSegments, signal);
    return bitfieldGeneratedNoReplyResult;
  }
${prepareInput}  var activeSegments;
  if (inputBytes === false) {
    activeSegments = ${name}OmittedSegments;
  } else {
    ${name}DirectSegments[1] = inputBytes;
    activeSegments = ${name}DirectSegments;
  }
${sourceOwnerCacheRemember}  if (${cacheGuard}) {
    ${name}LastValue0 = ${inputValueName};
    ${name}LastSegments = activeSegments;
  } else {
    ${name}LastValue0 = bitfieldGeneratedNoReplyUnset;
    ${name}LastSegments = undefined;
  }
  ${name}SendSegments(activeSegments, signal);
  return bitfieldGeneratedNoReplyResult;
}
`;
}

function fixedStaticInputObjectWriterPrefix(writer, inputFields) {
  const name = writer.name;
  const target = JSON.stringify(writer.target);
  const definitionBytes = bitfieldGeneratedNoReplyUtf8Bytes(writer.fixedDefinition);
  const frameBytes = [
    66,
    70,
    78,
    49,
    (1 + inputFields.length) & 255,
    ((1 + inputFields.length) >>> 8) & 255,
    ...pathValuePrefixBytes(['definition_id'], 2, definitionBytes.length),
    ...definitionBytes,
    ...inputFields.flatMap((field) => literalPathValueCellBytes(['input', field.key], field.value)),
  ];
  return `var ${name}StaticBytes = new Uint8Array([${frameBytes.join(', ')}]);
${writerBytesSenderPrefix(name, target)}
function ${name}(signal) {
  ${name}SendBytes(${name}StaticBytes, signal);
  return bitfieldGeneratedNoReplyResult;
}
`;
}

function writerSegmentsSenderPrefix(name, target) {
  return `var ${name}SendSegmentsManager;
var ${name}ReleaseSendSegmentsReset;
function ${name}BindSegments(segments, signal) {
  var manager = getConnectionManager();
  if (${name}SendSegmentsManager !== manager) {
    if (${name}ReleaseSendSegmentsReset) {
      ${name}ReleaseSendSegmentsReset();
    }
    ${name}SendSegmentsManager = manager;
    ${name}ReleaseSendSegmentsReset = manager.onAnyChange(function() {
      ${name}SendSegments = ${name}BindSegments;
    });
  }
  ${name}SendSegments = bindNoReplyByteRangesToBitfieldTarget(${target});
  ${name}SendSegments(segments, signal);
}
var ${name}SendSegments = ${name}BindSegments;
`;
}

function writerBytesSenderPrefix(name, target) {
  return `var ${name}SendBytesManager;
var ${name}ReleaseSendBytesReset;
function ${name}BindBytes(bytes, signal) {
  var manager = getConnectionManager();
  if (${name}SendBytesManager !== manager) {
    if (${name}ReleaseSendBytesReset) {
      ${name}ReleaseSendBytesReset();
    }
    ${name}SendBytesManager = manager;
    ${name}ReleaseSendBytesReset = manager.onAnyChange(function() {
      ${name}SendBytes = ${name}BindBytes;
    });
  }
  ${name}SendBytes = bindNoReplyBytesToBitfieldTarget(${target});
  ${name}SendBytes(bytes, signal);
}
var ${name}SendBytes = ${name}BindBytes;
`;
}

function sourceOwnerFrameCacheDeclarations(name, sourceOwnerCacheKeyNames, primitiveCacheValueNames) {
  if (sourceOwnerCacheKeyNames.length === 0) return '';
  const cacheArgs = [...sourceOwnerCacheKeyNames, ...primitiveCacheValueNames];
  const readSignature = cacheArgs.join(', ');
  const rememberSignature = [...cacheArgs, 'segments'].join(', ');
  const ownerKeyComparison = (entryName, keyName, index) => {
    const freshness =
      `${entryName}.revision${index} === ${keyName}.revision && ${entryName}.rowIndex${index} === ${keyName}.rowIndex`;
    return index === 0 ? freshness : `${entryName}.key${index} === ${keyName} && ${freshness}`;
  };
  const ownerKeyEntryFields = (keyName, index) => {
    const freshness = `revision${index}: ${keyName}.revision, rowIndex${index}: ${keyName}.rowIndex`;
    return index === 0 ? freshness : `key${index}: ${keyName}, ${freshness}`;
  };
  const comparisons = [
    ...sourceOwnerCacheKeyNames.map((keyName, index) =>
      ownerKeyComparison('entry', keyName, index)),
    ...primitiveCacheValueNames.map((valueName, index) =>
      `entry.primitive${index} === ${valueName}`),
  ].join(' && ') || 'true';
  const directComparisons = [
    ...sourceOwnerCacheKeyNames.map((keyName, index) =>
      ownerKeyComparison('directEntry', keyName, index)),
    ...primitiveCacheValueNames.map((valueName, index) =>
      `directEntry.primitive${index} === ${valueName}`),
  ].join(' && ') || 'true';
  const entryFields = [
    ...sourceOwnerCacheKeyNames.map((keyName, index) =>
      ownerKeyEntryFields(keyName, index)),
    ...primitiveCacheValueNames.map((valueName, index) =>
      `primitive${index}: ${valueName}`),
    'segments: snapshot',
  ].join(', ');
  return `var ${name}SourceOwnerFrameCacheSlot = Symbol();
var ${name}SourceOwnerFrameCache = new WeakMap();
function ${name}ReadSourceOwnerFrameCache(${readSignature}) {
  var directEntry = ${sourceOwnerCacheKeyNames[0]}[${name}SourceOwnerFrameCacheSlot];
  if (directEntry !== undefined && ${directComparisons}) return directEntry.segments;
  var entries = ${name}SourceOwnerFrameCache.get(${sourceOwnerCacheKeyNames[0]});
  if (entries === undefined) return undefined;
  for (var entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    var entry = entries[entryIndex];
    if (${comparisons}) return entry.segments;
  }
  return undefined;
}
function ${name}RememberSourceOwnerFrameCache(${rememberSignature}) {
  var snapshot = bitfieldGeneratedNoReplySnapshotSegments(segments);
  var directEntry = { ${entryFields} };
  try {
    if (Object.prototype.hasOwnProperty.call(${sourceOwnerCacheKeyNames[0]}, ${name}SourceOwnerFrameCacheSlot)) {
      ${sourceOwnerCacheKeyNames[0]}[${name}SourceOwnerFrameCacheSlot] = directEntry;
    } else {
      Object.defineProperty(${sourceOwnerCacheKeyNames[0]}, ${name}SourceOwnerFrameCacheSlot, { configurable: true, value: directEntry, writable: true });
    }
  } catch {
  }
  var entries = ${name}SourceOwnerFrameCache.get(${sourceOwnerCacheKeyNames[0]});
  if (entries === undefined) {
    ${name}SourceOwnerFrameCache.set(${sourceOwnerCacheKeyNames[0]}, [directEntry]);
    return;
  }
  for (var entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    var entry = entries[entryIndex];
    if (${comparisons}) {
      entry.segments = snapshot;
      return;
    }
  }
  entries.push(directEntry);
}
`;
}

function capitalized(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function sourceChildValueExpression(sourceParentName, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${sourceParentName}.${key}`
    : `${sourceParentName}[${JSON.stringify(key)}]`;
}

function normalizedInputObjectFields(writer) {
  if (Array.isArray(writer.inputObjectFields)) return writer.inputObjectFields;
  return writer.inputObjectKeys.map((key) => ({
    key,
    fixed: false,
  }));
}

function pathValuePrefixBytesLiteral(pathParts, fieldType = 3, valueLength = 0) {
  return pathValuePrefixBytes(pathParts, fieldType, valueLength).join(', ');
}

function literalPathValueCellBytes(pathParts, value) {
  const { fieldType, bytes } = literalCellValueBytes(value);
  return [
    ...pathValuePrefixBytes(pathParts, fieldType, bytes.length),
    ...bytes,
  ];
}

function literalCellValueBytes(value) {
  if (value === null) return { fieldType: 5, bytes: [] };
  if (typeof value === 'string') return { fieldType: 2, bytes: bitfieldGeneratedNoReplyUtf8Bytes(value) };
  if (typeof value === 'boolean') return { fieldType: 4, bytes: [value ? 1 : 0] };
  if (typeof value === 'number' && Number.isFinite(value)) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return { fieldType: 6, bytes: Array.from(bytes) };
  }
  throw new TypeError('static generated no-reply input cells require JSON-literal primitive values');
}

function pathValuePrefixBytes(pathParts, fieldType, valueLength) {
  const pathBytes = encodedPathBytes(pathParts);
  return [
    fieldType,
    pathBytes.length & 255,
    (pathBytes.length >>> 8) & 255,
    valueLength & 255,
    (valueLength >>> 8) & 255,
    (valueLength >>> 16) & 255,
    (valueLength >>> 24) & 255,
    ...pathBytes,
  ];
}

function encodedPathBytes(pathParts) {
  if (!Array.isArray(pathParts) || pathParts.length > 255) {
    throw new TypeError('generated path-value writers require up to 255 path parts');
  }
  const bytes = [pathParts.length];
  for (const part of pathParts) {
    const partBytes = bitfieldGeneratedNoReplyUtf8Bytes(String(part));
    if (partBytes.length > 0xffff) {
      throw new TypeError('generated path-value writers require uint16 path segment byte lengths');
    }
    bytes.push(partBytes.length & 255, (partBytes.length >>> 8) & 255, ...partBytes);
  }
  return bytes;
}

function bitfieldGeneratedNoReplyUtf8Bytes(value) {
  return Array.from(Buffer.from(String(value), 'utf8'));
}

function noReplyTargetWritePlans(binding) {
  const writes = binding?.scope_binding?.target_writes;
  if (!Array.isArray(writes)) return [];
  return writes.map(noReplyTargetWritePlan).filter((plan) => plan !== null);
}

function noReplyTargetWritePlan(write) {
  if (!isNoReplyWrite(write)) return null;
  const request = write.request;
  const target = request?.target;
  const payloadPattern = request?.payload;
  const fields = write.payload_encoding?.fields;
  if (typeof target !== 'string' || !isRecord(payloadPattern) || !Array.isArray(fields)) {
    return null;
  }
  const definitionField = fields.find((field) =>
    field?.type === 'utf8' && pathEquals(field.path, ['payload', 'definition_id']));
  const inputField = fields.find((field) =>
    field?.type === 'json' && pathEquals(field.path, ['payload', 'input']));
  if (!definitionField || !inputField) return null;
  return {
    target,
    payloadPattern,
  };
}

function isNoReplyWrite(write) {
  return write?.reply_required === false ||
    (Array.isArray(write?.answer_cells) && write.answer_cells.length === 0);
}

function pathEquals(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((part, index) => part === right[index]);
}

function matchNoReplyCall(requestExpression, plans, stringConstants, payloadBuilders = new Map(), constObjects = new Map()) {
  const resolvedRequestExpression = resolveConstObjectExpression(requestExpression, constObjects);
  const requestProperties = parseObjectProperties(resolvedRequestExpression);
  if (!requestProperties) return null;
  const target = sourceStringValue(requestProperties.get('target'), stringConstants);
  if (target === null) return null;
  const payloadExpression = resolveConstObjectExpression(requestProperties.get('payload'), constObjects);
  for (const plan of plans) {
    if (target !== plan.target) continue;
    const payloadMatch =
      matchNoReplyPayload(payloadExpression, plan.payloadPattern, stringConstants, constObjects) ??
      matchNoReplyPayloadBuilderCall(payloadExpression, payloadBuilders, plan.payloadPattern);
    if (!payloadMatch) continue;
    return {
      plan,
      ...payloadMatch,
    };
  }
  return null;
}

function matchNoReplyPayload(payloadExpression, payloadPattern, stringConstants, constObjects = new Map()) {
  const payloadProperties = parseObjectProperties(payloadExpression);
  if (!payloadProperties) return null;
  if (!payloadMatchesPattern(payloadProperties, payloadPattern)) return null;
  const definitionExpression = payloadProperties.get('definition_id')?.trim();
  const inputExpression = payloadProperties.get('input')?.trim();
  if (!definitionExpression || !inputExpression) return null;
  const resolvedInputExpression = resolveConstObjectExpression(inputExpression, constObjects);
  const inputObjectFields = parseObjectPropertyEntries(resolvedInputExpression)
    ?.map(inputObjectFieldPlan);
  return {
    definitionExpression,
    inputExpression,
    inputObjectFields,
    fixedDefinition: sourceStringValue(definitionExpression, stringConstants),
  };
}

function inputObjectFieldPlan(field) {
  const literal = literalValue(field.expression);
  if (literal !== undefined) {
    return {
      key: field.key,
      expression: field.expression,
      fixed: true,
      value: literal,
    };
  }
  const sourceChild = sourceChildMemberExpression(field.expression);
  return {
    key: field.key,
    expression: field.expression,
    fixed: false,
    ...(sourceChild ? { sourceChild } : {}),
  };
}

function payloadMatchesPattern(payloadProperties, payloadPattern) {
  for (const [key, expected] of Object.entries(payloadPattern)) {
    const actualExpression = payloadProperties.get(key);
    if (actualExpression === undefined) return false;
    if (literalValue(actualExpression) !== expected) return false;
  }
  return true;
}

function sourceStringValue(expression, stringConstants) {
  if (typeof expression !== 'string') return null;
  const literal = literalValue(expression);
  if (typeof literal === 'string') return literal;
  const trimmed = expression.trim();
  return stringConstants.get(trimmed) ?? null;
}

function resolveConstObjectExpression(expression, constObjects) {
  if (typeof expression !== 'string') return expression;
  const trimmed = stripBalancedOuterParens(expression.trim());
  return constObjects.get(trimmed) ?? expression;
}

function sameScopeConstObjectBindings(source, callStart) {
  const range = enclosingFunctionBodyRange(source, callStart) ?? { start: 0, end: source.length };
  const bindings = new Map();
  let depth = 0;
  let index = range.start;
  while (index < callStart && index < range.end) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index, char) + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index) + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index) + 1;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      index += 1;
      continue;
    }
    if (
      depth === 0 &&
      source.startsWith('const', index) &&
      isIdentifierBoundary(source, index - 1) &&
      isIdentifierBoundary(source, index + 'const'.length)
    ) {
      const binding = readConstObjectBinding(source, index, Math.min(callStart, range.end));
      if (binding) {
        if (!containsIdentifier(source.slice(binding.end, callStart), binding.name)) {
          bindings.set(binding.name, binding.expression);
        }
        index = binding.end;
        continue;
      }
    }
    index += 1;
  }
  return bindings;
}

function enclosingFunctionBodyRange(source, position) {
  let match;
  let range = null;
  const pattern = /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/g;
  while ((match = pattern.exec(source)) !== null) {
    const paramsOpen = source.indexOf('(', match.index + match[0].length - 1);
    if (paramsOpen < 0) continue;
    const params = readBalanced(source, paramsOpen, '(', ')');
    if (!params) continue;
    let bodyOpen = skipWhitespace(source, params.end + 1);
    if (source[bodyOpen] !== '{') {
      bodyOpen = source.indexOf('{', bodyOpen);
      if (bodyOpen < 0) continue;
    }
    const body = readBalanced(source, bodyOpen, '{', '}');
    if (!body) continue;
    const candidate = { start: bodyOpen + 1, end: body.end };
    if (candidate.start <= position && position < candidate.end) {
      if (!range || candidate.start >= range.start) range = candidate;
    }
  }
  return range;
}

function readConstObjectBinding(source, constIndex, limit) {
  let cursor = skipWhitespace(source, constIndex + 'const'.length);
  const nameMatch = source.slice(cursor).match(/^([A-Za-z_$][\w$]*)/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  cursor += name.length;
  const equals = findTopLevelChar(source, cursor, limit, '=');
  if (equals < 0) return null;
  const expression = readTopLevelExpressionWithEnd(source, skipWhitespace(source, equals + 1), limit);
  if (!expression) return null;
  if (!parseObjectPropertyEntries(expression.text)) return null;
  return {
    name,
    expression: expression.text,
    end: expression.end + 1,
  };
}

function readTopLevelExpressionWithEnd(source, start, limit = source.length) {
  let depth = 0;
  for (let index = start; index < limit; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index, char);
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ';' && depth === 0) {
      return {
        text: source.slice(start, index).trim(),
        end: index,
      };
    }
  }
  return null;
}

function findTopLevelChar(source, start, limit, wanted) {
  let depth = 0;
  for (let index = start; index < limit; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index, char);
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === wanted && depth === 0) return index;
    if (char === ';' && depth === 0) return -1;
  }
  return -1;
}

function containsIdentifier(source, identifier) {
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index, char);
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (
      source.startsWith(identifier, index) &&
      isIdentifierBoundary(source, index - 1) &&
      isIdentifierBoundary(source, index + identifier.length)
    ) {
      return true;
    }
  }
  return false;
}

function parseObjectProperties(expression) {
  const entries = parseObjectPropertyEntries(expression);
  if (!entries) return null;
  return new Map(entries.map((entry) => [entry.key, entry.expression]));
}

function parseObjectPropertyEntries(expression) {
  if (typeof expression !== 'string') return null;
  const trimmed = stripBalancedOuterParens(expression.trim());
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const body = trimmed.slice(1, -1);
  const parts = splitTopLevel(body);
  const entries = [];
  for (const part of parts) {
    const text = part.text.trim();
    if (!text) continue;
    if (text.startsWith('...')) return null;
    const colon = findTopLevelColon(text);
    if (colon < 0) {
      if (!/^[A-Za-z_$][\w$]*$/.test(text)) return null;
      entries.push({ key: text, expression: text });
      continue;
    }
    const key = propertyKey(text.slice(0, colon).trim());
    const valueExpression = text.slice(colon + 1).trim();
    if (!key || !valueExpression) return null;
    entries.push({ key, expression: valueExpression });
  }
  return entries;
}

function propertyKey(rawKey) {
  const literal = literalValue(rawKey);
  if (typeof literal === 'string') return literal;
  return /^[A-Za-z_$][\w$]*$/.test(rawKey) ? rawKey : null;
}

function literalValue(expression) {
  if (typeof expression !== 'string') return undefined;
  const trimmed = expression.trim();
  const constAsserted = stripTypeScriptConstAssertion(trimmed);
  if (constAsserted !== trimmed) return literalValue(constAsserted);
  const parenthesized = stripBalancedOuterParens(trimmed);
  if (parenthesized !== trimmed) return literalValue(parenthesized);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed[trimmed.length - 1] === first) {
    return parseStringLiteral(trimmed);
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  return undefined;
}

function sourceChildMemberExpression(expression) {
  if (typeof expression !== 'string') return null;
  const trimmed = stripBalancedOuterParens(expression.trim());
  const match = trimmed.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
  return match
    ? {
      parentExpression: match[1],
      key: match[2],
    }
    : null;
}

function stripTypeScriptConstAssertion(expression) {
  const match = expression.match(/^(.*)\s+as\s+const$/s);
  return match ? match[1].trim() : expression;
}

function stripBalancedOuterParens(expression) {
  let trimmed = expression;
  while (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const balanced = readBalanced(trimmed, 0, '(', ')');
    if (!balanced || balanced.end !== trimmed.length - 1) break;
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseStringLiteral(literal) {
  try {
    return Function(`"use strict"; return (${literal});`)();
  } catch {
    return undefined;
  }
}

function topLevelStringConstants(source) {
  const constants = new Map();
  const pattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(?:\\.|(?!\2).)*\2\s*;/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [statement, name] = match;
    const equals = statement.indexOf('=');
    const semi = statement.lastIndexOf(';');
    const value = literalValue(statement.slice(equals + 1, semi));
    if (typeof value === 'string') constants.set(name, value);
  }
  return constants;
}

function topLevelFunctionReturns(source) {
  const returns = [];
  const pattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, name] = match;
    const paramsOpen = source.indexOf('(', match.index + match[0].length - 1);
    if (paramsOpen < 0) continue;
    const params = readBalanced(source, paramsOpen, '(', ')');
    if (!params) continue;
    const parameterNames = functionParameterNames(params.body);
    if (!parameterNames) continue;
    let bodyOpen = skipWhitespace(source, params.end + 1);
    if (source[bodyOpen] !== '{') {
      bodyOpen = source.indexOf('{', bodyOpen);
      if (bodyOpen < 0) continue;
    }
    const nextFunctionIndex = source.slice(match.index + 1).search(/\bfunction\s+[A-Za-z_$][\w$]*\s*\(/);
    const bodySearchLimit = nextFunctionIndex < 0
      ? source.length
      : match.index + 1 + nextFunctionIndex;
    let returnExpression = null;
    while (bodyOpen >= 0 && bodyOpen < bodySearchLimit) {
      const body = readBalanced(source, bodyOpen, '{', '}');
      if (!body) break;
      returnExpression = readTopLevelReturnExpression(body.body);
      if (returnExpression) break;
      bodyOpen = source.indexOf('{', body.end + 1);
    }
    if (!returnExpression) continue;
    returns.push({ name, parameterNames, returnExpression });
  }
  return returns;
}

function topLevelNoReplyPayloadBuilders(source, plans, stringConstants) {
  const builders = new Map();
  for (const { name, parameterNames, returnExpression } of topLevelFunctionReturns(source)) {
    for (const plan of plans) {
      const payloadMatch = matchNoReplyPayload(returnExpression, plan.payloadPattern, stringConstants);
      if (!payloadMatch) continue;
      builders.set(name, {
        parameterNames,
        payloadPattern: plan.payloadPattern,
        match: payloadMatch,
      });
      break;
    }
  }
  return builders;
}

function topLevelNoReplyRequestBuilders(source, plans, stringConstants, payloadBuilders) {
  const builders = new Map();
  const returns = topLevelFunctionReturns(source);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, parameterNames, returnExpression } of returns) {
      if (builders.has(name)) continue;
      const requestMatch =
        matchNoReplyCall(returnExpression, plans, stringConstants, payloadBuilders) ??
        matchNoReplyRequestBuilderCall(returnExpression, builders);
      if (!requestMatch) continue;
      builders.set(name, {
        parameterNames,
        match: requestMatch,
      });
      changed = true;
    }
  }
  return builders;
}

function functionParameterNames(paramsBody) {
  const params = splitFunctionParameters(paramsBody)
    .map((part) => part.text.trim())
    .filter(Boolean);
  const names = [];
  for (const param of params) {
    const name = functionParameterName(param);
    if (!name) return null;
    names.push(name);
  }
  return names;
}

function splitFunctionParameters(source) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let angleDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index, char);
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (depth === 0 && char === '<') angleDepth += 1;
    if (depth === 0 && char === '>' && angleDepth > 0) angleDepth -= 1;
    if (char === ',' && depth === 0 && angleDepth === 0) {
      parts.push({ text: source.slice(start, index) });
      start = index + 1;
    }
  }
  parts.push({ text: source.slice(start) });
  return parts;
}

function functionParameterName(param) {
  if (param.startsWith('...') || param.startsWith('{') || param.startsWith('[')) {
    return null;
  }
  const match = param.match(/^([A-Za-z_$][\w$]*)\s*(?:\?|:|=|$)/);
  return match?.[1] ?? null;
}

function readTopLevelReturnExpression(body) {
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(body, index, char);
      continue;
    }
    if (char === '/' && body[index + 1] === '/') {
      index = skipLineComment(body, index);
      continue;
    }
    if (char === '/' && body[index + 1] === '*') {
      index = skipBlockComment(body, index);
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (
      depth === 0 &&
      body.startsWith('return', index) &&
      isIdentifierBoundary(body, index - 1) &&
      isIdentifierBoundary(body, index + 'return'.length)
    ) {
      const expressionStart = skipWhitespace(body, index + 'return'.length);
      return readTopLevelExpression(body, expressionStart);
    }
  }
  return null;
}

function readTopLevelExpression(source, start) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index, char);
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ';' && depth === 0) {
      return source.slice(start, index).trim();
    }
  }
  const expression = source.slice(start).trim();
  return expression || null;
}

function matchNoReplyRequestBuilderCall(expression, builders) {
  const call = parseSimpleCallExpression(expression);
  if (!call) return null;
  const builder = builders.get(call.name);
  if (!builder || call.args.length !== builder.parameterNames.length) return null;
  const replacements = new Map();
  builder.parameterNames.forEach((name, index) => {
    replacements.set(name, call.args[index]);
  });
  return remapNoReplyMatch(builder.match, replacements);
}

function matchNoReplyPayloadBuilderCall(expression, builders, payloadPattern) {
  if (typeof expression !== 'string') return null;
  const call = parseSimpleCallExpression(expression);
  if (!call) return null;
  const builder = builders.get(call.name);
  if (
    !builder ||
    builder.payloadPattern !== payloadPattern ||
    call.args.length !== builder.parameterNames.length
  ) {
    return null;
  }
  const replacements = new Map();
  builder.parameterNames.forEach((name, index) => {
    replacements.set(name, call.args[index]);
  });
  return remapNoReplyPayloadMatch(builder.match, replacements);
}

function parseSimpleCallExpression(expression) {
  if (typeof expression !== 'string') return null;
  const trimmed = expression.trim();
  const match = trimmed.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (!match) return null;
  const openParen = trimmed.indexOf('(', match[1].length);
  const call = readBalanced(trimmed, openParen, '(', ')');
  if (!call) return null;
  if (trimmed.slice(call.end + 1).trim() !== '') return null;
  return {
    name: match[1],
    args: splitTopLevel(call.body).map((part) => part.text.trim()),
  };
}

function remapNoReplyMatch(match, replacements) {
  return {
    ...match,
    ...remapNoReplyPayloadMatch(match, replacements),
  };
}

function remapNoReplyPayloadMatch(match, replacements) {
  const remapExpression = (expression) => replaceIdentifierReferences(expression, replacements);
  const definitionExpression = remapExpression(match.definitionExpression);
  const inputExpression = remapExpression(match.inputExpression);
  const inputObjectFields = match.inputObjectFields
    ? match.inputObjectFields.map((field) => field.fixed
      ? field
      : inputObjectFieldPlan({
          key: field.key,
          expression: remapExpression(field.expression),
        }))
    : parseObjectPropertyEntries(inputExpression)?.map(inputObjectFieldPlan);
  return {
    definitionExpression,
    inputExpression,
    inputObjectFields,
    fixedDefinition: match.fixedDefinition ?? sourceStringValue(definitionExpression, new Map()),
  };
}

function replaceIdentifierReferences(expression, replacements) {
  let output = '';
  let cursor = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(expression, index, char);
      continue;
    }
    if (char === '/' && expression[index + 1] === '/') {
      index = skipLineComment(expression, index);
      continue;
    }
    if (char === '/' && expression[index + 1] === '*') {
      index = skipBlockComment(expression, index);
      continue;
    }
    if (!/[A-Za-z_$]/.test(char) || !isIdentifierBoundary(expression, index - 1)) {
      continue;
    }
    let end = index + 1;
    while (/[A-Za-z0-9_$]/.test(expression[end] ?? '')) end += 1;
    const identifier = expression.slice(index, end);
    const replacement = replacements.get(identifier);
    if (replacement === undefined || previousNonWhitespaceChar(expression, index) === '.') {
      index = end - 1;
      continue;
    }
    output += expression.slice(cursor, index);
    output += `(${replacement})`;
    cursor = end;
    index = end - 1;
  }
  output += expression.slice(cursor);
  return output;
}

function previousNonWhitespaceChar(source, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(source[cursor])) return source[cursor];
  }
  return '';
}

function readBalanced(source, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index, char);
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return {
          body: source.slice(openIndex + 1, index),
          end: index,
        };
      }
    }
  }
  return null;
}

function splitTopLevel(source) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index, char);
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push({ text: source.slice(start, index) });
      start = index + 1;
    }
  }
  parts.push({ text: source.slice(start) });
  return parts;
}

function findTopLevelColon(source) {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index, char);
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ':' && depth === 0) return index;
  }
  return -1;
}

function skipString(source, start, quote) {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === quote) return index;
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      const expression = readBalanced(source, index + 1, '{', '}');
      if (!expression) return source.length - 1;
      index = expression.end;
    }
  }
  return source.length - 1;
}

function skipLineComment(source, start) {
  const newline = source.indexOf('\n', start + 2);
  return newline < 0 ? source.length - 1 : newline;
}

function skipBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2);
  return end < 0 ? source.length - 1 : end + 1;
}

function skipWhitespace(source, start) {
  let index = start;
  while (/\s/.test(source[index] ?? '')) index += 1;
  return index;
}

function isIdentifierBoundary(source, index) {
  if (index < 0 || index >= source.length) return true;
  return !/[A-Za-z0-9_$]/.test(source[index]);
}

function loaderForPath(filePath) {
  const extension = path.extname(filePath);
  if (extension === '.tsx') return 'tsx';
  if (extension === '.ts') return 'ts';
  if (extension === '.jsx') return 'jsx';
  return 'js';
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
