import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { DEFAULT_SITE_URL, normalizeBasePath } from '@selfpage/content-model';

const site = process.env.SITE_URL?.trim() || DEFAULT_SITE_URL;
const base = normalizeBasePath(process.env.BASE_PATH);

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  integrations: [react()],
});
