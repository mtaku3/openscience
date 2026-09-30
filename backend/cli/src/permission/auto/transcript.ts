// Transcript projection adapted from Qwen Code (https://github.com/QwenLM/qwen-code),
// packages/core/src/permissions/classifier-transcript.ts.
// Copyright 2025 Qwen Team. Licensed under the Apache License, Version 2.0.
// Modified for OpenScience's message parts, lead/worker sessions, and a single
// rendered classifier message.

export namespace AutoTranscript {
  export const MAX_TRANSCRIPT_MESSAGES = 40
  export const MAX_HISTORICAL_ACTION_CHARS = 4_000
  export const MAX_HISTORICAL_ACTIONS_TOTAL_CHARS = 40_000
  export const MAX_USER_TEXT_CHARS = 8_000
  const MAX_FIELD_CHARS = 1_500

  export type Entry =
    | { kind: "user"; text: string }
    | { kind: "delegated"; text: string }
    | { kind: "action"; tool: string; input: Record<string, unknown> }

  export type Message = {
    role: "user" | "assistant"
    parts: Array<
      | { type: "text"; text: string; synthetic?: boolean; ignored?: boolean }
      | { type: "tool"; tool: string; state: { input?: Record<string, unknown> } }
      | { type: string }
    >
  }

  export type Pending = {
    tool?: string
    input?: Record<string, unknown>
    permission: string
    patterns: string[]
    metadata: Record<string, unknown>
  }

  /** Oldest-first messages of one session, reduced to user text and bare tool calls. */
  export function entries(messages: readonly Message[], options: { delegated?: boolean } = {}): Entry[] {
    const recent = messages.slice(-MAX_TRANSCRIPT_MESSAGES)
    const result: Entry[] = []
    let first = true
    for (const message of recent) {
      if (message.role === "user") {
        const text = message.parts
          .flatMap((part) =>
            part.type === "text" && "text" in part && !part.synthetic && !part.ignored ? [part.text] : [],
          )
          .join("\n")
          .trim()
        if (text) result.push({ kind: options.delegated && first ? "delegated" : "user", text })
        first = false
        continue
      }
      for (const part of message.parts) {
        if (part.type !== "tool" || !("tool" in part)) continue
        result.push({ kind: "action", tool: part.tool, input: part.state?.input ?? {} })
      }
    }
    return result
  }

  function clamp(text: string, limit: number) {
    if (text.length <= limit) return text
    return `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`
  }

  export function project(input: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!input || typeof input !== "object") return {}
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => {
        if (typeof value === "string") return [key, clamp(value, MAX_FIELD_CHARS)]
        const text = JSON.stringify(value)
        if (text !== undefined && text.length > MAX_FIELD_CHARS) return [key, clamp(text, MAX_FIELD_CHARS)]
        return [key, value]
      }),
    )
  }

  function render(entry: Entry) {
    if (entry.kind === "user") return `User: ${clamp(entry.text, MAX_USER_TEXT_CHARS)}`
    if (entry.kind === "delegated")
      return `Delegated task (written by the lead agent, not the user): ${clamp(entry.text, MAX_USER_TEXT_CHARS)}`
    return clamp(`Prior action: ${entry.tool}(${JSON.stringify(project(entry.input))})`, MAX_HISTORICAL_ACTION_CHARS)
  }

  /** Newest prior actions keep their text; older ones collapse once the budget is spent. */
  function budget(lines: string[], entries: Entry[]) {
    let remaining = MAX_HISTORICAL_ACTIONS_TOTAL_CHARS
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!
      if (entry.kind !== "action") continue
      const line = lines[index]!
      if (remaining > 0 && line.length <= remaining) {
        remaining -= line.length
        continue
      }
      remaining = 0
      lines[index] = `Prior action: ${entry.tool}([omitted: transcript budget exhausted])`
    }
    return lines
  }

  export function pending(call: Pending) {
    const lines = ["## Pending tool call to classify", ""]
    if (call.tool) lines.push(`Tool: ${call.tool}`)
    lines.push(`Permission: ${call.permission}`)
    if (call.patterns.length) lines.push(`Targets: ${call.patterns.map((item) => clamp(item, 2_000)).join(" ; ")}`)
    if (call.input) lines.push("Arguments:", "```json", JSON.stringify(project(call.input), null, 2), "```")
    const details = project(call.metadata)
    if (Object.keys(details).length) lines.push("Details:", "```json", JSON.stringify(details, null, 2), "```")
    lines.push(
      "",
      "Decide whether this specific tool call should be ALLOWED or BLOCKED",
      "given the rules above and the prior conversation context.",
    )
    return lines.join("\n")
  }

  export function build(input: { lead: Entry[]; worker?: Entry[]; instructions?: string[]; pending: Pending }) {
    const sections: string[] = []
    if (input.instructions?.length)
      sections.push(
        `## Project instructions (AGENTS.md / CLAUDE.md)\n${clamp(input.instructions.join("\n\n"), 12_000)}`,
      )
    const lead = budget(input.lead.map(render), input.lead)
    sections.push(`## Transcript\n${lead.length ? lead.join("\n\n") : "(no prior messages)"}`)
    if (input.worker) {
      const worker = budget(input.worker.map(render), input.worker)
      sections.push(`## Worker session transcript\n${worker.length ? worker.join("\n\n") : "(no prior messages)"}`)
    }
    sections.push(pending(input.pending))
    return sections.join("\n\n")
  }
}
