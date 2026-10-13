# Architecture

`pi-last-words` separates task execution from final-response presentation. It registers one optional, model-only tool, `present_final`; it does not run a second autonomous agent or change the selected model.

## Ownership and handoff

The executing agent owns investigation, decisions, execution and verification. The presenter owns the final wording of those supported outcomes, not further work or permission requests.

`conclusions` is a required, non-empty array. `rationale`, `limitations` and `output_requirements` are optional arrays. The handoff records newly formed judgments and relevant requirements without requiring a complete answer draft.

The final call must be alone in the latest assistant message and must not accompany user-facing text. Sequential execution is not a substitute for this check. Model-only exposure also prevents indirect invocation from scripts or nested tools.

## Context preparation

At execution time, `buildSessionProjection()` supplies the current branch's effective persisted messages. The extension does not resurrect abandoned branches, undone edits or pre-compaction content, and does not truncate the middle of the projection.

`context.ts` makes a request-only copy:

- Execution-stage system messages and tool declarations are removed.
- Native user, assistant and tool-result messages retain their roles and provenance.
- Supported runtime material is converted through the pi SDK and explicitly marked as material, not a new user instruction. Image blocks remain intact.
- Earlier tool calls must have complete, correctly named result pairs. Unknown roles, orphaned results and unanswered calls fail explicitly instead of being silently discarded or repaired with invented results.
- The pending `present_final` call becomes an assistant-derived handoff record without copied signatures. A fixed delivery request follows it.

The copied request does not change the saved transcript. Unpersisted context-hook injections are not automatically included; necessary requirements belong in the handoff.

## Model request and streaming

The request uses the selected session model through `modelRegistry.streamSimple()`, the separate `presenter.md` system prompt and an empty tool list. It passes the parent cancellation signal and the session thinking level when enabled; it does not force high reasoning.

Each presentation has an independent provider session ID. Cleanup releases that request's resources, not the executing agent's connection.

`execute()` waits for the internal stream. Cumulative text is sent through `onUpdate`, with closely spaced updates coalesced. Thinking content is not rendered as response text. `render.ts` uses pi's Markdown renderer and displays the full body rather than a collapsed tool preview.

## Result and session continuity

Success returns the complete body in `content`, available provider `usage`, presentation details and `terminate: true`. This skips the normal automatic restatement after the tool finishes. It does not shut down the conversation or suppress queued user work and other extensions' valid continuations.

The saved answer is a `toolResult`, not a synthetic assistant message. Subsequent turns and session restoration use the same saved body, subject to ordinary compaction. JSON/RPC clients must consume tool results. Plain text print mode declines the handoff because that output path does not print a final tool result.

## Failures and cancellation

Missing models, invalid handoffs, incomplete history, empty responses, provider errors, length stops and unexpected tool calls do not produce a successful terminating result. The executing agent receives an error and can correct the handoff or answer directly.

If text was already streamed, the error result retains it with an explicit incomplete-output label. An empty final snapshot cannot promote a partial preview into a finished answer.

Cancellation interrupts iterator waiting even if a provider adapter responds slowly. Late updates are not published, cleanup is attempted, and no detached fallback generation is started. Cleanup errors after successful delivery cannot turn the answer into a retry.

Available final provider usage is returned once through the tool result. Usage that never reaches the extension is not estimated or invented.

## File responsibilities

| File | Responsibility |
| --- | --- |
| `index.ts` | Tool schema, stream lifecycle, errors, cancellation, usage and termination |
| `context.ts` | Projection conversion, exclusive-call checks and complete tool-history checks |
| `render.ts` | Complete response rendering |
| `presenter.md` | Separate presentation system prompt, read relative to the extension file |
| `test/` | Isolated deterministic regressions and optional offline terminal checks |
| `docs/` | Public architecture and approved brand assets |

The runtime prompt is neither a skill nor a prompt template. The npm package declares only its extension entry point and ships the required runtime files without bundling pi's host modules.
