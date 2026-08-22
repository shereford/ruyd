# Bundled fonts

Ruyd bundles the Latin subsets of these variable fonts so the desktop app renders
its intended typography without contacting a third-party font host at launch.

| File | Family | Weights | Subset |
| --- | --- | --- | --- |
| `dm-sans-latin.woff2` | DM Sans | 400–700 | latin |
| `dm-sans-latin-ext.woff2` | DM Sans | 400–700 | latin-ext |
| `manrope-latin.woff2` | Manrope | 600–800 | latin |
| `manrope-latin-ext.woff2` | Manrope | 600–800 | latin-ext |

Both families are licensed under the SIL Open Font License 1.1. The full license
texts are in `OFL-DM-Sans.txt` and `OFL-Manrope.txt`.

The files were taken from the Google Fonts `woff2` subsets for DM Sans v17 and
Manrope v20. Text outside these subsets falls back to the system font stack
declared in `../style.css`.
