import { type WsPushChannel, type WsPushData, type WsPush } from "@t3tools/contracts";
import { Deferred, Effect, Queue, Ref } from "effect";
import type { Scope } from "effect";
import type { WebSocket } from "ws";

type PushTarget =
  | { readonly kind: "all" }
  | { readonly kind: "client"; readonly client: WebSocket };

interface PushJob<C extends WsPushChannel = WsPushChannel> {
  readonly channel: C;
  readonly data: WsPushData<C>;
  readonly target: PushTarget;
  readonly delivered: Deferred.Deferred<boolean> | null;
}

interface ClientHandshakeState {
  readonly ready: boolean;
  readonly backlog: ReadonlyArray<WsPush>;
}

const PRE_WELCOME_BACKLOG_LIMIT = 200;

export interface ServerPushBus {
  readonly registerClient: (client: WebSocket) => Effect.Effect<void>;
  readonly removeClient: (client: WebSocket) => Effect.Effect<void>;
  readonly markClientReady: (client: WebSocket) => Effect.Effect<void>;
  readonly publishAll: <C extends WsPushChannel>(
    channel: C,
    data: WsPushData<C>,
  ) => Effect.Effect<void>;
  readonly publishClient: <C extends WsPushChannel>(
    client: WebSocket,
    channel: C,
    data: WsPushData<C>,
  ) => Effect.Effect<boolean>;
}

export const makeServerPushBus = (input: {
  readonly clients: Ref.Ref<Set<WebSocket>>;
  readonly logOutgoingPush: (push: WsPush, recipients: number) => void;
}): Effect.Effect<ServerPushBus, never, Scope.Scope> =>
  Effect.gen(function* () {
    const nextSequence = yield* Ref.make(0);
    const queue = yield* Queue.unbounded<PushJob>();
    const handshakeClients = yield* Ref.make(new Map<WebSocket, ClientHandshakeState>());

    const settleDelivery = (job: PushJob, delivered: boolean) =>
      job.delivered === null
        ? Effect.void
        : Deferred.succeed(job.delivered, delivered).pipe(Effect.orDie);

    const createPush = Effect.fnUntraced(function* (job: PushJob) {
      const sequence = yield* Ref.updateAndGet(nextSequence, (current) => current + 1);
      return {
        type: "push",
        sequence,
        channel: job.channel,
        data: job.data,
      } as WsPush;
    });

    const queueBacklogForPreWelcomeClients = (push: WsPush) =>
      Ref.update(handshakeClients, (current) => {
        let changed = false;
        const next = new Map(current);
        for (const [client, state] of current.entries()) {
          if (state.ready || !next.has(client)) {
            continue;
          }
          changed = true;
          const trimmedBacklog =
            state.backlog.length >= PRE_WELCOME_BACKLOG_LIMIT
              ? state.backlog.slice(state.backlog.length - PRE_WELCOME_BACKLOG_LIMIT + 1)
              : state.backlog;
          next.set(client, {
            ...state,
            backlog: [...trimmedBacklog, push],
          });
        }
        return changed ? next : current;
      });

    const send = Effect.fnUntraced(function* (job: PushJob) {
      const push = yield* createPush(job);
      const message = JSON.stringify(push);

      const recipients =
        job.target.kind === "all" ? yield* Ref.get(input.clients) : new Set([job.target.client]);

      let recipientCount = 0;
      for (const client of recipients) {
        if (client.readyState !== client.OPEN) {
          continue;
        }
        client.send(message);
        recipientCount += 1;
      }

      if (job.target.kind === "all") {
        yield* queueBacklogForPreWelcomeClients(push);
      }

      input.logOutgoingPush(push, recipientCount);
      return recipientCount > 0;
    });

    const flushClientBacklog = (client: WebSocket, backlog: ReadonlyArray<WsPush>) =>
      Effect.sync(() => {
        for (const push of backlog) {
          if (client.readyState !== client.OPEN) {
            return;
          }
          client.send(JSON.stringify(push));
        }
      });

    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((job) =>
            send(job).pipe(
              Effect.tap((delivered) => settleDelivery(job, delivered)),
              Effect.tapCause(() => settleDelivery(job, false)),
              Effect.ignoreCause({ log: true }),
            ),
          ),
        ),
      ),
    );

    const publish =
      (target: PushTarget) =>
      <C extends WsPushChannel>(channel: C, data: WsPushData<C>) =>
        Queue.offer(queue, {
          channel,
          data,
          target,
          delivered: null,
        }).pipe(Effect.asVoid);

    return {
      registerClient: (client) =>
        Ref.update(handshakeClients, (current) => {
          if (current.has(client)) {
            return current;
          }
          const next = new Map(current);
          next.set(client, { ready: false, backlog: [] });
          return next;
        }),
      removeClient: (client) =>
        Effect.gen(function* () {
          yield* Ref.update(input.clients, (current) => {
            if (!current.has(client)) {
              return current;
            }
            const next = new Set(current);
            next.delete(client);
            return next;
          });
          yield* Ref.update(handshakeClients, (current) => {
            if (!current.has(client)) {
              return current;
            }
            const next = new Map(current);
            next.delete(client);
            return next;
          });
        }),
      markClientReady: (client) =>
        Effect.gen(function* () {
          const backlog = yield* Ref.modify(handshakeClients, (current) => {
            const state = current.get(client);
            if (!state) {
              return [null, current] as const;
            }
            const next = new Map(current);
            next.set(client, { ready: true, backlog: [] });
            return [state.backlog, next] as const;
          });

          yield* Ref.update(input.clients, (current) => {
            if (current.has(client)) {
              return current;
            }
            const next = new Set(current);
            next.add(client);
            return next;
          });

          if (backlog && backlog.length > 0) {
            yield* flushClientBacklog(client, backlog);
          }
        }),
      publishAll: publish({ kind: "all" }),
      publishClient: (client, channel, data) =>
        Effect.gen(function* () {
          const delivered = yield* Deferred.make<boolean>();
          yield* Queue.offer(queue, {
            channel,
            data,
            target: { kind: "client", client },
            delivered,
          }).pipe(Effect.asVoid);
          return yield* Deferred.await(delivered);
        }),
    } satisfies ServerPushBus;
  });
