# Migrate JCT `viewParam` → `use-prms` `viewStateParam`

## Goal

Replace JCT's hand-rolled `viewParam` (`www/src/App.tsx:59-91`) with the
shared `viewStateParam` factory now exported from `use-prms`. Both
implementations share the same wire format (signed-delim, `lat lon zoom
pitch bearing`), so this is a typing/maintenance win, not a behavior
change for end users.

## Why

`use-prms` recently grew first-class support for camera-state params:

- `llzParam` — abbreviated keys (`{ lat, lng, zoom }`)
- `viewStateParam` — deck.gl-flavor (`{ latitude, longitude, zoom, pitch,
  bearing }`)
- `bboxParam` — `[w, s, e, n]`

All three share the **signed-delim** encoding (`-` and `+` between
numbers, so URLs read like `40.7197-74.0506+12.0+45+0`) — the same trick
JCT's local `encodeView` already uses. Pulling JCT onto the shared
factory deletes ~30 lines of duplicate code in `App.tsx` and lets future
refinements (e.g. transitions for `pitchFallback`, configurable
precision) land once in the lib.

Co-developed with the `nj-crashes` project's `CrashMapSection` migration;
JCT is the second consumer that validates the API before
`use-prms` is pushed upstream.

## Pre-requisites

JCT does not yet have `pds` configured. The migration **must** happen on
a local `pds l prms` link, not against the published `use-prms` —
because the API is still in flux (see API gap below) and the
`viewStateParam` you'll target lives only on `~/c/js/use-prms` until the
co-dev cycle ends.

```sh
cd ~/c/jc-taxes/www
pds init ../../js/use-prms       # one-time, registers prms as a managed dep
pds l prms                       # point JCT's use-prms at local checkout
```

After both consumers (JCT + nj-crashes' `CrashMapSection`) validate the
API end-to-end, `use-prms` is pushed (GH dist build), then `pds gh prms
<sha>` flips JCT to the published commit. **Do not push `use-prms`
upstream from this session before JCT verifies the migration.**

## Migration

### 1. Imports

```diff
-import { useUrlState, intParam, stringParam } from 'use-prms'
-import type { Param } from 'use-prms'
+import { useUrlState, intParam, stringParam, viewStateParam } from 'use-prms'
```

(The `Param` type-only import is no longer needed — only the local
`viewParam: Param<ViewState>` annotation used it.)

### 2. Replace `encodeView` + `viewParam`

Delete `App.tsx:59-91` (`encodeView` and the `viewParam` factory) and
replace with:

```ts
const viewParam = viewStateParam({
  default: DEFAULT_VIEW,
  signedDelim: true,
  zoomDecimals: 1,        // matches existing JCT URL appearance
})
```

`latLngDecimals: 4`, `pitchDecimals: 0`, `bearingDecimals: 0` are the
factory defaults — no need to set them.

The wire format is byte-identical to today's URLs, so existing bookmarks
and shareable URLs continue to round-trip.

### 3. `useUrlState` call site

`App.tsx:330` — no change to the call itself:

```ts
const [urlView, setUrlView] = useUrlState('v', viewParam)
```

But: `useUrlState` will infer `urlView: ViewState` only if
`viewStateParam` returns `Param<ViewState>` when given a non-null
default. **See "API gap" below.** If the return type stays
`Param<ViewState | null>` (the current shape on `~/c/js/use-prms`), JCT
needs a defensive `?? DEFAULT_VIEW`:

```ts
const [urlView_, setUrlView] = useUrlState('v', viewParam)
const urlView = urlView_ ?? DEFAULT_VIEW
```

That's a cosmetic wart — fixing the lib's overload (next section) is
the right answer.

### 4. Drop the `ViewState` augment in `useKeyboardShortcuts.ts`?

JCT's local `ViewState` type
(`www/src/useKeyboardShortcuts.ts:7-15`) extends the deck.gl shape with
optional `transitionDuration` + `transitionInterpolator` fields used by
the keyboard-pan/zoom-tilt animations. **Keep the local type.** The
use-prms `ViewState` (5 numeric fields) is a structural subset, so:

- `setViewState(useprmsView)` — fine (extra fields default to undefined)
- `setUrlView(jctView)` — fine (use-prms ignores the optional extras
  when encoding)

No type alias swap needed.

## API gap to fix in `use-prms` first

Current signature:

```ts
export function viewStateParam(opts: ViewStateParamOptions): Param<ViewState | null>
```

This forces JCT (which always wants a non-null `ViewState` because
`DEFAULT_VIEW` is never null) to `?? DEFAULT_VIEW` at every call site,
or assert non-null. The same nullable-vs-not asymmetry doesn't exist for
`llzParam` or `bboxParam`, which both return non-null types.

**Proposed overload** (land in use-prms before pushing):

```ts
export function viewStateParam(
  opts: { default: ViewState } & Omit<ViewStateParamOptions, 'default'>
): Param<ViewState>
export function viewStateParam(
  opts: { default: null } & Omit<ViewStateParamOptions, 'default'>
): Param<ViewState | null>
export function viewStateParam(opts: ViewStateParamOptions): Param<ViewState | null>
```

Implementation stays the same — only the type-level signature changes.
After this lands:

- JCT (`default: DEFAULT_VIEW`) → `Param<ViewState>` → no `??` needed
- nj-crashes `CrashMapSection` (`default: null`) → `Param<ViewState | null>`
  → unchanged

This is the kind of API refinement the `pds l` co-dev workflow exists
to surface; it should ride along with the JCT migration before
`use-prms` ships.

## Test plan

After running the migration locally with `pds l prms`:

1. Type-check: `pnpm tc` (or whatever JCT uses) — must pass.
2. Run dev server: `pnpm dev`. Load with no `?v=` — should auto-fit to
   responsive breakpoint default (no URL change).
3. Pan/zoom: URL updates to `?v=<lat>-<lon>+<zoom>+<pitch>+<bearing>`,
   signed-delim format, zoom 1 decimal place. Hard-reload the URL —
   view restores to the encoded position.
4. Reset to default (whatever the JCT UI provides) — URL clears `?v=`
   when the view matches the responsive default.
5. Round-trip a known URL like
   `?v=40.7197-74.0506+12.0+45+0` — should decode to lat=40.7197,
   lon=-74.0506, zoom=12.0, pitch=45, bearing=0. Same shape as today's
   URLs.

Only after all consumer-side checks pass: push `use-prms` upstream,
then `pds gh prms <new-sha>` here, commit JCT changes.

## Out of scope

- Migrating JCT to also use `bboxParam` (no current consumer in JCT).
- Refactoring `useKeyboardShortcuts` ViewState — see §4 above, leave
  alone.
- Wire-format changes (e.g. switching to underscore-delim) — explicitly
  not desired; signed-delim is preferred (and now shared) precisely
  because it reads cleaner in URLs.
