#!/usr/bin/env node
// Builds the body of a GitHub release from the matching CHANGELOG.md section, so a
// release describes what actually changed instead of repeating a fixed paragraph.
import { readFileSync, writeFileSync } from 'node:fs';

const VERIFICATION = (tag, repository) => [
  '## Verifying this download',
  '',
  'This development release is not Authenticode-signed, so Windows may display a SmartScreen',
  'warning. `SHA256SUMS.txt` contains the published file hashes, and the release assets carry',
  'GitHub build-provenance attestations:',
  '',
  '```',
  `gh release verify ${tag}${repository ? ` --repo ${repository}` : ''}`,
  '```',
  '',
  'Everyone in a room should run this same release.',
].join('\n');

/**
 * @param changelog contents of CHANGELOG.md
 * @param tag release tag, with or without a leading `v`
 * @param repository `owner/name`, used in the verification command
 * @returns the release body; the verification section alone when the version has no entry
 */
export function releaseNotes(changelog, tag, repository = '') {
  const version = String(tag).replace(/^v/, '');
  const section = changelog
    .split(/^## /m)
    .find((part) => part.split('\n', 1)[0].trim() === version);
  const verification = VERIFICATION(tag, repository);
  return section ? `## ${section.trimEnd()}\n\n${verification}\n` : `${verification}\n`;
}

if (process.argv[1]?.endsWith('release-notes.mjs')) {
  const tag = process.argv[2] ?? '';
  const notes = releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), tag, process.env.GITHUB_REPOSITORY ?? '');
  writeFileSync('release-notes.md', notes);
  process.stdout.write(`Wrote release-notes.md for ${tag} (${notes.length} bytes)\n`);
}
