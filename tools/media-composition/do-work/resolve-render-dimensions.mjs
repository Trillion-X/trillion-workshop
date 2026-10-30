/**
 * Resolve the output canvas selected by the editor. "source" uses the first
 * spine clip's decoded video dimensions; named presets are exact 16:9 sizes.
 * No maximum is imposed here, so the 8K preset reaches ffmpeg unchanged.
 */
export const RENDER_FRAME_PRESETS = Object.freeze({
  '1080p': Object.freeze({ width: 1920, height: 1080 }),
  '4k': Object.freeze({ width: 3840, height: 2160 }),
  '8k': Object.freeze({ width: 7680, height: 4320 }),
});

function validDimensions(value) {
  return value && Number.isSafeInteger(value.width) && value.width > 0
    && Number.isSafeInteger(value.height) && value.height > 0;
}

export function resolveRenderDimensions(encode = {}, sourceDimensions) {
  if (encode.resolution === 'source') {
    if (!validDimensions(sourceDimensions)) {
      throw new Error('[video.compose] Source resolution requires readable dimensions from the first spine clip');
    }
    return { width: sourceDimensions.width, height: sourceDimensions.height };
  }

  if (Object.hasOwn(RENDER_FRAME_PRESETS, encode.resolution)) {
    return { ...RENDER_FRAME_PRESETS[encode.resolution] };
  }

  if (encode.resolution !== undefined) {
    throw new Error(`[video.compose] unsupported output resolution ${JSON.stringify(encode.resolution)}`);
  }

  const width = encode.width ?? 1920;
  const height = encode.height ?? 1080;
  if (!validDimensions({ width, height })) {
    throw new Error(`[video.compose] output width and height must be positive safe integers (got ${width}x${height})`);
  }
  return { width, height };
}
