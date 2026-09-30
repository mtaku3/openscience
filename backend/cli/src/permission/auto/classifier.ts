// Two-stage classifier adapted from Qwen Code (https://github.com/QwenLM/qwen-code),
// packages/core/src/permissions/classifier.ts.
// Copyright 2025 Qwen Team. Licensed under the Apache License, Version 2.0.
// Modified for OpenScience: calls the configured reviewer model through the
// AI SDK and parses JSON from the text reply.

import { AutoPolicy } from "./policy"

export namespace AutoClassifier {
  export const STAGE1_TIMEOUT_MS = 20_000
  export const STAGE2_TIMEOUT_MS = 60_000

  export type Query = (input: {
    system: string
    prompt: string
    maxOutputTokens: number
    signal: AbortSignal
  }) => Promise<string>

  export type Result = {
    shouldBlock: boolean
    reason: string
    stage: 1 | 2
    unavailable?: boolean
    error?: string
    durationMs: number
  }

  export function parse<T extends Record<string, unknown>>(text: string): T | undefined {
    const trimmed = text.trim().replace(/^```(?:json)?\s*|```$/g, "")
    const candidates = [trimmed, ...(trimmed.match(/\{[\s\S]*\}/g) ?? [])]
    for (const candidate of candidates.reverse()) {
      try {
        const value = JSON.parse(candidate)
        if (value && typeof value === "object" && typeof value.shouldBlock === "boolean") return value as T
      } catch {}
    }
    return undefined
  }

  export function sanitize(raw: string) {
    let stripped = raw
    for (let i = 0; i < 8; i++) {
      const next = stripped.replace(/<[^>]*>/g, "")
      if (next === stripped) break
      stripped = next
    }
    return stripped.replace(/\s+/g, " ").trim().slice(0, 200)
  }

  function errorText(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  export async function classify(input: {
    system: string
    prompt: string
    query: Query
    signal?: AbortSignal
    timeouts?: { stage1: number; stage2: number }
  }): Promise<Result> {
    const started = Date.now()
    const timeouts = input.timeouts ?? { stage1: STAGE1_TIMEOUT_MS, stage2: STAGE2_TIMEOUT_MS }
    const signal = (ms: number) =>
      input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)

    let stage1: { shouldBlock: boolean } | undefined
    try {
      const text = await input.query({
        system: input.system + AutoPolicy.STAGE1_SUFFIX,
        prompt: input.prompt,
        maxOutputTokens: 1_024,
        signal: signal(timeouts.stage1),
      })
      stage1 = parse<{ shouldBlock: boolean }>(text)
      if (!stage1) throw new Error(`stage 1 returned no verdict: ${text.slice(0, 120)}`)
    } catch (error) {
      if (input.signal?.aborted) throw error
      return {
        shouldBlock: true,
        reason: "Auto could not classify this action.",
        unavailable: true,
        error: errorText(error),
        stage: 1,
        durationMs: Date.now() - started,
      }
    }
    if (!stage1.shouldBlock) return { shouldBlock: false, reason: "", stage: 1, durationMs: Date.now() - started }

    try {
      const text = await input.query({
        system: input.system + AutoPolicy.STAGE2_SUFFIX,
        prompt: input.prompt,
        maxOutputTokens: 8_192,
        signal: signal(timeouts.stage2),
      })
      const stage2 = parse<{ shouldBlock: boolean; reason?: string }>(text)
      if (!stage2) throw new Error(`stage 2 returned no verdict: ${text.slice(0, 120)}`)
      return {
        shouldBlock: stage2.shouldBlock,
        reason: stage2.shouldBlock ? sanitize(String(stage2.reason ?? "")) || "Blocked by auto mode policy." : "",
        stage: 2,
        durationMs: Date.now() - started,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      return {
        shouldBlock: true,
        reason: "Stage 1 flagged this as risky; stage 2 review was unavailable.",
        unavailable: true,
        error: errorText(error),
        stage: 2,
        durationMs: Date.now() - started,
      }
    }
  }
}
