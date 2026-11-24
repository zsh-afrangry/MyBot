// Shared by the deterministic, loopback-only acceptance model fixtures.
export const FIXTURE_CONTEXT_WINDOW = 262144;
export const FIXTURE_REQUEST_LIMIT = 16 * 1024 * 1024;

export async function readFixtureJson(stream, {maxBytes = FIXTURE_REQUEST_LIMIT} = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw Error('fixture_model_request_too_large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}
