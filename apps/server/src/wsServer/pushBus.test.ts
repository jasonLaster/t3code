import { describe, expect, it } from "vitest";

import type { WsPush } from "@t3tools/contracts";
import { createPushBus } from "./pushBus";

interface MockSocket {
  OPEN: number;
  readyState: number;
  sent: string[];
  send: (payload: string) => void;
}

function mkPush(channel: string): WsPush {
  return {
    type: "push",
    channel,
    data: {},
  };
}

function makeSocket(): MockSocket {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(payload: string) {
      this.sent.push(payload);
    },
  };
}

describe("pushBus", () => {
  it("buffers pre-welcome pushes and flushes in sequence after activation", () => {
    const encoded: Array<{ channel: string; seq: number }> = [];
    let seq = 0;
    const bus = createPushBus({
      encodePush: (push) => {
        seq += 1;
        encoded.push({ channel: push.channel, seq });
        return JSON.stringify({ push, seq });
      },
    });

    const active = makeSocket();
    const preWelcome = makeSocket();

    bus.registerPreWelcome(active as never);
    bus.activate(active as never);
    bus.registerPreWelcome(preWelcome as never);

    bus.publishAll(mkPush("one"));
    bus.publishAll(mkPush("two"));

    expect(active.sent).toHaveLength(2);
    expect(preWelcome.sent).toHaveLength(0);

    bus.publishAll(mkPush("welcome"));
    bus.activate(preWelcome as never);

    expect(preWelcome.sent).toHaveLength(3);
    const channels = preWelcome.sent.map((raw) => (JSON.parse(raw) as { push: WsPush }).push.channel);
    expect(channels).toEqual(["one", "two", "welcome"]);
  });
});
