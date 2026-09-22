#!/usr/bin/env node

/**
 * Standalone side calls — an extension's own system prompt, no tools, never seen by
 * the capture boundaries (pi-btw's /btw). They must reach Claude Code on the isolated
 * one-shot path instead of throwing in resolveOrDerive or syncing into the shared
 * session, while a tooled turn with an unaccountable prompt still throws.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptCaptures } from "../src/prompt-capture.js";
import { foldSideCallPrompt, isStandaloneSideCall } from "../src/side-call.js";

// Keep the user's global claude-bridge.json (executable path, long-context flags) out of the run.
const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-side-call-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { __test } = await import("../src/index.js");

const PI_PROMPT = "You are an expert coding assistant operating inside pi.\n\n<project_context>rules</project_context>";
const BTW_PROMPT = "You answer quick side questions for a coding-agent user.";
const TOOL = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };

function user(text) {
	return { role: "user", content: text, timestamp: 0 };
}

function assistant(content) {
	return { role: "assistant", content, stopReason: "stop", timestamp: 0 };
}

function recorded() {
	const diagnostics = [];
	const captures = new PromptCaptures(256, (diagnostic) => diagnostics.push(diagnostic));
	captures.record(PI_PROMPT, { contextFiles: [{ path: "/AGENTS.md", content: "rules" }], skills: [] });
	return { captures, diagnostics };
}

describe("PromptCaptures.accounts", () => {
	it("agrees with resolveOrDerive on what it can account for", () => {
		const { captures } = recorded();
		assert.equal(captures.accounts(PI_PROMPT), true);
		assert.equal(captures.accounts(`WRAPPER\n\n${PI_PROMPT}\n\nSUFFIX`), true);
		assert.equal(captures.accounts(undefined), true);
		assert.equal(captures.accounts(BTW_PROMPT), false);
		assert.throws(() => captures.resolveOrDerive(BTW_PROMPT), /prompt-capture: no capture/);
	});

	it("revives nothing and reports nothing", () => {
		const { captures, diagnostics } = recorded();
		captures.accounts(BTW_PROMPT);
		captures.accounts(`WRAPPER ${PI_PROMPT}`);
		assert.equal(diagnostics.length, 0);
		assert.equal(captures.size, 1);
	});
});

describe("isStandaloneSideCall", () => {
	it("takes a tool-less call with an unrecorded prompt", () => {
		const { captures } = recorded();
		assert.equal(isStandaloneSideCall({ systemPrompt: BTW_PROMPT, messages: [user("hi")] }, captures), true);
		assert.equal(isStandaloneSideCall({ systemPrompt: BTW_PROMPT, tools: [], messages: [user("hi")] }, captures), true);
	});

	it("leaves tooled turns, recorded prompts and prompt-less calls to the provider path", () => {
		const { captures } = recorded();
		// A tooled turn whose prompt we lost track of must still throw downstream.
		assert.equal(isStandaloneSideCall({ systemPrompt: BTW_PROMPT, tools: [TOOL], messages: [user("hi")] }, captures), false);
		// A --no-tools agent turn: its prompt was recorded at before_agent_start.
		assert.equal(isStandaloneSideCall({ systemPrompt: PI_PROMPT, messages: [user("hi")] }, captures), false);
		assert.equal(isStandaloneSideCall({ messages: [user("hi")] }, captures), false);
	});
});

describe("foldSideCallPrompt", () => {
	it("passes a single question through unchanged", () => {
		assert.equal(foldSideCallPrompt([user("hows it going?")]), "hows it going?");
	});

	it("folds earlier turns of a side thread ahead of the current question", () => {
		const prompt = foldSideCallPrompt([
			user("context + first question"),
			assistant([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "first answer" }]),
			user("follow-up"),
		]);
		assert.equal(
			prompt,
			"<conversation_so_far>\nUser:\ncontext + first question\n\nAssistant:\nfirst answer\n</conversation_so_far>\n\nfollow-up",
		);
		assert.doesNotMatch(prompt, /hidden/);
	});

	it("returns null when the last message is not from the user", () => {
		assert.equal(foldSideCallPrompt([user("q"), assistant([{ type: "text", text: "a" }])]), null);
		assert.equal(foldSideCallPrompt([]), null);
	});
});

describe("provider routing", () => {
	const model = {
		id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "claude-bridge", api: "claude-bridge", baseUrl: "claude-bridge",
		reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 8000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	let cwd;
	let argvPath;

	before(() => {
		// A fake `claude` that records how it was launched and exits: enough to see which
		// path the call took without spawning the real CLI.
		cwd = mkdtempSync(join(tmpdir(), "claude-bridge-side-call-"));
		argvPath = join(cwd, "argv.txt");
		const fake = join(cwd, "fake-claude");
		writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvPath}'\nexit 1\n`);
		chmodSync(fake, 0o755);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: fake } }));
	});

	after(() => {
		__test.resetSharedSession();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("sends a /btw-style call to an isolated one-shot process, leaving the shared session alone", async () => {
		const shared = { sessionId: "00000000-sentinel", cursor: 4, cwd };
		__test.setSharedSession(shared);

		const stream = __test.streamClaudeAgentSdk(model, {
			systemPrompt: BTW_PROMPT,
			messages: [user("hows it going?")],
		}, { cwd });
		const events = [];
		for await (const event of stream) events.push(event);

		// The fake exits 1, so the call fails — but from the isolated process, not the resolver.
		assert.equal(events.at(-1).type, "error");
		assert.doesNotMatch(events.at(-1).error.errorMessage, /prompt-capture/);
		const argv = readFileSync(argvPath, "utf8").split("\n");
		assert.ok(argv.includes("--no-session-persistence"), argv.join(" "));
		assert.equal(argv[argv.indexOf("--max-turns") + 1], "1");
		assert.equal(__test.getSharedSession(), shared);
	});

	it("still throws for a tooled turn whose prompt it cannot account for", () => {
		__test.resetSharedSession();
		assert.throws(
			() => __test.streamClaudeAgentSdk(model, { systemPrompt: BTW_PROMPT, tools: [TOOL], messages: [user("hi")] }, { cwd }),
			/prompt-capture: no capture/,
		);
	});
});

describe("sharedPromptCaptures across /reload", () => {
	it("upgrades a registry left behind by an older bridge in place", async () => {
		const { sharedPromptCaptures } = await import("../src/prompt-capture.js");
		const key = Symbol.for("claude-bridge:promptCaptures");
		const saved = globalThis[key];
		try {
			// What the previous module evaluation left on globalThis: same fields, a class
			// that predates accounts().
			class OldPromptCaptures extends PromptCaptures {}
			OldPromptCaptures.prototype.accounts = undefined;
			const old = new OldPromptCaptures();
			old.record(PI_PROMPT, { contextFiles: [], skills: [] });
			globalThis[key] = old;

			const shared = sharedPromptCaptures();
			assert.equal(shared, old, "the same registry object stays shared");
			assert.equal(shared.accounts(PI_PROMPT), true, "captures recorded before the reload survive");
			assert.equal(shared.accounts(BTW_PROMPT), false);
		} finally {
			globalThis[key] = saved;
		}
	});
});
