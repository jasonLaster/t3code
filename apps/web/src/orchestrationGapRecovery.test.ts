import { describe, expect, it, vi } from "vitest";

import {
  createDomainEventRecoveryQueue,
  recoverDomainEventSequenceGap,
} from "./orchestrationGapRecovery";

describe("recoverDomainEventSequenceGap", () => {
  it("triggers replay and snapshot sync when an incoming domain-event sequence gap is detected", async () => {
    const replayEvents = vi.fn(async () => [{ sequence: 2 }, { sequence: 3 }]);
    const syncSnapshot = vi.fn(async () => undefined);

    const nextSequence = await recoverDomainEventSequenceGap({
      latestSequence: 1,
      incomingSequence: 4,
      replayEvents,
      syncSnapshot,
    });

    expect(replayEvents).toHaveBeenCalledTimes(1);
    expect(replayEvents).toHaveBeenCalledWith(1);
    expect(syncSnapshot).toHaveBeenCalledTimes(1);
    expect(nextSequence).toBe(4);
  });

  it("still performs snapshot sync when replay fails", async () => {
    const replayEvents = vi.fn(async () => {
      throw new Error("replay unavailable");
    });
    const syncSnapshot = vi.fn(async () => undefined);

    const nextSequence = await recoverDomainEventSequenceGap({
      latestSequence: 10,
      incomingSequence: 14,
      replayEvents,
      syncSnapshot,
    });

    expect(replayEvents).toHaveBeenCalledTimes(1);
    expect(syncSnapshot).toHaveBeenCalledTimes(1);
    expect(nextSequence).toBe(14);
  });
});

describe("createDomainEventRecoveryQueue", () => {
  it("serializes recovery so latest sequence cannot move backwards", async () => {
    let latestSequence = 0;
    let resolveFirstReplay: (() => void) | null = null;
    const firstReplayGate = new Promise<void>((resolve) => {
      resolveFirstReplay = resolve;
    });

    const replayEvents = vi.fn(async (fromSequenceExclusive: number) => {
      if (fromSequenceExclusive === 0) {
        await firstReplayGate;
      }
      return [];
    });
    const syncSnapshot = vi.fn(async () => undefined);

    const queue = createDomainEventRecoveryQueue({
      getLatestSequence: () => latestSequence,
      setLatestSequence: (value) => {
        latestSequence = value;
      },
      replayEvents,
      syncSnapshot,
    });

    const first = queue.enqueue(2);
    const second = queue.enqueue(3);

    await Promise.resolve();
    expect(replayEvents).toHaveBeenCalledTimes(1);

    resolveFirstReplay?.();
    await Promise.all([first, second]);

    expect(replayEvents).toHaveBeenCalledTimes(1);
    expect(replayEvents).toHaveBeenNthCalledWith(1, 0);
    expect(syncSnapshot).toHaveBeenCalledTimes(2);
    expect(latestSequence).toBe(3);
  });
});
