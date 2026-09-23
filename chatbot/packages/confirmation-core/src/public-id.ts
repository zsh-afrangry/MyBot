import { randomUUID } from "node:crypto";

/** Public references cross text transports. Host 2026.7.1-2 mistakes an embedded
 * fc- prefix for a credential. Retain UUIDs and the secure random source while
 * avoiding that reserved token fragment; never disable credential redaction. */
export function createPublicUuid(generate: () => string = randomUUID): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = generate();
    if (!/fc-/iu.test(candidate)) return candidate;
  }
  throw new Error("Unable to generate a transport-safe public UUID");
}
