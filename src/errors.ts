/** An error with an HTTP status and a stable machine-readable code. */
export class StorageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/** The requested byte range lies outside the object. `size` is sent back in Content-Range. */
export class RangeNotSatisfiableError extends StorageError {
  constructor(readonly size: number) {
    super(416, "RANGE_NOT_SATISFIABLE", `Requested range is outside the object (${size} bytes)`);
    this.name = "RangeNotSatisfiableError";
  }
}

/**
 * The backend could not be reached (network, timeout, server error). Reads may still be
 * served from the cache; writes fail with 503 so that nothing is silently lost.
 */
export class BackendUnavailableError extends StorageError {
  constructor(message: string) {
    super(503, "BACKEND_UNAVAILABLE", message);
    this.name = "BackendUnavailableError";
  }
}

export function isBackendUnavailable(error: unknown): error is BackendUnavailableError {
  return error instanceof BackendUnavailableError;
}
