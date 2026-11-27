import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ContentValidationError } from './errors.ts';
import { loadSiteContent } from './load.ts';
import { DEFAULT_AUTHOR_ORIGIN } from './types.ts';

const USAGE = `SelfPage content CLI

Usage:
  content:validate <content-root>
  content:manifest <content-root> <output-file>

Environment:
  BASE_PATH              Public base path (default "/")
  PUBLIC_AUTHOR_ORIGIN   Author application origin (default "${DEFAULT_AUTHOR_ORIGIN}")
`;

function fail(message: string, exitCode: number): never {
  console.error(`error: ${message}`);
  process.exit(exitCode);
}

function reportWarnings(warnings: { file: string; message: string }[]): void {
  for (const warning of warnings) {
    console.error(`warning: ${warning.file}: ${warning.message}`);
  }
}

function load(contentRootArgument: string) {
  const contentRoot = resolve(contentRootArgument);
  return loadSiteContent({
    contentRoot,
    displayContentRoot: contentRootArgument.replace(/\\/g, '/').replace(/\/+$/g, ''),
    basePath: process.env.BASE_PATH,
    authorOrigin: process.env.PUBLIC_AUTHOR_ORIGIN,
  });
}

function runValidate(contentRootArgument: string | undefined): void {
  if (contentRootArgument === undefined) {
    fail('content:validate requires a <content-root> argument', 2);
  }
  const loaded = load(contentRootArgument);
  reportWarnings(loaded.warnings);
  console.log(
    `Content is valid: ${loaded.content.home.sections.length} Home section(s), ${loaded.content.publications.items.length} publication(s), ${loaded.content.blog.posts.length} blog post(s).`,
  );
}

function runManifest(contentRootArgument: string | undefined, outputArgument: string | undefined): void {
  if (contentRootArgument === undefined || outputArgument === undefined) {
    fail('content:manifest requires <content-root> and <output-file> arguments', 2);
  }
  const loaded = load(contentRootArgument);
  reportWarnings(loaded.warnings);
  const outputPath = resolve(outputArgument);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(loaded.manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote navigation manifest to ${outputPath}`);
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    process.exit(0);
  }

  try {
    if (command === 'validate') {
      runValidate(args[0]);
      return;
    }
    if (command === 'manifest') {
      runManifest(args[0], args[1]);
      return;
    }
    fail(`unknown command "${command}"\n\n${USAGE}`, 2);
  } catch (error) {
    if (error instanceof ContentValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    fail(error instanceof Error ? error.message : String(error), 1);
  }
}

main();
