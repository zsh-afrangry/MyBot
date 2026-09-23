// Acceptance-only observations. A successful tool response is NOT proof of a
// write: callers must independently assert database and scheduler state.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function analyzeCalls(messages) {
  const attempts = [], unmatchedResults = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content.filter(part => ["toolCall", "tool_use"].includes(part.type))) {
        attempts.push({ id: block.id, name: block.name, arguments: block.arguments ?? block.input,
          outcome: "unmatched", signature: JSON.stringify([block.name, stable(block.arguments ?? block.input)]) });
      }
    }
    if (message.role !== "toolResult") continue;
    const pending = attempts.filter(item => item.outcome === "unmatched");
    const matches = message.toolCallId ? pending.filter(item => item.id === message.toolCallId) : pending;
    const attempt = matches.length === 1 ? matches[0] : undefined;
    if (!attempt || (message.toolName && message.toolName !== attempt.name)) {
      unmatchedResults.push({ toolCallId: message.toolCallId, toolName: message.toolName }); continue;
    }
    const text = Array.isArray(message.content) ? message.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
    let result;
    try { result = JSON.parse(text); } catch { /* Host validation failures are plain text. */ }
    attempt.outcome = message.isError === true && text.startsWith("Validation failed for tool ") ? "schema-rejected"
      : message.isError !== true && result?.ok === true ? "success"
      : result?.ok === false ? "business-rejected" : "unknown";
    attempt.result = result;
  }
  let sameArgumentsAfterFailure = 0, correctedSchemaSuccesses = 0, repeatedSuccessRequests = 0;
  for (let i = 0; i < attempts.length; i++) {
    const current = attempts[i], previous = attempts.slice(0, i).filter(item => item.name === current.name);
    if (previous.some(item => ["schema-rejected", "business-rejected"].includes(item.outcome) && item.signature === current.signature)) sameArgumentsAfterFailure++;
    if (current.outcome === "success" && previous.some(item => item.outcome === "schema-rejected" && item.signature !== current.signature)) correctedSchemaSuccesses++;
    if (current.outcome === "success" && previous.some(item => item.outcome === "success" && item.signature === current.signature)) repeatedSuccessRequests++;
  }
  return { attempts, unmatchedResults, totalCalls: attempts.length,
    successes: attempts.filter(item => item.outcome === "success").length,
    schemaRejections: attempts.filter(item => item.outcome === "schema-rejected").length,
    businessRejections: attempts.filter(item => item.outcome === "business-rejected").length,
    unknownOrUnmatched: attempts.filter(item => ["unknown", "unmatched"].includes(item.outcome)).length + unmatchedResults.length,
    sameArgumentsAfterFailure, correctedSchemaSuccesses, repeatedSuccessRequests };
}

export function assertProposalCalls(analysis, name, assert) {
  assert.ok(analysis.totalCalls >= 1 && analysis.totalCalls <= 3, "Proposal must finish within three attempts");
  assert.ok(analysis.attempts.every(item => item.name === name), "Unexpected tool during proposal turn");
  assert.equal(analysis.unknownOrUnmatched, 0, "Unpaired or unknown result");
  assert.equal(analysis.businessRejections, 0, "Business rejection requires separate evaluation");
  assert.equal(analysis.sameArgumentsAfterFailure, 0, "Identical rejected arguments retried");
  assert.equal(analysis.successes, 1, "Expected exactly one successful proposal response");
  assert.equal(analysis.attempts.at(-1).outcome, "success", "Proposal must end in success");
  return analysis.attempts.find(item => item.outcome === "success").result;
}
