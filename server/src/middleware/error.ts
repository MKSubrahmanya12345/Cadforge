import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { createLogger } from '../logger.js';

const log = createLogger('http');

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'error',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message, 'not_found');
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message, 'bad_request');
}

export function upstream(message: string, status = 502): HttpError {
  return new HttpError(status, message, 'upstream_error');
}

interface ErrorBody {
  error: { code: string; message: string; issues?: unknown };
}

/** Wrap an async handler so rejections reach the error middleware. */
export function asyncRoute<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req as T, res, next).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    const body: ErrorBody = {
      error: {
        code: 'validation_error',
        message: 'Request failed validation',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } } satisfies ErrorBody);
    return;
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: { code: 'invalid_json', message: 'Request body is not valid JSON' },
    } satisfies ErrorBody);
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  log.error('unhandled error', { message, stack: err instanceof Error ? err.stack : undefined });
  res.status(500).json({
    error: { code: 'internal_error', message: 'Internal server error' },
  } satisfies ErrorBody);
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
  } satisfies ErrorBody);
}
