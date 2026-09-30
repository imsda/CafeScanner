import { NextFunction, Request, Response, Router } from 'express';

// Express 4 does not forward rejected promises from async handlers to the error
// middleware; an unhandled rejection would otherwise crash the process. This
// router wraps every handler so async errors reach the shared `/api` error handler.
const ROUTE_METHODS = ['all', 'get', 'post', 'put', 'patch', 'delete', 'use'] as const;

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

function isRouter(value: unknown): boolean {
  return typeof value === 'function' && Array.isArray((value as { stack?: unknown }).stack);
}

function wrapHandler(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wrapHandler);
  // Leave non-handlers (paths), error handlers (arity 4), and nested routers untouched.
  if (typeof value !== 'function' || value.length === 4 || isRouter(value)) return value;
  const handler = value as Handler;
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}

export function asyncRouter(): Router {
  const router = Router();
  for (const method of ROUTE_METHODS) {
    const original = (router[method] as (...args: unknown[]) => unknown).bind(router);
    (router as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => original(...args.map(wrapHandler));
  }
  return router;
}
