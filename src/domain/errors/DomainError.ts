export class DomainError extends Error {
  name = 'DomainError';
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;

    Object.setPrototypeOf(this, DomainError.prototype);
  }
}
