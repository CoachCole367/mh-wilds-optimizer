# MH Wilds optimizer

- Stack: Vite, TypeScript, vanilla browser UI, dedicated Web Workers; no runtime framework.
- Node: 20.19+ (CI uses Node 22). Install: `npm ci`; dev: `npm run dev`; build: `npm run build`; preview: `npm run preview`.
- Tests: `npm test`; fixture benchmark: `npm run bench:optimizer`; optional network benchmark: `npm run bench:live`.
- Browser tests: `npx playwright install chromium`, then `npm run test:browser`; deterministic fixtures against production preview.
- Keep calculations in optimizer modules, inventory rules in the shared public inventory module, and search lifecycle in searchCoordinator.
- Search equips exactly one talisman. Keep armor and weapon slot types and enforce decoration quantities.
- Never destroy imported inventory to match the current dataset. Reject unsupported search inputs with an explanation instead.
- Do not invent legal talisman/weapon roll tables, transcended stats, patch coverage, or unreleased expansion data.
- Definition of done: targeted regressions, typecheck/build and benchmarks pass; relevant browser flows verified or explicitly reported unverified; update CHANGELOG and implementation status.
