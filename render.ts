import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, Text } from "@earendil-works/pi-tui";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

export interface PresentationDetails {
	status: "streaming" | "completed" | "failed" | "cancelled" | "rejected";
	model?: string;
	elapsedMs: number;
	stopReason?: string;
}

export function renderCall(_args: unknown, theme: Theme, context: ToolRenderContext): Component {
	return new Text(theme.fg("muted", "Final response"), context.outputPad, 0);
}

/** Full text even when the enclosing tool is collapsed. Never render the handoff as a draft. */
export function renderResult(
	result: AgentToolResult<PresentationDetails>,
	_options: { expanded: boolean; isPartial: boolean },
	_theme: Theme,
	context: ToolRenderContext,
): Component {
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	// Recreate on a theme/padding change as well as on an update. Markdown owns its layout cache.
	return new Markdown(text, context.outputPad, 0, getMarkdownTheme());
}
