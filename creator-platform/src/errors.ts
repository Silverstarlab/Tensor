export class DomainError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
export const badRequest = (code: string, msg: string, d?: unknown) => new DomainError(400, code, msg, d);
export const unauthorized = (msg = "unauthorized") => new DomainError(401, "unauthorized", msg);
export const forbidden = (code: string, msg: string) => new DomainError(403, code, msg);
export const notFound = (what: string) => new DomainError(404, "not_found", `${what} not found`);
export const conflict = (code: string, msg: string, d?: unknown) => new DomainError(409, code, msg, d);
