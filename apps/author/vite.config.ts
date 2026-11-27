import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { loadSiteContent } from '@selfpage/content-model';
import { buildShellNav } from '@selfpage/site-shell/nav-data';
import { resolvePublicSiteOrigin } from '@selfpage/site-shell/origin';
import { DEFAULT_PREFERENCES, preferenceMetaColorScheme } from '@selfpage/site-shell/preferences';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { resolveBuildEnv, type BuildEnv } from './build-env.ts';

const NAV_MODULE_ID = 'virtual:selfpage-site-nav';
const RESOLVED_NAV_MODULE_ID = `\0${NAV_MODULE_ID}`;

/**
 * Builds the author shell's navigation from the same `content/` tree and the
 * same content-model manifest the public site uses (task 07.5, D29).
 *
 * The author app is a separate origin and cannot fetch the public site's HTML
 * or manifest cross-origin, so the hierarchy is baked in at build time. This
 * keeps one source of truth: the site and the author shell show the same Home
 * sections, Blog years/posts and labels, and `PUBLIC_SITE_ORIGIN` (validated
 * below) is the only place the public origin is configured. Nothing from this
 * module is a secret: it is the public navigation manifest plus a public origin.
 */
function siteNavPlugin(env: BuildEnv): Plugin {
  return {
    name: 'selfpage-site-nav',
    configResolved() {
      // Review P2-4: the effective origin is printed in the build log, and a
      // build without PUBLIC_SITE_ORIGIN says so explicitly instead of silently
      // baking the local default into a non-local artifact.
      const origin = resolvePublicSiteOrigin(env.siteOrigin);
      if (!env.siteOrigin) {
        this.warn(
          'PUBLIC_SITE_ORIGIN is not set; the author shell links to the local default http://localhost:4321. Set it in apps/author/.env.local for any non-local build.',
        );
      }
      this.info(`author shell public site origin: ${origin}`);
    },
    resolveId(id) {
      return id === NAV_MODULE_ID ? RESOLVED_NAV_MODULE_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_NAV_MODULE_ID) {
        return null;
      }
      const contentRoot =
        env.contentRoot || fileURLToPath(new URL('../../content', import.meta.url));
      const siteOrigin = resolvePublicSiteOrigin(env.siteOrigin);
      const loaded = loadSiteContent({
        contentRoot,
        basePath: env.basePath,
        authorOrigin: env.authorOrigin,
      });
      for (const warning of loaded.warnings) {
        this.warn(`${warning.file}: ${warning.message}`);
      }
      const nav = buildShellNav(loaded.manifest, { siteOrigin, newHref: '/new/' });
      const publicBlogUrl = new URL(loaded.manifest.blog.href, `${siteOrigin}/`).toString();
      return [
        `export const shellNav = ${JSON.stringify(nav)};`,
        `export const publicSiteOrigin = ${JSON.stringify(siteOrigin)};`,
        `export const publicBlogUrl = ${JSON.stringify(publicBlogUrl)};`,
        '',
      ].join('\n');
    },
  };
}

/**
 * Task 08 (review P2-6): the author `index.html` is static, so its
 * `color-scheme` meta default is a placeholder rather than a literal copy of
 * the preference model. This replaces it at build/dev time from the same
 * constant the runtime uses, so the no-JS default cannot drift.
 */
function preferenceMetaPlugin(): Plugin {
  const colorScheme = preferenceMetaColorScheme(DEFAULT_PREFERENCES.theme);
  return {
    name: 'selfpage-preference-meta',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string) {
        return html.replaceAll('%PREFERENCE_META_COLOR_SCHEME%', colorScheme);
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  // Review P2-4: `loadEnv` is what makes `.env.local` effective; `process.env`
  // still wins when both set a value.
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const env = resolveBuildEnv(fileEnv, process.env);
  return {
    plugins: [preferenceMetaPlugin(), siteNavPlugin(env), react()],
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
    },
  };
});
