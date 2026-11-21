import {
  EnvironmentId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal, type Screen } from "../../../test/render";

const testState = vi.hoisted(() => ({
  connect: vi.fn(),
  answer: vi.fn(),
  canAnswer: true,
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((_atom: unknown, options?: { readonly label?: string }) =>
    options?.label === "answer SSH environment request"
      ? testState.answer
      : testState.connect) as never,
}));
vi.mock(import("~/state/peerLinks"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    peerLinkEnvironment: {
      ...actual.peerLinkEnvironment,
      answerRequest: Object.assign(Object.create(actual.peerLinkEnvironment.answerRequest), {
        permissionAtom: () => Atom.make(testState.canAnswer),
      }),
    },
  };
});

import { LinkRequestCard } from "./LinkRequestCard";

type LinkRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "link_request" }>;

const environmentId = EnvironmentId.make("environment-laptop");
const vm = EnvironmentId.make("environment-vm");
const now = DateTime.makeUnsafe("2026-11-21T00:00:00.000Z");

const card = (overrides: Partial<LinkRequestItem> = {}): LinkRequestItem => ({
  id: TurnItemId.make("turn-item:ssh-request:1"),
  threadId: ThreadId.make("thread-1"),
  runId: RunId.make("run-1"),
  nodeId: NodeId.make("node-1"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "waiting",
  title: "Connect t3-vm",
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  type: "link_request",
  reason: "Run work on the cloud VM.",
  ssh: { host: "t3-vm", username: "ubuntu" },
  linkStatus: "pending",
  ...overrides,
});

function setup(desktop: boolean): Disposable {
  testState.connect.mockReset();
  testState.answer.mockReset();
  testState.canAnswer = true;
  return stubGlobal("desktopBridge", desktop ? {} : undefined);
}

const renderCard = (item: LinkRequestItem) =>
  render(<LinkRequestCard environmentId={environmentId} item={item} visibility="local" />);

const button = (screen: Screen, name: string) =>
  [...screen.container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === name,
  );

const click = (screen: Screen, name: string) => act(async () => button(screen, name)!.click());

describe("SSH request card", () => {
  it("connects the host in the desktop app, then answers with the environment it saved", async () => {
    using _state = setup(true);
    testState.connect.mockResolvedValue(AsyncResult.success(vm));
    testState.answer.mockResolvedValue(AsyncResult.success(undefined));
    await using screen = await renderCard(card());

    expect(screen.container.textContent).toContain("Connect ubuntu@t3-vm over SSH");
    expect(screen.container.textContent).toContain("Run work on the cloud VM.");
    // No link dialog: an SSH card has no machine, pairing code or access to pick.
    expect(button(screen, "Review link…")).toBeUndefined();

    await click(screen, "Connect");

    expect(testState.connect).toHaveBeenCalledWith({
      target: { alias: "t3-vm", hostname: "t3-vm", username: "ubuntu", port: null },
      label: "",
    });
    expect(testState.answer).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId: ThreadId.make("thread-1"),
        turnItemId: TurnItemId.make("turn-item:ssh-request:1"),
        answer: { type: "ssh-connected", environmentId: vm, label: "t3-vm" },
      },
    });
  });

  it("keeps the card open with the SSH error when connecting fails, and answers nothing", async () => {
    using _state = setup(true);
    testState.connect.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Permission denied (publickey)."))),
    );
    await using screen = await renderCard(card());

    await click(screen, "Connect");

    expect(screen.container.querySelector("[role=alert]")?.textContent).toContain(
      "Permission denied (publickey).",
    );
    expect(testState.answer).not.toHaveBeenCalled();
    expect(button(screen, "Connect")!.disabled).toBe(false);
  });

  it("declines without connecting", async () => {
    using _state = setup(true);
    testState.answer.mockResolvedValue(AsyncResult.success(undefined));
    await using screen = await renderCard(card());

    await click(screen, "Decline");

    expect(testState.connect).not.toHaveBeenCalled();
    expect(testState.answer).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId: ThreadId.make("thread-1"),
        turnItemId: TurnItemId.make("turn-item:ssh-request:1"),
        answer: { type: "decline" },
      },
    });
  });

  it("outside the desktop app offers only Decline, and says where to connect", async () => {
    using _state = setup(false);
    await using screen = await renderCard(card());

    expect(button(screen, "Connect")).toBeUndefined();
    expect(button(screen, "Decline")).toBeDefined();
    expect(screen.container.textContent).toContain("T3 Code desktop app");
  });

  it("shows a connected card as one line naming the environment", async () => {
    using _state = setup(true);
    await using screen = await renderCard(
      card({
        status: "completed",
        linkStatus: "linked",
        linkedEnvironmentId: vm,
        linkedLabel: "VM",
      }),
    );

    expect(screen.container.textContent).toContain("Connected VM over SSH");
    expect(screen.container.querySelector("[data-ssh-request]")).toBeNull();
  });
});
