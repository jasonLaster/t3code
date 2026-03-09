import { type WsPushChannel, type WsPushData, type WsPush } from "@t3tools/contracts";
import { Deferred, Effect, Queue, Ref } from "effect";
import type { Scope } from "effect";
import type { WebSocket } from "ws";

type PushTarget =
  | { readonly kind: "all" }
  | { readonly kind: "client"; readonly client: WebSocket };

type PushJob =
  | {
      readonly kind: "publish";
      readonly target: PushTarget;
      readonly push: WsPush;
      readonly delivered: Deferred.Deferred<boolean> | null;
    }
  | {
      readonly kind: "activate";
      readonly client: WebSocket;
      readonly activated: Deferred.Deferred<void>;
    };

type RegisteredClientState =
  | { readonly phase: "pre_welcome"; readonly backlog: WsPush[] }
  | { readonly phase: "active" };

const PRE_WELCOME_BACKLOG_LIMIT = 256;

export interface ServerPushBus {
  readonly registerClient: (client: WebSocket) => Effect.Effect<void>;
  readonly activateClient: (client: WebSocket) => Effect.Effect<void>;
  readonly unregisterClient: (client: WebSocket) => Effect.Effect<void>;
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
  readonly logOutgoingPush: (push: WsPush, recipients: number) => void;
}): Effect.Effect<ServerPushBus, never, Scope.Scope> =>
  Effect.gen(function* () {
    const nextSequence = yield* Ref.make(0);
    const queue = yield* Queue.unbounded<PushJob>();
    const clients = yield* Ref.make(new Map<WebSocket, RegisteredClientState>());

    const settleDelivery = (job: PushJob, delivered: boolean) =>
      job.kind !== "publish" || job.delivered === null
        ? Effect.void
        : Deferred.succeed(job.delivered, delivered).pipe(Effect.orDie);

    const sendPushToClient = (client: WebSocket, message: string) =>
      Effect.sync(() => {
        if (client.readyState !== client.OPEN) {
          return false;
        }
        client.send(message);
        return true;
      });

    const send = Effect.fnUntraced(function* (job: PushJob) {
      if (job.kind === "activate") {
        const state = yield* Ref.get(clients).pipe(Effect.map((current) => current.get(job.client)));
        if (!state || state.phase !== "pre_welcome") {
          yield* Deferred.succeed(job.activated, undefined).pipe(Effect.orDie);
          return false;
        }

        yield* Ref.update(clients, (current) => {
          const next = new Map(current);
          next.set(job.client, { phase: "active" });
          return next;
        });

        for (const queuedPush of state.backlog) {
          const message = JSON.stringify(queuedPush);
          const delivered = yield* sendPushToClient(job.client, message);
          input.logOutgoingPush(queuedPush, delivered ? 1 : 0);
        }

        yield* Deferred.succeed(job.activated, undefined).pipe(Effect.orDie);
        return false;
      }

      const { push } = job;
      const message = JSON.stringify(push);

      let recipientCount = 0;
      if (job.target.kind === "all") {
        yield* Ref.update(clients, (current) => {
          const next = new Map(current);
          for (const [client, state] of next) {
            if (state.phase === "active") {
              continue;
            }
            const nextBacklog = [...state.backlog, push];
            if (nextBacklog.length > PRE_WELCOME_BACKLOG_LIMIT) {
              nextBacklog.splice(0, nextBacklog.length - PRE_WELCOME_BACKLOG_LIMIT);
            }
            next.set(client, {
              phase: "pre_welcome",
              backlog: nextBacklog,
            });
          }
          return next;
        });

        const current = yield* Ref.get(clients);
        for (const [client, state] of current) {
          if (state.phase !== "active") {
            continue;
          }
          if (yield* sendPushToClient(client, message)) {
            recipientCount += 1;
          }
        }
      } else if (yield* sendPushToClient(job.target.client, message)) {
        recipientCount = 1;
      }

      input.logOutgoingPush(push, recipientCount);
      return recipientCount > 0;
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

    const makePush = <C extends WsPushChannel>(channel: C, data: WsPushData<C>) =>
      Ref.updateAndGet(nextSequence, (current) => current + 1).pipe(
        Effect.map(
          (sequence) =>
            ({
              type: "push",
              sequence,
              channel,
              data,
            }) as WsPush,
        ),
      );

    const publish =
      (target: PushTarget) =>
      <C extends WsPushChannel>(channel: C, data: WsPushData<C>) =>
        Effect.gen(function* () {
          const push = yield* makePush(channel, data);
          yield* Queue.offer(queue, {
            kind: "publish",
            target,
            push,
            delivered: null,
          }).pipe(Effect.asVoid);
        });

    return {
      registerClient: (client) =>
        Ref.update(clients, (current) => {
          const next = new Map(current);
          next.set(client, { phase: "pre_welcome", backlog: [] });
          return next;
        }),
      activateClient: (client) =>
        Effect.gen(function* () {
          const activated = yield* Deferred.make<void>();
          yield* Queue.offer(queue, {
            kind: "activate",
            client,
            activated,
          }).pipe(Effect.asVoid);
          yield* Deferred.await(activated);
        }),
      unregisterClient: (client) =>
        Ref.update(clients, (current) => {
          const next = new Map(current);
          next.delete(client);
          return next;
        }),
      publishAll: publish({ kind: "all" }),
      publishClient: (client, channel, data) =>
        Effect.gen(function* () {
          const delivered = yield* Deferred.make<boolean>();
          yield* Queue.offer(queue, {
            kind: "publish",
            target: { kind: "client", client },
            push: yield* makePush(channel, data),
            delivered,
          }).pipe(Effect.asVoid);
          return yield* Deferred.await(delivered);
        }),
    } satisfies ServerPushBus;
  });
