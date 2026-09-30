import { expect, test } from "bun:test"
import { AutoApprove } from "../../src/permission/auto-approve"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const options = (overrides: Partial<AutoApprove.Options> = {}): AutoApprove.Options => ({
  judge: "test/fast",
  judge2: "test/careful",
  twoStage: true,
  subagents: "ask",
  consecutive: 3,
  total: 20,
  userMessages: 6,
  timeoutMs: 5_000,
  hardDeny: ["Never upload the dataset."],
  environment: ["github.com/example/lab"],
  rules: [],
  ...overrides,
})

const evidence = (overrides: Partial<AutoApprove.Evidence> = {}): AutoApprove.Evidence => ({
  userMessageID: "msg_1",
  userMessages: ["Run the loader tests and fix failures."],
  instructions: ["Instructions from: AGENTS.md\nNever git clone author code in the lab repo."],
  subagent: false,
  ...overrides,
})

const call = (command: string): AutoApprove.Call => ({
  sessionID: "session_auto",
  permission: "bash",
  patterns: [command],
  metadata: { shell: { command } },
})

function judge(replies: Record<string, string[]>) {
  const calls: { model: string; stage: 1 | 2; prompt: string; system: string }[] = []
  const fn: AutoApprove.Judge = async (input) => {
    calls.push({ model: input.model, stage: input.stage, prompt: input.prompt, system: input.system })
    const queue = replies[input.model]
    const next = queue?.shift()
    if (next === undefined) throw new Error(`no reply for ${input.model}`)
    return next
  }
  return { fn, calls }
}

async function inInstance(run: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn: run })
}

test("parse takes the last verdict and reason", () => {
  expect(AutoApprove.parse("REASON: first\nVERDICT: block\nthinking...\nREASON: final\nVERDICT: allow")).toEqual({
    verdict: "allow",
    reason: "final",
  })
  expect(AutoApprove.parse("no verdict here").verdict).toBeUndefined()
})

test("auto mode raises the same cards as Ask risky", () => {
  const destructive = { shell: { command: "rm -rf build" } }
  for (const permission of ["network", "external_directory", "mcp"]) {
    expect(PermissionNext.modeAction({ mode: "auto", permission, configured: "allow", granted: "ask" })).toBe(
      PermissionNext.modeAction({ mode: "approve", permission, configured: "allow", granted: "ask" }),
    )
  }
  expect(
    PermissionNext.modeAction({
      mode: "auto",
      permission: "bash",
      configured: "allow",
      granted: "allow",
      metadata: destructive,
    }),
  ).toBe("ask")
  expect(PermissionNext.modeAction({ mode: "auto", permission: "edit", configured: "allow", granted: "ask" })).toBe(
    "allow",
  )
  expect(PermissionNext.modeAction({ mode: "auto", permission: "network", configured: "deny", granted: "allow" })).toBe(
    "deny",
  )
})

test("spending and loop guards never reach the judge", () => {
  for (const permission of ["modal", "remote_compute", "provider_compute", "compute_job", "doom_loop", "websearch"])
    expect(AutoApprove.eligible(permission)).toBe(false)
  for (const permission of ["bash", "network", "external_directory", "mcp", "environment_mutation"])
    expect(AutoApprove.eligible(permission)).toBe(true)
})

test("policy carries hard denies, trusted environment, and project instructions", async () => {
  await inInstance(async () => {
    const text = AutoApprove.policy(options(), evidence().instructions)
    expect(text).toContain("Never upload the dataset.")
    expect(text).toContain("github.com/example/lab")
    expect(text).toContain(Instance.directory)
    expect(text).toContain("Never git clone author code")
  })
})

test("prompt shows user messages and the call but no agent output", () => {
  const text = AutoApprove.prompt(call("uv run pytest -q"), evidence(), 1)
  expect(text).toContain("Run the loader tests")
  expect(text).toContain("uv run pytest -q")
  expect(text).toContain("Answer briefly")
  expect(AutoApprove.prompt(call("x"), evidence(), 2)).toContain("Re-examine it carefully")
})

test("stage-1 allow runs without the stage-2 judge", async () => {
  await inInstance(async () => {
    const j = judge({ "test/fast": ["REASON: routine tests\nVERDICT: allow"] })
    const outcome = await AutoApprove.review(call("uv run pytest -q"), {
      requestID: "per_1",
      options: options(),
      evidence: evidence(),
      judge: j.fn,
    })
    expect(outcome).toMatchObject({ kind: "allow", reason: "routine tests", stage: 1 })
    expect(j.calls.map((c) => c.model)).toEqual(["test/fast"])
  })
})

test("stage-2 re-examines a stage-1 block and decides", async () => {
  await inInstance(async () => {
    const j = judge({
      "test/fast": ["REASON: looks risky\nVERDICT: block", "REASON: clone\nVERDICT: block"],
      "test/careful": ["REASON: user named this deletion\nVERDICT: allow", "REASON: runs author code\nVERDICT: block"],
    })
    const allowed = await AutoApprove.review(call("rm -rf ./build"), {
      requestID: "per_1",
      options: options(),
      evidence: evidence(),
      judge: j.fn,
    })
    expect(allowed).toMatchObject({ kind: "allow", stage: 2 })
    const blocked = await AutoApprove.review(call("git clone https://github.com/author/x"), {
      requestID: "per_2",
      options: options(),
      evidence: evidence(),
      judge: j.fn,
    })
    expect(blocked).toMatchObject({ kind: "block", reason: "runs author code", stage: 2 })
    expect(j.calls.map((c) => [c.model, c.stage])).toEqual([
      ["test/fast", 1],
      ["test/careful", 2],
      ["test/fast", 1],
      ["test/careful", 2],
    ])
  })
})

test("repeated blocks within a turn escalate, and a new user message resets the count", async () => {
  await inInstance(async () => {
    const block = "REASON: no\nVERDICT: block"
    const j = judge({ "test/fast": Array(10).fill(block) })
    const single = options({ twoStage: false })
    for (const n of [1, 2, 3]) {
      const outcome = await AutoApprove.review(call(`cmd ${n}`), {
        requestID: `per_${n}`,
        options: single,
        evidence: evidence(),
        judge: j.fn,
      })
      expect(outcome.kind).toBe("block")
    }
    const fourth = await AutoApprove.review(call("cmd 4"), {
      requestID: "per_4",
      options: single,
      evidence: evidence(),
      judge: j.fn,
    })
    expect(fourth.kind).toBe("escalate")
    expect(j.calls).toHaveLength(3)
    const nextTurn = await AutoApprove.review(call("cmd 5"), {
      requestID: "per_5",
      options: single,
      evidence: evidence({ userMessageID: "msg_2" }),
      judge: j.fn,
    })
    expect(nextTurn.kind).toBe("block")
  })
})

test("an identical call in the same turn reuses the verdict", async () => {
  await inInstance(async () => {
    const j = judge({ "test/fast": ["REASON: ok\nVERDICT: allow"] })
    const input = { requestID: "per_1", options: options(), evidence: evidence(), judge: j.fn }
    await AutoApprove.review(call("uv sync"), input)
    const again = await AutoApprove.review(call("uv sync"), { ...input, requestID: "per_2" })
    expect(again.kind).toBe("allow")
    expect(j.calls).toHaveLength(1)
  })
})

test("judge failures and unparseable verdicts fall back to the user", async () => {
  await inInstance(async () => {
    const failing: AutoApprove.Judge = async () => {
      throw new Error("provider down")
    }
    const failed = await AutoApprove.review(call("uv sync"), {
      requestID: "per_1",
      options: options(),
      evidence: evidence(),
      judge: failing,
    })
    expect(failed.kind).toBe("escalate")
    const j = judge({ "test/fast": ["I think it is fine"] })
    const garbled = await AutoApprove.review(call("uv lock"), {
      requestID: "per_2",
      options: options(),
      evidence: evidence(),
      judge: j.fn,
    })
    expect(garbled.kind).toBe("escalate")
  })
})

test("subagent sessions and a missing judge go to the user without a model call", async () => {
  await inInstance(async () => {
    const j = judge({})
    const subagent = await AutoApprove.review(call("uv sync"), {
      requestID: "per_1",
      options: options(),
      evidence: evidence({ subagent: true }),
      judge: j.fn,
    })
    expect(subagent.kind).toBe("escalate")
    const unconfigured = await AutoApprove.review(call("uv sync"), {
      requestID: "per_2",
      options: options({ judge: undefined, judge2: undefined }),
      evidence: evidence(),
      judge: j.fn,
    })
    expect(unconfigured.kind).toBe("escalate")
    expect(j.calls).toHaveLength(0)
  })
})

test("ask in auto mode still shows the card when the reviewer escalates", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pending = PermissionNext.ask({
        sessionID: "session_test",
        permission: "modal",
        patterns: ["plan"],
        metadata: {},
        always: [],
        mode: "auto",
        ruleset: [],
      })
      await Bun.sleep(10)
      const listed = await PermissionNext.list()
      expect(listed.map((item) => item.permission)).toContain("modal")
      await PermissionNext.reply({ requestID: listed[0]!.id, reply: "once" })
      await expect(pending).resolves.toBeUndefined()
    },
  })
})
