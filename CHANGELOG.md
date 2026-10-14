# Changelog

## 2026-10-13

- Repair GitHub Pages deployment to publish the production build instead of raw TypeScript; use portable asset, page, manifest and embedded-editor paths.
- Restore a visible Set bonus optimizer with set/group targets and piece-threshold guidance; add set-only search and navigation tests on domain-root and repository-path hosting.

- Fix armor bounds that rejected builds completed by decorations, near-miss handling, and decoration assignment quality.
- Search equipped owned talismans directly instead of adding them on top of craftable talismans.
- Preserve weapon skills, weapon slots, unknown skill IDs and inventory metadata; add backed-up imports and non-destructive editing.
- Enforce typed decoration slots and optional owned quantities, with exact gear placement in results.
- Stop counting conditional set/group skills as innate armor skills. Separate actual Gogma weapon set/group rolls.
- Add equipment locks/exclusions, rank and rarity filters, base defense mode and user-entered upgrade/transcendence values.
- Replace technical controls with an equipment → skills → decorations flow, searchable selections, favorites, accessible level buttons, mobile actions, and explicit incomplete-result labels.
- Add saved builds, comparison, checklists and versioned exact-build links.
- Prepare/prune once per search, cap workers at four, rank consistently, order promising candidates first and add safe defense/slot bounds.
- Harden worker failures, cancellation, settings changes, cache schema validation, API timeouts, imports and rendering.
- Consolidate theme tokens and inventory rules, reduce obsolete UI/CSS, add canonical skill classifications across data languages.
- Update development tools and transitive packages; audit reports zero known vulnerabilities at validation time.
- Add solver/inventory regressions, exhaustive small-fixture feasibility checks, live-data benchmarks and GitHub test/build CI.
- Add approved Playwright browser checks for quantities, owned talismans, editing, sharing, mobile layout, worker equivalence, errors and cancellation.

Remaining data limitations and deferred optimizations are tracked in `IMPLEMENTATION_STATUS.md`.
