const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export function boundedText(value: string, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new TypeError(`${name} is outside the allowed length`);
  }
  return value;
}

export function assertHash(value: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new TypeError("payloadHash must be a SHA-256 hex digest");
  return value.toLowerCase();
}

export function assertUnixSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("timestamp must be a non-negative integer");
  return value;
}
