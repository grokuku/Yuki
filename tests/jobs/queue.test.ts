import { describe, expect, it } from "vitest";

import { JobQueue } from "../../src/jobs/index.js";

describe("JobQueue — concurrence bornée & file FIFO", () => {
  it("admet jusqu'à maxConcurrent puis met en file, puis refuse", () => {
    const queue = new JobQueue({ maxConcurrent: 2, maxQueue: 1 });
    expect(queue.admit("a")).toEqual({ admission: "start" });
    expect(queue.admit("b")).toEqual({ admission: "start" });
    expect(queue.admit("c")).toEqual({ admission: "queued", position: 1 });
    expect(queue.admit("d")).toEqual({
      admission: "rejected",
      reason: "queue_full",
    });
    expect(queue.runningCount).toBe(2);
    expect(queue.queuedCount).toBe(1);
  });

  it("libère un slot et démarre le suivant en FIFO", () => {
    const queue = new JobQueue({ maxConcurrent: 1, maxQueue: 2 });
    queue.admit("a");
    queue.admit("b");
    queue.admit("c");
    expect(queue.release("a")).toBe("b");
    expect(queue.isRunning("b")).toBe(true);
    expect(queue.release("b")).toBe("c");
    expect(queue.release("c")).toBeUndefined();
    expect(queue.runningCount).toBe(0);
    expect(queue.queuedCount).toBe(0);
  });

  it("retire un job en attente (annulation) sans affecter les slots", () => {
    const queue = new JobQueue({ maxConcurrent: 1, maxQueue: 3 });
    queue.admit("a");
    queue.admit("b");
    queue.admit("c");
    expect(queue.remove("b")).toBe(true);
    expect(queue.remove("b")).toBe(false);
    expect(queue.queuedCount).toBe(1);
    expect(queue.release("a")).toBe("c");
  });

  it("la file pleine refuse explicitement (jamais de blocage silencieux)", () => {
    const queue = new JobQueue({ maxConcurrent: 1, maxQueue: 0 });
    expect(queue.admit("a")).toEqual({ admission: "start" });
    expect(queue.admit("b")).toEqual({
      admission: "rejected",
      reason: "queue_full",
    });
  });
});
