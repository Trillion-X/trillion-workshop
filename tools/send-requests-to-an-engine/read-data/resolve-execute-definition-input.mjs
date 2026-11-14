import fs from "node:fs";

export function resolveExecuteDefinitionInput(arguments_, { readFile = fs.readFileSync } = {}) {
  const optionValue = (name) => {
    const index = arguments_.indexOf(name);
    return index >= 0 ? (arguments_[index + 1] ?? null) : null;
  };
  const inputJson = optionValue("--input-json");
  const inputJsonFile = optionValue("--input-json-file");
  if (inputJson !== null && inputJsonFile !== null) {
    throw new Error("use exactly one of --input-json or --input-json-file");
  }
  const inputText = inputJsonFile !== null ? readFile(inputJsonFile, "utf8") : (inputJson ?? "{}");
  let input;
  try {
    input = JSON.parse(inputText);
  } catch {
    throw new Error("definition input must be a JSON object");
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("definition input must be a JSON object");
  }
  return input;
}
