import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, cleanupSessionResources } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildPresentationContext } from "./context.ts";
import { type PresentationDetails, renderCall, renderResult } from "./render.ts";

const Points = Type.Array(Type.String({ minLength: 1 }));
export const Parameters = Type.Object({
	conclusions: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		description:
			"Your settled conclusions or outcomes, not a complete answer draft. Do not delegate investigation or decision-making.",
	}),
	rationale: Type.Optional(Points),
	limitations: Type.Optional(Points),
	output_requirements: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Still-applicable user language, format, exact-content or audience requirements that may not be visible in persisted history, especially transient context. Do not invent new requirements.",
		}),
	),
});

export function messageText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** A cancelled tool must settle even if an adapter is slow to acknowledge its signal. */
async function nextEvent(
	iterator: AsyncIterator<AssistantMessageEvent>,
	signal: AbortSignal | undefined,
): Promise<IteratorResult<AssistantMessageEvent>> {
	if (!signal) return iterator.next();
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Presentation cancelled."));
		signal.addEventListener("abort", abort, { once: true });
		iterator.next().then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

export function createPresentationTool(): ToolDefinition<typeof Parameters, PresentationDetails> {
	return {
		name: "present_final",
		label: "Final response",
		description:
			"Deliver this turn's final answer through a separate, tool-free call to the current model, using the current effective conversation and your handoff. The result is shown directly to the user, retained in the conversation, and ends the normal tool loop. Finish execution and verification first. This is not a consultant or a draft-polishing tool.",
		promptSnippet: "Optionally hand off final presentation; supply conclusions, not a full draft.",
		promptGuidelines: [
			"For a final answer that benefits from explanation, comparison or organizing several outcomes, you may use present_final; simple replies may be answered directly. It does not handle progress updates, clarifications or permission requests.",
			"Call present_final alone, with no other tool calls or user-facing text in that assistant message. Supply settled conclusions, essential reasons and limitations, not a complete answer. Its successful result is already the final user-facing answer; do not restate it. If it fails, correct the handoff or answer directly.",
		],
		parameters: Parameters,
		exposure: "model-only",
		executionMode: "sequential",
		annotations: { readOnlyHint: true, openWorldHint: true },
		renderShell: "self",
		renderCall,
		renderResult,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const started = performance.now();
			let status: PresentationDetails["status"] = "rejected";
			let partial = "";
			let final: AssistantMessage | undefined;
			let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
			let modelName: string | undefined;
			let presentationSessionId: string | undefined;
			const details = (): PresentationDetails => ({
				status,
				model: modelName,
				elapsedMs: Math.round(performance.now() - started),
				stopReason: final?.stopReason,
			});
			try {
				signal?.throwIfAborted();
				if (ctx.mode === "print") {
					throw new Error(
						"Plain print mode does not display final tool results. Answer directly, or use TUI/JSON/RPC mode.",
					);
				}
				const model = ctx.model;
				if (!model) throw new Error("No active session model.");
				modelName = `${model.provider}/${model.id}`;
				if (params.conclusions.every((point) => !point.trim())) {
					throw new Error("Supply at least one settled conclusion, not an empty handoff.");
				}
				// Capture at execution time, never an earlier model-request snapshot or raw branch history.
				const projection = ctx.sessionManager.buildSessionProjection();
				const context = buildPresentationContext(projection.messages, toolCallId, params);
				const systemPrompt = await readFile(new URL("./presenter.md", import.meta.url), "utf8");
				if (!systemPrompt.trim()) throw new Error("presenter.md is empty.");
				signal?.throwIfAborted();
				status = "streaming";
				onUpdate?.({ content: [], details: details() });
				signal?.throwIfAborted();
				presentationSessionId = `${ctx.sessionManager.getSessionId()}:present_final:${toolCallId}`;
				const stream = ctx.modelRegistry.streamSimple(
					model,
					{ systemPrompt, messages: context, tools: [] },
					{
						signal,
						reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
						// Keep provider cache/connection identity separate from the executing agent.
						sessionId: presentationSessionId,
					},
				);
				iterator = stream[Symbol.asyncIterator]();
				let lastUpdate = Number.NEGATIVE_INFINITY;
				for (;;) {
					const next = await nextEvent(iterator, signal);
					signal?.throwIfAborted();
					if (next.done) break;
					const event = next.value;
					if (event.type === "done") final = event.message;
					else if (event.type === "error") final = event.error;
					else if (event.type === "text_delta" || event.type === "text_end") {
						const nextText = messageText(event.partial);
						// A malformed empty snapshot must not erase an already displayed incomplete answer.
						if (!nextText.trim()) continue;
						partial = nextText;
						const now = performance.now();
						if (now - lastUpdate >= 80 || event.type === "text_end") {
							onUpdate?.({ content: [{ type: "text", text: partial }], details: details() });
							lastUpdate = now;
						}
					}
				}
				signal?.throwIfAborted();
				if (!final) throw new Error("The presentation stream ended without a final response.");
				const finalText = messageText(final);
				if (finalText.trim()) partial = finalText;
				if (final.stopReason !== "stop") {
					throw new Error(`Presentation did not finish (${final.stopReason}). ${final.errorMessage ?? ""}`.trim());
				}
				if (final.content.some((block) => block.type === "toolCall")) {
					throw new Error("The presenter attempted to call a tool; no tool was executed.");
				}
				if (!finalText.trim()) throw new Error("The presenter returned no answer text.");
				status = "completed";
				return {
					content: [{ type: "text", text: partial }],
					details: details(),
					usage: final.usage,
					terminate: true,
				};
			} catch (error) {
				status = signal?.aborted ? "cancelled" : status === "rejected" ? "rejected" : "failed";
				const reason =
					status === "cancelled" ? "Cancelled by the user." : error instanceof Error ? error.message : String(error);
				const receipt = `present_final ${status}; no complete final answer was delivered. ${reason}`;
				const text = partial ? `${receipt}\n\nIncomplete output (not a finished answer):\n\n${partial}` : receipt;
				const result: AgentToolResult<PresentationDetails> = {
					content: [{ type: "text", text }],
					details: details(),
					isError: true,
				};
				if (final) result.usage = final.usage;
				return result;
			} finally {
				// Some adapters finish cancellation asynchronously. Never wait here or publish late updates.
				void iterator?.return?.().catch(() => {});
				if (presentationSessionId) {
					try {
						cleanupSessionResources(presentationSessionId);
					} catch {
						// Do not turn an already delivered answer into a retry/duplicate because cleanup failed.
						ctx.ui?.notify("pi-last-words: could not release the presentation connection.", "warning");
					}
				}
			}
		},
	};
}

export default function lastWords(pi: ExtensionAPI): void {
	pi.registerTool(createPresentationTool());
}
