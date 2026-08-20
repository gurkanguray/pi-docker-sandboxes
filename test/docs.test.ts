import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { Ajv } from "ajv";
import { parse } from "yaml";
import { main as cliMain } from "../src/cli.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const digest =
	"ghcr.io/gurkanguray/pi-docker-sandboxes-runtime-standard@sha256:43433061a13ba16ca6e2d327d245844199acd231b9a4087aa26773e5f2d6714b";
const publicDocuments = [
	"README.md",
	"CHANGELOG.md",
	"COMPATIBILITY.md",
	"SECURITY.md",
	"SUPPORT.md",
	"ARCHITECTURE.md",
	"docker/README.md",
	"docs/index.md",
	"docs/getting-started.md",
	"docs/configuration.md",
	"docs/cli-reference.md",
	"docs/troubleshooting.md",
	"docs/uninstall.md",
] as const;

const read = (path: string) => readFile(resolve(path), "utf8");

async function schema(path: string): Promise<object> {
	return JSON.parse(await read(path)) as object;
}

test("public documentation is the stable 1.0.0 contract", async () => {
	const text = (await Promise.all(publicDocuments.map(read))).join("\n");
	assert.match(await read("CHANGELOG.md"), /^## 1\.0\.0 — 2026-08-19$/m);
	assert.match(text, /pi install npm:pi-docker-sandboxes@1\.0\.0/);
	assert.match(text, /npm view pi-docker-sandboxes@1\.0\.0 version/);
	assert.doesNotMatch(
		text,
		/\b(?:alpha|Early Access|not(?:-| )yet(?:-| )published|candidate)\b/i,
	);
	assert.doesNotMatch(text, /pi-docker-sandboxes@0\.1\.0/);
});

test("README is concise and routes details to maintained guides", async () => {
	const readme = await read("README.md");
	assert.ok(readme.split(/\s+/).length <= 500);
	assert.match(readme, /pi install npm:pi-docker-sandboxes@1\.0\.0/);
	assert.match(readme, /pi-dsbx doctor --json/);
	assert.match(readme, /pi --docker-sandbox/);
	for (const route of [
		"getting-started",
		"cli-reference",
		"configuration",
		"troubleshooting",
	])
		assert.match(
			readme,
			new RegExp(
				`https://gurkanguray\\.github\\.io/pi-docker-sandboxes/${route}`,
			),
		);
	for (const target of [
		"COMPATIBILITY.md",
		"SUPPORT.md",
		"SECURITY.md",
		"CONTRIBUTING.md",
	])
		assert.ok(readme.includes(`](${target})`), target);
});

test("compatibility names only release-gated hosts and the Windows milestone", async () => {
	const [compatibility, packageJson, imageLock] = await Promise.all([
		read("COMPATIBILITY.md"),
		read("package.json").then(JSON.parse),
		read("docker/image-lock.json").then(JSON.parse),
	]);
	const normalizedCompatibility = compatibility.replaceAll("\\|", "|");
	for (const value of [
		packageJson.engines.node,
		packageJson.peerDependencies["@earendil-works/pi-coding-agent"],
		packageJson.devDependencies["@earendil-works/pi-coding-agent"],
		imageLock.piVersion,
	])
		assert.ok(normalizedCompatibility.includes(value), value);
	assert.match(compatibility, /^\| macOS 14\+ \| Apple Silicon \| Supported/m);
	assert.match(
		compatibility,
		/^\| Ubuntu 24\.04\+ \| amd64, arm64 \| Supported; KVM required/m,
	);
	assert.match(compatibility, /Windows 11 x64[\s\S]*next package milestone/);
	assert.match(compatibility, /Windows 11 x64[\s\S]*not certified/i);
	assert.match(compatibility, new RegExp(digest));
	assert.match(compatibility, /`linux\/amd64`.*`linux\/arm64`/);
});

test("docs state secure defaults and immutable runtime provenance", async () => {
	const text = `${await read("README.md")}\n${await read("docs/configuration.md")}\n${await read("docker/README.md")}`;
	for (const statement of [
		/hardened.*default/i,
		/auth(?:entication)?.*`none`.*default/i,
		/model metadata.*(?:not|disabled|false)/i,
		/private Docker Engine.*disabled/i,
		/standard.*non-privileged/i,
		/GitHub OIDC provenance/i,
	])
		assert.match(text, statement);
	assert.match(text, new RegExp(digest));
	assert.match(text, /`linux\/amd64`.*`linux\/arm64`/);
	assert.doesNotMatch(text, /(?:run|use).*pi-dsbx image build/i);
});

test("operations docs cover upgrades, recovery, diagnostics, leases, and sessions", async () => {
	const text = `${await read("docs/cli-reference.md")}\n${await read("docs/troubleshooting.md")}\n${await read("docs/uninstall.md")}`;
	for (const requirement of [
		/pi-dsbx status --json/,
		/pi-dsbx doctor --json/,
		/upgrade/i,
		/recover/i,
		/lifecycle lease/i,
		/pi-dsbx unlock --name NAME --yes/,
		/pi-dsbx sessions list/,
		/pi-dsbx sessions restore/,
		/pi-dsbx sessions delete/,
	])
		assert.match(text, requirement);
});

test("CLI reference stays source-complete and truthful", async () => {
	const reference = await read("docs/cli-reference.md");
	const output: string[] = [];
	const originalLog = console.log;
	console.log = (message?: unknown) => output.push(String(message));
	try {
		assert.equal(await cliMain(["--help"]), 0);
	} finally {
		console.log = originalLog;
	}
	const usage = output.join("\n");
	for (const command of usage.match(/^ {2}pi-dsbx .+$/gm) ?? [])
		assert.ok(reference.includes(command.trim()), command.trim());
	for (const flag of usage.match(/--[a-z][a-z-]*/g) ?? [])
		assert.ok(reference.includes("`" + flag + "`"), flag);

	const extension = await read("extensions/docker-sandboxes/index.ts");
	for (const [, flag] of extension.matchAll(/registerFlag\("([^"]+)"/g))
		assert.ok(reference.includes(`\`--${flag}\``), flag);
	for (const command of ["status", "doctor", "config"])
		assert.ok(reference.includes(`\`/docker-sandbox ${command}\``), command);

	assert.match(reference, /`--profile`.*`hardened` \(default\)/i);
	assert.match(
		reference,
		new RegExp(`--sync.*${DEFAULT_CONFIG.syncProfile}.*default`, "i"),
	);
	assert.doesNotMatch(reference, /pi-dsbx image build/i);
	assert.doesNotMatch(reference, /`--image`|`--json`.*run option/i);
});

test("data-loss warnings are adjacent to destructive actions", async () => {
	const [cli, uninstall] = await Promise.all([
		read("docs/cli-reference.md"),
		read("docs/uninstall.md"),
	]);
	assert.match(
		cli,
		/pi-dsbx destroy --name NAME --discard-changes.*(?:permanent|lose|data loss)/i,
	);
	assert.match(
		uninstall,
		/(?:permanently lose|data loss).*pi-dsbx destroy --name NAME --discard-changes/is,
	);
	assert.match(uninstall, /export[\s\S]*before.*remov/i);
});

test("support and security describe the current stable line", async () => {
	const [support, security] = await Promise.all([
		read("SUPPORT.md"),
		read("SECURITY.md"),
	]);
	assert.match(support, /latest 1\.x/i);
	assert.match(support, /no (?:response-time )?SLA/i);
	assert.match(support, /pi-dsbx doctor --json/);
	assert.match(
		security,
		/https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/security\/advisories\/new/,
	);
	assert.match(security, /Do not open a public issue/i);
	assert.match(security, /latest 1\.x/i);
	assert.match(security, /\[threat model\]\(THREAT_MODEL\.md\)/i);
});

test("architecture matches production custody and lifecycle boundaries", async () => {
	const architecture = await read("ARCHITECTURE.md");
	for (const requirement of [
		/host-source custody/i,
		/standard.*non-privileged/i,
		/durable state/i,
		/exclusive.*lease/i,
		/preserv.*ambigu/i,
		/runtime schema/i,
		/worktree/i,
	])
		assert.match(architecture, requirement);
	assert.doesNotMatch(architecture, /private Docker Engine$/m);
});

test("issue forms are valid and platform intake matches certification", async () => {
	const ajv = new Ajv({ allErrors: true, strict: true });
	const validateConfig = ajv.compile(
		await schema("test/schema/github-issue-config.json"),
	);
	const validateForm = ajv.compile(
		await schema("test/schema/github-issue-forms.json"),
	);
	const templates = [
		[".github/ISSUE_TEMPLATE/config.yml", validateConfig],
		[".github/ISSUE_TEMPLATE/bug.yml", validateForm],
		[".github/ISSUE_TEMPLATE/question.yml", validateForm],
		[".github/ISSUE_TEMPLATE/feature.yml", validateForm],
		[".github/ISSUE_TEMPLATE/platform.yml", validateForm],
	] as const;
	for (const [path, validate] of templates) {
		const value = parse(await read(path), { strict: true, uniqueKeys: true });
		assert.ok(validate(value), `${path}: ${ajv.errorsText(validate.errors)}`);
	}
	const platform = await read(".github/ISSUE_TEMPLATE/platform.yml");
	assert.match(platform, /macOS 14\+.*Apple Silicon/i);
	assert.match(platform, /Ubuntu 24\.04\+.*amd64.*arm64.*KVM/i);
	assert.match(platform, /Windows 11 x64.*next.*milestone/i);
	assert.match(platform, /not certified/i);
	assert.match(platform, /does[\s\S]{0,80}roadmap/i);
});

test("every relative Markdown link resolves", async () => {
	for (const document of publicDocuments) {
		const markdown = await read(document);
		for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
			const target = match[1]!.split("#", 1)[0]!;
			if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
			await assert.doesNotReject(
				access(resolve(dirname(document), decodeURIComponent(target))),
				`${document}: unresolved link ${match[1]}`,
			);
		}
	}
});
