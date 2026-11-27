#!/usr/bin/env node
/**
 * Reads the rendered "Back to Blog" href from a running author client.
 * Used by the independent VITE_PUBLIC_BLOG_URL probe (default / override /
 * invalid fallback). The URL is printed as the last stdout line.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2];
if (!url) {
  console.error('usage: node read-back-link.mjs <author-url>');
  process.exit(2);
}

const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('post-title').waitFor();
  const href = await page.getByTestId('back-to-blog').getAttribute('href');
  console.log(href);
} finally {
  await browser.close();
}
