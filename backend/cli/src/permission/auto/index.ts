// Auto approval for OpenScience, porting Qwen Code's Auto Mode
// (https://github.com/QwenLM/qwen-code, packages/core/src/permissions/autoMode.ts,
// Copyright 2025 Qwen Team, Apache License 2.0) onto PermissionNext: the
// classifier answers the cards Ask risky would show, instead of the user.

import { generateText } from "ai"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { AutoClassifier } from "./classifier"
import { AutoDenial } from "./denial"
import { AutoPolicy } from "./policy"
import { AutoTranscript } from "./transcript"

export namespace AutoApprove {
  const log = Log.create({ service: "permission.auto" })

  export type Call = {
    sessionID: string
    permission: string
    patterns: string[]
    metadata: Record<string, unknown>
    tool?: { messageID: string; callID: string }
  }

  export type Outcome =
    | { kind: "allow"; stage: 1 | 2; durationMs: number }
    | { kind: "block"; reason: string; stage: 1 | 2; durationMs: number }
    | { kind: "manual"; reason: string; error?: string }

  export type Context = {
    rootSessionID: string
    lead: AutoTranscript.Entry[]
    worker?: AutoTranscript.Entry[]
    instructions: string[]
    tool?: string
    input?: Record<string, unknown>
  }

  export const Event = {
    Decided: BusEvent.define(
      "permission.auto.decided",
      z.object({
        sessionID: z.string(),
        permission: z.string(),
        patterns: z.string().array(),
        verdict: z.enum(["allow", "block", "manual"]),
        reason: z.string(),
        error: z.string().optional(),
        durationMs: z.number().optional(),
      }),
    ),
  }

  export const GUIDANCE =
    "Do not try to complete the denied action through another tool, shell indirection, generated script, alias, symlink, config change, hook, command file, MCP configuration, encoded payload, or equivalent path. To request manual approval for this exact action, retry the same tool call without changing its arguments. You may continue with unrelated safe work or a genuinely safer alternative that does not accomplish the denied action."

  export class BlockedError extends Error {
    constructor(readonly reason: string) {
      super(`Blocked by auto mode policy: ${reason}\n${GUIDANCE}`)
    }
  }

  /** Spending and runaway-loop guards always reach a person. */
  const HUMAN_ONLY = new Set([
    "atlas",
    "atlas_write",
    "compute_job",
    "doom_loop",
    "generate_image",
    "modal",
    "provider_compute",
    "remote_compute",
    "websearch",
  ])

  export function eligible(permission: string) {
    return !HUMAN_ONLY.has(permission)
  }

  export function ready(config: Config.AutoApprove) {
    return Boolean(config.model)
  }

  const state = Instance.state(() => ({ denial: new Map<string, AutoDenial.State>() }))

  async function denial(rootSessionID: string) {
    const map = (await state()).denial
    return {
      get: () => map.get(rootSessionID) ?? AutoDenial.create(),
      set: (next: AutoDenial.State) => map.set(rootSessionID, next),
    }
  }

  export async function context(call: Call): Promise<Context> {
    const { MessageV2 } = await import("@/session/message-v2")
    const { InstructionPrompt } = await import("@/session/instruction")
    const history = async (sessionID: string) => {
      const messages: AutoTranscript.Message[] = []
      for await (const message of MessageV2.stream(sessionID)) {
        messages.unshift({ role: message.info.role, parts: message.parts as AutoTranscript.Message["parts"] })
        if (messages.length >= AutoTranscript.MAX_TRANSCRIPT_MESSAGES) break
      }
      return messages
    }
    const rootSessionID = await root(call.sessionID)
    const lead = AutoTranscript.entries(await history(rootSessionID))
    const worker =
      rootSessionID === call.sessionID
        ? undefined
        : AutoTranscript.entries(await history(call.sessionID), { delegated: true })
    let tool: string | undefined
    let input: Record<string, unknown> | undefined
    if (call.tool) {
      const parts = await MessageV2.parts(call.tool.messageID).catch(() => [])
      const part = parts.find((item) => item.type === "tool" && item.callID === call.tool!.callID)
      if (part?.type === "tool") {
        tool = part.tool
        input = part.state.input
      }
    }
    const instructions = await InstructionPrompt.system().catch(() => [] as string[])
    return { rootSessionID, lead, worker, instructions, tool, input }
  }

  export async function defaultQuery(model: string): Promise<AutoClassifier.Query> {
    const { Provider } = await import("@/provider/provider")
    const parsed = Provider.parseModel(model)
    const language = await Provider.getLanguage(await Provider.getModel(parsed.providerID, parsed.modelID))
    return async (input) => {
      const result = await generateText({
        model: language,
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
        temperature: 0,
        maxOutputTokens: input.maxOutputTokens,
        abortSignal: input.signal,
        experimental_telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
      })
      return result.text
    }
  }

  function publish(call: Call, outcome: Outcome) {
    const reason = outcome.kind === "allow" ? "" : outcome.reason
    log.info("decided", {
      sessionID: call.sessionID,
      permission: call.permission,
      verdict: outcome.kind,
      reason,
      error: outcome.kind === "manual" ? outcome.error : undefined,
    })
    Bus.publish(Event.Decided, {
      sessionID: call.sessionID,
      permission: call.permission,
      patterns: call.patterns,
      verdict: outcome.kind,
      reason,
      error: outcome.kind === "manual" ? outcome.error : undefined,
      durationMs: outcome.kind === "manual" ? undefined : outcome.durationMs,
    }).catch((error) => log.error("failed to publish decision", { error }))
    return outcome
  }

  /**
   * Answer one card Auto would otherwise show. Never allows without a
   * verdict: missing configuration, classifier failures, and the denial
   * limits hand the card back to the user.
   */
  export async function review(
    call: Call,
    input: {
      requestID: string
      signal?: AbortSignal
      sandboxed?: boolean
      query?: AutoClassifier.Query
      config?: Config.AutoApprove
      context?: Context
    },
  ): Promise<Outcome> {
    if (!eligible(call.permission))
      return publish(call, { kind: "manual", reason: "Spending and loop guards always ask in Auto." })
    const config = input.config ?? (await Config.trustedAutoApprove())
    if (!ready(config)) return publish(call, { kind: "manual", reason: "The Auto reviewer model is not set." })
    let ctx: Context
    try {
      ctx = input.context ?? (await context(call))
    } catch (error) {
      return publish(call, {
        kind: "manual",
        reason: "Auto could not read this conversation.",
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const tracker = await denial(ctx.rootSessionID)
    const fingerprint = JSON.stringify([call.permission, call.patterns, ctx.tool ?? null, ctx.input ?? call.metadata])
    const fallback = AutoDenial.shouldFallback(tracker.get(), fingerprint)
    if (fallback.fallback) return publish(call, { kind: "manual", reason: AutoDenial.describe(fallback.reason) })

    const system = AutoPolicy.build({
      hints: { ...config.hints, environment: config.environment },
      workspaces: [...new Set([Instance.directory, Instance.worktree])],
      sandboxed: input.sandboxed,
    })
    const prompt = AutoTranscript.build({
      lead: ctx.lead,
      worker: ctx.worker,
      instructions: ctx.instructions,
      pending: {
        tool: ctx.tool,
        input: ctx.input,
        permission: call.permission,
        patterns: call.patterns,
        metadata: call.metadata,
      },
    })
    let query: AutoClassifier.Query
    try {
      query = input.query ?? (await defaultQuery(config.model!))
    } catch (error) {
      tracker.set(AutoDenial.recordUnavailable(tracker.get()))
      return publish(call, {
        kind: "manual",
        reason: `The Auto reviewer model ${config.model} is unavailable.`,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const { Provider } = await import("@/provider/provider")
    const result = await Provider.withRequestContext(
      { sessionID: call.sessionID, messageID: `auto:${input.requestID}`, attempt: 1 },
      () => AutoClassifier.classify({ system, prompt, query, signal: input.signal }),
    )
    if (result.unavailable) {
      tracker.set(AutoDenial.recordUnavailable(tracker.get()))
      return publish(call, { kind: "manual", reason: result.reason, error: result.error })
    }
    if (result.shouldBlock) {
      tracker.set(AutoDenial.recordBlock(tracker.get(), fingerprint))
      return publish(call, { kind: "block", reason: result.reason, stage: result.stage, durationMs: result.durationMs })
    }
    tracker.set(AutoDenial.recordAllow(tracker.get(), fingerprint))
    return publish(call, { kind: "allow", stage: result.stage, durationMs: result.durationMs })
  }

  async function root(sessionID: string) {
    const { Session } = await import("@/session")
    let current = sessionID
    for (let depth = 0; depth < 8; depth++) {
      const parent = (await Session.get(current)).parentID
      if (!parent) break
      current = parent
    }
    return current
  }

  /** A person approved a card Auto handed back. */
  export async function manualApproved(sessionID: string) {
    const tracker = await denial(await root(sessionID).catch(() => sessionID))
    tracker.set(AutoDenial.recordManualApprove(tracker.get()))
  }

  /** Check a candidate reviewer model before it is saved: it must answer with a verdict. */
  export async function probe(model: string, query?: AutoClassifier.Query) {
    const started = Date.now()
    try {
      const ask = query ?? (await defaultQuery(model))
      const text = await ask({
        system: AutoPolicy.build({ workspaces: ["/workspace"] }) + AutoPolicy.STAGE1_SUFFIX,
        prompt: AutoTranscript.build({
          lead: [{ kind: "user", text: "Run the unit tests." }],
          pending: {
            tool: "bash",
            input: { command: "pytest -q" },
            permission: "bash",
            patterns: ["pytest -q"],
            metadata: {},
          },
        }),
        maxOutputTokens: 256,
        signal: AbortSignal.timeout(AutoClassifier.STAGE1_TIMEOUT_MS),
      })
      if (!AutoClassifier.parse(text))
        return { ok: false as const, error: `The model did not return a verdict: ${text.slice(0, 160)}` }
      return { ok: true as const, durationMs: Date.now() - started }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
