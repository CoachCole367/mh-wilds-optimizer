# MH Wilds Skill-First Gear Optimizer (V1)

Client-side TypeScript app that loads MHDB Wilds data and finds valid armor/charm/decoration builds for requested skill targets.

## Run

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

## Included V1 Features

- Skill target picker with level controls (from `/skills`)
- Decoration pool multi-select with `Armor decorations only` filter
- Alpha/Gamma armor toggles
- Worker-based optimization (`Max Threads`, `Max Results Per Thread`)
- Dominated armor pruning + branch-and-bound search
- Set bonus + group bonus skill application
- Decoration feasibility DFS with memoization
- Ranked results with defense, slot usage, skill totals, and placements
- Share-link encoding for optimizer inputs
- Footer disclaimer: `Not affiliated with Capcom.`
