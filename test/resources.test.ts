import { strict as assert } from "node:assert";
import test from "node:test";
import { createAssistantMessageEventStream, registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { createPresentationTool } from "../index.ts";
import { assistant, mockContext, responseStream, until } from "./helpers.ts";

for (const outcome of ["success", "failed", "cancelled"] as const) {
	test(`${outcome} cleans only its independent provider session, never the worker session`, async () => {
		const cleaned: Array<string | undefined> = [];
		const remove = registerSessionResourceCleanup((sessionId) => cleaned.push(sessionId));
		const controller = new AbortController();
		const stalled = createAssistantMessageEventStream();
		const { ctx, calls } = mockContext({
			stream: () =>
				outcome === "cancelled"
					? stalled
					: responseStream(
							assistant([{ type: "text", text: "answer" }], { stopReason: outcome === "failed" ? "length" : "stop" }),
						),
		});
		try {
			const running = createPresentationTool().execute(
				"final-call",
				{ conclusions: ["Done"] },
				controller.signal,
				undefined,
				ctx,
			);
			if (outcome === "cancelled") {
				await until(() => calls.length === 1);
				controller.abort();
			}
			await running;
			assert.deepEqual(cleaned, ["test-session:present_final:final-call"]);
		} finally {
			remove();
			stalled.end();
		}
	});
}

test("cleanup failure cannot turn a completed answer into a duplicate-producing retry", async () => {
	const remove = registerSessionResourceCleanup(() => {
		throw new Error("Fixture cleanup failure");
	});
	const { ctx } = mockContext();
	const warnings: string[] = [];
	ctx.ui = { notify: (message: string) => warnings.push(message) } as unknown as typeof ctx.ui;
	try {
		const result = await createPresentationTool().execute(
			"final-call",
			{ conclusions: ["Done"] },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.terminate, true);
		assert.equal(result.details.status, "completed");
		assert.equal(warnings.length, 1);
	} finally {
		remove();
	}
});
