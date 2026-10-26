import { msg, translateFieldErrors, translateMessage } from "@/i18n/translate";

/**
 * Errors with a safe, user-facing message and an HTTP status. Anything else becomes a 500.
 *
 * Services pass message descriptors (see `msg()`). `descriptor` keeps it so the API can answer in
 * the reader's language; `message` is the English text, for server logs and tests.
 */
export class AppError extends Error {
  public readonly descriptor: string;
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(translateMessage(message, "en"));
    this.descriptor = message;
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  /** English field messages (logs, tests); `fieldDescriptors` are translated per reader. */
  public readonly fieldErrors: Record<string, string>;
  constructor(
    public readonly fieldDescriptors: Record<string, string>,
    message = msg("e.validation"),
  ) {
    super(message, 422, "VALIDATION_ERROR", { fieldErrors: fieldDescriptors });
    this.fieldErrors = translateFieldErrors(fieldDescriptors, "en");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = msg("e.unauthorized")) {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = msg("e.forbidden")) {
    super(message, 403, "FORBIDDEN");
  }
}

export class NotFoundError extends AppError {
  constructor(message = msg("e.notFound")) {
    super(message, 404, "NOT_FOUND");
  }
}

export type ConflictDetail = {
  technicianId: string;
  technicianName: string;
  appointmentId: string;
  appointmentCode: string;
  startsAt: string;
  endsAt: string;
  customerName?: string;
};

export class SchedulingConflictError extends AppError {
  constructor(
    public readonly conflicts: ConflictDetail[],
    message = msg("e.conflict"),
  ) {
    super(message, 409, "SCHEDULING_CONFLICT", { conflicts });
  }
}

export class StaleRecordError extends AppError {
  constructor(message = msg("e.stale")) {
    super(message, 409, "STALE_RECORD");
  }
}

export class RateLimitError extends AppError {
  constructor(message = msg("e.rateLimited")) {
    super(message, 429, "RATE_LIMITED");
  }
}
