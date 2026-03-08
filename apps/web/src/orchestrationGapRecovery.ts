import type { NativeApi } from "@t3tools/contracts";

export interface DomainEventGapRecoveryInput {
  latestSequence: number;
  incomingSequence: number;
  replayEvents: NativeApi["orchestration"]["replayEvents"];
  syncSnapshot: () => Promise<void>;
}

export interface DomainEventRecoveryQueue {
  readonly enqueue: (incomingSequence: number) => Promise<void>;
}

/**
 * Handles domain-event sequence progression and fills reconnect gaps.
 *
 * Returns the next latest sequence value callers should persist.
 */
export async function recoverDomainEventSequenceGap(
  input: DomainEventGapRecoveryInput,
): Promise<number> {
  if (input.incomingSequence <= input.latestSequence) {
    return input.latestSequence;
  }

  const hasGap = input.incomingSequence > input.latestSequence + 1;

  if (hasGap) {
    try {
      await input.replayEvents(input.latestSequence);
    } catch {
      // Fallback to snapshot sync below.
    }
  }

  await input.syncSnapshot();
  return input.incomingSequence;
}

/**
 * Serializes domain-event recovery work so out-of-order async completions
 * cannot move latest sequence backwards.
 */
export function createDomainEventRecoveryQueue(input: {
  getLatestSequence: () => number;
  setLatestSequence: (value: number) => void;
  replayEvents: NativeApi["orchestration"]["replayEvents"];
  syncSnapshot: () => Promise<void>;
}): DomainEventRecoveryQueue {
  let chain = Promise.resolve();

  return {
    enqueue: (incomingSequence) => {
      chain = chain
        .then(async () => {
          const next = await recoverDomainEventSequenceGap({
            latestSequence: input.getLatestSequence(),
            incomingSequence,
            replayEvents: input.replayEvents,
            syncSnapshot: input.syncSnapshot,
          });
          input.setLatestSequence(next);
        })
        .catch(() => undefined);

      return chain;
    },
  };
}
