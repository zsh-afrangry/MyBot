const PERSONAL_SEARCH_TOOL_NAME = "personal_web_search";
const REDACTED_QUERY = "[redacted search query]";

type UnknownRecord = Record<string, unknown>;

/**
 * Redact only the persisted assistant tool-call copy.  OpenClaw applies this
 * hook after it has already extracted and executed the real tool call, so the
 * model/runtime still receives the original arguments for the current turn.
 */
export function redactSearchToolCallForPersistence(message: unknown): unknown {
  const record = asRecord(message);
  if (record?.role !== "assistant" || !Array.isArray(record.content)) return message;

  let changed = false;
  const content = record.content.map((block) => {
    const blockRecord = asRecord(block);
    if (
      blockRecord?.type !== "toolCall" ||
      blockRecord.name !== PERSONAL_SEARCH_TOOL_NAME
    ) {
      return block;
    }

    const argumentsRecord = asRecord(blockRecord.arguments);
    if (!argumentsRecord || typeof argumentsRecord.query !== "string") return block;

    changed = true;
    const redactedArguments = {
      ...argumentsRecord,
      query: REDACTED_QUERY,
    };
    return {
      ...blockRecord,
      arguments: redactedArguments,
      ...(typeof blockRecord.partialJson === "string"
        ? { partialJson: JSON.stringify(redactedArguments) }
        : {}),
      ...(typeof blockRecord.partialArgs === "string"
        ? { partialArgs: JSON.stringify(redactedArguments) }
        : {}),
    };
  });

  return changed ? { ...record, content } : message;
}

/**
 * Redact query fields from the persisted result/details copy while preserving
 * the answer text, citations, status and error information used for replay.
 */
export function redactSearchToolResultForPersistence(
  message: unknown,
  toolName?: unknown,
): unknown {
  const record = asRecord(message);
  if (
    !record ||
    (toolName !== PERSONAL_SEARCH_TOOL_NAME &&
      record.toolName !== PERSONAL_SEARCH_TOOL_NAME)
  ) {
    return message;
  }

  const redactValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const next = value.map(redactValue);
      return next.some((item, index) => item !== value[index]) ? next : value;
    }
    const valueRecord = asRecord(value);
    if (!valueRecord) return value;

    const next: UnknownRecord = {};
    let changed = false;
    for (const [key, item] of Object.entries(valueRecord)) {
      if (key === "query" && typeof item === "string") {
        next[key] = REDACTED_QUERY;
        changed ||= item !== REDACTED_QUERY;
      } else {
        const redacted = redactValue(item);
        next[key] = redacted;
        changed ||= redacted !== item;
      }
    }
    return changed ? next : value;
  };

  const content = Array.isArray(record.content)
    ? record.content.map((block) => {
        const blockRecord = asRecord(block);
        if (blockRecord?.type !== "text" || typeof blockRecord.text !== "string") {
          return block;
        }
        try {
          const parsed = JSON.parse(blockRecord.text) as unknown;
          const redacted = redactValue(parsed);
          return redacted === parsed
            ? block
            : { ...blockRecord, text: JSON.stringify(redacted, null, 2) };
        } catch {
          return block;
        }
      })
    : record.content;
  const details = record.details === undefined ? undefined : redactValue(record.details);

  if (content === record.content && details === record.details) return message;
  return {
    ...record,
    content,
    ...(record.details === undefined ? {} : { details }),
  };
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}
