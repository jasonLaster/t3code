import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GitListBranchesResult,
  GitCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitResolvePullRequestResult,
} from "./git";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(GitCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeListBranchesResult = Schema.decodeUnknownSync(GitListBranchesResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);

describe("GitCreateWorktreeInput", () => {
  it("accepts omitted newBranch for existing-branch worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      branch: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newBranch).toBeUndefined();
    expect(parsed.branch).toBe("feature/existing");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
  });
});

describe("GitListBranchesResult", () => {
  it("decodes selector pull request metadata", () => {
    const parsed = decodeListBranchesResult({
      branches: [],
      pullRequests: [
        {
          number: 42,
          title: "PR threads",
          url: "https://github.com/pingdotgg/codething-mvp/pull/42",
          baseBranch: "main",
          headBranch: "feature/pr-threads",
          localBranchName: "feature/pr-threads",
          state: "open",
          worktreePath: null,
        },
      ],
      isRepo: true,
    });

    expect(parsed.pullRequests[0]?.number).toBe(42);
    expect(parsed.pullRequests[0]?.localBranchName).toBe("feature/pr-threads");
  });
});
