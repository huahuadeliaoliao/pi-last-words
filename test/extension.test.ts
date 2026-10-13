import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lastWords, { createPresentationTool } from "../index.ts";
import type { PresentationDetails } from "../render.ts";
import { assistant, history, MODEL, mockContext, pending, responseStream, USAGE, until } from "./helpers.ts";

const params = { conclusions: ["单测通过"], limitations: ["集成测试未运行"] };
const body = (result: AgentToolResult<PresentationDetails>) =>
	result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");

test("registers one optional model-only tool with a self-rendered result and no hooks", () => {
	const tools: ReturnType<typeof createPresentationTool>[] = [];
	lastWords({
		registerTool: (tool: ReturnType<typeof createPresentationTool>) => tools.push(tool),
	} as unknown as ExtensionAPI);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "present_final");
	assert.equal(tools[0].exposure, "model-only");
	assert.equal(tools[0].renderShell, "self");
	assert.equal(tools[0].executionMode, "sequential");
	assert.ok(tools[0].promptGuidelines?.join(" ").includes("may"));
});

test("uses the selected model/reasoning, isolated prompt, no tools and the fresh projection", async () => {
	const { ctx, calls, setMessages } = mockContext();
	const fresh = history();
	fresh.splice(1, 0, { role: "user", content: "LATEST_REQUIREMENT", timestamp: 2 });
	setMessages(fresh);
	const controller = new AbortController();
	const result = await createPresentationTool().execute("final-call", params, controller.signal, undefined, ctx);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].model, MODEL);
	assert.equal(calls[0].options?.reasoning, "medium");
	assert.equal(calls[0].options?.signal, controller.signal);
	assert.equal(calls[0].options?.sessionId, "test-session:present_final:final-call");
	assert.deepEqual(calls[0].context.tools, []);
	assert.equal(calls[0].context.systemPrompt, await readFile(new URL("../presenter.md", import.meta.url), "utf8"));
	assert.ok(JSON.stringify(calls[0].context.messages).includes("LATEST_REQUIREMENT"));
	assert.ok(!calls[0].context.messages.some((message) => message.role === "system"));
	assert.equal(result.terminate, true);
	assert.deepEqual(result.usage, USAGE);
	assert.equal(result.details.status, "completed");
});

test("does not force high reasoning; off follows streamSimple's undefined-reasoning convention", async () => {
	for (const level of ["low", "high", "max", "off"] as const) {
		const { ctx, calls } = mockContext();
		ctx.thinkingLevel = level;
		await createPresentationTool().execute("final-call", params, undefined, undefined, ctx);
		assert.equal(calls[0].options?.reasoning, level === "off" ? undefined : level);
	}
});

test("streams cumulative text while execute is pending, then returns one exact final body", async () => {
	const stream = createAssistantMessageEventStream();
	const { ctx, calls } = mockContext({ stream: () => stream });
	const updates: AgentToolResult<PresentationDetails>[] = [];
	let settled = false;
	const promise = createPresentationTool()
		.execute("final-call", params, undefined, (update) => updates.push(update), ctx)
		.then((result) => {
			settled = true;
			return result;
		});
	await until(() => calls.length === 1);
	stream.push({
		type: "thinking_delta",
		contentIndex: 0,
		delta: "PRIVATE_THOUGHT",
		partial: assistant([{ type: "thinking", thinking: "PRIVATE_THOUGHT" }], { stopReason: "pending" }),
	});
	stream.push({
		type: "text_delta",
		contentIndex: 1,
		delta: "first",
		partial: assistant([{ type: "text", text: "first" }], { stopReason: "pending" }),
	});
	await until(() => updates.some((update) => body(update) === "first"));
	assert.equal(settled, false);
	const exact = "  first\nsecond\n";
	const final = assistant([{ type: "text", text: exact }]);
	stream.push({ type: "text_end", contentIndex: 1, content: exact, partial: final });
	stream.push({ type: "done", reason: "stop", message: final });
	const result = await promise;
	assert.equal(body(result), exact);
	assert.equal(body(updates.at(-1)!), exact);
	assert.ok(updates.every((update) => !update.terminate));
	assert.ok(updates.every((update) => !JSON.stringify(update).includes("PRIVATE_THOUGHT")));
	assert.equal(result.terminate, true);
});

test("rejection never starts a presentation request", async () => {
	const cases = [
		{ messages: [pending("wrong")], params },
		{ messages: [assistant([...pending().content, { type: "text" as const, text: "draft" }])], params },
		{
			messages: [
				assistant([...pending().content, { type: "toolCall" as const, id: "other", name: "read", arguments: {} }]),
			],
			params,
		},
		{ messages: history(), params: { conclusions: ["   "] } },
	];
	for (const item of cases) {
		const { ctx, calls } = mockContext({ messages: item.messages });
		const result = await createPresentationTool().execute("final-call", item.params, undefined, undefined, ctx);
		assert.equal(result.details.status, "rejected");
		assert.equal(result.isError, true);
		assert.equal(result.terminate, undefined);
		assert.equal(calls.length, 0);
	}
});

test("refuses print mode rather than silently delivering an invisible final tool result", async () => {
	const { ctx, calls } = mockContext({ mode: "print" });
	const result = await createPresentationTool().execute("final-call", params, undefined, undefined, ctx);
	assert.match(body(result), /Answer directly/);
	assert.equal(result.terminate, undefined);
	assert.equal(calls.length, 0);
});

test("missing model is recoverable without a request", async () => {
	const { ctx, calls } = mockContext();
	ctx.model = undefined;
	const result = await createPresentationTool().execute("final-call", params, undefined, undefined, ctx);
	assert.match(body(result), /No active session model/);
	assert.equal(result.terminate, undefined);
	assert.equal(calls.length, 0);
});

for (const scenario of [
	{ name: "empty output", message: assistant([]), match: /no answer text/ },
	{ name: "whitespace output", message: assistant([{ type: "text", text: "  \n" }]), match: /no answer text/ },
	{
		name: "length limit",
		message: assistant([{ type: "text", text: "HALF_ANSWER" }], { stopReason: "length" }),
		match: /length/,
	},
	{
		name: "provider error",
		message: assistant([{ type: "text", text: "HALF_ANSWER" }], {
			stopReason: "error",
			errorMessage: "Fixture failure",
		}),
		match: /Fixture failure/,
	},
	{
		name: "unexpected tool call",
		message: assistant([{ type: "toolCall", id: "bad", name: "bash", arguments: { command: "no" } }]),
		match: /attempted to call a tool/,
	},
	{ name: "tool-use stop", message: assistant([], { stopReason: "toolUse" }), match: /toolUse/ },
]) {
	test(`${scenario.name} is not a completed final answer and preserves available usage`, async () => {
		const { ctx, calls } = mockContext({ stream: () => responseStream(scenario.message) });
		const result = await createPresentationTool().execute("final-call", params, undefined, undefined, ctx);
		assert.equal(result.details.status, "failed");
		assert.equal(result.terminate, undefined);
		assert.equal(result.isError, true);
		assert.match(body(result), scenario.match);
		assert.deepEqual(result.usage, USAGE);
		assert.equal(calls.length, 1);
		if (JSON.stringify(scenario.message).includes("HALF_ANSWER"))
			assert.match(body(result), /Incomplete output.*\n\nHALF_ANSWER/s);
	});
}

test("stream creation failure is caught without claiming delivery", async () => {
	const { ctx } = mockContext({
		stream: () => {
			throw new Error("Fixture connection failure");
		},
	});
	const result = await createPresentationTool().execute("final-call", params, undefined, undefined, ctx);
	assert.equal(result.details.status, "failed");
	assert.equal(result.terminate, undefined);
	assert.match(body(result), /Fixture connection failure/);
});

test("a stream without a terminal message fails without hanging on result()", async () => {
	const stream = createAssistantMessageEventStream();
	stream.end();
	const { ctx } = mockContext({ stream: () => stream });
	const result = await createPresentationTool().execute("final-call", params, undefined, undefined, ctx);
	assert.equal(result.terminate, undefined);
	assert.match(body(result), /without a final response/);
});

test("empty/whitespace final messages cannot promote or erase an earlier incomplete preview", async () => {
	for (const finalText of ["", " \n"]) {
		for (const emitTextEnd of [false, true]) {
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: "HALF",
				partial: assistant([{ type: "text", text: "HALF" }], { stopReason: "pending" }),
			});
			const final = assistant([{ type: "text", text: finalText }]);
			if (emitTextEnd) stream.push({ type: "text_end", contentIndex: 0, content: finalText, partial: final });
			stream.push({ type: "done", reason: "stop", message: final });
			const { ctx } = mockContext({ stream: () => stream });
			const updates: AgentToolResult<PresentationDetails>[] = [];
			const result = await createPresentationTool().execute(
				"final-call",
				params,
				undefined,
				(update) => updates.push(update),
				ctx,
			);
			assert.equal(result.details.status, "failed");
			assert.equal(result.terminate, undefined);
			assert.match(body(result), /no answer text/);
			assert.match(body(result), /Incomplete output.*HALF/s);
			assert.equal(body(updates.at(-1)!), "HALF");
		}
	}
});

test("cancellation before execute starts no request and no fallback", async () => {
	const controller = new AbortController();
	controller.abort();
	const { ctx, calls } = mockContext();
	const result = await createPresentationTool().execute("final-call", params, controller.signal, undefined, ctx);
	assert.equal(result.details.status, "cancelled");
	assert.equal(result.terminate, undefined);
	assert.equal(calls.length, 0);
});

test("midstream cancellation settles promptly and blocks late output even from a non-cooperative adapter", async () => {
	const stream = createAssistantMessageEventStream();
	const controller = new AbortController();
	const { ctx, calls } = mockContext({ stream: () => stream });
	const updates: AgentToolResult<PresentationDetails>[] = [];
	const promise = createPresentationTool().execute(
		"final-call",
		params,
		controller.signal,
		(update) => updates.push(update),
		ctx,
	);
	await until(() => calls.length === 1);
	stream.push({
		type: "text_delta",
		contentIndex: 0,
		delta: "HALF",
		partial: assistant([{ type: "text", text: "HALF" }], { stopReason: "pending" }),
	});
	await until(() => updates.some((update) => body(update) === "HALF"));
	controller.abort();
	const result = await promise;
	assert.equal(result.details.status, "cancelled");
	assert.equal(result.terminate, undefined);
	assert.match(body(result), /Incomplete output.*HALF/s);
	const count = updates.length;
	stream.push({
		type: "text_end",
		contentIndex: 0,
		content: "LATE",
		partial: assistant([{ type: "text", text: "LATE" }]),
	});
	stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text: "LATE" }]) });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(updates.length, count);
	assert.equal(calls.length, 1);
});
