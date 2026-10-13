import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeFiles = ["index.ts", "context.ts", "render.ts", "presenter.md"];

function manifest() {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

test("manifest declares complete runtime resources without bundled host modules", () => {
	const pkg = manifest();
	assert.equal(pkg.name, "pi-last-words");
	assert.equal(pkg.type, "module");
	assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);
	assert.deepEqual(pkg.files, runtimeFiles);
	assert.equal(pkg.dependencies, undefined);
	for (const name of runtimeFiles) assert.ok(statSync(join(root, name)).isFile());
	for (const name of [
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"typebox",
	]) {
		assert.equal(pkg.peerDependencies[name], "*");
		assert.equal(pkg.peerDependenciesMeta[name].optional, true);
	}
	assert.equal(pkg.pi.skills, undefined);
	assert.equal(pkg.pi.prompts, undefined);
});

test("npm tarball contains exactly the distribution files and matching public metadata", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-last-words-pack-"));
	try {
		const npmCli = process.env.npm_execpath;
		assert.ok(npmCli, "Run packaging tests through npm test so the npm CLI path is available.");
		const output = execFileSync(
			process.execPath,
			[npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", directory],
			{
				cwd: root,
				encoding: "utf8",
				timeout: 30_000,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const packed = JSON.parse(output)[0];
		const pkg = manifest();
		assert.equal(packed.name, pkg.name);
		assert.equal(packed.version, pkg.version);
		assert.deepEqual(
			packed.files.map((file: { path: string }) => file.path).sort(),
			[...runtimeFiles, "LICENSE", "README.md", "package.json"].sort(),
		);
		assert.equal(pkg.repository.url, "git+https://github.com/huahuadeliaoliao/pi-last-words.git");
		assert.equal(pkg.homepage, "https://github.com/huahuadeliaoliao/pi-last-words#readme");
		assert.equal(
			pkg.pi.image,
			`https://raw.githubusercontent.com/huahuadeliaoliao/pi-last-words/v${pkg.version}/docs/logo.png`,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
