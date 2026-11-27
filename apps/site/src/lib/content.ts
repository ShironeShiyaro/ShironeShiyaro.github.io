import { getCollection, type CollectionEntry } from 'astro:content';
import { compareBlogPostsNewestFirst, type NavigationManifest } from '@selfpage/content-model';
import type { BlogEntryData, ManifestEntryData, PublicationsEntryData, ResumeEntryData } from './entry-types.ts';

export type SiteEntry = CollectionEntry<'site'>;
export type ResumeEntry = Omit<SiteEntry, 'data'> & { data: ResumeEntryData };
export type PublicationsEntry = Omit<SiteEntry, 'data'> & { data: PublicationsEntryData };
export type BlogEntry = Omit<SiteEntry, 'data'> & { data: BlogEntryData };

export interface SiteData {
  manifest: NavigationManifest;
  resume: ResumeEntry[];
  publications: PublicationsEntry;
  posts: BlogEntry[];
}

function isResume(entry: SiteEntry): entry is ResumeEntry {
  return entry.data.type === 'resume';
}

function isBlog(entry: SiteEntry): entry is BlogEntry {
  return entry.data.type === 'blog';
}

export async function getSiteData(): Promise<SiteData> {
  const entries = await getCollection('site');
  const manifestEntry = entries.find((entry) => entry.data.type === 'manifest');
  if (!manifestEntry) {
    throw new Error('The site content collection is missing the manifest entry.');
  }
  const manifest = (manifestEntry.data as ManifestEntryData).manifest;

  const publicationEntry = entries.find((entry) => entry.data.type === 'publications');
  if (!publicationEntry) {
    throw new Error('The site content collection is missing the publications entry.');
  }

  return {
    manifest,
    resume: entries.filter(isResume).sort((left, right) => left.data.order - right.data.order),
    publications: publicationEntry as PublicationsEntry,
    posts: entries
      .filter(isBlog)
      .sort((left, right) =>
        compareBlogPostsNewestFirst(
          { date: left.data.date, route: left.data.route },
          { date: right.data.date, route: right.data.route },
        ),
      ),
  };
}
