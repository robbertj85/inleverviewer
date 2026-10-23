import path from 'path';

/**
 * Where the generated data lives on disk for server code.
 *
 * Locally that is webapp/public. In the container the worker writes it to a
 * volume and INLEVER_PUBLIC_DIR points there (see deploy/). The env-only
 * indirection matters: a literal path.join(process.cwd(), 'public', ...) makes
 * the build tracer copy the whole ~90 MB data tree into the standalone server.
 */
const PUBLIC_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.INLEVER_PUBLIC_DIR || 'public');

/** A file at the root of the public dir, e.g. municipalities.json. */
export const publicFile = (...segments: string[]) =>
  path.join(/*turbopackIgnore: true*/ PUBLIC_DIR, ...segments);

/** A file under public/data. */
export const dataFile = (...segments: string[]) =>
  path.join(/*turbopackIgnore: true*/ PUBLIC_DIR, 'data', ...segments);
