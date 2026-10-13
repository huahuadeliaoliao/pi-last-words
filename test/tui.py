"""Opt-in, offline CLI/TUI smoke test in private PTYs; never touches a user's terminal."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

PROJECT = Path(__file__).resolve().parent.parent
PI = os.environ.get("PI_LAST_WORDS_PI") or shutil.which("pi")
if not PI:
    raise SystemExit("The installed pi CLI is required for the TUI smoke test.")
RUN = Path(tempfile.mkdtemp(prefix="pi-last-words-tui-"))
os.chmod(RUN, 0o700)
print(f"TUI run: {RUN}", flush=True)
results = []


def run_case(mode, cancel):
    directory = RUN / f"{mode}-{'cancel' if cancel else 'complete'}"
    agent = directory / "agent"
    cwd = directory / "workspace"
    agent.mkdir(parents=True)
    cwd.mkdir()
    (agent / "settings.json").write_text(json.dumps({
        "quietStartup": True, "theme": "dark", "cacheWarming": "off",
        "compaction": {"enabled": False}, "retry": {"enabled": False},
    }))
    event_path = directory / "events.jsonl"
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent),
               PI_CODING_AGENT_SESSION_DIR=str(agent / "sessions"),
               PI_LAST_WORDS_TUI_EVENTS=str(event_path), TERM="xterm-256color", PI_OFFLINE="1")
    command = [PI, "--offline", "--no-extensions", "-e", str(PROJECT / "test/tui-fixture.ts"),
               "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
               "--no-mcp", "--provider", "fixture-tui", "--model", "fixture", "--thinking", "off",
               "--tools", "present_final", "--tui-mode", mode, "Run the offline presentation fixture."]
    (directory / "command.json").write_text(json.dumps(command))
    (directory / "cwd.txt").write_text(str(cwd))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=slave, stdout=slave,
                               stderr=slave, start_new_session=True)
    (directory / "pid").write_text(str(process.pid))
    os.close(slave)
    output = bytearray()
    cancelled = False
    deadline = time.monotonic() + 35
    events = []
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    output.extend(chunk)
            if cancel and not cancelled and b"FIRST_CHUNK" in output:
                os.write(master, b"\x1b")
                cancelled = True
            if event_path.exists():
                events = [json.loads(line)["event"] for line in event_path.read_text().splitlines()]
            if "agent_end" in events:
                # Allow the final tool-result paint to reach the PTY before shutdown.
                end = time.monotonic() + 0.4
                while time.monotonic() < end:
                    ready, _, _ = select.select([master], [], [], 0.05)
                    if ready:
                        output.extend(os.read(master, 65536))
                break
            if process.poll() is not None:
                raise AssertionError(f"pi exited early: {process.returncode}")
        else:
            raise AssertionError("TUI did not finish within 35 seconds")
        text = output.decode("utf-8", errors="replace")
        assert "Working" in text, "working indicator was not rendered"
        assert "FIRST_CHUNK" in text, "first streamed content was not rendered"
        assert events.count("shared_cleanup_registry") == 1, events
        assert events.count("worker") == 1, events
        assert events.count("presenter_start") == 1, events
        if cancel:
            assert cancelled and "presenter_cancelled" in events, events
            assert "cancelled" in text and "Incomplete output" in text
            assert "END_OF_LONG_ANSWER" not in text
        else:
            assert "presenter_done" in events, events
            assert "END_OF_LONG_ANSWER" in text
            assert "more lines" not in text
        entries = []
        for session in (agent / "sessions").rglob("*.jsonl"):
            entries.extend(json.loads(line) for line in session.read_text().splitlines())
        delivered = [entry["message"] for entry in entries if entry.get("type") == "message"
                     and entry["message"].get("role") == "toolResult"
                     and entry["message"].get("toolName") == "present_final"]
        assert len(delivered) == 1, "one persisted tool result required"
        assert delivered[0]["isError"] == cancel
        saved = "\n".join(block.get("text", "") for block in delivered[0]["content"])
        assert ("END_OF_LONG_ANSWER" in saved) != cancel
        os.write(master, b"\x04")
        # Keep draining while Pi restores the terminal/prints its exit transcript.
        # Waiting without reading can block the child on the PTY's bounded output buffer.
        shutdown_deadline = time.monotonic() + 8
        while process.poll() is None and time.monotonic() < shutdown_deadline:
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
        process.wait(timeout=2)
        assert process.returncode == 0, f"unclean TUI shutdown: {process.returncode}"
        results.append({"mode": mode, "cancelled": cancel, "passed": True,
                        "bytes": len(output), "events": events})
        print(f"{mode} {'cancel' if cancel else 'complete'}: PASS", flush=True)
    finally:
        (directory / "terminal.ansi").write_bytes(output)
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        (directory / "exit-code").write_text(str(process.returncode))
        os.close(master)


try:
    run_case("regular", False)
    run_case("fullscreen", False)
    run_case("regular", True)
    run_case("fullscreen", True)
finally:
    (RUN / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
print("PASS: four isolated CLI/TUI scenarios.", flush=True)
