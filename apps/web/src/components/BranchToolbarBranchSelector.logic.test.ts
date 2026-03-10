import { describe, expect, it } from "vitest";

import {
  buildBranchToolbarPickerItems,
  filterBranchToolbarPickerItems,
} from "./BranchToolbarBranchSelector.logic";

describe("buildBranchToolbarPickerItems", () => {
  it("places discovered pull requests ahead of branches", () => {
    const items = buildBranchToolbarPickerItems({
      branches: [
        {
          name: "main",
          current: true,
          isDefault: true,
          isRemote: false,
          worktreePath: "/repo",
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
      createBranchName: null,
      checkoutPullRequestReference: null,
      hasExactBranchMatch: false,
      includePullRequests: true,
    });

    expect(items.map((item) => item.kind)).toEqual(["pull_request", "branch"]);
  });

  it("omits the typed pull request shortcut when the PR is already discovered", () => {
    const items = buildBranchToolbarPickerItems({
      branches: [],
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
      createBranchName: null,
      checkoutPullRequestReference: "#42",
      hasExactBranchMatch: false,
      includePullRequests: true,
    });

    expect(items.some((item) => item.kind === "typed_pull_request")).toBe(false);
  });
});

describe("filterBranchToolbarPickerItems", () => {
  it("matches pull requests by title and branch", () => {
    const items = buildBranchToolbarPickerItems({
      branches: [
        {
          name: "main",
          current: true,
          isDefault: true,
          isRemote: false,
          worktreePath: "/repo",
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
      createBranchName: "feature/new-selector",
      checkoutPullRequestReference: null,
      hasExactBranchMatch: false,
      includePullRequests: true,
    });

    expect(filterBranchToolbarPickerItems(items, "selector").map((item) => item.kind)).toEqual([
      "pull_request",
      "create_branch",
    ]);
    expect(filterBranchToolbarPickerItems(items, "#42").map((item) => item.kind)).toEqual([
      "pull_request",
      "create_branch",
    ]);
  });
});
