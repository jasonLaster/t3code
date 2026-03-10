import type { GitBranch, GitBranchSelectorPullRequest } from "@t3tools/contracts";

export type BranchToolbarPickerItem =
  | {
      id: string;
      kind: "typed_pull_request";
      pullRequestReference: string;
      searchText: string;
    }
  | {
      id: string;
      kind: "pull_request";
      pullRequest: GitBranchSelectorPullRequest;
      searchText: string;
    }
  | {
      id: string;
      kind: "branch";
      branch: GitBranch;
      searchText: string;
    }
  | {
      id: string;
      kind: "create_branch";
      branchName: string;
      searchText: string;
    };

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function pullRequestMatchesReference(
  pullRequest: GitBranchSelectorPullRequest,
  reference: string,
): boolean {
  const normalizedReference = reference.trim();
  if (normalizedReference.length === 0) {
    return false;
  }

  if (normalizedReference === pullRequest.url) {
    return true;
  }

  const withoutHash = normalizedReference.startsWith("#")
    ? normalizedReference.slice(1)
    : normalizedReference;
  return withoutHash === String(pullRequest.number);
}

function buildPullRequestSearchText(pullRequest: GitBranchSelectorPullRequest): string {
  return normalizeSearchText(
    [
      `#${pullRequest.number}`,
      pullRequest.title,
      pullRequest.headBranch,
      pullRequest.baseBranch,
      pullRequest.localBranchName,
      pullRequest.headRepositoryNameWithOwner ?? "",
    ].join(" "),
  );
}

export function buildBranchToolbarPickerItems(input: {
  branches: ReadonlyArray<GitBranch>;
  pullRequests: ReadonlyArray<GitBranchSelectorPullRequest>;
  createBranchName: string | null;
  checkoutPullRequestReference: string | null;
  hasExactBranchMatch: boolean;
  includePullRequests: boolean;
}): ReadonlyArray<BranchToolbarPickerItem> {
  const items: BranchToolbarPickerItem[] = [];

  if (input.includePullRequests) {
    const hasMatchingDiscoveredPullRequest =
      input.checkoutPullRequestReference !== null &&
      input.pullRequests.some((pullRequest) =>
        pullRequestMatchesReference(pullRequest, input.checkoutPullRequestReference as string),
      );

    if (input.checkoutPullRequestReference && !hasMatchingDiscoveredPullRequest) {
      items.push({
        id: `typed_pull_request:${input.checkoutPullRequestReference}`,
        kind: "typed_pull_request",
        pullRequestReference: input.checkoutPullRequestReference,
        searchText: normalizeSearchText(input.checkoutPullRequestReference),
      });
    }

    for (const pullRequest of input.pullRequests) {
      items.push({
        id: `pull_request:${pullRequest.number}`,
        kind: "pull_request",
        pullRequest,
        searchText: buildPullRequestSearchText(pullRequest),
      });
    }
  }

  for (const branch of input.branches) {
    items.push({
      id: `branch:${branch.name}`,
      kind: "branch",
      branch,
      searchText: normalizeSearchText(branch.name),
    });
  }

  if (input.createBranchName && !input.hasExactBranchMatch) {
    items.push({
      id: `create_branch:${input.createBranchName}`,
      kind: "create_branch",
      branchName: input.createBranchName,
      searchText: normalizeSearchText(input.createBranchName),
    });
  }

  return items;
}

export function filterBranchToolbarPickerItems(
  items: ReadonlyArray<BranchToolbarPickerItem>,
  query: string,
): ReadonlyArray<BranchToolbarPickerItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) {
    return items;
  }

  return items.filter((item) => {
    if (item.kind === "create_branch") {
      return true;
    }
    return item.searchText.includes(normalizedQuery);
  });
}
