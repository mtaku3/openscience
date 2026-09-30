// Adapted from Qwen Code (https://github.com/QwenLM/qwen-code),
// packages/core/src/permissions/denialTracking.ts.
// Copyright 2025 Qwen Team. Licensed under the Apache License, Version 2.0.

export namespace AutoDenial {
  export type FallbackReason =
    "classifier_blocked_retry" | "consecutive_block" | "consecutive_unavailable" | "total_denial"

  export type State = {
    consecutiveBlock: number
    consecutiveUnavailable: number
    totalBlock: number
    totalUnavailable: number
    pendingManualRetryFingerprint?: string
  }

  export const LIMITS = {
    maxConsecutiveBlock: 3,
    maxConsecutiveUnavailable: 2,
    maxTotalDenials: 20,
  } as const

  export function create(): State {
    return { consecutiveBlock: 0, consecutiveUnavailable: 0, totalBlock: 0, totalUnavailable: 0 }
  }

  function totalCapReached(state: State) {
    return state.totalBlock + state.totalUnavailable >= LIMITS.maxTotalDenials
  }

  export function recordAllow(state: State, fingerprint?: string): State {
    const clearsRetry = fingerprint !== undefined && state.pendingManualRetryFingerprint === fingerprint
    if (state.consecutiveBlock === 0 && state.consecutiveUnavailable === 0 && !clearsRetry) return state
    const next: State = { ...state, consecutiveBlock: 0, consecutiveUnavailable: 0 }
    if (clearsRetry) delete next.pendingManualRetryFingerprint
    return next
  }

  export function recordBlock(state: State, fingerprint?: string): State {
    return {
      ...state,
      consecutiveBlock: state.consecutiveBlock + 1,
      consecutiveUnavailable: 0,
      totalBlock: state.totalBlock + 1,
      ...(fingerprint ? { pendingManualRetryFingerprint: fingerprint } : {}),
    }
  }

  export function recordUnavailable(state: State): State {
    return {
      ...state,
      consecutiveBlock: 0,
      consecutiveUnavailable: state.consecutiveUnavailable + 1,
      totalUnavailable: state.totalUnavailable + 1,
    }
  }

  export function shouldFallback(
    state: State,
    fingerprint?: string,
  ): { fallback: true; reason: FallbackReason } | { fallback: false } {
    if (totalCapReached(state)) return { fallback: true, reason: "total_denial" }
    if (state.consecutiveBlock >= LIMITS.maxConsecutiveBlock) return { fallback: true, reason: "consecutive_block" }
    if (state.consecutiveUnavailable >= LIMITS.maxConsecutiveUnavailable)
      return { fallback: true, reason: "consecutive_unavailable" }
    if (fingerprint !== undefined && state.pendingManualRetryFingerprint === fingerprint)
      return { fallback: true, reason: "classifier_blocked_retry" }
    return { fallback: false }
  }

  /** A person approved a card Auto handed back: the streak it was guarding is over. */
  export function recordManualApprove(state: State): State {
    if (totalCapReached(state)) return create()
    const next: State = { ...state, consecutiveBlock: 0, consecutiveUnavailable: 0 }
    delete next.pendingManualRetryFingerprint
    return next
  }

  export function describe(reason: FallbackReason, detail?: string) {
    switch (reason) {
      case "classifier_blocked_retry":
        return "Auto previously blocked this exact action. Review it manually."
      case "consecutive_block":
        return `Auto reached its consecutive denial limit${detail ? ` (${detail})` : ""}. Review this action manually.`
      case "consecutive_unavailable":
        return "Auto could not classify consecutive actions. Review this action manually."
      case "total_denial":
        return "Auto reached its session denial limit. Review this action manually."
    }
  }
}
