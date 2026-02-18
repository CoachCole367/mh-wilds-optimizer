/// <reference lib="webworker" />

import { optimizeBuilds } from "./optimizer";
import type {
  OptimizeWorkerDone,
  OptimizeWorkerProgress,
  OptimizeWorkerRequest,
  OptimizeWorkerResponse,
} from "./types";

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<OptimizeWorkerRequest & { workerIndex: number }>) => {
  const { workerIndex, ...request } = event.data;
  let response: OptimizeWorkerResponse;
  try {
    response = optimizeBuilds(request, workerIndex, (progress) => {
      const progressMessage: OptimizeWorkerProgress = {
        type: "progress",
        workerIndex,
        ...progress,
      };
      worker.postMessage(progressMessage);
    });
  } catch (error) {
    response = {
      workerIndex,
      results: [],
      stats: {
        branchesVisited: 0,
        prunedByBound: 0,
        completedArmorCombos: 0,
        feasibleBuilds: 0,
        durationMs: 0,
      },
      error: error instanceof Error ? error.message : "Worker failed.",
    };
  }
  const doneMessage: OptimizeWorkerDone = {
    type: "done",
    ...response,
  };
  worker.postMessage(doneMessage);
};

export {};
