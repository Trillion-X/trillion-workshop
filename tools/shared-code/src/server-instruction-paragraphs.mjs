import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/server-instructions.json' with { type: 'json' };

// Names belong to the instruction DATA, independently of its copy or position.
// MCP instructions and structured readers resolve the same text.
export function instructionParagraph(id, source = data) {
  const text = Object.hasOwn(source.named_paragraphs ?? {}, id) ? source.named_paragraphs[id] : null;
  if (typeof text !== 'string' || !text.trim()) throw new Error(`The instruction paragraph ${id} has no text.`);
  return text;
}

export function instructionParagraphs(source = data) {
  return source.paragraphs.map(text => {
    const reference = /^\{([a-z][a-z0-9_-]*)\}$/.exec(text);
    return reference ? instructionParagraph(reference[1], source) : text;
  });
}

export default { ...data, paragraphs: instructionParagraphs() };
