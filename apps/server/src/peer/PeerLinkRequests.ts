/**
 * Links an agent asks the user to make. The user picks the machine and access in a card, and
 * their client answers with its addresses and a pairing code that goes straight to
 * `PeerLinks.link`, never into the transcript or the agent's context. Asking does not wait
 * (provider CLIs abandon a long tool call): the answer reaches the agent as a notification.
 */
import {
  CommandId,
  type EnvironmentId,
  formatLinkRequestSshTarget,
  MessageId,
  type NodeId,
  type OrchestrationV2Notification,
  type OrchestrationV2TurnItem,
  type OrchestratorMcpEnvironmentAddSshInput,
  type OrchestratorMcpEnvironmentAddSshResult,
  type OrchestratorMcpEnvironmentLinkInput,
  type OrchestratorMcpEnvironmentLinkResult,
  OrchestratorMcpFailure,
  type PeerLink,
  PeerLinkError,
  PeerLinkRequestError,
  type PeerLinkRequestAnswerInput,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "./PeerLinks.ts";

type LinkRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "link_request" }>;

/** The request as it was asked, which every update of its card repeats. */
type LinkRequestAsk = Pick<
  LinkRequestItem,
  "id" | "threadId" | "url" | "reason" | "environmentId" | "hint" | "requestedAccess" | "ssh"
> & { readonly runId: RunId; readonly nodeId: NodeId };

/** The notification that tells the agent how its card ended. */
type LinkRequestWake = {
  readonly messageId: MessageId;
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
};

/** What a card update may change. */
type LinkRequestOutcome = Pick<
  LinkRequestItem,
  "linkStatus" | "linkedEnvironmentId" | "linkedLabel" | "linkedAccess" | "failure"
>;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";

export class PeerLinkRequests extends Context.Service<
  PeerLinkRequests,
  {
    /**
     * Shows a link card in the calling thread and returns at once. A retry
     * with the same clientRequestId and MCP credential returns the card's
     * current outcome.
     */
    readonly request: (
      scope: McpInvocationContext.McpInvocationScope,
      input: OrchestratorMcpEnvironmentLinkInput,
    ) => Effect.Effect<OrchestratorMcpEnvironmentLinkResult, OrchestratorMcpFailure>;
    /**
     * Shows a card asking the user to connect an SSH host, and returns at once.
     * Their desktop app connects it with their own SSH config and keys, then
     * answers with the environment it saved. Needs no Linked environments beta.
     */
    readonly requestSsh: (
      scope: McpInvocationContext.McpInvocationScope,
      input: OrchestratorMcpEnvironmentAddSshInput,
    ) => Effect.Effect<OrchestratorMcpEnvironmentAddSshResult, OrchestratorMcpFailure>;
    /**
     * Answers a pending card and tells the agent. Linking uses the pairing
     * code once; a link the other environment refuses closes the card as
     * failed, with its reason.
     */
    readonly answer: (
      input: PeerLinkRequestAnswerInput,
    ) => Effect.Effect<void, PeerLinkRequestError>;
  }
>()("t3/peer/PeerLinkRequests") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const random = yield* SecureRandom.SecureRandom;

  const readCard = (threadId: ThreadId, turnItemId: TurnItemId) =>
    threadManagement
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["link_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.map((records) => {
          const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
          // A deleted thread's cards went with it.
          return item?.type === "link_request" && records.thread.deletedAt === null
            ? item
            : undefined;
        }),
      );

  /**
   * The stored link to `environmentId`, or nothing once it has expired: an
   * expired link needs a new pairing code, which only the card asks for.
   */
  const usableLink = (environmentId: EnvironmentId) =>
    Effect.all([peerLinks.get(environmentId), DateTime.now]).pipe(
      Effect.map(([linked, now]) =>
        Option.filter(linked, (link) => DateTime.isGreaterThan(link.expiresAt, now)),
      ),
    );

  const record = (
    card: LinkRequestAsk,
    outcome: LinkRequestOutcome,
    commandId: CommandId,
    wake?: LinkRequestWake,
    answeringTurnItemIds?: ReadonlyArray<TurnItemId>,
  ) =>
    threadManagement.dispatch({
      type: "link_request.record",
      commandId,
      threadId: card.threadId,
      runId: card.runId,
      nodeId: card.nodeId,
      turnItemId: card.id,
      ...(card.url === undefined ? {} : { url: card.url }),
      reason: card.reason,
      ...(card.environmentId === undefined ? {} : { environmentId: card.environmentId }),
      ...(card.hint === undefined ? {} : { hint: card.hint }),
      ...(card.requestedAccess === undefined ? {} : { requestedAccess: card.requestedAccess }),
      ...(card.ssh === undefined ? {} : { ssh: card.ssh }),
      ...outcome,
      ...(wake === undefined ? {} : { wake }),
      ...(answeringTurnItemIds === undefined ? {} : { answeringTurnItemIds }),
    });

  const linkedOutcome = (linked: PeerLink): LinkRequestOutcome => ({
    linkStatus: "linked",
    linkedEnvironmentId: linked.environmentId,
    linkedLabel: linked.label,
    linkedAccess: linked.access,
  });

  // One answer per card at a time: two answers racing on one card must not
  // both link. Other cards go on while a slow peer holds one.
  const answerLocks = yield* KeyedLock.make<TurnItemId>();
  // Per thread, held only to read a card before answering and to record the
  // answer, never while linking. A link ends older cards for the same
  // machine, but not one already being answered (its key is in answerLocks);
  // an answer that starts after that reads the ended card and links nothing.
  const lifecycleLocks = yield* KeyedLock.make<ThreadId>();

  /**
   * Closes a card still waiting when its agent retries naming a machine linked
   * meanwhile. Nothing wakes the agent: the retry itself returns the link.
   */
  const closeAsLinked = (threadId: ThreadId, turnItemId: TurnItemId, linked: PeerLink) =>
    answerLocks.withLock(
      turnItemId,
      lifecycleLocks.withLock(
        threadId,
        Effect.gen(function* () {
          const card = yield* readCard(threadId, turnItemId);
          if (
            card === undefined ||
            card.linkStatus !== "pending" ||
            card.runId === null ||
            card.nodeId === null
          ) {
            return;
          }
          yield* record(
            { ...card, runId: card.runId, nodeId: card.nodeId },
            linkedOutcome(linked),
            CommandId.make(`link-request:${card.id}:linked-on-retry`),
            undefined,
            yield* answerLocks.activeKeys,
          );
        }),
      ),
    );

  const request: PeerLinkRequests["Service"]["request"] = Effect.fn("PeerLinkRequests.request")(
    function* (scope, input) {
      // The card is shown in, and answered from, the caller's own thread.
      const threadScope = yield* McpInvocationContext.requireThreadScope(
        scope,
        "t3_environment_link",
      );
      const threadId = threadScope.thread.threadId;
      if (!(yield* peerLinks.enabled)) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
        });
      }
      if (input.url !== undefined && input.environmentId !== undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Pass either environmentId or url, not both. Pass neither to let the user pick the machine.",
        });
      }
      // A machine already linked needs no card: the agent can use it now.
      if (input.environmentId !== undefined) {
        const linked = yield* usableLink(input.environmentId).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
        if (Option.isSome(linked)) {
          if (input.clientRequestId !== undefined) {
            yield* closeAsLinked(
              threadId,
              cardId("link", threadId, scope.requestNamespace, input.clientRequestId),
              linked.value,
            ).pipe(
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: `Could not close the link request: ${errorMessage(error)}`,
                  }),
              ),
            );
          }
          return {
            status: "linked",
            environmentId: linked.value.environmentId,
            label: linked.value.label,
            access: linked.value.access,
          } as const;
        }
      }
      // Anything can answer at an address as any machine, so a card for an
      // address names none. The client names it from addresses it already has.
      const opened = yield* openCard(threadScope, input.clientRequestId, "link", {
        ...(input.url === undefined ? {} : { url: input.url }),
        reason: input.reason ?? "",
        ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
        ...(input.hint === undefined ? {} : { hint: input.hint }),
        ...(input.requestedAccess === undefined ? {} : { requestedAccess: input.requestedAccess }),
      });
      return opened.existing === undefined
        ? pendingResult(opened.turnItemId)
        : resultOf(opened.existing);
    },
    Effect.withSpan("PeerLinkRequests.request"),
  );

  /**
   * Records a new pending card in the caller's thread, or finds the one an
   * earlier call with the same clientRequestId recorded and records nothing.
   */
  const openCard = Effect.fn("PeerLinkRequests.openCard")(function* (
    threadScope: McpInvocationContext.McpThreadInvocationScope,
    clientRequestId: string | undefined,
    kind: CardKind,
    ask: Omit<LinkRequestAsk, "id" | "threadId" | "runId" | "nodeId">,
  ) {
    const threadId = threadScope.thread.threadId;
    const unreadable = (error: unknown) =>
      new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: `Unable to read the ${CARD_NOUN[kind]}: ${errorMessage(error)}`,
      });
    const key = clientRequestId ?? (yield* random.uuidV4());
    const turnItemId = cardId(kind, threadId, threadScope.requestNamespace, key);
    if (clientRequestId !== undefined) {
      const existing = yield* readCard(threadId, turnItemId).pipe(Effect.mapError(unreadable));
      if (existing !== undefined) return { turnItemId, existing };
    }
    const parent = yield* threadManagement
      .getThreadRecords(threadId, ["runs"], { messageRoles: [] })
      .pipe(Effect.mapError(unreadable));
    const run = ThreadManagementService.latestActiveRun(parent);
    if (
      run === undefined ||
      run.rootNodeId === null ||
      run.providerInstanceId !== threadScope.thread.providerInstanceId
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "parent_not_active",
        message: `Asking to ${CARD_VERB[kind]} requires an active run owned by this MCP provider session.`,
      });
    }
    yield* record(
      { ...ask, id: turnItemId, threadId, runId: run.id, nodeId: run.rootNodeId },
      { linkStatus: "pending" },
      CommandId.make(
        `command:mcp:${encodeURIComponent(threadScope.requestNamespace)}:${kind}-pending:${encodeURIComponent(key)}`,
      ),
    ).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `Could not record the ${CARD_NOUN[kind]}: ${errorMessage(error)}`,
          }),
      ),
    );
    return { turnItemId, existing: undefined };
  });

  const requestSsh: PeerLinkRequests["Service"]["requestSsh"] = Effect.fn(
    "PeerLinkRequests.requestSsh",
  )(function* (scope, input) {
    // The card is shown in, and answered from, the caller's own thread.
    const threadScope = yield* McpInvocationContext.requireThreadScope(
      scope,
      "t3_environment_add_ssh",
    );
    const opened = yield* openCard(threadScope, input.clientRequestId, "ssh", {
      reason: input.reason ?? "",
      ssh: {
        host: input.host,
        ...(input.username === undefined ? {} : { username: input.username }),
        ...(input.port === undefined ? {} : { port: input.port }),
      },
    });
    return opened.existing === undefined
      ? sshPendingResult(opened.turnItemId)
      : sshResultOf(opened.existing);
  }, Effect.withSpan("PeerLinkRequests.requestSsh"));

  /** Links the machine the user picked, or finds the link they chose to keep. */
  const answerOutcome = (
    answer: PeerLinkRequestAnswerInput["answer"],
  ): Effect.Effect<LinkRequestOutcome> => {
    switch (answer.type) {
      case "decline":
        return Effect.succeed({ linkStatus: "declined" });
      // The desktop app already connected and saved it; the card records that.
      case "ssh-connected":
        return Effect.succeed({
          linkStatus: "linked",
          linkedEnvironmentId: answer.environmentId,
          linkedLabel: answer.label,
        });
      case "use-existing":
        return usableLink(answer.environmentId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new PeerLinkError({
                    reason: "unknown_link",
                    message:
                      "That environment is no longer linked here, or its link expired. Link it again.",
                  }),
                ),
              onSome: (linked) => Effect.succeed(linkedOutcome(linked)),
            }),
          ),
          Effect.catch((error) =>
            Effect.succeed<LinkRequestOutcome>({ linkStatus: "failed", failure: error.message }),
          ),
        );
      case "link": {
        const [url, ...alternateUrls] = answer.urls;
        return peerLinks
          .link({
            url,
            ...(alternateUrls.length === 0 ? {} : { alternateUrls }),
            pairingCode: answer.pairingCode,
            access: answer.access,
            ...(answer.environmentId === undefined
              ? {}
              : { expectedEnvironmentId: answer.environmentId }),
            ...(answer.label === undefined ? {} : { expectedLabel: answer.label }),
          })
          .pipe(
            Effect.map(linkedOutcome),
            Effect.catch((error) =>
              Effect.succeed<LinkRequestOutcome>({ linkStatus: "failed", failure: error.message }),
            ),
          );
      }
    }
  };

  const answer: PeerLinkRequests["Service"]["answer"] = Effect.fn("PeerLinkRequests.answer")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "link_request.answer": input.answer.type,
      });
      const card = yield* lifecycleLocks.withLock(
        input.threadId,
        Effect.gen(function* () {
          const card = yield* readCard(input.threadId, input.turnItemId).pipe(
            Effect.mapError((cause) => new PeerLinkRequestError({ reason: "load_failed", cause })),
          );
          if (card === undefined || card.runId === null || card.nodeId === null) {
            return yield* new PeerLinkRequestError({ reason: "not_found" });
          }
          // Any time while the card is open: the agent hears the answer as a
          // notification, whether or not its run is still going.
          if (card.linkStatus !== "pending") {
            return yield* new PeerLinkRequestError({ reason: "already_answered" });
          }
          // An SSH card takes only an SSH answer, and a link card never one:
          // neither kind may close the other.
          if (input.answer.type !== "decline" && (card.ssh !== undefined) !== isSshAnswer(input)) {
            return yield* new PeerLinkRequestError({ reason: "wrong_answer" });
          }
          return { ...card, runId: card.runId, nodeId: card.nodeId };
        }),
      );
      // An id beside an address is what answered there, recorded by an older
      // server. Linking that machine could send its pairing code to the address.
      const outcome: LinkRequestOutcome =
        card.url !== undefined &&
        card.environmentId !== undefined &&
        input.answer.type === "link" &&
        input.answer.environmentId !== undefined
          ? {
              linkStatus: "failed",
              failure: "This request is from before an update. Ask for the link again.",
            }
          : yield* answerOutcome(input.answer);
      // If Stop closed the card while linking, the card keeps that; the link
      // itself stands and Settings lists it.
      yield* lifecycleLocks.withLock(
        input.threadId,
        Effect.flatMap(answerLocks.activeKeys, (answering) =>
          record(
            card,
            outcome,
            CommandId.make(`link-request:${card.id}:${outcome.linkStatus}`),
            {
              messageId: MessageId.make(`message:link-request:${card.id}`),
              ...outcomeNotice(card, outcome),
            },
            answering,
          ),
        ).pipe(
          Effect.mapError((cause) => new PeerLinkRequestError({ reason: "record_failed", cause })),
        ),
      );
    },
    (effect, input) =>
      effect.pipe(
        (effect) => answerLocks.withLock(input.turnItemId, effect),
        Effect.withSpan("PeerLinkRequests.answer"),
      ),
  );

  return PeerLinkRequests.of({ request, requestSsh, answer });
});

const isSshAnswer = (input: PeerLinkRequestAnswerInput) => input.answer.type === "ssh-connected";

/** A card asks for a link between environments, or for an SSH environment. */
type CardKind = "link" | "ssh";
const CARD_NOUN: Record<CardKind, string> = {
  link: "link request",
  ssh: "SSH environment request",
};
const CARD_VERB: Record<CardKind, string> = {
  link: "link an environment",
  ssh: "add an SSH environment",
};

/**
 * Turn item ids are global; scope the key to this thread and provider session,
 * since a later session may reuse it. Each kind has its own ids, so a key one
 * tool used never finds the other tool's card.
 */
const cardId = (kind: CardKind, threadId: ThreadId, requestNamespace: string, key: string) =>
  TurnItemId.make(
    `turn-item:${kind === "link" ? "link-request" : "ssh-request"}:${encodeURIComponent(threadId)}:${encodeURIComponent(requestNamespace)}:${encodeURIComponent(key)}`,
  );

const sshTargetLabel = formatLinkRequestSshTarget;

const sshPendingResult = (turnItemId: TurnItemId): OrchestratorMcpEnvironmentAddSshResult => ({
  status: "pending",
  turnItemId,
});

/** What a retry of an SSH request hears: the card's outcome. */
const sshResultOf = (card: LinkRequestItem): OrchestratorMcpEnvironmentAddSshResult => {
  switch (card.linkStatus) {
    case "pending":
      return sshPendingResult(card.id);
    case "linked":
      return {
        status: "connected",
        environmentId: card.linkedEnvironmentId!,
        label: card.linkedLabel ?? (card.ssh === undefined ? "" : sshTargetLabel(card.ssh)),
      };
    // The client answers only once it connected, so a card never fails.
    case "failed":
    case "cancelled":
      return { status: "cancelled" };
    case "declined":
      return { status: "declined" };
  }
};

const pendingResult = (turnItemId: TurnItemId): OrchestratorMcpEnvironmentLinkResult => ({
  status: "pending",
  turnItemId,
});

/** What a retry hears: the card's outcome, without anything the user typed. */
const resultOf = (card: LinkRequestItem): OrchestratorMcpEnvironmentLinkResult => {
  switch (card.linkStatus) {
    case "pending":
      return pendingResult(card.id);
    case "linked":
      return {
        status: "linked",
        environmentId: card.linkedEnvironmentId!,
        label: card.linkedLabel ?? linkTarget(card),
        access: card.linkedAccess!,
      };
    case "failed":
      return { status: "failed", message: card.failure ?? "The link could not be made." };
    case "declined":
    case "cancelled":
      return { status: card.linkStatus };
  }
};

/** What the agent's words call the target: its address, its id, or the user's pick. */
const linkTarget = (card: Pick<LinkRequestItem, "url" | "environmentId">) =>
  card.url ?? card.environmentId ?? "a machine";

/**
 * The notification an answer sends the agent: what the card says, and what
 * to do next. It carries the outcome only, never the pairing code.
 */
const outcomeNotice = (
  card: Pick<LinkRequestItem, "url" | "environmentId" | "ssh">,
  outcome: LinkRequestOutcome,
): Omit<LinkRequestWake, "messageId"> => {
  if (card.ssh !== undefined) return sshOutcomeNotice(card.ssh, outcome);
  const target = linkTarget(card);
  switch (outcome.linkStatus) {
    case "linked": {
      const label = outcome.linkedLabel ?? target;
      return {
        text: `The user linked ${label} with ${outcome.linkedAccess} access. Pass environmentId ${outcome.linkedEnvironmentId} to act there.`,
        notification: {
          source: { kind: "background_task" },
          outcome: "completed",
          summary: `Linked ${label}`,
        },
      };
    }
    case "failed":
      return {
        text: `Linking ${target} failed: ${outcome.failure ?? "the other environment refused"}. Call t3_environment_link again if the user still wants it.`,
        notification: {
          source: { kind: "background_task" },
          outcome: "failed",
          summary: `Could not link ${target}`,
        },
      };
    default:
      return {
        text: `The user declined to link ${target}.`,
        notification: {
          source: { kind: "background_task" },
          outcome: "cancelled",
          summary: `Declined to link ${target}`,
        },
      };
  }
};

/**
 * The notification an SSH answer sends the agent. The connection belongs to
 * the user's app and tunnels to a loopback port, so agents here cannot use it.
 */
const sshOutcomeNotice = (
  ssh: NonNullable<LinkRequestItem["ssh"]>,
  outcome: LinkRequestOutcome,
): Omit<LinkRequestWake, "messageId"> => {
  const target = sshTargetLabel(ssh);
  if (outcome.linkStatus === "linked") {
    const label = outcome.linkedLabel ?? target;
    return {
      text: `The user connected ${target} over SSH as the environment ${label} (${outcome.linkedEnvironmentId}). They can start threads there from the app; this connection does not let agents here reach it.`,
      notification: {
        source: { kind: "background_task" },
        outcome: "completed",
        summary: `Connected ${label} over SSH`,
      },
    };
  }
  return {
    text: `The user declined to connect ${target} over SSH.`,
    notification: {
      source: { kind: "background_task" },
      outcome: "cancelled",
      summary: `Declined to connect ${target}`,
    },
  };
};

export const layer = Layer.effect(PeerLinkRequests, make);
