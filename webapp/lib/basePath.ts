// Path prefix the app is served under (e.g. "/inleverpuntenviewer" behind the
// prototype.transportlab.app proxy; empty for local dev). Baked in at build
// time; next.config.ts uses the same variable for Next's basePath.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// Prefix an absolute app path ("/data/...", "/api/...") for fetch(), plain
// <a href> and anything else next/link does not handle.
export const withBase = (path: string) => `${BASE_PATH}${path}`;
