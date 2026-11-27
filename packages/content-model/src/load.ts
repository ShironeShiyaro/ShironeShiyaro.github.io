import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ContentValidationError, issue } from './errors.ts';
import { buildNavigationManifest } from './manifest.ts';
import {
  auditMarkdownSafety,
  extractHeadings,
  parseBlogMarkdown,
  parseFrontMatter,
  parseResumeMarkdown,
  type BlogMarkdownData,
} from './markdown.ts';
import { sortBlogPostsNewestFirst } from './order.ts';
import { buildAuthorNewHref, normalizeBasePath, resolvePublicUrl, withBasePath } from './paths.ts';
import {
  createUniqueSlugger,
  deriveBlogPathSegments,
  deriveBlogRouteFromSegments,
  findReservedBlogRouteCharacter,
  findUnsafeBlogPathSegment,
  parseBlogFileNameForLoad,
  sanitizeBlogTitleForFileName,
  slugifyHeading,
} from './slug.ts';
import {
  DEFAULT_AUTHOR_ORIGIN,
  type BlogPost,
  type ContentIssue,
  type LoadedSite,
  type LoadSiteOptions,
  type PublicationItem,
  type ResumeSectionContent,
  type SiteContent,
} from './types.ts';

const publicationItemSchema = z
  .strictObject({
    title: z.string().trim().min(1),
    authors: z.array(z.string().trim().min(1)).min(1),
    venue: z.string().trim().min(1),
    year: z.number().int().min(1000).max(9999),
    paperUrl: z.string().trim().min(1).optional(),
    codeUrl: z.string().trim().min(1).optional(),
  });

const publicationsFrontMatterSchema = z
  .strictObject({
    items: z.array(publicationItemSchema).min(1),
  });

interface LoadState {
  contentRoot: string;
  displayRoot: string;
  strictBlogFileNameDate: boolean;
  issues: ContentIssue[];
  warnings: ContentIssue[];
}

function displayPath(state: LoadState, absolutePath: string): string {
  const relativePath = relative(state.contentRoot, absolutePath);
  if (relativePath === '' || relativePath.startsWith('..')) {
    return absolutePath.split(sep).join('/');
  }
  return `${state.displayRoot}/${relativePath.split(sep).join('/')}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportMarkdownAudit(state: LoadState, display: string, markdown: string): void {
  for (const finding of auditMarkdownSafety(markdown)) {
    state.warnings.push(issue(display, `security audit: ${finding.message}`));
  }
}

function readContentFile(state: LoadState, absolutePath: string): string | null {
  const display = displayPath(state, absolutePath);
  if (!existsSync(absolutePath)) {
    state.issues.push(issue(display, 'required content file is missing'));
    return null;
  }
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch (error) {
    state.issues.push(issue(display, `cannot read content file: ${describeError(error)}`));
    return null;
  }
}

function loadHome(state: LoadState, basePath: string): SiteContent['home'] | null {
  const absolutePath = join(state.contentRoot, 'home', 'resume.md');
  const raw = readContentFile(state, absolutePath);
  if (raw === null) {
    return null;
  }
  const display = displayPath(state, absolutePath);
  let parsed: ReturnType<typeof parseResumeMarkdown>;
  try {
    parsed = parseResumeMarkdown(raw);
  } catch (error) {
    state.issues.push(issue(display, describeError(error)));
    return null;
  }
  if (parsed.hasFrontMatter) {
    state.issues.push(
      issue(display, 'resume front matter is not defined; remove even an empty "---" block and use H1 sections'),
    );
    return null;
  }

  const homeHref = withBasePath(basePath, '/');
  const nextId = createUniqueSlugger();
  const sections: ResumeSectionContent[] = parsed.sections.map((section) => {
    reportMarkdownAudit(state, display, `${section.title}\n${section.markdown}`);
    const baseId = slugifyHeading(section.title);
    const id = nextId(section.title);
    if (id !== baseId) {
      state.warnings.push(
        issue(display, `duplicate Home heading "${section.title}" uses fragment id "${id}" instead of overwriting an existing id`),
      );
    }
    return {
      id,
      title: section.title,
      href: `${homeHref}#${id}`,
      markdown: section.markdown,
    };
  });

  const ids = sections.map((section) => section.id);
  if (new Set(ids).size !== sections.length) {
    state.issues.push(
      issue(display, 'duplicate Home fragment ids were generated from different headings; refusing to overwrite a section'),
    );
    return null;
  }

  return { title: 'Home', sections };
}

function loadPublications(state: LoadState, basePath: string): SiteContent['publications'] | null {
  const absolutePath = join(state.contentRoot, 'publications', 'selected-publications.md');
  const raw = readContentFile(state, absolutePath);
  if (raw === null) {
    return null;
  }
  const display = displayPath(state, absolutePath);
  let parsed: ReturnType<typeof parseFrontMatter>;
  try {
    parsed = parseFrontMatter(raw);
  } catch (error) {
    state.issues.push(issue(display, describeError(error)));
    return null;
  }
  if (!parsed.hasFrontMatter) {
    state.issues.push(issue(display, 'publications front matter with an "items" list is required'));
    return null;
  }

  const schemaResult = publicationsFrontMatterSchema.safeParse(parsed.data);
  if (!schemaResult.success) {
    for (const zodIssue of schemaResult.error.issues) {
      const location = zodIssue.path.length > 0 ? `${zodIssue.path.join('.')}: ` : '';
      state.issues.push(issue(display, `${location}${zodIssue.message}`));
    }
    return null;
  }

  const headings = extractHeadings(parsed.body);
  const h1s = headings.filter((heading) => heading.level === 1);
  if (h1s.length !== 1) {
    state.issues.push(issue(display, `publications must contain exactly one H1 heading, found ${h1s.length}`));
    return null;
  }
  reportMarkdownAudit(state, display, parsed.body);
  const title = h1s[0]?.text ?? 'Publications';
  const bodyLines = parsed.body.split('\n');
  const bodyWithoutTitle = bodyLines
    .slice((h1s[0]?.lineIndex ?? 0) + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');

  const items: PublicationItem[] = [];
  schemaResult.data.items.forEach((rawItem, index) => {
    let paperHref: string | undefined;
    let codeHref: string | undefined;
    if (rawItem.paperUrl !== undefined) {
      try {
        paperHref = resolvePublicUrl(rawItem.paperUrl, basePath);
      } catch (error) {
        state.issues.push(issue(display, `items.${index}.paperUrl: ${describeError(error)}`));
      }
    }
    if (rawItem.codeUrl !== undefined) {
      try {
        codeHref = resolvePublicUrl(rawItem.codeUrl, basePath);
      } catch (error) {
        state.issues.push(issue(display, `items.${index}.codeUrl: ${describeError(error)}`));
      }
    }
    items.push({
      title: rawItem.title,
      authors: rawItem.authors,
      venue: rawItem.venue,
      year: rawItem.year,
      ...(paperHref === undefined ? {} : { paperHref }),
      ...(codeHref === undefined ? {} : { codeHref }),
    });
  });

  return { title, markdown: bodyWithoutTitle, items };
}

function listMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        found.push(absolutePath);
      }
    }
  };
  walk(root);
  return found.sort((left, right) => left.localeCompare(right));
}

function blogPostFrom(
  parsed: BlogMarkdownData,
  route: string,
  segments: string[],
  basePath: string,
  sourcePath: string,
  time: string,
): BlogPost {
  return {
    id: route,
    route,
    title: parsed.title,
    date: parsed.date,
    shortDate: parsed.shortDate,
    // The file name's validated -HH-mm-ss suffix is the only time source (D35);
    // seconds stay out of the UI, and a file without a usable time simply has
    // no time fields, so views fall back to the date.
    ...(time === ''
      ? {}
      : {
          time,
          displayDate: `${parsed.date} ${time}`,
          displayShortDate: `${parsed.shortDate} ${time}`,
        }),
    year: parsed.year,
    month: parsed.month,
    href: withBasePath(basePath, route),
    sourcePath,
    segments,
    bodyMarkdown: parsed.body,
    visibleMarkdown: parsed.visibleMarkdown,
  };
}

function loadBlog(state: LoadState, basePath: string): SiteContent['blog'] | null {
  const blogRoot = join(state.contentRoot, 'blog');
  const files = listMarkdownFiles(blogRoot);
  if (!existsSync(blogRoot)) {
    state.issues.push(issue(`${state.displayRoot}/blog`, 'required content directory is missing'));
    return null;
  }
  if (files.length === 0) {
    state.issues.push(issue(`${state.displayRoot}/blog`, 'at least one blog post is required'));
    return null;
  }

  const posts: BlogPost[] = [];
  const routes = new Map<string, string>();
  for (const absolutePath of files) {
    const display = displayPath(state, absolutePath);
    const raw = readContentFile(state, absolutePath);
    if (raw === null) {
      continue;
    }
    let parsed: BlogMarkdownData;
    try {
      parsed = parseBlogMarkdown(raw);
    } catch (error) {
      state.issues.push(issue(display, describeError(error)));
      continue;
    }
    const relativeWithoutExtension = relative(blogRoot, absolutePath)
      .split(sep)
      .join('/')
      .replace(/\.md$/i, '');
    reportMarkdownAudit(state, display, parsed.visibleMarkdown);

    const unsafePath = findUnsafeBlogPathSegment(relativeWithoutExtension);
    if (unsafePath !== null) {
      const description =
        unsafePath.reason === 'empty-segment'
          ? 'contains an empty path segment (for example a file named ".md")'
          : `contains the path segment "${unsafePath.segment}", which would normalise to another route`;
      state.issues.push(issue(display, `blog file path ${description}`));
      continue;
    }

    const reservedCharacter = findReservedBlogRouteCharacter(relativeWithoutExtension);
    if (reservedCharacter !== null) {
      state.issues.push(
        issue(
          display,
          `file name contains the reserved character "${reservedCharacter}"; blog file paths must not contain # $ & + , : ; = ? @ because Astro would build a different URL than the manifest route`,
        ),
      );
      continue;
    }

    const fileName = relativeWithoutExtension.split('/').at(-1) ?? '';
    const fileNameCheck = parseBlogFileNameForLoad(fileName);
    if (!fileNameCheck.ok) {
      state.issues.push(issue(display, `invalid blog file name: ${fileNameCheck.detail}`));
      continue;
    }
    if (fileNameCheck.timeIssue === 'missing-time') {
      // D35/P1-5: manual content may omit the time; the date contract still
      // applies, the post simply displays date-only (New! always writes a time).
      state.warnings.push(
        issue(
          display,
          'file name has no -HH-mm-ss publication time; the post is accepted and only the date is displayed (New! always writes a time)',
        ),
      );
    } else if (fileNameCheck.timeIssue === 'invalid-time') {
      state.warnings.push(
        issue(
          display,
          'file name time is not a valid 24-hour time; the post is accepted and only the date is displayed (New! always writes a valid time)',
        ),
      );
    }
    const dateMatches = fileNameCheck.date === parsed.date;
    if (!dateMatches) {
      const message = `file name date "${fileNameCheck.date}" does not match visible date "${parsed.date}"`;
      if (state.strictBlogFileNameDate) {
        state.issues.push(issue(display, `${message}; New! strict mode requires a matching date`));
        continue;
      }
      state.warnings.push(
        issue(display, `${message}; manual content is accepted with a warning (New! generation is strict)`),
      );
    }

    const expectedFileNameTitle = sanitizeBlogTitleForFileName(parsed.title);
    if (fileNameCheck.title.normalize('NFC') !== expectedFileNameTitle) {
      const message = `file name title "${fileNameCheck.title}" does not match sanitised H1/title "${expectedFileNameTitle}"`;
      if (dateMatches) {
        state.issues.push(issue(display, message));
        continue;
      }
      // D11: a manually edited file whose date no longer matches must remain
      // loadable so acceptance clause 8 can change H1/date without renaming.
      state.warnings.push(issue(display, `${message}; manual content with a stale file-name date is accepted`));
    }

    const segments = deriveBlogPathSegments(relativeWithoutExtension);
    const route = deriveBlogRouteFromSegments(segments);
    const existing = routes.get(route);
    if (existing !== undefined) {
      state.issues.push(
        issue(display, `route "${route}" conflicts with ${existing} after Unicode NFC normalisation`),
      );
      continue;
    }
    routes.set(route, display);
    const [hour = '', minute = ''] = (fileNameCheck.time ?? '').split('-');
    // A missing/invalid file-name time must not become ":" — the post then has
    // no time fields at all and every view falls back to the date (D35/P1-5).
    const time = fileNameCheck.time === null ? '' : `${hour}:${minute}`;
    posts.push(blogPostFrom(parsed, route, segments, basePath, display, time));
  }

  return { title: 'Blog', posts: sortBlogPostsNewestFirst(posts) };
}

/**
 * Read, validate and build a complete site content snapshot. Throws
 * ContentValidationError with every discovered issue; callers should display
 * the included file paths.
 */
export function loadSiteContent(options: LoadSiteOptions): LoadedSite {
  const contentRoot = resolve(options.contentRoot);
  const displayRoot =
    (options.displayContentRoot ?? 'content').trim().replace(/\\/g, '/').replace(/\/+$/g, '') || 'content';
  const state: LoadState = {
    contentRoot,
    displayRoot,
    strictBlogFileNameDate: options.strictBlogFileNameDate === true,
    issues: [],
    warnings: [],
  };
  if (!existsSync(contentRoot)) {
    state.issues.push(issue(displayRoot, `content root does not exist: ${contentRoot}`));
  }

  let basePath = '/';
  try {
    basePath = normalizeBasePath(options.basePath, (message) => {
      state.warnings.push(issue('<config>', message));
    });
  } catch (error) {
    state.issues.push(issue('<config>', describeError(error)));
  }

  const authorOrigin = options.authorOrigin ?? DEFAULT_AUTHOR_ORIGIN;
  try {
    buildAuthorNewHref(authorOrigin);
  } catch (error) {
    state.issues.push(issue('<config>', describeError(error)));
  }

  const home = loadHome(state, basePath);
  const publications = loadPublications(state, basePath);
  const blog = loadBlog(state, basePath);

  if (state.issues.length > 0) {
    throw new ContentValidationError(state.issues);
  }
  if (home === null || publications === null || blog === null) {
    throw new ContentValidationError([
      ...state.issues,
      issue('<content>', 'content loading stopped before all required sections were available'),
    ]);
  }

  const content: SiteContent = { home, publications, blog };
  const manifest = buildNavigationManifest(content, { basePath, authorOrigin });
  return { content, manifest, warnings: state.warnings };
}
