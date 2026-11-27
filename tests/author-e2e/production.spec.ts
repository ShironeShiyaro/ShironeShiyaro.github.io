import { expect, test } from './console-guard.ts';
import { PROD_BASE_URL } from './helpers.ts';

test.describe('production isolation', () => {
  test('E15: mock publish and test clock are JSON 404 in a production-mode Worker', async ({
    request,
  }) => {
    const cases: Array<[string, 'GET' | 'POST', Record<string, unknown>?]> = [
      ['/api/mock/publish', 'POST', { title: 'x', body: 'y', draftId: 'z' }],
      ['/api/test/clock', 'POST', { now: '2026-11-23T15:42:15Z' }],
      ['/api/mock/session', 'GET'],
      ['/api/mock/auth', 'POST', { outcome: 'authorized' }],
      ['/api/test/reset', 'POST', {}],
    ];

    for (const [path, method, data] of cases) {
      const response = await request.fetch(`${PROD_BASE_URL}${path}`, {
        method,
        data,
      });
      expect(response.status(), `${method} ${path}`).toBe(404);
      expect(response.headers()['content-type']).toContain('application/json');
      await expect(response.json()).resolves.toEqual({ error: 'not_found' });
    }
  });

  test('E15: the production UI offers no mock authorization or publishing surface', async ({
    page,
  }) => {
    await page.goto(PROD_BASE_URL);
    // R075-4: the production Worker has no author session here, so the gate is
    // the only surface; there is no editor to edit and no mock control.
    await expect(page.getByText(/GitHub authorization is not available in this build/)).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('mock-controls')).toHaveCount(0);
    await expect(page.getByTestId('auth-status-back')).toBeVisible();
  });

  test('P2-3: the served mode hint keeps the client off the mock endpoints', async ({ page }) => {
    const mockRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/mock/')) {
        mockRequests.push(request.url());
      }
    });
    await page.goto(PROD_BASE_URL);
    await expect(page.getByText(/GitHub authorization is not available in this build/)).toBeVisible();
    // The meta tag the Worker injects (one for the mock worker, one here).
    await expect(page.locator('meta[name="selfpage-author-mode"]')).toHaveAttribute(
      'content',
      'github',
    );
    // No `/api/mock/session` probe in a real deployment: no 404 console noise.
    await page.waitForTimeout(500);
    expect(mockRequests, 'no mock-endpoint request in production mode').toEqual([]);
  });

  test('P2-1: favicons are served as images and linked from the app HTML', async ({ page, request }) => {
    for (const path of ['/', '/new/success']) {
      await page.goto(`${PROD_BASE_URL}${path}`);
      const icons = await page
        .locator('link[rel="icon"]')
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('href')));
      expect(icons, `${path} links both placeholder icons`).toEqual(
        expect.arrayContaining(['/favicon.svg', '/favicon.ico']),
      );
    }

    const svg = await request.get(`${PROD_BASE_URL}/favicon.svg`);
    expect(svg.status()).toBe(200);
    expect(svg.headers()['content-type']).toContain('image/svg+xml');

    const ico = await request.get(`${PROD_BASE_URL}/favicon.ico`);
    expect(ico.status()).toBe(200);
    const icoType = ico.headers()['content-type'] ?? '';
    // Never the SPA fallback: `/favicon.ico` must not come back as HTML.
    expect(icoType).not.toContain('text/html');
    expect(/image\/(x-icon|vnd\.microsoft\.icon)/u.test(icoType), icoType).toBe(true);
  });
});
