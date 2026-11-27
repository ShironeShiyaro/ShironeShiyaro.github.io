import { expect, test } from './console-guard.ts';
import { parse as parseYaml } from 'yaml';
import {
  FIXED_CLOCK,
  TEST_BASE_URL,
  authorize,
  backToEditor,
  chooseMockAuthOutcome,
  chooseMockPublishOutcome,
  continueWithGitHub,
  expectDraftSaved,
  frontMatterOf,
  openApp,
  publishAndWait,
  readDraft,
  resetMock,
  setClock,
  setEditorValue,
  trackRequests,
} from './helpers.ts';

test.beforeEach(async ({ request }) => {
  await resetMock(request);
  await setClock(request, FIXED_CLOCK);
});

test.describe('Markdown publishing', () => {
  test('E05: fixed clock yields the exact front matter and visible Markdown', async ({
    page,
    request,
  }) => {
    await openApp(page);
    await authorize(page);
    await setEditorValue(page, 'title', 'Example Post');
    await setEditorValue(page, 'body', 'Body Markdown stays exactly as the author wrote it.');

    const captured = await publishAndWait(page);
    expect(captured.status).toBe(201);
    const markdown = captured.json.markdown as string;
    expect(markdown).toBe(
      '---\ntitle: Example Post\ndate: 2026-11-23\n---\n\n' +
        '# Example Post\n\n2026-11-23\n\n---\n\n' +
        'Body Markdown stays exactly as the author wrote it.\n',
    );

    const frontMatter = frontMatterOf(markdown);
    const parsed = parseYaml(frontMatter.source) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['date', 'title']);
    expect(parsed.title).toBe('Example Post');
    expect(parsed.date).toBe('2026-11-23');
    expect(frontMatter.visible).toBe(
      '# Example Post\n\n2026-11-23\n\n---\n\nBody Markdown stays exactly as the author wrote it.\n',
    );
    expect(captured.json.date).toBe('2026-11-23');
    expect(captured.json.timestamp).toBe('2026-11-23-23-42-15');

    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    await expect(page.getByText(/deployment is still pending/i)).toBeVisible();
    const statusText = await page.locator('.publish-status').innerText();
    expect(statusText).not.toMatch(/\bis live\b/i);
    expect(statusText).toContain('not live');
    await expect(page.getByTestId('back-to-blog')).toBeVisible();

    await request.post(`${TEST_BASE_URL}/api/mock/logout`);
  });

  test('E06: body Markdown survives CRLF, blank lines, #, lists and code blocks unchanged', async ({
    page,
  }) => {
    const rawBody = [
      '',
      '',
      '# hash line stays literal',
      '',
      '- one',
      '- two',
      '',
      '```ts',
      'const value = "<tag> & `tick`";',
      '```',
      '',
      '',
      '',
    ].join('\r\n');

    await openApp(page);
    await authorize(page);
    await setEditorValue(page, 'title', 'Preserved body');
    await setEditorValue(page, 'body', rawBody);
    const captured = await publishAndWait(page);
    expect(captured.status).toBe(201);

    const normalized = rawBody.replace(/\r\n?/g, '\n');
    const { visible } = frontMatterOf(captured.json.markdown as string);
    const expectedPrefix = '# Preserved body\n\n2026-11-23\n\n---\n\n';
    expect(visible.startsWith(expectedPrefix)).toBe(true);
    expect(visible.slice(expectedPrefix.length)).toBe(normalized);
    expect(visible).toContain('- one\n- two');
    expect(visible).toContain('const value = "<tag> & `tick`";');
    expect(visible.startsWith(`${expectedPrefix}\n\n`)).toBe(true);
    expect(visible.endsWith('\n\n\n')).toBe(true);

    const draft = await readDraft(page);
    // The published content is cleared from storage only when identical; the
    // stored body itself is not rewritten before publish.
    expect(draft === null || draft.body === rawBody).toBe(true);
  });

  test('E07: YAML-unsafe title characters stay in the H1 and add no front matter fields', async ({
    page,
  }) => {
    const title = 'A "B" * <C>';
    await openApp(page);
    await authorize(page);
    await setEditorValue(page, 'title', title);
    await setEditorValue(page, 'body', 'yaml safety');
    const captured = await publishAndWait(page);
    expect(captured.status).toBe(201);

    const frontMatter = frontMatterOf(captured.json.markdown as string);
    const parsed = parseYaml(frontMatter.source) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['date', 'title']);
    expect(parsed.title).toBe(title);
    expect(frontMatter.visible.startsWith(`# ${title}\n\n2026-11-23\n\n---\n\nyaml safety\n`)).toBe(
      true,
    );
    expect((frontMatter.source.match(/^[A-Za-z]+:/gm) ?? []).length).toBe(2);

    // A newline in the title is rejected before any request is sent.
    const publishRequests = trackRequests(page, '/api/mock/publish');
    await backToEditor(page);
    await setEditorValue(page, 'title', 'Injected\nsecret: yes');
    await page.getByTestId('publish-button').click();
    await expect(page.getByText(/single line of plain text/)).toBeVisible();
    expect(publishRequests).toEqual([]);

    // D22: the remaining route-reserved characters are errors, not silent
    // file-name rewrites; quote/star/angle above stay publishable.
    for (const character of [':', '?']) {
      await setEditorValue(page, 'title', `Bad ${character} title`);
      await page.getByTestId('publish-button').click();
      await expect(page.getByText(`Title contains "${character}"`)).toBeVisible();
    }
    expect(publishRequests).toEqual([]);
  });

  test('E05/P1-2: crossing the Asia/Shanghai midnight refreshes the visible date', async ({
    page,
    request,
  }) => {
    await openApp(page);
    // R075-4: the date lives in the editor, which exists only after sign-in.
    await authorize(page);
    await expect(page.getByTestId('post-date')).toHaveText('2026-11-23');
    await setEditorValue(page, 'title', 'Midnight post');
    await setEditorValue(page, 'body', 'Published after midnight.');

    await setClock(request, '2026-11-23T18:42:15Z');
    const captured = await publishAndWait(page);
    expect(captured.status).toBe(201);
    expect(captured.json.date).toBe('2026-11-24');
    expect(captured.json.timestamp).toBe('2026-11-24-02-42-15');
    expect((captured.json.commit as { path: string }).path).toBe(
      'content/blog/2026/Midnight post-2026-11-24-02-42-15.md',
    );
    // D32: the success page shows the written path, which carries the date the
    // server stamped (the editor has already been left).
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    await expect(page.getByTestId('success-panel')).toContainText(
      'content/blog/2026/Midnight post-2026-11-24-02-42-15.md',
    );
  });

  test('P1-2: a window focus refreshes the server-owned date', async ({ page, request }) => {
    await openApp(page);
    await authorize(page);
    await expect(page.getByTestId('post-date')).toHaveText('2026-11-23');
    await setClock(request, '2026-11-23T18:42:15Z');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.getByTestId('post-date')).toHaveText('2026-11-24');
  });

  test('P2: Write another post returns to a fresh editor after a publish', async ({ page }) => {
    await openApp(page);
    await authorize(page);
    await setEditorValue(page, 'title', 'First post');
    await setEditorValue(page, 'body', 'First body');
    const captured = await publishAndWait(page);
    expect(captured.status).toBe(201);
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    expect(await readDraft(page)).toBeNull();

    await page.getByTestId('new-post').click();
    await expect(page.getByTestId('leave-confirm')).toHaveCount(0);
    await expect(page.getByTestId('post-title')).toHaveText('');
    await expect(page.getByTestId('post-body')).toHaveText('');
    expect(await readDraft(page)).toBeNull();
    await expect(page.getByTestId('post-date')).not.toHaveText(/Loading date/);
  });

  test('E12: double click sends one request; dedupe covers three hours; commit and deployment differ', async ({
    page,
    request,
  }) => {
    await openApp(page);
    await authorize(page);
    await setEditorValue(page, 'title', 'Double click');
    await setEditorValue(page, 'body', 'One request only.');
    await expect(page.getByTestId('post-date')).toHaveText('2026-11-23');

    const publishRequests = trackRequests(page, '/api/mock/publish');
    const savedDraft = await expectDraftSaved(page);
    const firstResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/api/mock/publish') && response.request().method() === 'POST',
    );
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="publish-button"]');
      button?.click();
      button?.click();
    });
    const firstResponse = await firstResponsePromise;
    const first = (await firstResponse.json()) as Record<string, unknown> & {
      commit: { sha: string };
    };
    expect(firstResponse.status()).toBe(201);
    expect(publishRequests).toHaveLength(1);
    const firstSha = first.commit.sha;
    expect(first.status).toBe('committed');
    expect(first.deployment).toMatchObject({ status: 'pending' });
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();

    // A debounce armed just before the response must not re-create the draft.
    await page.waitForTimeout(800);
    expect(await readDraft(page)).toBeNull();

    // D32: the success page has no second Publish action, so the 3-hour dedupe
    // contract is exercised through the same endpoint with the same draft id and
    // content (what the old editor sent on a repeated explicit click).
    const publishAgain = () =>
      request.post(`${TEST_BASE_URL}/api/mock/publish`, {
        data: { title: 'Double click', body: 'One request only.', draftId: savedDraft.draftId },
      });

    const duplicate = await publishAgain();
    expect(duplicate.status()).toBe(200);
    const duplicateJson = (await duplicate.json()) as {
      status: string;
      commit: { sha: string };
    };
    expect(duplicateJson.status).toBe('duplicate_ignored');
    expect(duplicateJson.commit.sha).toBe(firstSha);

    // Exactly three hours after the first commit, an explicit publish creates a
    // new timestamped article.
    await setClock(request, '2026-11-23T18:42:15Z');
    const later = await publishAgain();
    expect(later.status()).toBe(201);
    const laterJson = (await later.json()) as {
      status: string;
      timestamp: string;
      commit: { sha: string; path: string };
    };
    expect(laterJson.status).toBe('committed');
    expect(laterJson.timestamp).toBe('2026-11-24-02-42-15');
    expect(laterJson.commit.sha).not.toBe(firstSha);
    expect(laterJson.commit.path).toBe(
      'content/blog/2026/Double click-2026-11-24-02-42-15.md',
    );
    // Commit success is not deployment success; the first success page still
    // shows the pending deployment written for that commit.
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    await expect(page.getByText(/deployment is still pending/i)).toBeVisible();
    expect(publishRequests).toHaveLength(1);
  });

  test('E13: editing while a publish is pending keeps the newer draft', async ({ page }) => {
    await openApp(page);
    await authorize(page);
    await chooseMockPublishOutcome(page, 'slow');
    await setEditorValue(page, 'title', 'Race draft');
    await setEditorValue(page, 'body', 'Original body');

    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('/api/mock/publish') && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Publishing…' })).toBeVisible();

    const body = page.getByTestId('post-body');
    await body.evaluate((element) => {
      element.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.insertText(' edited while waiting');

    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const published = (await response.json()) as {
      markdown: string;
      status: string;
    };
    expect(published.markdown.endsWith('Original body\n')).toBe(true);
    expect(published.markdown).not.toContain('edited while waiting');

    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    await expect(page.getByText('A newer edit was kept in this browser.')).toBeVisible();
    // D33: the kept newer draft is protected when leaving the success page.
    await page.getByTestId('new-post').click();
    await expect(page.getByTestId('leave-confirm')).toBeVisible();
    await page.getByTestId('leave-accept').click();
    await expect(page.getByTestId('post-body')).toHaveText('Original body edited while waiting');
    const draft = await expectDraftSaved(page);
    expect(draft.body).toBe('Original body edited while waiting');
  });

  test('E11: every mock failure reaches an English terminal state with Back and keeps the draft', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);

    const failureOutcomes: Array<[string, string]> = [
      ['conflict', 'Publishing conflict'],
      ['rate_limited', 'Rate limit reached'],
      ['server_error', 'Publishing failed'],
      ['timeout', 'Publishing timed out'],
      ['permission_denied', 'Permission denied'],
    ];

    let conflictRequests = 0;
    for (const [outcome, heading] of failureOutcomes) {
      await setEditorValue(page, 'title', `Failure ${outcome}`);
      await setEditorValue(page, 'body', `Draft for ${outcome}`);
      await chooseMockPublishOutcome(page, outcome);
      const before = trackRequests(page, '/api/mock/publish');
      const startedAt = Date.now();
      await page.getByTestId('publish-button').click();
      await expect(page.getByRole('heading', { name: heading })).toBeVisible({ timeout: 15_000 });
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(before).toHaveLength(1);
      await expect(page.getByTestId('status-back')).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectDraftSaved(page);

      if (outcome === 'conflict') {
        conflictRequests = before.length;
        await page.waitForTimeout(1_200);
        expect(before).toHaveLength(conflictRequests);
      }
    }

    // Expired authorization clears the session and offers reauthorization.
    await setEditorValue(page, 'title', 'Failure expired');
    await setEditorValue(page, 'body', 'Draft for expired');
    await chooseMockPublishOutcome(page, 'expired');
    await page.getByTestId('publish-button').click();
    // R075-4: the cleared session turns the page back into the expired gate,
    // so there is no publish panel any more — only the auth Back link.
    await expect(page.getByText(/Your GitHub authorization expired/)).toBeVisible();
    await expect(page.getByTestId('auth-status-back')).toHaveCount(1);
    await expect(page.getByTestId('status-back')).toHaveCount(0);
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expectDraftSaved(page);

    // A dropped connection reaches the offline terminal instead of hanging.
    await continueWithGitHub(page);
    await expect(page.getByTestId('logout-button')).toBeVisible();
    await setEditorValue(page, 'title', 'Failure offline');
    await setEditorValue(page, 'body', 'Draft for offline');
    await chooseMockPublishOutcome(page, 'auto');
    await page.route('**/api/mock/publish', (route) => route.abort());
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Connection problem' })).toBeVisible();
    await expect(page.locator('.publish-status').getByTestId('status-back')).toBeVisible();
    await expectDraftSaved(page);
    await page.unroute('**/api/mock/publish');
    await page.getByTestId('publish-retry').click();
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();

    // Commit success is not deployment success.
    await backToEditor(page);
    await setEditorValue(page, 'title', 'Deployment failed');
    await setEditorValue(page, 'body', 'Commit exists.');
    await chooseMockPublishOutcome(page, 'deploy_failed');
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Commit created, deployment failed' })).toBeVisible();
    await expect(page.getByText(/not live/i)).toBeVisible();
    await expect(page.getByTestId('back-to-blog')).toBeVisible();

    await backToEditor(page);
    await setEditorValue(page, 'title', 'Deployment unconfirmed');
    await setEditorValue(page, 'body', 'Commit exists too.');
    await chooseMockPublishOutcome(page, 'deploy_unconfirmed');
    await page.getByTestId('publish-button').click();
    await expect(
      page.getByRole('heading', { name: 'Commit created, deployment unconfirmed' }),
    ).toBeVisible();
    await expect(page.getByText(/could not be confirmed/i)).toBeVisible();
    await expect(page.getByTestId('back-to-blog')).toBeVisible();
  });

  test('E09: no client secret, token, OAuth state or verifier is stored or returned', async ({
    page,
    request,
  }) => {
    const requestBodies: string[] = [];
    const responseBodies: string[] = [];
    page.on('request', (captured) => {
      const data = captured.postData();
      if (data) {
        requestBodies.push(data);
      }
    });
    page.on('response', async (response) => {
      if (response.url().includes('/api/')) {
        try {
          responseBodies.push(await response.text());
        } catch {
          // redirects/non-text responses are irrelevant here
        }
      }
    });

    await openApp(page);
    await authorize(page);
    await setEditorValue(page, 'title', 'Secret scan');
    await setEditorValue(page, 'body', 'No secrets anywhere.');
    await expectDraftSaved(page);

    const storage = await page.evaluate(() => {
      const entries: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key !== null) {
          entries[key] = localStorage.getItem(key) ?? '';
        }
      }
      return entries;
    });
    for (const [key, value] of Object.entries(storage)) {
      expect(key).toBe('selfpage:author:draft');
      const parsed = JSON.parse(value) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(
        ['body', 'draftId', 'schemaVersion', 'title', 'updatedAt'].sort(),
      );
    }

    await publishAndWait(page);
    await page.waitForTimeout(500);

    const html = await page.content();
    const scripts = await page
      .locator('script[src]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('src') ?? ''));
    const scriptBodies: string[] = [];
    for (const source of scripts.filter(Boolean)) {
      const response = await request.get(new URL(source, TEST_BASE_URL).toString());
      expect(response.status()).toBe(200);
      scriptBodies.push(await response.text());
    }

    const haystack = [
      JSON.stringify(storage),
      html,
      ...requestBodies,
      ...responseBodies,
      ...scriptBodies,
    ].join('\n');
    expect(haystack).not.toMatch(/client_secret/i);
    expect(haystack).not.toMatch(/code_verifier/i);
    expect(haystack).not.toMatch(/access_token/i);
    expect(haystack).not.toMatch(/ghu_/);
    expect(haystack).not.toMatch(/github_pat_/);
    expect(haystack).not.toMatch(/oauth_state/i);
  });
});
