/**
 * Lightweight typed error classes.
 *
 * NOTE (finding H1): the project skill `error-handling-patterns` mandates
 * `@mysterylane/errors`, but that package is NOT published to the npm registry
 * (`npm view @mysterylane/errors` → 404), so it cannot be installed.  Rather
 * than fabricate a stand-in for that package's full API, we define the minimal
 * plain `Error` subclasses the request boundary actually needs to classify
 * upstream failures (external service vs timeout).  Swap these for
 * `@mysterylane/errors` if/when it becomes installable.
 */

/** An external dependency (SMHI, metobs, etc.) failed or returned non-OK. */
export class ExternalServiceError extends Error {
  /** Upstream HTTP status when known (used to classify e.g. rate limits). */
  readonly status?: number;
  /** Short service identifier for logging/classification. */
  readonly service?: string;

  constructor(
    message: string,
    options?: { status?: number; service?: string; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "ExternalServiceError";
    this.status = options?.status;
    this.service = options?.service;
  }
}

/** An external dependency did not respond within the allotted time. */
export class TimeoutError extends Error {
  readonly service?: string;

  constructor(
    message: string,
    options?: { service?: string; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "TimeoutError";
    this.service = options?.service;
  }
}
