// Query state: QueryContext class.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) each get their own QueryContext instance, managed by index.ts.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { McpResult } from "./extract-tool-results.js";
import type { PromptStream } from "./prompt-stream.js";

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	latestCursor = 0;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	/** tool_use ids emitted this turn. Sole purpose is routing a delivered result
	 *  to the owning query when several queries are in flight — pairing a result
	 *  to its call is done by id from Claude's tools/call _meta, not from here. */
	turnToolCallIds: string[] = [];
	/** Streaming-input handle for the active query — how steers reach CC mid-turn. */
	promptStream: PromptStream | null = null;
	/** Last rate-limit rejection seen on this query. Claude Code sends it just before the
	 *  failure it caused, which is the only thing tying the two together. */
	rateLimitRejection: { rateLimitType?: string; resetsAt?: number } | null = null;
	/** Highest 5% utilization bucket we notified for, so repeat rate_limit_event spam is suppressed. */
	lastRateLimitWarnStep: number | null = null;
	lastRateLimitWarnThreshold: number | undefined;
	/** Set once pi aborted any stream this query served (the user pressed Esc). Every
	 *  later failure of the query is then an abort, whatever text Claude Code sends. */
	abortRequested = false;
	/** Tears the query down: settles the prompt stream and parked handlers, stops CC. */
	requestAbort: (() => void) | null = null;

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	/** Answer every parked MCP handler with `reason` and forget the turn's queued
	 *  results. Called when the query it belongs to is going away (abort, error,
	 *  normal end). Handlers must be *resolved*, not rejected: an error reply is
	 *  still a reply, and a handler left awaiting a subprocess that is gone keeps
	 *  CC's tools/call open forever, which wedges pi's turn behind it. */
	releasePendingToolCalls(reason: string): void {
		for (const pending of this.pendingToolCalls.values()) pending.resolve({ content: [{ type: "text", text: reason }] });
		this.pendingToolCalls.clear();
		this.pendingResults.clear();
	}

	/** Clear what the previous query left behind before this context serves a new one.
	 *  The top-level context is reused for every prompt, so an Esc on an earlier query
	 *  must not leave abortRequested set: every later turn would end as aborted. */
	resetQueryState(model: Model<any>): void {
		this.pendingToolCalls.clear();
		this.pendingResults.clear();
		// Stale ids would let a late result from the previous query route here via
		// contextForToolResults — which now means pushing its steer into this
		// query's stdin, not just mismatching a map.
		this.turnToolCallIds = [];
		this.abortRequested = false;
		this.requestAbort = null;
		this.resetTurnState(model);
		this.latestCursor = 0;
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		// turnToolCallIds is NOT reset — it persists across tool-result delivery
		// callbacks within the same assistant message so results can be routed to
		// this query while its handlers are still pending.
	}
}

let _ctx = new QueryContext();

export function ctx(): QueryContext { return _ctx; }

// Test-only: replace the module-level context so test files start clean.
// Not called from production.
export function resetCtx(): void {
	_ctx = new QueryContext();
}
