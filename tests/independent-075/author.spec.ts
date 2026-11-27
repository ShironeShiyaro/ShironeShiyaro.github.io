import { expect, test, type Page } from '@playwright/test';
import {
  AUTHOR_URL,
  SITE_URL,
  DRAFT_KEY,
  authorizeIfNeeded,
  drawerScrollTop,
  editorText,
  ensureDrawer,
  fillDraft,
  openAnonymous,
  openAuthorized,
  readDraft,
  readShellLinks,
  readTopbar,
  resetEnvironment,
  screenshot,
  setEditorValue,
  waitForDraftSaved,
  writeEvidence,
} from './helpers';

const SITE = SITE_URL;
const AUTHOR = AUTHOR_URL;

async function setMockOutcome(page: Page, testId: string, value: string): Promise<void> {
  const details = page.getByTestId('mock-controls');
  const open = await details.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!open) {
    await details.locator('summary').click();
  }
  await page.getByTestId(testId).selectOption(value);
}

interface PublishCapture {
  status: number;
  json: Record<string, unknown>;
}

async function publish(page: Page): Promise<PublishCapture> {
  await expect(page.getByTestId('publish-button')).toBeEnabled();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/mock/publish') && response.request().method() === 'POST',
  );
  await page.getByTestId('publish-button').click();
  const response = await responsePromise;
  return { status: response.status(), json: (await response.json()) as Record<string, unknown> };
}

async function publishSuccess(page: Page, title: string, body: string): Promise<PublishCapture> {
  await fillDraft(page, title, body);
  await waitForDraftSaved(page);
  const result = await publish(page);
  await page.waitForURL(`${AUTHOR}/new/success`);
  return result;
}

async function openLeaveDialog(page: Page): Promise<void> {
  await ensureDrawer(page, true);
  await page.locator('[data-nav-key="publications"]').click();
  await expect(page.getByTestId('leave-confirm')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await resetEnvironment(request);
});

test.describe('X01 shell parity between the two origins', () => {
  test('top bar, sidebar geometry, hierarchy labels and origins match', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${SITE}/blog/`);
    await ensureDrawer(page, true);
    await page.locator('[data-year-toggle][data-year="2025"]').click();
    await expect(page.locator('[data-year-toggle][data-year="2025"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const siteBlog = await readTopbar(page);
    const siteLinks = await readShellLinks(page);
    const siteYearLinks = await page.$$eval('[data-year-toggle]', (links) =>
      links.map((link) => ({ year: (link as HTMLElement).dataset.year, href: (link as HTMLAnchorElement).href })),
    );
    const sitePosts = await page.$$eval('[data-nav-year="2025"] .site-nav__post-link', (links) =>
      links.map((link) => ({
        text: link.textContent?.trim() ?? '',
        href: (link as HTMLAnchorElement).href,
        rect: (() => {
          const box = link.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        })(),
      })),
    );

    await page.goto(`${SITE}/`);
    await ensureDrawer(page, true);
    const siteHomeLinks = await readShellLinks(page);

    await page.goto(`${AUTHOR}/new/`);
    await authorizeIfNeeded(page);
    await ensureDrawer(page, true);
    await page.locator('[data-year-toggle][data-year="2025"]').click();
    await expect(page.locator('[data-year-toggle][data-year="2025"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const author = await readTopbar(page);
    const authorLinks = await readShellLinks(page);
    const authorPosts = await page.$$eval('[data-nav-year="2025"] .site-nav__post-link', (links) =>
      links.map((link) => ({
        text: link.textContent?.trim() ?? '',
        href: (link as HTMLAnchorElement).href,
        rect: (() => {
          const box = link.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        })(),
      })),
    );

    expect(author.topbar.height).toBeCloseTo(siteBlog.topbar.height, 0);
    expect(author.topbar.y).toBeCloseTo(siteBlog.topbar.y, 0);
    expect(author.topbar.width).toBeCloseTo(siteBlog.topbar.width, 0);
    expect(author.menu.x).toBeCloseTo(siteBlog.menu.x, 0);
    expect(author.menu.y).toBeCloseTo(siteBlog.menu.y, 0);
    expect(author.menu.width).toBeCloseTo(siteBlog.menu.width, 0);
    expect(author.menu.height).toBeCloseTo(siteBlog.menu.height, 0);
    expect(author.brand.x).toBeCloseTo(siteBlog.brand.x, 0);
    expect(author.brand.y).toBeCloseTo(siteBlog.brand.y, 0);
    expect(author.brand.text).toBe(siteBlog.brand.text);
    expect(author.drawer.width).toBeCloseTo(siteBlog.drawer.width, 0);
    expect(author.drawer.width / 1280, 'sidebar is 19.4% of the viewport').toBeGreaterThan(0.192);
    expect(author.drawer.width / 1280).toBeLessThan(0.196);
    expect(siteBlog.drawer.width / 1280, 'public sidebar is 19.4% of the viewport').toBeGreaterThan(
      0.192,
    );
    expect(siteBlog.drawer.width / 1280).toBeLessThan(0.196);

    expect(author.brandWrap).toBe('normal');

    const settings = await page.locator('[data-settings-slot]').evaluate((element) => ({
      tag: element.tagName,
      href: element.getAttribute('href'),
      tabindex: element.getAttribute('tabindex'),
      text: element.textContent?.trim() ?? '',
    }));
    expect(settings).toEqual({ tag: 'SPAN', href: null, tabindex: null, text: 'Settings' });

    // Labels/hrefs: the shared nav model, not just the shared CSS.
    const levelOne = (links: typeof siteLinks) =>
      links
        .filter((link) => ['Home', 'Publications', 'Blog'].includes(link.text))
        .map((link) => `${link.text}|${link.absolute}`)
        .sort();
    expect(levelOne(authorLinks)).toEqual(levelOne(siteLinks));
    const homeChildren = (links: typeof siteLinks) =>
      links
        .filter((link) => ['About Me', 'Education', 'Skills', 'Projects'].includes(link.text))
        .map((link) => `${link.text}|${link.absolute}`)
        .sort();
    expect(homeChildren(authorLinks)).toEqual(homeChildren(siteHomeLinks));
    expect(siteYearLinks.map((link) => link.href).sort()).toEqual(
      [`${SITE}/blog/#year-2025`, `${SITE}/blog/#year-2026`].sort(),
    );
    expect(
      await page.$$eval('[data-year-toggle]', (links) =>
        links.map((link) => (link as HTMLAnchorElement).href),
      ),
    ).toEqual(siteYearLinks.map((link) => link.href));
    expect(authorPosts.map(({ text, href }) => ({ text, href }))).toEqual(
      sitePosts.map(({ text, href }) => ({ text, href })),
    );
    expect(authorPosts.map((post) => post.rect.height)).toEqual(
      sitePosts.map((post) => post.rect.height),
    );
    for (const [index, post] of authorPosts.entries()) {
      const sitePost = sitePosts[index];
      if (!sitePost) continue;
      expect(post.rect.x, `level-3 row ${index} x`).toBeCloseTo(sitePost.rect.x, 0);
      expect(post.rect.width, `level-3 row ${index} width`).toBeCloseTo(sitePost.rect.width, 0);
    }

    const newLinks = authorLinks.filter((link) => link.text.includes('New!'));
    expect(newLinks).toHaveLength(1);
    expect(newLinks[0]?.absolute).toBe(`${AUTHOR}/new/`);
    const siteOrigin = new URL(SITE).origin;
    const authorOrigin = new URL(AUTHOR).origin;
    const stray = authorLinks.filter((link) => {
      const url = new URL(link.absolute);
      const isNewRoute = url.origin === authorOrigin && url.pathname === '/new/';
      return url.origin !== siteOrigin && !isNewRoute;
    });
    expect(stray, 'every author link points at PUBLIC_SITE_ORIGIN except New!').toEqual([]);
    expect(authorLinks.some((link) => link.absolute.includes(':4321'))).toBe(false);
    expect(siteLinks.some((link) => link.absolute.includes(':4321'))).toBe(false);
    expect(
      siteLinks
        .filter((link) => new URL(link.absolute).origin !== siteOrigin)
        .map((link) => link.absolute),
      'the only cross-origin link on the public site is New!',
    ).toEqual([`${AUTHOR}/new/`]);

    // Narrow overlay behaviour: same shell, no article shift, modal attributes.
    const narrow: Record<string, unknown> = {};
    for (const origin of ['site', 'author'] as const) {
      await page.setViewportSize({ width: 390, height: 844 });
      if (origin === 'site') {
        await page.goto(`${SITE}/blog/`);
      } else {
        await page.goto(`${AUTHOR}/new/`);
        await authorizeIfNeeded(page);
      }
      await ensureDrawer(page, true);
      const topbar = await readTopbar(page);
      const modal = await page.locator('#site-drawer').evaluate((element) => ({
        role: element.getAttribute('role'),
        ariaModal: element.getAttribute('aria-modal'),
        mainX: document.querySelector('main')?.getBoundingClientRect().x ?? -1,
        mainWidth: document.querySelector('main')?.getBoundingClientRect().width ?? -1,
        mainInert: document.querySelector('main')?.hasAttribute('inert') ?? false,
      }));
      narrow[origin] = { topbar, modal };
      await screenshot(page, `x01-narrow-${origin}.png`);
    }
    const siteNarrow = narrow.site as { topbar: typeof author; modal: Record<string, unknown> };
    const authorNarrow = narrow.author as { topbar: typeof author; modal: Record<string, unknown> };
    expect(siteNarrow.modal.role).toBe('dialog');
    expect(authorNarrow.modal.role).toBe('dialog');
    expect(siteNarrow.modal.ariaModal).toBe('true');
    expect(authorNarrow.modal.ariaModal).toBe('true');
    expect(siteNarrow.modal.mainX).toBe(0);
    expect(authorNarrow.modal.mainX).toBe(0);
    expect(siteNarrow.modal.mainWidth).toBe(390);
    expect(authorNarrow.modal.mainWidth).toBe(390);
    expect(authorNarrow.topbar.topbar.height).toBeCloseTo(siteNarrow.topbar.topbar.height, 0);
    expect(authorNarrow.topbar.menu.x).toBeCloseTo(siteNarrow.topbar.menu.x, 0);

    await screenshot(page, 'x01-author-narrow-open.png');
    writeEvidence('x01-shell-geometry.json', {
      site: { topbar: siteBlog, links: siteLinks, homeLinks: siteHomeLinks, years: siteYearLinks, posts: sitePosts },
      author: { topbar: author, links: authorLinks, posts: authorPosts },
      narrow,
    });
  });
});

test.describe('X02 New! entry', () => {
  test('anonymous gets only the short explanation, Continue and Back', async ({ page }) => {
    await openAnonymous(page);
    const text = await page.locator('.author-page').innerText();
    expect(text).toContain('This page is where Xinyang Zeng writes Blog posts');
    expect(text).toContain('Continue with GitHub');
    expect(text).toContain('Back to Blog');
    expect(text).not.toMatch(/how to write|tutorial|getting started|step 1/i);
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expect(page.getByTestId('back-to-blog')).toHaveAttribute('href', `${SITE}/blog/`);
    await expect(page.locator('.post-editor')).toHaveCount(0);
    await expect(page.locator('[data-testid="post-title"]')).toHaveCount(0);
    await expect(page.locator('.publish-actions')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('discard-button')).toHaveCount(0);
    await expect(page.getByTestId('preview-toggle')).toHaveCount(0);
    await expect(page.getByTestId('logout-button')).toHaveCount(0);
    await expect(page.getByTestId('mock-controls')).toHaveCount(0);
    const visibleButtons = await page.locator('button:visible').allInnerTexts();
    expect(visibleButtons.map((label) => label.trim())).toEqual(['Menu', 'Continue with GitHub']);
    await screenshot(page, 'x02-anonymous.png');
    writeEvidence('x02-anonymous.json', { text, visibleButtons });
  });

  test('nothing navigates to OAuth on its own within 30 seconds', async ({ page }) => {
    await openAnonymous(page);
    const authRequests: string[] = [];
    let navigations = 0;
    page.on('request', (request) => {
      if (request.url().includes('/auth/') || request.url().includes('/api/mock/auth')) {
        authRequests.push(`${request.method()} ${request.url()}`);
      }
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    const startUrl = page.url();
    await page.waitForTimeout(30_000);
    expect(authRequests, 'no automatic OAuth request').toEqual([]);
    expect(navigations, 'no automatic navigation').toBe(0);
    expect(page.url()).toBe(startUrl);
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    writeEvidence('x02-autoauth.json', { authRequests, navigations, startUrl, endUrl: page.url() });
  });

  test('authorized enters the editor directly and the draft survives login/logout', async ({ page }) => {
    await openAnonymous(page);
    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('logout-button')).toBeVisible();
    await expect(page.getByTestId('post-title')).toBeVisible();
    await expect(page.locator('.status-panel--auth')).toHaveCount(0);
    await fillDraft(page, 'Draft across login', 'Body kept across a logout and login round trip.');
    await waitForDraftSaved(page);
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    expect((await readDraft(page))?.title).toBe('Draft across login');
    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('post-title')).toBeVisible();
    expect((await editorText(page)).title).toBe('Draft across login');

    await page.goto(`${AUTHOR}/new/`);
    await expect(page.getByTestId('post-title')).toBeVisible();
    await expect(page.getByTestId('auth-continue')).toHaveCount(0);
    await screenshot(page, 'x02-authorized.png');
    writeEvidence('x02-authorized.json', { url: page.url(), draft: await readDraft(page) });
  });
});

test.describe('X03 editor actions', () => {
  test('only Publish / Delete draft / Preview; Delete draft confirms, Escape cancels, no network write', async ({
    page,
  }) => {
    await openAuthorized(page);
    const actions = await page.locator('.publish-actions button').allInnerTexts();
    expect(actions.map((label) => label.trim())).toEqual(['Publish', 'Delete draft', 'Preview']);
    await screenshot(page, 'x03-actions.png');

    await fillDraft(page, 'Delete draft probe', 'Body that must survive Escape and disappear on confirm.');
    await waitForDraftSaved(page);
    await page.getByTestId('discard-button').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.locator('#confirm-heading').innerText()).toBe('Delete this draft?');
    const buttons = await dialog.locator('button').allInnerTexts();
    expect(buttons.map((label) => label.trim())).toEqual(['Delete draft', 'Keep editing']);
    await expect(page.getByTestId('discard-confirm')).toBeFocused();
    await screenshot(page, 'x03-delete-confirm.png');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await readDraft(page))?.title).toBe('Delete draft probe');
    await expect(page.getByTestId('discard-button')).toBeFocused();

    await page.getByTestId('discard-button').click();
    const writes: string[] = [];
    page.on('request', (request) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        writes.push(`${request.method()} ${request.url()}`);
      }
    });
    await page.getByTestId('discard-confirm').click();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(writes, 'deleting a local draft performs no network write').toEqual([]);
    expect(await readDraft(page)).toBeNull();
    expect((await editorText(page)).title).toBe('');
    expect((await editorText(page)).body).toBe('');
    expect(await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY)).toBeNull();
    writeEvidence('x03-delete-network.json', { actions, writes, draftCleared: true });
  });
});

test.describe('X05 success page', () => {
  test('publish lands on /new/success with the shell, commit id, deployment status and both exits', async ({
    page,
  }) => {
    await openAuthorized(page);
    const captured = await publishSuccess(
      page,
      'Independent success flow',
      'The success page must show a commit and a separate deployment status.',
    );
    expect(captured.status).toBe(201);
    await expect(page.locator('.top-bar')).toBeVisible();
    await expect(page.locator('#site-drawer')).toHaveCount(1);
    await expect(page.locator('#success-heading')).toHaveText('Commit created');
    const sha = String((captured.json.commit as { sha?: string } | undefined)?.sha ?? '');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const panel = page.getByTestId('success-panel');
    const panelText = await panel.innerText();
    expect(panelText).toContain(`Commit ${sha.slice(0, 12)}`);
    expect(panelText).toContain('File: content/blog/2026/Independent success flow-2026-11-23-23-42-15.md');
    expect(panelText).toContain('Deployment status: Pending.');
    expect(panelText).toContain('A commit is not a deployment');
    await expect(page.getByTestId('new-post')).toHaveAttribute('href', '/new/');
    await expect(page.getByTestId('back-to-blog')).toHaveAttribute('href', `${SITE}/blog/`);
    await expect(page.getByTestId('check-deployment')).toBeVisible();
    await expect(page.getByTestId('view-commit')).toHaveCount(0);
    await expect(page.getByTestId('view-actions')).toHaveCount(0);
    expect(panelText).toContain('this environment has no GitHub commit URL');
    await screenshot(page, 'x05-success.png');

    await page.reload();
    await expect(page.locator('#success-heading')).toHaveText('Commit created');
    await expect(page.getByTestId('success-panel')).toContainText(`Commit ${sha.slice(0, 12)}`);
    await screenshot(page, 'x05-success-refresh.png');
    writeEvidence('x05-success.json', { status: captured.status, sha, panelText, url: page.url() });
  });

  test('direct access without state degrades to a clear page with a Blog exit', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${AUTHOR}/new/success`);
    await expect(page.locator('#success-heading')).toHaveText('No publication result to show');
    await expect(page.getByTestId('new-post')).toHaveAttribute('href', '/new/');
    await expect(page.getByTestId('back-to-blog')).toHaveAttribute('href', `${SITE}/blog/`);
    await page.reload();
    await expect(page.locator('#success-heading')).toHaveText('No publication result to show');
    expect(errors).toEqual([]);
    await screenshot(page, 'x05-success-nostate.png');
    writeEvidence('x05-nostate.json', { url: page.url(), errors });
  });

  for (const [outcome, heading, status] of [
    ['deploy_failed', 'Commit created, deployment failed', 'Failed'],
    ['deploy_unconfirmed', 'Commit created, deployment unconfirmed', 'Unconfirmed'],
  ] as const) {
    test(`${outcome} renders its own deployment status`, async ({ page }) => {
      await openAuthorized(page);
      await setMockOutcome(page, 'mock-publish-outcome', outcome);
      await publishSuccess(
        page,
        `Independent ${outcome} probe`,
        'Deployment status must be reported separately from the commit.',
      );
      await expect(page.locator('#success-heading')).toHaveText(heading);
      await expect(page.getByTestId('deployment-status')).toHaveText(status);
      await screenshot(page, `x05-${outcome}.png`);
      writeEvidence(`x05-${outcome}.json`, {
        heading,
        status,
        panel: await page.getByTestId('success-panel').innerText(),
      });
    });
  }

  test('a failed publish stays on the editor and keeps the draft', async ({ page }) => {
    await openAuthorized(page);
    await fillDraft(page, 'Publish failure probe', 'This body must remain after a server error.');
    await waitForDraftSaved(page);
    await setMockOutcome(page, 'mock-publish-outcome', 'server_error');
    const response = await publish(page);
    expect(response.status).toBe(500);
    await expect(page.locator('#success-heading')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/new/');
    await expect(page.getByTestId('post-title')).toHaveText('Publish failure probe');
    expect((await readDraft(page))?.body).toContain('This body must remain');
    await expect(page.getByRole('heading', { name: 'Publishing failed' })).toBeVisible();
    await screenshot(page, 'x05-failure.png');
    writeEvidence('x05-failure.json', {
      status: response.status,
      url: page.url(),
      draft: await readDraft(page),
    });
  });

  test('Check deployment is bounded and leaves an explicit terminal state', async ({ page }) => {
    await openAuthorized(page);
    await publishSuccess(page, 'Independent deployment check', 'Deployment check must not hang.');
    const started = Date.now();
    const responsePromise = page.waitForResponse((response) =>
      response.url().includes('/api/deployments/'),
    );
    await page.getByTestId('check-deployment').click();
    const response = await responsePromise;
    await expect(page.getByTestId('recheck-deployment')).toBeVisible({ timeout: 5_000 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000);
    await expect(page.getByTestId('deployment-status')).toBeVisible();
    await screenshot(page, 'x05-deployment-check.png');
    writeEvidence('x05-deploy-check.json', {
      status: response.status(),
      elapsedMs: elapsed,
      deploymentStatus: await page.getByTestId('deployment-status').innerText(),
      recheckVisible: await page.getByTestId('recheck-deployment').isVisible(),
    });
  });
});

test.describe('X06 unpublished draft leave confirmation', () => {
  test('in-app navigation shows Leave/Stay, Escape=Stay, focus is constrained and restored', async ({
    page,
  }) => {
    await openAuthorized(page);
    await fillDraft(page, 'Leave confirmation probe', 'Draft that must survive Stay and Escape.');
    await waitForDraftSaved(page);

    await openLeaveDialog(page);
    const dialog = page.getByTestId('leave-confirm');
    await expect(dialog).toBeVisible();
    expect(await dialog.locator('#leave-heading').innerText()).toBe(
      'You have an unpublished draft. Leave anyway?',
    );
    const buttons = await dialog.locator('button').allInnerTexts();
    expect(buttons.map((label) => label.trim())).toEqual(['Leave', 'Stay']);
    await expect(page.getByTestId('leave-stay')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('leave-accept')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('leave-stay')).toBeFocused();
    await screenshot(page, 'x06-leave.png');

    const url = page.url();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(page.url()).toBe(url);
    expect((await readDraft(page))?.title).toBe('Leave confirmation probe');
    await expect(page.locator('[data-nav-key="publications"]')).toBeFocused();

    await openLeaveDialog(page);
    await page.getByTestId('leave-stay').click();
    await expect(dialog).toHaveCount(0);
    expect(page.url()).toBe(url);
    expect((await readDraft(page))?.title).toBe('Leave confirmation probe');

    await openLeaveDialog(page);
    await page.getByTestId('leave-accept').click();
    await page.waitForURL(`${SITE}/publications/`);
    expect(new URL(page.url()).pathname).toBe('/publications/');
    await page.goto(`${AUTHOR}/new/`);
    await authorizeIfNeeded(page);
    await expect(page.getByTestId('post-title')).toHaveText('Leave confirmation probe');
    writeEvidence('x06-leave.json', { url, buttons, draft: await readDraft(page) });
  });

  test('reloading the page gets the native beforeunload prompt and restores the draft', async ({
    page,
  }) => {
    await openAuthorized(page);
    await fillDraft(page, 'Beforeunload probe', 'Draft that must survive a cancelled reload.');
    await waitForDraftSaved(page);

    let dialogType = '';
    page.once('dialog', async (dialog) => {
      dialogType = dialog.type();
      await dialog.accept();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(dialogType, 'refresh shows the browser-native beforeunload dialog').toBe('beforeunload');
    await expect(page.getByTestId('post-title')).toHaveText('Beforeunload probe');
    expect((await readDraft(page))?.title).toBe('Beforeunload probe');
    await screenshot(page, 'x06-beforeunload-after-reload.png');

    // Dismissing the prompt must cancel the cross-page navigation and keep the
    // draft. The navigation promise is bounded so a cancelled navigation does
    // not block the test.
    let dismissedType = '';
    page.once('dialog', async (dialog) => {
      dismissedType = dialog.type();
      await dialog.dismiss();
    });
    await page
      .goto(`${SITE}/blog/`, { waitUntil: 'commit', timeout: 8_000 })
      .catch(() => null);
    expect(dismissedType, 'cross-page navigation shows beforeunload too').toBe('beforeunload');
    await expect.poll(() => page.url()).toContain(AUTHOR);
    expect((await readDraft(page))?.title).toBe('Beforeunload probe');
    writeEvidence('x06-beforeunload.json', {
      dialogType,
      dismissedType,
      url: page.url(),
      draft: await readDraft(page),
    });
  });

  test('no draft or already-published content is not intercepted', async ({ page }) => {
    await openAuthorized(page);
    let dialogs = 0;
    page.on('dialog', async (dialog) => {
      dialogs += 1;
      await dialog.dismiss();
    });
    await ensureDrawer(page, true);
    await page.locator('[data-nav-key="publications"]').click();
    await page.waitForURL(`${SITE}/publications/`);
    expect(dialogs, 'empty editor navigates without a prompt').toBe(0);

    await page.goto(`${AUTHOR}/new/`);
    await authorizeIfNeeded(page);
    await publishSuccess(page, 'Published draft has no prompt', 'A published draft is cleared.');
    await page.getByTestId('back-to-blog').click();
    await page.waitForURL(`${SITE}/blog/`);
    expect(dialogs, 'published content navigates without a prompt').toBe(0);
    writeEvidence('x06-no-draft.json', { dialogs, url: page.url() });
  });

  test('R075-6: Write another post confirms when a newer draft exists and never loses it', async ({
    page,
  }) => {
    await openAuthorized(page);
    await publishSuccess(page, 'Published first', 'First body.');
    await page.getByTestId('new-post').click();
    await page.waitForURL(`${AUTHOR}/new/`);
    await fillDraft(page, 'Newer draft', 'Newer draft body.');
    await waitForDraftSaved(page);

    page.once('dialog', (dialog) => dialog.accept());
    await page.goto(`${AUTHOR}/new/success`);
    await expect(page.locator('#success-heading')).toHaveText('Commit created');
    await page.getByTestId('new-post').click();
    await expect(page.getByTestId('leave-confirm')).toBeVisible();
    await page.getByTestId('leave-stay').click();
    await expect(page.locator('#success-heading')).toHaveText('Commit created');
    expect((await readDraft(page))?.title).toBe('Newer draft');

    await page.getByTestId('new-post').click();
    await page.getByTestId('leave-accept').click();
    await page.waitForURL(`${AUTHOR}/new/`);
    await expect(page.getByTestId('post-title')).toHaveText('Newer draft');
    await screenshot(page, 'x06-r075-6.png');
    writeEvidence('x06-r075-6.json', { draft: await readDraft(page), url: page.url() });
  });
});

test.describe('X09 secret boundary', () => {
  test('URL, storage, cookies, network and cross-origin navigation carry no session/token/secret', async ({
    page,
  }) => {
    await openAuthorized(page);
    const network: { method: string; url: string; resourceType: string }[] = [];
    page.on('request', (request) => {
      network.push({ method: request.method(), url: request.url(), resourceType: request.resourceType() });
    });
    await publishSuccess(page, 'Secret boundary probe', 'Storage must only hold public data.');
    const successUrl = page.url();
    const storage = await page.evaluate(() => {
      const read = (storage: Storage) =>
        Object.fromEntries(
          Array.from({ length: storage.length }, (_, index) => {
            const key = storage.key(index) ?? '';
            return [key, storage.getItem(key) ?? ''];
          }),
        );
      return {
        local: read(localStorage),
        session: read(sessionStorage),
        cookie: document.cookie,
      };
    });

    const secretPattern =
      /(gho_[A-Za-z0-9]+|ghu_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|client_secret|access_token|refresh_token|SESSION_SECRET|TOKEN_ENCRYPTION_KEY|BEGIN [A-Z ]*PRIVATE KEY)/;
    const findings: string[] = [];
    for (const [area, entries] of [
      ['localStorage', storage.local],
      ['sessionStorage', storage.session],
    ] as const) {
      for (const [key, value] of Object.entries(entries)) {
        if (secretPattern.test(key) || secretPattern.test(value)) {
          findings.push(`${area} key ${key}`);
        }
      }
    }
    if (secretPattern.test(storage.cookie)) findings.push('document.cookie');
    if (secretPattern.test(successUrl)) findings.push('success URL');
    for (const request of network) {
      if (secretPattern.test(request.url)) findings.push(`request ${request.url}`);
      const url = new URL(request.url);
      if (/(token|session|secret|client_secret|code|state)=/i.test(url.search)) {
        findings.push(`query ${request.url}`);
      }
      if (url.origin !== AUTHOR && request.resourceType !== 'document') {
        findings.push(`cross-origin ${request.resourceType} ${request.url}`);
      }
    }
    const keys = {
      local: Object.keys(storage.local),
      session: Object.keys(storage.session),
    };
    expect(findings, findings.join('\n')).toEqual([]);

    await page.goto(`${SITE}/blog/`);
    const siteStorage = await page.evaluate(() => {
      const read = (storage: Storage) =>
        Object.fromEntries(
          Array.from({ length: storage.length }, (_, index) => {
            const key = storage.key(index) ?? '';
            return [key, storage.getItem(key) ?? ''];
          }),
        );
      return { local: read(localStorage), session: read(sessionStorage) };
    });
    expect(Object.keys(siteStorage.local)).not.toContain(DRAFT_KEY);
    expect(Object.keys(siteStorage.session)).not.toContain(DRAFT_KEY);
    for (const [area, entries] of Object.entries(siteStorage)) {
      for (const [key, value] of Object.entries(entries)) {
        expect(secretPattern.test(key) || secretPattern.test(value), `${area}/${key}`).toBe(false);
      }
    }
    const navUrls = await page.$$eval('.site-nav a[href]', (links) =>
      links.map((link) => (link as HTMLAnchorElement).href),
    );
    for (const href of navUrls) {
      const url = new URL(href);
      expect(url.search, `${href} has no query`).toBe('');
      expect(secretPattern.test(href), `${href} has no secret pattern`).toBe(false);
    }
    await screenshot(page, 'x09-site-storage.png');
    writeEvidence('x09-secret-scan.json', {
      findings,
      keys,
      successUrl,
      cookieLength: storage.cookie.length,
      networkRequests: network.length,
      siteStorage,
      sampleNavUrls: navUrls.slice(0, 6),
    });
  });
});

test.describe('X11 keyboard and focus', () => {
  test('public shell is fully keyboard operable and has no unexpected trap', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${SITE}/blog/`);
    const trail: string[] = [];
    const active = async () => {
      const info = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        return {
          tag: element?.tagName ?? '',
          text: (element?.textContent ?? '').trim().slice(0, 60),
          cls: typeof element?.className === 'string' ? element.className : '',
        };
      });
      trail.push(`${info.tag} ${info.text} ${info.cls}`);
      return info;
    };
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press('Tab');
      const current = await active();
      if (current.text === 'Menu') break;
    }
    expect(trail.some((entry) => entry.includes('Menu')), trail.join('\n')).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'visible');
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() =>
        Boolean(document.querySelector('#site-drawer')?.contains(document.activeElement)),
      );
      expect(inside, 'Tab stays inside the modal drawer').toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'hidden');
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${SITE}/`);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const menuFocused = await page.getByRole('button', { name: 'Menu' }).evaluate(
      (element) => document.activeElement === element,
    );
    if (!menuFocused) {
      await page.getByRole('button', { name: 'Menu' }).focus();
    }
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await page.locator('[data-nav-key="publications"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(`${SITE}/publications/`);
    expect(new URL(page.url()).pathname).toBe('/publications/');
    writeEvidence('x11-site-keyboard.json', { trail, url: page.url() });
  });

  test('delete draft, leave dialog and success page keep focus rules', async ({ page }) => {
    await openAuthorized(page);
    await fillDraft(page, 'Keyboard focus probe', 'Focus must return after each dialog.');
    await waitForDraftSaved(page);
    await page.getByTestId('discard-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('discard-confirm')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByTestId('discard-button')).toBeFocused();

    await openLeaveDialog(page);
    await expect(page.getByTestId('leave-stay')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('leave-confirm')).toHaveCount(0);
    await expect(page.locator('[data-nav-key="publications"]')).toBeFocused();
    await page.keyboard.press('Tab');
    const outside = await page.evaluate(
      () => !document.querySelector('[data-testid="leave-confirm"]')?.contains(document.activeElement),
    );
    expect(outside, 'focus leaves the closed dialog').toBe(true);

    await publishSuccess(page, 'Keyboard success probe', 'Success page must be keyboard reachable.');
    await expect(page.locator('#success-heading')).toBeFocused();
    const order: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? '',
      );
      order.push(id);
      if (order.includes('new-post') && order.includes('back-to-blog')) break;
    }
    expect(order).toContain('new-post');
    expect(order).toContain('back-to-blog');
    await screenshot(page, 'x11-success-keyboard.png');
    writeEvidence('x11-focus.json', {
      successOrder: order,
      successFocused: await page.evaluate(() => document.activeElement?.id ?? ''),
    });
  });
});

test.describe('X12 no out-of-scope features', () => {
  test('no search/comments/account/language/analytics; Settings stays a placeholder', async ({
    page,
  }) => {
    const analytics = [
      'google-analytics.com',
      'googletagmanager.com',
      'plausible.io',
      'umami.is',
      'analytics.',
      'cloudflareinsights.com',
      'sentry.io',
      'segment.com',
      'mixpanel.com',
    ];
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    const scan: Record<string, unknown> = {};
    for (const path of ['/', '/publications/', '/blog/']) {
      await page.goto(`${SITE}${path}`);
      scan[path] = await page.evaluate(() => ({
        searchInputs: document.querySelectorAll('input[type="search"], [role="search"]').length,
        commentForms: document.querySelectorAll('form, textarea').length,
        accountLinks: Array.from(document.querySelectorAll('a[href]')).filter((link) =>
          /account|login|signin|sign-in/i.test(link.textContent ?? ''),
        ).length,
        languageSelects: document.querySelectorAll('select, [hreflang]').length,
        settingsLinks: Array.from(document.querySelectorAll('a[href]')).filter((link) =>
          /settings/i.test((link as HTMLAnchorElement).href),
        ).length,
        settingsSlot: document.querySelector('[data-settings-slot]')?.tagName ?? '',
      }));
    }

    await page.goto(`${AUTHOR}/new/`);
    await authorizeIfNeeded(page);
    const author = await page.evaluate(() => {
      const mock = document.querySelector('[data-testid="mock-controls"]');
      const buttons = Array.from(document.querySelectorAll('button'))
        .filter((button) => !mock?.contains(button))
        .map((button) => button.textContent?.trim() ?? '');
      return {
        buttons,
        searchInputs: document.querySelectorAll('input[type="search"], [role="search"]').length,
        settingsSlot: document.querySelector('[data-settings-slot]')?.tagName ?? '',
        settingsLinks: Array.from(document.querySelectorAll('a[href]')).filter((link) =>
          /settings/i.test((link as HTMLAnchorElement).href),
        ).length,
        mockControls: Boolean(mock),
      };
    });
    const analyticsHits = requests.filter((url) => analytics.some((needle) => url.includes(needle)));
    expect(analyticsHits).toEqual([]);
    for (const [path, info] of Object.entries(scan)) {
      const record = info as Record<string, unknown>;
      expect(record.searchInputs, `${path}: no search`).toBe(0);
      expect(record.commentForms, `${path}: no forms/comments`).toBe(0);
      expect(record.accountLinks, `${path}: no account links`).toBe(0);
      expect(record.languageSelects, `${path}: no language switcher`).toBe(0);
      expect(record.settingsLinks, `${path}: no settings page link`).toBe(0);
      expect(record.settingsSlot, `${path}: settings placeholder`).toBe('SPAN');
    }
    expect(author.searchInputs).toBe(0);
    expect(author.settingsSlot).toBe('SPAN');
    expect(author.settingsLinks).toBe(0);
    expect(author.buttons.sort()).toEqual(
      ['Close', 'Delete draft', 'Log out', 'Menu', 'Preview', 'Publish'].sort(),
    );
    expect(author.mockControls, 'mock controls exist only in the test Worker').toBe(true);
    await screenshot(page, 'x12-author-dom.png');
    writeEvidence('x12-dom-scan.json', { scan, author, analyticsHits, requests: requests.length });
  });
});
