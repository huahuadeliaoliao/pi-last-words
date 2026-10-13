import { strict as assert } from "node:assert";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	cleanupSessionResources,
	createAssistantMessageEventStream,
	getSystemMessageText,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lastWords from "../index.ts";
import { assistant, MODEL, pending } from "./helpers.ts";

/** Offline provider for the actual CLI/TUI. Never loads credentials or reaches a network. */
export default function tuiFixture(pi: ExtensionAPI): void {
	const record = (event: string) => {
		const path = process.env.PI_LAST_WORDS_TUI_EVENTS;
		if (path) appendFileSync(path, `${JSON.stringify({ event, time: Date.now() })}\n`);
	};
	// Probe the real installed CLI, not just the project's SDK dependency tree.
	const hostEntry = realpathSync(process.argv[1]);
	const hostRequire = process.getBuiltinModule("module").createRequire(hostEntry);
	const chunks = join(dirname(hostEntry), "chunks");
	// Bundled Pi embeds the registry in one shared chunk; importing a disk SDK copy
	// would compare against a different, unused registry and is not a valid probe.
	const candidates = existsSync(chunks)
		? readdirSync(chunks)
				.filter((file) => file.startsWith("chunk-") && file.endsWith(".js"))
				.map((file) => join(chunks, file))
				.filter((file) => /function\s+cleanupSessionResources\s*\(/.test(readFileSync(file, "utf8")))
		: [join(dirname(dirname(hostEntry)), "node_modules", "@earendil-works", "pi-ai", "dist", "session-resources.js")];
	assert.equal(candidates.length, 1, "one host provider cleanup registry required");
	const hostResources = hostRequire(candidates[0]) as { cleanupSessionResources: typeof cleanupSessionResources };
	assert.equal(
		cleanupSessionResources,
		hostResources.cleanupSessionResources,
		"extension and host must share the provider cleanup registry",
	);
	record("shared_cleanup_registry");
	pi.registerProvider("fixture-tui", {
		api: "last-words-tui-fixture",
		baseUrl: "https://example.invalid",
		apiKey: "offline-fixture-not-a-credential",
		models: [{ ...MODEL, api: "last-words-tui-fixture" }],
		streamSimple: (_model, context, options) => {
			const stream = createAssistantMessageEventStream();
			const first = context.messages[0];
			const presenting =
				first?.role === "system" && getSystemMessageText(first).includes("final-response presenter for pi-last-words");
			if (!presenting) {
				record("worker");
				queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message: pending() }));
				return stream;
			}
			record("presenter_start");
			const chunks = [
				"FIRST_CHUNK\n\n",
				...Array.from({ length: 24 }, (_, i) => `段落 ${i + 1}: 条件、验证范围和未完成事项均应保留。\n\n`),
				"END_OF_LONG_ANSWER",
			];
			let text = "";
			let index = 0;
			const cancel = () => {
				clearInterval(timer);
				record("presenter_cancelled");
				stream.push({
					type: "error",
					reason: "aborted",
					error: assistant([{ type: "text", text }], { stopReason: "aborted" }),
				});
			};
			const timer = setInterval(() => {
				const delta = chunks[index++];
				text += delta;
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta,
					partial: assistant([{ type: "text", text }], { stopReason: "pending" }),
				});
				if (index === chunks.length) {
					clearInterval(timer);
					options?.signal?.removeEventListener("abort", cancel);
					const final = assistant([{ type: "text", text }]);
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
					stream.push({ type: "done", reason: "stop", message: final });
					record("presenter_done");
				}
			}, 100);
			options?.signal?.addEventListener("abort", cancel, { once: true });
			if (options?.signal?.aborted) cancel();
			return stream;
		},
	});
	lastWords(pi);
	pi.on("agent_end", () => record("agent_end"));
}
