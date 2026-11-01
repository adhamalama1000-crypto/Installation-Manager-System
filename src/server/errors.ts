import { createT } from "@/i18n/translator";

const english = createT("en");

/**
 * Errors with a safe, user-facing message and an HTTP status. Anything else becomes a 500.
 *
 * Messages are message keys (see `msg` in src/i18n/translator.ts) or plain text. `message` is the
 * English text (logs, tests); `raw` keeps the key so the API answers in the requester's language.
 */
export class AppError extends Error {
  public readonly raw: string;
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(english.msg(message));
    this.raw = message;
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  /** English texts per field; `rawFieldErrors` keeps the message keys. */
  public readonly fieldErrors: Record<string, string>;
  constructor(
    public readonly rawFieldErrors: Record<string, string>,
    message = "errors.validation",
  ) {
    super(message, 422, "VALIDATION_ERROR", { fieldErrors: rawFieldErrors });
    this.fieldErrors = Object.fromEntries(Object.entries(rawFieldErrors).map(([k, v]) => [k, english.msg(v)]));
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "errors.signInRequired") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "errors.forbidden") {
    super(message, 403, "FORBIDDEN");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "errors.notFound") {
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
    message = "errors.conflict",
  ) {
    super(message, 409, "SCHEDULING_CONFLICT", { conflicts });
  }
}

export class StaleRecordError extends AppError {
  constructor(message = "errors.stale") {
    super(message, 409, "STALE_RECORD");
  }
}

export class RateLimitError extends AppError {
  constructor(message = "errors.rateLimited") {
    super(message, 429, "RATE_LIMITED");
  }
}
