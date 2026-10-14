# MH Wilds Skill-First Gear Optimizer

Client-side Vite / TypeScript optimizer using MHDB data, dedicated Web Workers, and browser storage. No runtime framework or backend.

[Live site](https://mh-wilds-optimizer.pages.dev/) · [Implementation status](IMPLEMENTATION_STATUS.md) · [Release notes](CHANGELOG.md)

## Development

Node 20.19+ is required (CI uses Node 22).

```sh
npm ci
npm run dev
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run bench:optimizer
npm run bench:live
```

The live benchmark needs internet access. Its timings depend on the current dataset and machine; the tiny fixture benchmark is not an endgame performance guarantee. Browser tests intercept MHDB with deterministic fixtures and run against the production build. There is no separate lint command; TypeScript checks are part of build.

Deploy the generated `dist` directory to static hosting. Cloudflare Pages: build command `npm run build`, output directory `dist`, supported Node version. GitHub pushes do not independently confirm that the hosting deployment succeeded.

## Search behavior

- Equip exactly one craftable, owned, or clearly labeled hypothetical talisman.
- Required targets determine feasibility; preferred targets improve ranking.
- Ranking: fewer missing levels, more preferred levels, selected sort priority, equipment defense, empty capacity, fewer excess requested points, then deterministic ties.
- Armor and weapon decoration slots are separate. Optional owned quantities constrain target jewels and leftover-slot suggestions.
- Lock/exclude armor, limit rarity/rank, and select base or database maximum defense. Enter actual upgraded/transcended values when the database cannot verify them.
- Save builds locally, pin comparisons, export checklists, and share exact equipment snapshots. Shared builds include the chosen talisman, not the entire inventory.
- Searches snapshot inputs, retain a global result limit, and use at most four workers. Changing inputs invalidates results.

Defense and resistances are equipment sums, excluding food and conditional skill effects. Results are not DPS rankings. Leftover-slot suggestions are heuristic and not an exhaustive optimizer.

## Data and game coverage

Equipment comes from [MHDB Wilds](https://wilds.mhdb.io/). Database timestamps and game patches are shown separately. Official patch changes were checked through Ver.1.042.00.02 (August 14, 2026); complete item, quest, and legal-roll coverage is **not certified**.

Gogma set and group rolls are entered independently. Appraised talismans preserve armor/weapon skills and slots. Timeworn Charm guidance reflects improved rarity odds without inventing new attributes. Verified legal roll tables, complete acquisition metadata, and automatic transcended variants remain unavailable. Future Ascendance / Master Rank content is excluded.

The [implementation status](IMPLEMENTATION_STATUS.md) maps all 55 review items to completed or partial work and explains outstanding limits.

## Maintenance

- `src/optimizer.ts`: filtering, bounds, exact decoration assignment, ranking.
- `src/searchCoordinator.ts`: immutable run inputs, worker sharding, cancellation/errors.
- `src/main.ts`, `src/interfaceMarkup.ts`, `src/style.css`: UI flow and presentation.
- `public/charm-inventory.js`: shared lossless inventory rules for the app and talisman editor.
- `src/mhdbApi.ts`, `src/validatePayload.ts`, `src/cacheStore.ts`: data validation and versioned fallback cache.
- `src/shareState.ts`, `src/buildStorage.ts`: links, saved builds, checklists.

Inventories use the original storage key and retain unknown numeric skill IDs. Imports can merge or replace with a previous-inventory backup. Export before changing browsers/devices: browser storage is local and can be cleared by browser settings.

Not affiliated with Capcom. Monster Hunter belongs to Capcom.
