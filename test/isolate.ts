import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preloaded before SDK imports, including in test workers. Never discover the real user's agent directory.
const root = mkdtempSync(join(tmpdir(), "pi-last-words-unit-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
