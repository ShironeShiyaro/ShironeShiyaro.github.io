import type { NavigationManifest, PublicationItem } from '@selfpage/content-model';

export type ResumeEntryData = {
  type: 'resume';
  id: string;
  title: string;
  href: string;
  order: number;
};

export type PublicationsEntryData = {
  type: 'publications';
  title: string;
  items: PublicationItem[];
};

export type BlogEntryData = {
  type: 'blog';
  title: string;
  date: string;
  shortDate: string;
  /** D35: `HH:mm` from the file name; absent for legacy entries. */
  time?: string;
  /** D35 display form `YYYY-MM-DD HH:mm`; absent when no time is known. */
  displayDate?: string;
  /** D35 sidebar display form `MM.DD HH:mm`; absent when no time is known. */
  displayShortDate?: string;
  year: string;
  month: string;
  route: string;
  href: string;
  /** Decoded NFC form of the canonical content-model `route`, for getStaticPaths. */
  segments: string[];
};

export type ManifestEntryData = {
  type: 'manifest';
  manifest: NavigationManifest;
};

export type SiteEntryData = ResumeEntryData | PublicationsEntryData | BlogEntryData | ManifestEntryData;
