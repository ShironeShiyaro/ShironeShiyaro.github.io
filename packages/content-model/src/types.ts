/**
 * Public data contracts for the SelfPage content model.
 *
 * Only publicly readable data belongs here. Tokens, OAuth configuration and
 * author-only drafts are deliberately absent.
 */

export interface ResumeSection {
  id: string;
  title: string;
  href: string;
}

export interface ResumeSectionContent extends ResumeSection {
  /** Markdown body following the section H1 (the H1 itself is rendered by the page). */
  markdown: string;
}

export interface BlogPostSummary {
  title: string;
  /** Visible publication date, YYYY-MM-DD. */
  date: string;
  /** Visible publication date in MM.DD form. */
  shortDate: string;
  /**
   * Publication time `HH:mm` taken from the file name's `-HH-mm-ss` suffix
   * (D35, task 07.5). Optional so a manifest produced before that change, or a
   * file without a usable time, still renders: views then show `date` only.
   */
  time?: string;
  /** Full display form `YYYY-MM-DD HH:mm`; absent when no file-name time exists. */
  displayDate?: string;
  /** Sidebar display form `MM.DD HH:mm`; absent when no file-name time exists. */
  displayShortDate?: string;
  /** Site-absolute href including BASE_PATH. */
  href: string;
}

export interface BlogYear {
  year: string;
  href: string;
  posts: BlogPostSummary[];
}

export interface NavigationManifest {
  home: { title: 'Home'; href: string; children: ResumeSection[] };
  publications: { title: 'Publications'; href: string; children: [] };
  blog: { title: 'Blog'; href: string; newHref: string; years: BlogYear[] };
}

export interface PublicationItem {
  title: string;
  authors: string[];
  venue: string;
  year: number;
  /** Validated absolute URL or site-relative href, when supplied. */
  paperHref?: string;
  codeHref?: string;
}

export interface BlogPost extends BlogPostSummary {
  /** NFC-normalised, encoded route id, for example `blog/2025/example/`. */
  id: string;
  /** NFC-normalised, encoded route without BASE_PATH, ending with `/`. */
  route: string;
  year: string;
  month: string;
  /** Repository-relative source path, for example `content/blog/2025/example.md`. */
  sourcePath: string;
  /** Decoded NFC form of `route` below /blog/, used by Astro getStaticPaths. */
  segments: string[];
  /** Markdown after the visible date separator. */
  bodyMarkdown: string;
  /** Full visible Markdown from the H1 through the body, without front matter. */
  visibleMarkdown: string;
}

export interface SiteContent {
  home: {
    title: 'Home';
    sections: ResumeSectionContent[];
  };
  publications: {
    /** Display title taken from the document's single H1. */
    title: string;
    /** Markdown body including the H1 and any H2 headings. */
    markdown: string;
    items: PublicationItem[];
  };
  blog: {
    title: 'Blog';
    posts: BlogPost[];
  };
}

export interface ContentIssue {
  /** Repository-style path such as `content/blog/2025/post.md`, or `<config>`. */
  file: string;
  message: string;
}

export interface LoadedSite {
  content: SiteContent;
  manifest: NavigationManifest;
  warnings: ContentIssue[];
}

export interface LoadSiteOptions {
  /** Absolute path to the `content/` directory. */
  contentRoot: string;
  /** Prefix used in reported issue paths; defaults to `content`. */
  displayContentRoot?: string;
  /** Public base path, default `/`. */
  basePath?: string;
  /** Author application origin, default `https://selfpage-author.invalid`. */
  authorOrigin?: string;
  /**
   * New! publication mode (D11): reject a file-name date that differs from the
   * visible date. Manual/build content defaults to a warning so acceptance can
   * edit a heading/date without renaming the file.
   */
  strictBlogFileNameDate?: boolean;
}

export const DEFAULT_AUTHOR_ORIGIN = 'https://selfpage-author.invalid';
export const DEFAULT_SITE_URL = 'https://shironeshiyaro.github.io/';
