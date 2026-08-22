# Developing Ruyd

## Requirements

- Node.js 22 or newer
- Rust stable
- The platform prerequisites for [Tauri 2](https://v2.tauri.app/start/prerequisites/)

## Local setup

```bash
npm install
npm test
npm run build
npm run tauri dev
```

Use `npm ci` instead of `npm install` when validating the committed lockfile exactly.

`vite.config.ts` pins the dev server to port 1420 with `strictPort`, because that is the `devUrl`
that `src-tauri/tauri.conf.json` tells Tauri to load. Changing one without the other breaks
`npm run tauri dev`.

## Signaling configuration

Production builds use `https://connect.ruyd.us` by default. Set `VITE_RUYD_SIGNALING_URL` at build time to use another compatible signaling endpoint:

```bash
VITE_RUYD_SIGNALING_URL=https://example.invalid npm run build
```

The public STUN server is configured separately in `src/connectivity.ts`.

## Windows bundles

Create the Windows installer bundles on Windows:

```bash
npm run tauri build
```

The release workflow runs JavaScript and Rust tests, builds the frontend and Tauri application, creates `.exe` and `.msi` installers, publishes SHA-256 checksums, and generates GitHub build-provenance attestations.

## Cutting a release

The `Release` workflow runs on any pushed `v*` tag. Before tagging, bump the version in all three
places that ship it:

- `package.json` — also the version the UI footer shows, injected by `vite.config.ts`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Then push the tag from `master`:

```bash
git tag v0.2.1
git push origin v0.2.1
```

The workflow tests, builds, packages the `.exe` and `.msi`, writes `SHA256SUMS.txt`, attests the
assets, and publishes the GitHub release. Verify the published assets with `gh release verify`
before announcing the release.

## Before opening a pull request

Run the checks documented in [CONTRIBUTING.md](../CONTRIBUTING.md). Networking or security changes should describe user-visible behavior, failure handling, cleanup, and the exact routes or ports affected.
