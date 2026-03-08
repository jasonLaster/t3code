import type { WsPush } from "@t3tools/contracts";
import type { WebSocket } from "ws";

type ClientState =
  | {
      status: "pre_welcome";
      backlog: PushEnvelope[];
    }
  | {
      status: "active";
      backlog: PushEnvelope[];
    };

interface PushEnvelope {
  sequence: number;
  payload: string;
  push: WsPush;
}

export interface PushBus {
  readonly registerPreWelcome: (ws: WebSocket) => void;
  readonly activate: (ws: WebSocket) => void;
  readonly unregister: (ws: WebSocket) => void;
  readonly publishAll: (push: WsPush) => void;
}

const DEFAULT_MAX_BACKLOG_PER_CLIENT = 512;

export function createPushBus(params: {
  readonly encodePush: (push: WsPush) => string;
  readonly onPublish?: (push: WsPush, recipients: number) => void;
  readonly maxBacklogPerClient?: number;
}): PushBus {
  let nextSequence = 0;
  const clients = new Map<WebSocket, ClientState>();
  const maxBacklogPerClient = params.maxBacklogPerClient ?? DEFAULT_MAX_BACKLOG_PER_CLIENT;

  const registerPreWelcome = (ws: WebSocket) => {
    clients.set(ws, { status: "pre_welcome", backlog: [] });
  };

  const unregister = (ws: WebSocket) => {
    clients.delete(ws);
  };

  const activate = (ws: WebSocket) => {
    const client = clients.get(ws);
    if (!client) {
      return;
    }
    const backlog = client.backlog.toSorted((a, b) => a.sequence - b.sequence);
    clients.set(ws, { status: "active", backlog: [] });
    if (ws.readyState !== ws.OPEN) {
      return;
    }
    for (const envelope of backlog) {
      ws.send(envelope.payload);
    }
  };

  const publishAll = (push: WsPush) => {
    nextSequence += 1;
    const envelope: PushEnvelope = {
      sequence: nextSequence,
      payload: params.encodePush(push),
      push,
    };

    let recipients = 0;
    for (const [client, state] of clients.entries()) {
      if (state.status === "active") {
        if (client.readyState !== client.OPEN) {
          continue;
        }
        client.send(envelope.payload);
        recipients += 1;
        continue;
      }

      if (state.backlog.length >= maxBacklogPerClient) {
        state.backlog.shift();
      }
      state.backlog.push(envelope);
    }

    params.onPublish?.(envelope.push, recipients);
  };

  return {
    registerPreWelcome,
    activate,
    unregister,
    publishAll,
  };
}
