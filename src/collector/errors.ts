// Typed collector errors. Every failure that propagates to the gap log is a
// typed Error subclass so the log can record a stable `name` plus structured
// context, not a bare message string.

export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly url: string,
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class WsError extends Error {
  override readonly name = 'WsError';
  constructor(
    readonly reason: string,
    readonly code?: number,
    options?: { cause?: unknown },
  ) {
    super(`websocket ${reason}${code === undefined ? '' : ` (code ${code})`}`, options);
  }
}
