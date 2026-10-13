import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type AssistantMessageEventStream, getSystemMessageText, type TranscriptContext } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import lastWords from "../index.ts";
import { assistant, MODEL, pending, responseStream, USAGE } from "./helpers.ts";

async function setup(
	stream: (context: TranscriptContext, isPresenter: boolean) => AssistantMessageEventStream,
	extra?: (pi: ExtensionAPI) => void,
) {
	const root = mkdtempSync(join(tmpdir(), "pi-last-words-session-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	const model = { ...MODEL, api: "last-words-fixture" };
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-cache"),
		refreshOnCreate: false,
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Fixture worker; do not perform real work.",
		extensionFactories: [
			(pi) => {
				pi.registerProvider("fixture", {
					api: model.api,
					baseUrl: MODEL.baseUrl,
					apiKey: "fixture-key-not-a-credential",
					models: [{ ...MODEL, api: model.api }],
					streamSimple: (_model, context) => {
						const first = context.messages[0];
						const system = first?.role === "system" ? getSystemMessageText(first) : "";
						return stream(context, system.includes("final-response presenter for pi-last-words"));
					},
				});
				lastWords(pi);
				extra?.(pi);
			},
		],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		modelRuntime,
		model,
		thinkingLevel: "medium",
		sessionManager: manager,
		noTools: "builtin",
	});
	await session.bindExtensions({ mode: "json" });
	return {
		session,
		manager,
		root,
		dispose: () => {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

const finalText = "验证结果：单测通过，集成测试未运行。\n\n第二点：不据此声称全面验证。";

test("real SDK loop waits, streams, terminates once, persists complete text and accounts usage once", async () => {
	let workerCalls = 0;
	let presenterCalls = 0;
	const env = await setup((context, presenter) => {
		if (presenter) {
			presenterCalls++;
			const system = context.messages[0];
			assert.equal(system.role, "system");
			if (system.role === "system") assert.equal(system.toolsAdded?.length ?? 0, 0);
			return responseStream(assistant([{ type: "text", text: finalText }]));
		}
		workerCalls++;
		return responseStream(pending());
	});
	try {
		const events: string[] = [];
		const incrementalBodies: string[] = [];
		env.session.subscribe((event) => {
			events.push(event.type);
			if (event.type === "tool_execution_update") {
				assert.equal(env.session.isStreaming, true);
				incrementalBodies.push(
					event.partialResult.content
						.map((block: { type: string; text?: string }) => (block.type === "text" ? block.text : ""))
						.join("\n"),
				);
			}
		});
		await env.session.prompt("Explain the verified outcome.");
		assert.equal(workerCalls, 1, "successful termination must not ask the worker to restate the answer");
		assert.equal(presenterCalls, 1);
		assert.ok(incrementalBodies.some((text) => text.length > 0 && text.length < finalText.length));
		assert.equal(incrementalBodies.at(-1), finalText);
		assert.ok(events.lastIndexOf("tool_execution_update") < events.indexOf("agent_end"));
		assert.equal(env.session.isStreaming, false);
		const results = env.session.messages.filter((message) => message.role === "toolResult");
		assert.equal(results.length, 1);
		assert.deepEqual(results[0].content, [{ type: "text", text: finalText }]);
		const stats = env.session.getSessionStats();
		assert.equal(stats.tokens.total, USAGE.totalTokens * 2);
		assert.equal(stats.cost, USAGE.cost.total * 2);
		const file = env.manager.getSessionFile()!;
		const persisted = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line: string) => JSON.parse(line));
		assert.equal(
			persisted.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length,
			1,
		);
		const restored = SessionManager.open(file).buildSessionProjection().messages;
		assert.ok(
			restored.some(
				(message) =>
					message.role === "toolResult" &&
					message.content.some((block) => block.type === "text" && block.text === finalText),
			),
		);
	} finally {
		env.dispose();
	}
});

test("a later user question sees the exact delivered tool text in its model context", async () => {
	let workers = 0;
	const env = await setup((context, presenter) => {
		if (presenter) return responseStream(assistant([{ type: "text", text: finalText }]));
		if (++workers === 1) return responseStream(pending());
		assert.ok(
			context.messages.some(
				(message) =>
					message.role === "toolResult" &&
					message.content.some((block) => block.type === "text" && block.text === finalText),
			),
		);
		return responseStream(assistant([{ type: "text", text: "第二点限制的是验证范围。" }]));
	});
	try {
		await env.session.prompt("交付结果。");
		await env.session.prompt("刚才第二点是什么意思？");
		assert.equal(workers, 2);
		assert.equal(env.session.getLastAssistantText(), "第二点限制的是验证范围。");
	} finally {
		env.dispose();
	}
});

test("newly queued user work is processed after a terminating presentation", async () => {
	let workers = 0;
	let presentations = 0;
	const env = await setup((_context, presenter) => {
		if (presenter) {
			presentations++;
			return responseStream(assistant([{ type: "text", text: finalText }]));
		}
		return responseStream(++workers === 1 ? pending() : assistant([{ type: "text", text: "Queued request handled." }]));
	});
	try {
		let queued: Promise<unknown> | undefined;
		env.session.subscribe((event) => {
			if (event.type === "tool_execution_update" && !queued)
				queued = env.session.followUp("Please handle this next user question too.");
		});
		await env.session.prompt("First user task.");
		await queued;
		await env.session.waitForIdle();
		assert.equal(workers, 2);
		assert.equal(presentations, 1);
		assert.equal(env.session.getLastAssistantText(), "Queued request handled.");
	} finally {
		env.dispose();
	}
});

test("a failed presentation allows one normal worker fallback without marking success", async () => {
	let workers = 0;
	const env = await setup((_context, presenter) => {
		if (presenter) return responseStream(assistant([{ type: "text", text: "incomplete" }], { stopReason: "length" }));
		return responseStream(++workers === 1 ? pending() : assistant([{ type: "text", text: "Direct fallback." }]));
	});
	try {
		await env.session.prompt("Deliver the outcome.");
		assert.equal(workers, 2);
		assert.equal(env.session.getLastAssistantText(), "Direct fallback.");
		const result = env.session.messages.find((message) => message.role === "toolResult");
		assert.equal(result?.isError, true);
		assert.ok(JSON.stringify(result?.content).includes("Incomplete output"));
	} finally {
		env.dispose();
	}
});

test("mixed-batch rejection is enforced inside the real loop before any presenter request", async () => {
	let workers = 0;
	let presentations = 0;
	let sideCalls = 0;
	const env = await setup(
		(_context, presenter) => {
			if (presenter) {
				presentations++;
				throw new Error("Must never present mixed batches");
			}
			if (++workers > 1)
				return responseStream(assistant([{ type: "text", text: "Direct answer after rejected batch." }]));
			const mixed = pending();
			mixed.content.push({ type: "toolCall", id: "side-call", name: "fixture_read", arguments: {} });
			return responseStream(mixed);
		},
		(pi) =>
			pi.registerTool({
				name: "fixture_read",
				label: "Fixture",
				description: "Deterministic test fixture",
				parameters: Type.Object({}),
				async execute() {
					sideCalls++;
					return { content: [{ type: "text", text: "fixture" }], details: {} };
				},
			}),
	);
	try {
		await env.session.prompt("Fixture task.");
		assert.equal(presentations, 0);
		assert.equal(workers, 2);
		assert.equal(sideCalls, 1);
		assert.equal(env.session.getLastAssistantText(), "Direct answer after rejected batch.");
	} finally {
		env.dispose();
	}
});

test("user cancellation aborts the SDK run without generating a fallback", async () => {
	let workers = 0;
	const env = await setup((_context, presenter) => {
		if (presenter) return responseStream(assistant([{ type: "text", text: finalText }]));
		workers++;
		return responseStream(pending());
	});
	try {
		let abort: Promise<void> | undefined;
		env.session.subscribe((event) => {
			if (event.type === "tool_execution_update" && !abort) abort = env.session.abort();
		});
		await env.session.prompt("Cancelled fixture task.");
		await abort;
		assert.equal(workers, 1);
		assert.equal(env.session.isStreaming, false);
		const result = env.session.messages.find((message) => message.role === "toolResult");
		assert.ok(result?.isError);
		assert.ok(JSON.stringify(result?.content).includes("cancelled"));
	} finally {
		env.dispose();
	}
});

test("pi-goal-style settle-boundary continuation survives termination without repeating the final delivery", async () => {
	let workers = 0;
	let presentations = 0;
	let continued = false;
	const env = await setup(
		(_context, presenter) => {
			if (presenter) {
				presentations++;
				return responseStream(assistant([{ type: "text", text: finalText }]));
			}
			return responseStream(++workers === 1 ? pending() : assistant([{ type: "text", text: "Continuation handled." }]));
		},
		(pi) =>
			pi.on("agent_before_settle", (event) => {
				if (continued) return;
				continued = true;
				return {
					entries: [
						...event.entries,
						{
							type: "custom_message",
							customType: "fixture-continuation",
							content: "Continue the still-active fixture goal.",
							display: false,
						},
					],
					continue: true,
				};
			}),
	);
	try {
		await env.session.prompt("Fixture goal task.");
		await env.session.waitForIdle();
		assert.equal(workers, 2);
		assert.equal(presentations, 1);
		assert.equal(env.session.getLastAssistantText(), "Continuation handled.");
	} finally {
		env.dispose();
	}
});
