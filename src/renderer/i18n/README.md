# UI strings (i18n)

Keys are the English text. Missing translations fall back to English, so a new string works immediately.

- Renderer: `import { t, plural, tk, tx } from '<rel>/i18n'`
  - `t('Export')`, `t('{0} is ready.', name)`: arguments are `{0}`, `{1}`…; numbers print as plain digits.
  - `t('Welcome to {app}')`: `{app}` is the product name from `src/shared/brand.ts`. Never write the product name in a key.
  - `plural(n, '1 clip', '{0} clips')`: the Mac uses a separate key per form.
  - `tk('Label')` marks a key without translating it (tables that also feed undo labels, MCP text or prompts); call `t(x)` where it is shown.
  - `tx(message)` translates a finished English message from src/core or main (exact key, or a `{0}` key with the same shape).
- Main process (menus, dialogs, notifications): `import { tm, tmPlural } from './i18n'` (src/main/i18n.ts).
- src/shared and src/core: use `tk` from `src/shared/i18n.ts` (shared) or list the keys in `src/renderer/i18n/keys.ts` (core stays i18n-free).
- Keys must be literal strings (no template literals); `tests/i18n/keys.test.ts` checks this.
- Keep English-only: MCP tool texts, agent instructions and prompts, undo labels, file names.

After adding or changing strings, run `node scripts/i18n/build-locales.mjs`. It regenerates `resources/locales/*.json` from the Mac `.lproj` files and writes `docs/i18n-coverage.md`. If the Mac says the same thing in different words, add `"Linux key": "Mac key"` to `scripts/i18n/aliases.json`.

The language is chosen in Settings ▸ General ▸ Language and takes effect after a restart, as on the Mac. For headless checks, set `FRAMEWRIGHT_LANG=de` (or the older `PALMIER_LANG`).
