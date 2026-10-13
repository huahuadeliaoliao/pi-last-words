# pi-last-words

![pi-last-words — Work first. Words last.](https://raw.githubusercontent.com/huahuadeliaoliao/pi-last-words/v0.1.0/docs/logo.png)

An optional final-response presenter for the [pi coding agent](https://github.com/earendil-works/pi).

The executing agent investigates, decides, works and verifies. When the work is ready, it can hand the final response to `present_final`: a separate, tool-free call to the **same session model** that organizes the supported outcome for the user.

**Work first. Words last.**

## Install

Requires **pi 1.1.0 or newer** and **Node.js 22.19 or newer**.

```sh
pi install npm:pi-last-words
```

Or install from GitHub:

```sh
pi install git:github.com/huahuadeliaoliao/pi-last-words
```

Restart pi or run `/reload` to load the extension in an existing session.

## Use it

There is no new slash command, model setting or mandatory presentation step. The extension adds one model-facing tool, `present_final`. The agent may use it when an explanation, comparison or several outcomes benefit from a dedicated final response; simple answers can remain direct.

You can also ask for it explicitly:

> Review the changes and finish the checks. Once the work is complete, use present_final to explain the result, important reasons and remaining limitations.

A handoff contains **settled conclusions**, not a complete answer draft or an assignment to do more research:

```json
{
  "conclusions": ["The requested change is implemented."],
  "rationale": ["The regression checks completed successfully."],
  "limitations": ["Deployment was not part of this task."]
}
```

The optional `output_requirements` field carries still-applicable language, format, exact-content or audience requirements that might not be present in the saved conversation.

The tool must be the **only tool call** in its assistant message, with no accompanying reply text. The extension checks this boundary rather than relying on prompting alone.

## What happens at handoff?

1. The extension reads the current branch's effective, persisted conversation.
2. It prepares a separate request with `presenter.md`, the handoff and **no tools**.
3. The selected session model generates the response while pi remains busy; text streams into the current tool area.
4. On success, the complete response is saved in the tool result and `terminate: true` skips the executing agent's ordinary follow-up. The answer is not repeated.

The conversation stays open. Later questions can reference the delivered text. New user messages and legitimate continuations from other extensions are not discarded.

Each handoff makes a separate model request, with its own token cost and latency. It uses your configured provider and session model; no additional service or model configuration is introduced.

## Usage notes

- **TUI:** the complete answer is shown even when ordinary tool output is collapsed. Select text to copy it. Pi's built-in `/copy` targets assistant messages, not this final tool result.
- **JSON / RPC:** clients must consume tool execution updates and the final tool result; the answer is not a native assistant message.
- **Plain text print mode:** the tool declines the handoff so the agent can answer directly, rather than delivering an invisible tool result.
- **Context:** compaction, branch selection and persisted context edits are respected. Temporary context-hook material is not automatically inherited; pass necessary requirements in the handoff.
- **Failure or cancellation:** incomplete output is marked as incomplete. Failure does not terminate the normal tool loop; user cancellation does not start a fallback generation.

The presenter organizes existing work. It is not another investigator, a reviewer that independently verifies results, or a way to outsource unfinished technical decisions.

## Development

```sh
npm ci --ignore-scripts
npm run lint
npm run check
npm test
npm pack --dry-run --ignore-scripts
```

The extension is TypeScript loaded directly by pi; there is no build step. Host packages are optional peers and are pinned as development dependencies for local checks.

An optional offline terminal smoke test uses the installed pi CLI in private PTYs:

```sh
PI_LAST_WORDS_PI="$(command -v pi)" npm run test:tui
```

It requires Python 3 and a Unix-like system. Normal tests use isolated agent directories and synthetic providers, without real credentials or model requests.

See [architecture](docs/ARCHITECTURE.md), [agent guidance](AGENTS.md) and [visual identity](docs/BRANDING.md).

## License

[MIT](LICENSE). The Pi badge is an upstream ecosystem mark; see its [source and attribution](docs/BRANDING.md).
