import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Execute the exact required GitHub workflow program. No code from a PR,
// network traffic, repository mutation, or merge is involved.
const workflow = fs.readFileSync(".github/workflows/sdk-release-readiness.yml", "utf8");
const program = workflow.split("node <<'JS'\n")[1].split("\n          JS")[0];
const repo = "local/sdk";
const release = {
  number: 1,
  state: "open",
  user: { login: "workos-sdk-automation[bot]", type: "Bot" },
  head: { ref: "release-please--branches--main", sha: "head", repo: { full_name: repo } },
  base: { ref: "main" },
};
const check = {
  id: 2,
  app: { id: 42 },
  head_sha: "head",
  status: "completed",
  conclusion: "success",
};
async function run(
  options: {
    ordinary?: boolean;
    pr?: Record<string, unknown>;
    checks?: unknown[];
    checkSequence?: unknown[][];
    head?: string;
    state?: string;
    relation?: string;
    apiFailure?: boolean;
    appId?: string;
  } = {},
) {
  let exit: number | undefined;
  let now = 0;
  let poll = 0;
  const logs: string[] = [];
  const requests: string[] = [];
  const exitSignal = new Error("exit");
  const context = {
    require: (name: string) => {
      if (name !== "node:fs") throw new Error(`Unexpected require ${name}`);
      return {
        appendFileSync: (_path: string, text: string) => logs.push(text),
        readFileSync: () =>
          JSON.stringify({
            repository: { full_name: repo },
            pull_request:
              options.pr ??
              (options.ordinary
                ? { ...release, user: { login: "engineer", type: "User" } }
                : release),
          }),
      };
    },
    process: {
      env: {
        RELEASE_CHECK_APP_ID: options.appId ?? "42",
        GH_TOKEN: "inert",
        GITHUB_EVENT_PATH: "inert",
        GITHUB_STEP_SUMMARY: "inert",
      },
      exit: (code: number) => {
        exit = code;
        throw exitSignal;
      },
    },
    console: {
      log: (text: string) => logs.push(text),
      error: (text: string) => logs.push(text),
    },
    Date: { now: () => now },
    setTimeout: (fn: () => void, delay: number) => {
      now += delay;
      fn();
    },
    AbortSignal,
    fetch: async (url: string) => {
      requests.push(url);
      assert.equal(url.startsWith(`https://api.github.com/repos/${repo}/`), true);
      if (options.apiFailure) return new Response("unavailable", { status: 503 });
      if (url.includes("check-runs"))
        return Response.json({ check_runs: options.checkSequence?.[poll++] ?? options.checks ?? [check] });
      if (url.includes("/pulls/"))
        return Response.json({
          ...release,
          state: options.state ?? "open",
          head: { ...release.head, sha: options.head ?? "head" },
        });
      if (url.includes("/git/ref/")) return Response.json({ object: { sha: "base" } });
      if (url.includes("/compare/")) return Response.json({ status: options.relation ?? "ahead" });
      throw new Error(`Unexpected API read: ${url}`);
    },
  };
  try {
    await vm.runInNewContext(program, context, { timeout: 1000 });
  } catch (error) {
    if (error !== exitSignal) {
      logs.push(String(error));
      exit = 1;
    }
  }
  return { exit: exit ?? 0, logs: logs.join("\n"), requests };
}
describe("release merge workflow executable contract", () => {
  it("allows ordinary PRs without requiring a release check", async () => {
    const result = await run({ ordinary: true, appId: "" });
    assert.equal(result.exit, 0);
    assert.deepEqual(result.requests, []);
  });
  it("allows a fresh release with a successful check from the configured App", async () => {
    assert.equal((await run()).exit, 0);
  });
  it("passes after missing, waiting, and failed checks recover on later polls", async () => {
    const result = await run({ checkSequence: [
      [], [{ ...check, status: "in_progress", conclusion: null }],
      [{ ...check, conclusion: "failure" }], [check],
    ] });
    assert.equal(result.exit, 0);
    assert.equal(result.requests.filter(url => url.includes("check-runs")).length, 4);
    assert.ok(result.logs.includes("https://prodsec-ai.workos.tools/activity/releases"));
  });
  it("applies to a release authored by the generic Actions bot", async () => {
    const pr = { ...release, user: { login: "github-actions[bot]", type: "Bot" } };
    assert.equal((await run({ pr })).exit, 0);
    assert.equal((await run({ pr, checks: [] })).exit, 1);
  });
  it("treats a release bot's non-release automation PR as ordinary", async () => {
    const pr = {
      ...release,
      head: { ...release.head, ref: "oagen/batch-a5c70910" },
    };
    const result = await run({ pr, checks: [] });
    assert.equal(result.exit, 0);
    assert.deepEqual(result.requests, []);
  });
  for (const { name, checks } of [
    { name: "missing check", checks: [] },
    { name: "wrong App", checks: [{ ...check, app: { id: 99 } }] },
    { name: "wrong revision", checks: [{ ...check, head_sha: "old" }] },
    {
      name: "newer failed check",
      checks: [check, { ...check, id: 3, conclusion: "failure" }],
    },
  ]) it(`blocks a release with ${name}`, async () => {
    const result = await run({ checks });
    assert.equal(result.exit, 1);
    assert.ok((result.logs).includes("has not passed"));
  });
  it("rejects a changed release head", async () => {
    assert.ok(((await run({ head: "changed" })).logs).includes("Pull request changed"));
  });
  for (const change of [{ head: "changed" }, { state: "closed" }]) {
    it(`stops an obsolete release before waiting for coverage: ${JSON.stringify(change)}`, async () => {
      const result = await run({ ...change, checks: [] });
      assert.equal(result.exit, 1);
      assert.ok(result.logs.includes("Pull request changed"));
      assert.equal(result.requests.filter(url => url.includes("check-runs")).length, 0);
    });
  }
  it("rejects a release behind the current base", async () => {
    assert.ok(((await run({ relation: "diverged" })).logs).includes("Update the release branch"));
  });
  it("fails on API read errors", async () => {
    assert.equal((await run({ apiFailure: true })).exit, 1);
  });
  it("fails when the checks App is not configured", async () => {
    assert.equal((await run({ appId: "" })).exit, 1);
  });
});
