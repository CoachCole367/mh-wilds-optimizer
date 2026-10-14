import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const dir = await mkdtemp(join(tmpdir(), "mh-wilds-live-"));
try {
  const entry = join(dir, "entry.js");
  await writeFile(
    entry,
    `export {loadOptimizerData} from ${JSON.stringify(join(process.cwd(), "src/mhdbApi.ts"))}; export {optimizeBuilds,prepareSearchData} from ${JSON.stringify(join(process.cwd(), "src/optimizer.ts"))};`,
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(dir, "bundle.mjs"),
  });
  const { loadOptimizerData, optimizeBuilds, prepareSearchData } = await import(
    pathToFileURL(join(dir, "bundle.mjs"))
  );
  const { data } = await loadOptimizerData("en", true);
  console.log(
    "Database",
    data.version,
    "armor",
    Object.keys(data.armorById).length,
    "skills",
    data.skills.length,
  );
  for (const desiredSkills of [
    [
      { skillId: 105, level: 3 },
      { skillId: 102, level: 1 },
    ],
    [
      { skillId: 57, level: 5 },
      { skillId: 144, level: 5 },
    ],
  ]) {
    const request = {
      data,
      desiredSkills,
      allowAlpha: true,
      allowGamma: true,
      useAllDecorations: true,
      allowedDecorationIds: [],
      allowedHeadIds: data.armorByKind.head.map((p) => p.id),
      maxResults: 10,
      weaponGroupBonusPieces: {},
    };
    const start = performance.now();
    request.data = prepareSearchData(request);
    request.prepared = true;
    request.allowedHeadIds = request.data.armorByKind.head.map((p) => p.id);
    console.log(
      "Prepared pools",
      Object.fromEntries(
        Object.entries(request.data.armorByKind).map(([k, p]) => [k, p.length]),
      ),
    );
    const result = optimizeBuilds(request);
    console.log(
      JSON.stringify({
        targets: desiredSkills,
        ms: performance.now() - start,
        results: result.results.length,
        stats: result.stats,
      }),
    );
    if (!result.results.length)
      throw Error("Representative search returned no builds.");
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
