import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releaseNotes } from './release-notes.mjs';

const CHANGELOG = `# Changelog

Preamble.

## 0.3.0

### Added

- A thing.

## 0.2.10

Not 0.2.1.

## 0.2.1

The older one.
`;

describe('release notes', () => {
  it('uses the section for the tag', () => {
    const notes = releaseNotes(CHANGELOG, 'v0.3.0', 'shereford/ruyd');
    expect(notes).toContain('## 0.3.0');
    expect(notes).toContain('- A thing.');
    expect(notes).not.toContain('The older one.');
    expect(notes).not.toContain('Preamble.');
  });

  it('matches the version exactly rather than by prefix', () => {
    expect(releaseNotes(CHANGELOG, 'v0.2.1')).toContain('The older one.');
    expect(releaseNotes(CHANGELOG, 'v0.2.1')).not.toContain('Not 0.2.1.');
  });

  it('accepts a tag with or without the v', () => {
    expect(releaseNotes(CHANGELOG, '0.3.0')).toContain('- A thing.');
  });

  it('always explains how to verify the download', () => {
    const notes = releaseNotes(CHANGELOG, 'v0.3.0', 'shereford/ruyd');
    expect(notes).toContain('gh release verify v0.3.0 --repo shereford/ruyd');
    expect(notes).toContain('not Authenticode-signed');
  });

  it('falls back to the verification section for an unknown version', () => {
    const notes = releaseNotes(CHANGELOG, 'v9.9.9');
    expect(notes).not.toContain('##  9.9.9');
    expect(notes).toContain('not Authenticode-signed');
    expect(notes.startsWith('## Verifying this download')).toBe(true);
  });

  it('has an entry for the version this repository is about to release', () => {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    const notes = releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), `v${version}`);
    expect(notes).toContain(`## ${version}`);
  });
});
