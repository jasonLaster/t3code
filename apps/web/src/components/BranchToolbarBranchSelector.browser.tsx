import "../index.css";

import type { GitListBranchesResult, GitStatusResult, NativeApi } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

const DEFAULT_BRANCHES: GitListBranchesResult = {
  branches: [
    {
      name: "main",
      current: true,
      isDefault: true,
      isRemote: false,
      worktreePath: "/repo",
    },
    {
      name: "origin/feature/pr-selector",
      current: false,
      isDefault: false,
      isRemote: true,
      remoteName: "origin",
      worktreePath: null,
    },
  ],
  pullRequests: [
    {
      number: 42,
      title: "Add PR selector rows",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseBranch: "main",
      headBranch: "feature/pr-selector",
      localBranchName: "feature/pr-selector",
      state: "open",
      worktreePath: null,
    },
  ],
  isRepo: true,
};

const DEFAULT_STATUS: GitStatusResult = {
  branch: "main",
  hasWorkingTreeChanges: false,
  workingTree: {
    files: [],
    insertions: 0,
    deletions: 0,
  },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

let branchListResponse: GitListBranchesResult = DEFAULT_BRANCHES;
let statusResponse: GitStatusResult = DEFAULT_STATUS;
const listBranchesMock = vi.fn(async () => branchListResponse);
const statusMock = vi.fn(async () => statusResponse);
const createBranchMock = vi.fn(async () => undefined);
const checkoutMock = vi.fn(async () => undefined);

const nativeApi = {
  git: {
    listBranches: listBranchesMock,
    status: statusMock,
    createBranch: createBranchMock,
    checkout: checkoutMock,
  },
} as unknown as NativeApi;

interface MountedSelector {
  cleanup: () => Promise<void>;
  onCheckoutPullRequestRequest: ReturnType<typeof vi.fn>;
  host: HTMLDivElement;
}

beforeAll(() => {
  window.nativeApi = nativeApi;
});

beforeEach(() => {
  branchListResponse = DEFAULT_BRANCHES;
  statusResponse = DEFAULT_STATUS;
  listBranchesMock.mockClear();
  statusMock.mockClear();
  createBranchMock.mockClear();
  checkoutMock.mockClear();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function mountSelector(
  overrides: Partial<ComponentProps<typeof BranchToolbarBranchSelector>> = {},
): Promise<MountedSelector> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.display = "grid";
  host.style.alignItems = "start";
  host.style.justifyItems = "start";
  host.style.padding = "16px";
  document.body.append(host);
  const root = createRoot(host);

  const onCheckoutPullRequestRequest = vi.fn();
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <BranchToolbarBranchSelector
          activeProjectCwd="/repo"
          activeThreadBranch="main"
          activeWorktreePath={null}
          branchCwd="/repo"
          effectiveEnvMode="local"
          envLocked={false}
          onSetThreadBranch={vi.fn()}
          onCheckoutPullRequestRequest={onCheckoutPullRequestRequest}
          {...overrides}
        />
      </QueryClientProvider>,
    );
  });
  await Promise.resolve();

  return {
    cleanup: async () => {
      queryClient.clear();
      root.unmount();
      host.remove();
    },
    onCheckoutPullRequestRequest,
    host,
  };
}

async function waitForElementWithin<T extends Element>(
  root: ParentNode,
  selector: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(() => {
    element = root.querySelector<T>(selector);
    expect(element).not.toBeNull();
  });
  if (!element) {
    throw new Error(`Expected element for selector ${selector}`);
  }
  return element;
}

async function waitForEnabledTrigger(root: ParentNode): Promise<HTMLButtonElement> {
  let trigger: HTMLButtonElement | null = null;
  await vi.waitFor(() => {
    trigger = root.querySelector<HTMLButtonElement>('[data-slot="combobox-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.hasAttribute("disabled")).toBe(false);
  });
  if (!trigger) {
    throw new Error("Expected combobox trigger");
  }
  return trigger;
}

async function waitForItemContainingTextWithin(root: ParentNode, text: string): Promise<HTMLElement> {
  let element: HTMLElement | null = null;
  await vi.waitFor(() => {
    element =
      [...root.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')].find((candidate) =>
        (candidate.textContent ?? "").includes(text),
      ) ?? null;
    expect(element).not.toBeNull();
  });
  if (!element) {
    throw new Error(`Expected combobox item containing text: ${text}`);
  }
  return element;
}

describe("BranchToolbarBranchSelector", () => {
  it("renders discovered pull requests and dispatches their number when selected", async () => {
    const mounted = await mountSelector();

    try {
      const trigger = await waitForEnabledTrigger(mounted.host);
      trigger.click();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Add PR selector rows");
      });

      const input = await waitForElementWithin<HTMLInputElement>(
        document.body,
        'input[placeholder="Search branches and PRs..."]',
      );
      input.focus();
      input.value = "selector rows";
      input.dispatchEvent(new Event("input", { bubbles: true }));

      const pullRequestItem = await waitForItemContainingTextWithin(document.body, "Add PR selector rows");
      pullRequestItem.click();
      expect(mounted.onCheckoutPullRequestRequest).toHaveBeenCalledWith("42");
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides pull requests while selecting a base branch for a new worktree", async () => {
    const mounted = await mountSelector({
      effectiveEnvMode: "worktree",
      activeThreadBranch: "main",
    });

    try {
      const trigger = await waitForEnabledTrigger(mounted.host);
      trigger.click();

      await waitForElementWithin<HTMLInputElement>(
        document.body,
        'input[placeholder="Search branches..."]',
      );
      expect(document.body.textContent ?? "").not.toContain("Add PR selector rows");
    } finally {
      await mounted.cleanup();
    }
  });
});
