/**
 * A user's Esc must reach pi as stopReason "aborted". Claude Code words an interrupted
 * query as an error result ("This operation was aborted"), and the abort can arrive
 * through the signal of a later pi call than the one that started the query. Reported
 * as "error", pi and extensions such as pi-goal treat the Esc as a provider failure.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };

function fakeStream() {
	const events = [];
	return { events, push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
}

function makeCtx() {
	const c = new QueryContext();
	c.currentPiStream = fakeStream();
	c.resetTurnState(fakeModel);
	return c;
}

async function consume(c, messages, wasAborted = () => false) {
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), new Map(), fakeModel, wasAborted, c);
}

const abortedResult = {
	type: "result", subtype: "error_during_execution", is_error: true,
	errors: ["This operation was aborted"],
};

describe("an interrupted query", () => {
	it("reports aborted when this query's own signal fires while the result arrives", async () => {
		const c = makeCtx();
		// Not aborted when the loop checks before the message, aborted by the time the
		// error result is recorded.
		let checks = 0;
		await consume(c, [abortedResult], () => checks++ > 0);
		assert.strictEqual(c.turnOutput.stopReason, "aborted");
		assert.strictEqual(c.turnOutput.errorMessage, "Operation aborted");
	});

	it("reports aborted when a later call's signal requested the abort", async () => {
		const c = makeCtx();
		c.abortRequested = true;
		await consume(c, [abortedResult]);
		assert.strictEqual(c.turnOutput.stopReason, "aborted");
	});

	it("finalizes as an aborted stream event, never a plain error", () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		c.turnOutput.stopReason = "error";
		c.turnOutput.errorMessage = "This operation was aborted";
		c.abortRequested = true;
		__test.finalizeCurrentStream(c, "error");
		const terminal = stream.events.find((e) => e.type === "error");
		assert.strictEqual(terminal.reason, "aborted");
		assert.strictEqual(terminal.error.stopReason, "aborted");
	});

	it("keeps a genuine failure an error when nothing was aborted", async () => {
		const c = makeCtx();
		await consume(c, [{ ...abortedResult, errors: ["API Error: 500 Internal Server Error"] }]);
		assert.strictEqual(c.turnOutput.stopReason, "error");
		assert.strictEqual(c.turnOutput.errorMessage, "API Error: 500 Internal Server Error");
	});
});

describe("a query after an aborted one", () => {
	it("finishes as stop once the reused context starts a new query", () => {
		const c = makeCtx();
		c.abortRequested = true;
		c.requestAbort = () => {};
		c.resetQueryState(fakeModel);
		assert.strictEqual(c.abortRequested, false);
		assert.strictEqual(c.requestAbort, null);
		const stream = c.currentPiStream;
		__test.finalizeCurrentStream(c, "stop");
		assert.ok(!stream.events.some((e) => e.type === "error"));
		assert.strictEqual(c.turnOutput.stopReason, "stop");
	});

	it("keeps a genuine failure an error rather than a stale abort", async () => {
		const c = makeCtx();
		c.abortRequested = true;
		c.resetQueryState(fakeModel);
		await consume(c, [{ ...abortedResult, errors: ["API Error: 500 Internal Server Error"] }]);
		assert.strictEqual(c.turnOutput.stopReason, "error");
	});
});

describe("watchStreamAbort", () => {
	it("marks the query and tears it down when the call's signal aborts later", () => {
		const c = new QueryContext();
		let teardowns = 0;
		c.requestAbort = () => { teardowns++; };
		const controller = new AbortController();
		__test.watchStreamAbort(c, controller.signal);
		assert.strictEqual(c.abortRequested, false);
		controller.abort();
		assert.strictEqual(c.abortRequested, true);
		assert.strictEqual(teardowns, 1);
	});

	it("acts at once on a signal that is already aborted", () => {
		const c = new QueryContext();
		let teardowns = 0;
		c.requestAbort = () => { teardowns++; };
		const controller = new AbortController();
		controller.abort();
		__test.watchStreamAbort(c, controller.signal);
		assert.strictEqual(c.abortRequested, true);
		assert.strictEqual(teardowns, 1);
	});

	it("does nothing without a signal", () => {
		const c = new QueryContext();
		__test.watchStreamAbort(c, undefined);
		assert.strictEqual(c.abortRequested, false);
	});
});
