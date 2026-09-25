# Bump `use-prms` to `^0.5.0` + fix dead `signedDelim`

`use-prms@0.5.0` is on npm (published 2026-08-27). This repo's
`www/package.json` was just bumped from the github-dist pin
(`#da21b49c…`) to `^0.5.0` (uncommitted — run `pnpm install` in `www/`
and commit).

`da21b49c` was already *past* the `signedDelim` → `signDelim` rename
(that landed 2026-05-04; the dist pin is from 2026-05-28), so this bump
is a forward no-op for behavior — `0.5.0` treats the option exactly as
the pinned dist already did. Nothing about the map encoding changes.

## One cleanup while here

`www/src/MapView.tsx:69` still passes the old option name:

```diff
-  signedDelim: true,
+  signDelim: true,
```

`signedDelim` has been ignored since the May rename — `viewStateParam`
reads `signDelim`, whose default is already `true`, so the map has been
getting the intended behavior regardless. The rename just makes the
option live again (and drops a dead property). Since `true` is now the
default, deleting the line entirely is equivalent — either is fine.

If `www/` type-checks in CI and `viewStateParam`'s options type rejects
excess properties, this line may already be a lurking `tsc` error that
the dist pin's looser build tolerated; renaming resolves it either way.

## pds note

This repo is `pds`-managed (`www/.pds.json`). The package.json edit
alone is stable (nothing reverts it), but `.pds.json` now shows drift
(still records the gh source). Run `pds n use-prms 0.5.0` in `www/` to
sync the pds metadata + install in one step, instead of a bare
`pnpm install`.

## Verify + commit

1. `pds n use-prms 0.5.0` (or `pnpm install`) in `www/`.
2. `pnpm build` / typecheck — confirm the `signDelim` rename compiles.
3. Load the map, confirm the view-state URL (`?…`) round-trips.
4. Commit package.json + lockfile + `MapView.tsx` + `.pds.json`
   together; move this spec to `specs/done/`.

## Implemented (2026-09-25)

Done exactly as specced, with two notes:
- **Both** packages bumped, not just `www`: `files/package.json` `^0.4` → `^0.5.0`
  too (plain `pnpm install`; `files/` isn't `pds`-managed). `www/` via
  `pds n use-prms 0.5.0` (updates `.pds.json` + lockfile + install).
- `MapView.tsx` `signedDelim` → `signDelim` renamed.
- Verified: `vite build` + `eslint` pass; CIC'd the map — view-state URL
  (`?v=…` with `signDelim`) decodes to the right camera. `tsc` has 57
  pre-existing errors (deck.gl/loose param types); the source edits net −1,
  and CI runs `vite build`/Playwright, not `tsc`.
- Left alone: `@rdub/file-tree` peer-declares `use-prms@^0.4`, so pnpm warns
  under 0.5.0 (cosmetic, behavior-compatible). Widen its peer range to
  `^0.4 || ^0.5` in that repo when convenient.
