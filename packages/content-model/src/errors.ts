import type { ContentIssue } from './types.ts';

export class ContentValidationError extends Error {
  readonly issues: ContentIssue[];

  constructor(issues: ContentIssue[]) {
    super(formatIssues(issues));
    this.name = 'ContentValidationError';
    this.issues = issues;
  }
}

export function formatIssues(issues: ContentIssue[]): string {
  return ['Content validation failed:', ...issues.map((issue) => `  ${issue.file}: ${issue.message}`)].join('\n');
}

export function issue(file: string, message: string): ContentIssue {
  return { file, message };
}
