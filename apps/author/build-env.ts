/**
 * Build-time environment resolution for the author app (review P2-4).
 *
 * Vite loads `.env`, `.env.local`, `.env.[mode]` and `.env.[mode].local` into
 * `loadEnv()` (and exposes `VITE_*` to the client), but **not** into
 * `process.env`. Reading `process.env.PUBLIC_SITE_ORIGIN` therefore missed
 * `.env.local` and silently baked the default localhost origin into a build.
 * This module is the single place that merges both sources; a real process
 * environment variable still wins over a file value.
 */
export interface BuildEnv {
  siteOrigin: string | undefined;
  contentRoot: string | undefined;
  basePath: string | undefined;
  authorOrigin: string | undefined;
}

export function resolveBuildEnv(
  fileEnv: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): BuildEnv {
  // Windows editors commonly save `.env.local` with a UTF-8 BOM; Vite's dotenv
  // parser keeps it on the first key, which would silently hide
  // PUBLIC_SITE_ORIGIN. Normalise keys and values before looking anything up.
  const files: Record<string, string> = {};
  for (const [key, value] of Object.entries(fileEnv)) {
    files[key.replace(/^\uFEFF/, '')] = value.replace(/^\uFEFF/, '');
  }
  const pick = (name: string): string | undefined => {
    const fromProcess = processEnv[name]?.replace(/^\uFEFF/, '').trim();
    if (fromProcess) return fromProcess;
    return files[name]?.trim() || undefined;
  };
  return {
    siteOrigin: pick('PUBLIC_SITE_ORIGIN'),
    contentRoot: pick('SELF_PAGE_CONTENT_ROOT'),
    basePath: pick('BASE_PATH'),
    authorOrigin: pick('PUBLIC_AUTHOR_ORIGIN'),
  };
}
