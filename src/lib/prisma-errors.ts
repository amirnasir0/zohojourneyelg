import { Prisma } from '@prisma/client';

const CONNECTION_ERROR_CODES = new Set(['P1017', 'P1001', 'P1008', 'P1002']);

/**
 * True for Prisma errors that mean "the database connection died/dropped",
 * as opposed to a real constraint violation or application bug. Shared
 * between the sync worker's batch retry (src/sync/with-retry.ts) and the
 * request-path error handler (src/server.ts) so both agree on exactly which
 * Prisma error codes count as a connection-class failure.
 */
export function isPrismaConnectionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return CONNECTION_ERROR_CODES.has(err.code);
  }
  return err instanceof Prisma.PrismaClientInitializationError;
}
