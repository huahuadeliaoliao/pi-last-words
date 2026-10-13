import { setImmediate as immediate } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type ModelsSimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

export const MODEL: Model<"openai-responses"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	input: ["text", "image"],
	reasoning: true,
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

export const USAGE: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

export function assistant(
	content: AssistantMessage["content"],
	fields: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: structuredClone(USAGE),
		stopReason: "stop",
		timestamp: Date.now(),
		content,
		...fields,
	};
}

export function pending(id = "final-call"): AssistantMessage {
	return assistant([{ type: "toolCall", id, name: "present_final", arguments: { conclusions: ["Done"] } }], {
		stopReason: "toolUse",
	});
}

export function history(): AgentMessage[] {
	return [
		{ role: "user", content: "请解释结果，保留验证范围。", timestamp: 1 },
		assistant([{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "results.json" } }], {
			stopReason: "toolUse",
		}),
		{
			role: "toolResult",
			toolName: "read",
			toolCallId: "read-call",
			content: [{ type: "text", text: "Unit tests passed; integration tests were not run." }],
			isError: false,
			timestamp: 3,
		},
		pending(),
	];
}

export function responseStream(final = assistant([{ type: "text", text: "单测通过；集成测试未运行。" }])) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: assistant([], { stopReason: "pending" }) });
		const text = final.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (text) {
			const half = text.slice(0, Math.ceil(text.length / 2));
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: half,
				partial: assistant([{ type: "text", text: half }], { stopReason: "pending" }),
			});
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
		}
		if (final.stopReason === "error" || final.stopReason === "aborted") {
			stream.push({ type: "error", reason: final.stopReason, error: final });
		} else {
			stream.push({ type: "done", reason: final.stopReason === "pending" ? "stop" : final.stopReason, message: final });
		}
	});
	return stream;
}

export function mockContext(
	options: {
		messages?: AgentMessage[];
		stream?: () => ReturnType<typeof createAssistantMessageEventStream>;
		mode?: ExtensionToolContext["mode"];
	} = {},
) {
	let messages = options.messages ?? history();
	const calls: Array<{ model: Model<"openai-responses">; context: Context; options?: ModelsSimpleStreamOptions }> = [];
	const ctx = {
		model: MODEL,
		mode: options.mode ?? "tui",
		thinkingLevel: "medium",
		sessionManager: {
			getSessionId: () => "test-session",
			buildSessionProjection: () => ({ messages, entries: [], thinkingLevel: "medium", model: null }),
		},
		modelRegistry: {
			streamSimple(model: Model<"openai-responses">, context: Context, requestOptions?: ModelsSimpleStreamOptions) {
				calls.push({ model, context, options: requestOptions });
				return options.stream?.() ?? responseStream();
			},
		},
	} as unknown as ExtensionToolContext;
	return {
		ctx,
		calls,
		setMessages: (next: AgentMessage[]) => {
			messages = next;
		},
	};
}

export async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for test state.");
		await immediate();
	}
}
