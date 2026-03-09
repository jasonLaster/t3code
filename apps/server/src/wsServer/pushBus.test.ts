import type { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { WS_CHANNELS } from "@t3tools/contracts";

import { makeServerPushBus } from "./pushBus";

class MockWebSocket {
  static readonly OPEN = 1;

  readonly OPEN = MockWebSocket.OPEN;
  readyState = MockWebSocket.OPEN;
  readonly sent: string[] = [];
  private readonly waiters = new Set<() => void>();

  send(message: string) {
    this.sent.push(message);
    for (const waiter of this.waiters) {
      waiter();
    }
  }

  waitForSentCount(count: number): Promise<void> {
    if (this.sent.length >= count) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const check = () => {
        if (this.sent.length < count) {
          return;
        }
        this.waiters.delete(check);
        resolve();
      };

      this.waiters.add(check);
    });
  }
}

describe("makeServerPushBus", () => {
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
  });

  it("queues publishAll pushes for pre_welcome clients and flushes after activation", async () => {
    scope = await Effect.runPromise(Scope.make("sequential"));

    const client = new MockWebSocket();
    const pushBus = await Effect.runPromise(
      makeServerPushBus({
        logOutgoingPush: () => {},
      }).pipe(Scope.provide(scope)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* pushBus.registerClient(client as unknown as WebSocket);
        yield* pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          issues: [{ kind: "keybindings.malformed-config", message: "queued-before-welcome" }],
          providers: [],
        });

        const delivered = yield* pushBus.publishClient(
          client as unknown as WebSocket,
          WS_CHANNELS.serverWelcome,
          {
            cwd: "/tmp/project",
            projectName: "project",
          },
        );
        expect(delivered).toBe(true);

        yield* pushBus.activateClient(client as unknown as WebSocket);
      }),
    );

    await client.waitForSentCount(2);

    const messages = client.sent.map(
      (message) => JSON.parse(message) as { channel: string; data: unknown; sequence: number },
    );

    expect(messages).toEqual([
      {
        type: "push",
        sequence: 2,
        channel: WS_CHANNELS.serverWelcome,
        data: {
          cwd: "/tmp/project",
          projectName: "project",
        },
      },
      {
        type: "push",
        sequence: 1,
        channel: WS_CHANNELS.serverConfigUpdated,
        data: {
          issues: [{ kind: "keybindings.malformed-config", message: "queued-before-welcome" }],
          providers: [],
        },
      },
    ]);
  });
});
