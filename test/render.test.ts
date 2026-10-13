import { strict as assert } from "node:assert";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { createPresentationTool } from "../index.ts";

function component() {
	initTheme("dark", false);
	const view = new ToolExecutionComponent(
		"present_final",
		"test-call",
		{ conclusions: ["HANDOFF_MUST_NOT_BE_RENDERED"] },
		{ outputPad: 1, showImages: false },
		createPresentationTool(),
		{ requestRender() {} } as unknown as TUI,
		"/tmp",
	);
	view.setArgsComplete();
	view.markExecutionStarted();
	return view;
}

const output = (text: string, status = "completed", isError = false) => ({
	content: [{ type: "text", text }],
	details: { status, elapsedMs: 1 },
	isError,
});

test("actual TUI tool component shows the full answer even when collapsed", () => {
	const view = component();
	const text = Array.from({ length: 60 }, (_, i) => `结果 ${i + 1}: 已验证的范围。`).join("\n\n");
	view.updateResult(output(text));
	view.setExpanded(false);
	const collapsed = view.render(80).map(stripAnsi).join("\n");
	assert.ok(collapsed.includes("结果 60"));
	assert.ok(!collapsed.includes("HANDOFF_MUST_NOT_BE_RENDERED"));
	assert.ok(!collapsed.includes("more lines"));
	view.setExpanded(true);
	assert.equal(view.render(80).map(stripAnsi).join("\n"), collapsed);
});

test("streaming replaces the same result region; failure is visibly marked and keeps the partial body", () => {
	const view = component();
	view.updateResult(output("FIRST", "streaming"), true);
	assert.ok(view.render(80).map(stripAnsi).join("\n").includes("FIRST"));
	view.updateResult(output("FIRST SECOND", "streaming"), true);
	assert.equal(view.render(80).map(stripAnsi).join("\n").match(/FIRST/g)?.length, 1);
	view.updateResult(
		output(
			"present_final failed; no complete final answer was delivered.\n\nIncomplete output (not a finished answer):\n\nFIRST SECOND",
			"failed",
			true,
		),
	);
	const rendered = view.render(80).map(stripAnsi).join("\n");
	assert.ok(rendered.includes("Incomplete output"));
	assert.ok(rendered.includes("FIRST SECOND"));
});

test("renderer handles narrow widths, CJK/emoji, code and theme/padding changes", () => {
	const view = component();
	view.updateResult(
		output(
			'## 结果 🧪\n\n条件仍然适用，没有完成的部分不能说成完成。\n\n```json\n{"path":"MixedCase/文件.json","passed":false}\n```',
		),
	);
	for (const width of [12, 30, 80]) {
		for (const line of view.render(width))
			assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${stripAnsi(line)}`);
	}
	initTheme("light", false);
	view.setOutputPad(0);
	view.invalidate();
	const rendered = view.render(80).map(stripAnsi).join("\n");
	assert.ok(rendered.includes("MixedCase/文件.json"));
	assert.ok(rendered.includes("false"));
});
