import { compareForMode, prepareSearchData } from "./optimizer";
import type {
  BuildResult,
  OptimizeWorkerMessage,
  OptimizeWorkerRequest,
  WorkerStats,
} from "./types";

export type SearchSummary = {
  results: BuildResult[];
  stats: WorkerStats[];
  durationMs: number;
};
export function startSearch(
  input: OptimizeWorkerRequest,
  requestedWorkers: number,
  progress: (visited: number, found: number) => void,
): { promise: Promise<SearchSummary>; cancel: () => void } {
  const started = performance.now();
  const request = structuredClone(input);
  request.data = prepareSearchData(request);
  request.prepared = true;
  const heads = request.data.armorByKind.head.map((p) => p.id);
  const count = Math.max(1, Math.min(requestedWorkers, 4, heads.length));
  const chunks: number[][] = Array.from({ length: count }, () => []);
  heads.forEach((id, i) => chunks[i % count].push(id));
  const workers: Worker[] = [];
  const cancels: Array<() => void> = [];
  const summaries = new Map<number, { visited: number; found: number }>();
  const promises = chunks
    .filter((c) => c.length)
    .map(
      (allowedHeadIds, index) =>
        new Promise<{ results: BuildResult[]; stats: WorkerStats }>(
          (resolve, reject) => {
            const worker = new Worker(
              new URL("./optimizerWorker.ts", import.meta.url),
              { type: "module" },
            );
            workers.push(worker);
            let settled = false;
            const fail = (message: string) => {
              if (settled) return;
              settled = true;
              worker.terminate();
              reject(new Error(message));
            };
            cancels.push(() => fail("Search cancelled."));
            worker.onerror = (e) =>
              fail(
                e.message ||
                  "A search worker failed. Please retry with fewer workers.",
              );
            worker.onmessageerror = () =>
              fail("Could not read the search worker response.");
            worker.onmessage = (event: MessageEvent<OptimizeWorkerMessage>) => {
              if (settled) return;
              const message = event.data;
              if (message.type === "progress") {
                summaries.set(index, {
                  visited: message.branchesVisited,
                  found: message.feasibleBuilds,
                });
                progress(
                  [...summaries.values()].reduce((n, s) => n + s.visited, 0),
                  [...summaries.values()].reduce((n, s) => n + s.found, 0),
                );
                return;
              }
              if (message.error) {
                fail(message.error);
                return;
              }
              settled = true;
              worker.terminate();
              resolve(message);
            };
            worker.postMessage({
              ...request,
              allowedHeadIds,
              workerIndex: index,
            });
          },
        ),
    );
  const cancel = () => {
    cancels.forEach((fn) => fn());
    workers.forEach((w) => w.terminate());
  };
  const promise = Promise.all(promises)
    .then((responses) => ({
      results: responses
        .flatMap((r) => r.results)
        .sort((a, b) => compareForMode(a, b, request.sortMode))
        .slice(0, request.maxResults),
      stats: responses.map((r) => r.stats),
      durationMs: performance.now() - started,
    }))
    .catch((error) => {
      cancel();
      throw error;
    });
  return { promise, cancel };
}
