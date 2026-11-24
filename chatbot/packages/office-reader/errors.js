export class OfficeReaderError extends Error {
  constructor(code = 'office_read_failed', details = undefined) {
    super(code);
    this.name = 'OfficeReaderError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function officeFail(code, details) {
  throw new OfficeReaderError(code, details);
}
