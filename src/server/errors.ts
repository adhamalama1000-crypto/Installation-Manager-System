/** Errors with a safe, user-facing message and an HTTP status. Anything else becomes a 500. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(
    public readonly fieldErrors: Record<string, string>,
    message = "Please correct the highlighted fields.",
  ) {
    super(message, 422, "VALIDATION_ERROR", { fieldErrors });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Please sign in to continue.") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super(message, 403, "FORBIDDEN");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "The requested record was not found.") {
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
    message = "One or more technicians are already booked at this time.",
  ) {
    super(message, 409, "SCHEDULING_CONFLICT", { conflicts });
  }
}

export class StaleRecordError extends AppError {
  constructor(message = "This appointment was changed by someone else. Reload it to see the latest version.") {
    super(message, 409, "STALE_RECORD");
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many attempts. Please wait a few minutes and try again.") {
    super(message, 429, "RATE_LIMITED");
  }
}
