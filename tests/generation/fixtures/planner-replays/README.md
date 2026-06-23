# Planner Replay Fixtures

These files are raw planner outputs captured from live Claude calls. They are intentionally not
required before the planner/compiler path exists.

To capture:

```bash
npx tsx scripts/capture-planner-replays.ts
```

This spends live Claude usage. Once `law-firm.json`, `npm-release.json`, and
`full-stack-feature.json` are committed, `tests/generation/planner-replay.test.ts` becomes a hard
offline replay gate.
