import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { Ajv } from "ajv";
import { parse } from "yaml";
import { main as cliMain } from "../src/cli.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const documents = [
	"README.md",
	"SECURITY.md",
	"SUPPORT.md",
	"CONTRIBUTING.md",
	"CODE_OF_CONDUCT.md",
	"GOVERNANCE.md",
	"docs/getting-started.md",
	"docs/configuration.md",
	"docs/troubleshooting.md",
	"docs/migration.md",
	"docs/uninstall.md",
] as const;

async function read(path: string): Promise<string> {
	return readFile(resolve(path), "utf8");
}

async function schema(path: string): Promise<object> {
	return JSON.parse(await read(path)) as object;
}

test("README describes the supported Early Access onboarding path", async () => {
	const readme = await read("README.md");
	const top = readme.split("\n").slice(0, 12).join("\n");

	assert.match(top, /Early Access/);
	assert.match(top, /tested on macOS 26\.5\.2[^\n]*Apple Silicon/i);
	assert.match(
		top,
		/other macOS releases[^\n]*(?:not yet validated|not supported|unsupported)/i,
	);
	for (const version of [
		/Pi 0\.84\.1/,
		/Node\.js 24\.12\.0/,
		/Docker Engine 29\.7\.1/,
		/Docker Sandboxes \(`sbx`\) 0\.38\.0/,
	])
		assert.match(top, version);
	assert.match(top, /Linux[^\n]*Windows[^\n]*(?:not supported|unsupported)/i);
	assert.match(readme, /pi install npm:pi-docker-sandboxes@0\.1\.0/);
	assert.match(readme, /pi --docker-sandbox/);
	assert.match(readme, /--docker-sandbox-no-host-auth/);
	assert.match(
		readme,
		/pi --docker-sandbox --docker-sandbox-session (?:ID|SESSION_ID)/,
	);
	assert.match(readme, /host `--session`[^\r\n]*unsupported/i);
	assert.match(readme, /\/resume/);
	assert.match(readme, /--keep[^\r\n]*same sandbox/i);
	assert.match(readme, /pi-dsbx run[^\n]*-- --session (?:ID|SESSION_ID)/);
	assert.match(readme, /git commit --allow-empty -m ["']Initial commit["']/);
});

test("README command reference stays aligned with the CLI and extension", async () => {
	const readme = await read("README.md");
	const output: string[] = [];
	const originalLog = console.log;
	console.log = (message?: unknown) => output.push(String(message));
	try {
		assert.equal(await cliMain(["--help"]), 0);
	} finally {
		console.log = originalLog;
	}
	const usage = output.join("\n");
	for (const command of usage.match(/^  pi-dsbx .+$/gm) ?? [])
		assert.ok(readme.includes(command.trim()), command.trim());
	for (const flag of usage.match(/--[a-z][a-z-]*/g) ?? [])
		assert.ok(readme.includes("`" + flag + "`"), flag);

	const extension = await read("extensions/docker-sandboxes/index.ts");
	const extensionFlags = [...extension.matchAll(/registerFlag\("([^"]+)"/g)].map(
		([, flag]) => `--${flag}`,
	);
	for (const flag of extensionFlags)
		assert.ok(readme.includes("`" + flag + "`"), flag);
	for (const command of ["status", "doctor", "config"])
		assert.ok(readme.includes("`/docker-sandbox " + command + "`"), command);

	assert.match(
		readme,
		new RegExp(
			"`--profile`[^\\n]*`" +
				DEFAULT_CONFIG.profile +
				"` \\(default\\)[^\\n]*`hardened`",
		),
	);
	assert.match(
		readme,
		new RegExp(
			"`--sync`[^\\n]*`" +
				DEFAULT_CONFIG.syncProfile +
				"` \\(default\\)[^\\n]*`clean`[^\\n]*`mirror`",
		),
	);
	assert.match(readme, /`--image`[^\n]*immutable[^\n]*digest/i);
	assert.doesNotMatch(readme, /`--image`[^\n]*local content tag/i);
	assert.match(readme, /`--fresh`[^\n]*cannot[^\n]*`--name`/i);
	assert.match(readme, /`--discard-changes`[^\n]*noninteractive/i);
	assert.match(
		readme,
		/interactive confirmation[^\n]*(?:changed|uninspectable)[^\n]*(?:remove|discard|destroy)/i,
	);
	assert.match(readme, /`pi-dsbx`[^\n]*same as `pi-dsbx run`/i);
	assert.match(readme, /`pi-dsbx status`[^\n]*on the host[^\n]*list/i);
	assert.doesNotMatch(readme, /`pi-dsbx image build`[^\n]*accepts no flags/i);
});

test("docs state the implemented safety, cleanup, and image defaults", async () => {
	const text = (await Promise.all(documents.map(read))).join("\n");

	assert.doesNotMatch(
		text,
		/^(?!.*(?:do not|unsupported)).*(?:run|use|authenticate|sign in|log in)[^\n]*\/login/im,
	);
	assert.match(text, /clean sandboxes are removed by default/i);
	assert.match(
		text,
		/changed or uninspectable sandboxes are (?:kept|preserved)/i,
	);
	assert.match(text, /--keep[^\n]*preserve/i);
	assert.match(text, /--docker-sandbox-session/);
	assert.match(
		text,
		/--discard-changes[^\n]*(?:explicit|permanent|discard|lose)/i,
	);
	assert.match(text, /verified local image/i);
	assert.match(text, /pi remove npm:pi-docker-sandboxes/);
	assert.doesNotMatch(text, /(?:Linux|Windows)[^\n]*(?:is|are) supported/i);
});

test("getting started documents the ordered native first-launch transcript", async () => {
	const gettingStarted = await read("docs/getting-started.md");
	const transcript = [
		"pi-dsbx: checking Docker Sandboxes",
		"pi-dsbx: syncing host credentials",
		"2 packages need a compiler in this sandbox (npm:context-mode, npm:pi-hermes-memory).",
		"Install toolchain here? ~1–2 min, not saved. [y/N] y",
		"pi-dsbx: copying host profile",
		"pi-dsbx: creating sandbox",
		"pi-dsbx: installing compiler (12s)",
		"pi-dsbx: installing npm:context-mode (18s)",
		"pi-dsbx: starting Pi",
	];
	let previous = -1;
	for (const line of transcript) {
		const index = gettingStarted.indexOf(line);
		assert.ok(index > previous, `${line} must appear in transcript order`);
		previous = index;
	}
	assert.match(
		gettingStarted,
		/all mirrored remote packages[^\n]*before (?:Pi starts|attach)/i,
	);
	assert.match(
		gettingStarted,
		/compiler consent[^\n]*only[^\n]*native packages/i,
	);
	assert.match(gettingStarted, /declin[^\n]*skills only/i);
});

test("README links to dedicated operations guidance", async () => {
	const readme = await read("README.md");

	assert.match(readme, /\[Troubleshooting\]\(docs\/troubleshooting\.md\)/);
	assert.match(readme, /\[Migration\]\(docs\/migration\.md\)/);
	assert.match(readme, /\[Uninstall\]\(docs\/uninstall\.md\)/);
	assert.match(readme, /\[Support\]\(SUPPORT\.md\)/);
	assert.match(
		readme,
		/\[Documentation source\]\(https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/tree\/main\/docs\)/,
	);
	assert.doesNotMatch(readme, /gurkanguray\.github\.io/);
	assert.doesNotMatch(
		readme,
		/docs\/(?:getting-started|configuration)\.md#(?:troubleshooting|migration-notes|uninstall)/,
	);
});

test("troubleshooting documents supported failures and recovery", async () => {
	const troubleshooting = await read("docs/troubleshooting.md");

	for (const heading of [
		"sbx is missing or unsupported",
		"Git repository has no initial commit",
		"No models or credentials",
		"Image pull or build fails",
		"Sandbox is retained with unexported changes",
		"Patch export or apply fails",
		"State is missing or corrupt",
		"Host cleanup leaves residue",
		"Collect doctor output without secrets",
	])
		assert.match(troubleshooting, new RegExp(`^## ${heading}$`, "im"));

	assert.match(troubleshooting, /sbx version/);
	assert.match(
		troubleshooting,
		/git commit --allow-empty (?:--only )?-m ["']Initial commit["']/,
	);
	assert.match(troubleshooting, /sbx secret set <provider>/);
	assert.match(troubleshooting, /pi-dsbx image build/);
	assert.match(troubleshooting, /pi-dsbx export --name NAME/);
	assert.match(troubleshooting, /pi-dsbx apply PATCH --name NAME --yes/);
	assert.match(troubleshooting, /\.preserved/);
	assert.match(troubleshooting, /sbx exec NAME git status --porcelain=v1/);
	assert.match(troubleshooting, /pi-docker-sandboxes-/);
	assert.match(troubleshooting, /doctor[\s\S]*does not print secret values/i);
	assert.doesNotMatch(troubleshooting, /(?:API[_ -]?KEY|TOKEN|SECRET)=\S+/i);
});

test("migration documents changed defaults and rollback", async () => {
	const migration = await read("docs/migration.md");

	for (const claim of [
		/verified image/i,
		/no runtime installation/i,
		/remove clean sandboxes/i,
		/safe personalization/i,
		/dynamic proxy support/i,
		/dedicated discard/i,
		/temporary owner-only file[\s\S]*atomically rename/i,
		/original remains intact/i,
		/warnings and rollback/i,
	])
		assert.match(migration, claim);
	assert.doesNotMatch(migration, /delete state blindly/i);
});

test("uninstall preserves data and follows the safe removal order", async () => {
	const uninstall = await read("docs/uninstall.md");
	const ordered = [
		"## 1. List and export changed sandboxes",
		"## 2. Remove confirmed sandboxes",
		"## 3. Remove the package",
		"## 4. Optionally remove images",
		"## 5. Optionally archive or remove configuration and state",
		"## 6. Retain or archive patches",
	].map((heading) => uninstall.indexOf(heading));

	assert.ok(ordered.every((index) => index >= 0));
	assert.deepEqual(
		ordered,
		[...ordered].sort((left, right) => left - right),
	);
	assert.match(uninstall, /sbx ls/);
	assert.match(uninstall, /pi-dsbx export --name NAME/);
	assert.match(uninstall, /pi-dsbx destroy --name NAME/);
	assert.match(uninstall, /pi remove npm:pi-docker-sandboxes/);
	assert.match(
		uninstall,
		/docker image rm docker\.io\/pi-docker-sandboxes\/pi:/,
	);
	assert.match(uninstall, /~\/\.pi\/agent\/docker-sandboxes\.json/);
	assert.match(uninstall, /\.pi\/docker-sandboxes\.json/);
	assert.match(uninstall, /\.git\/pi-docker-sandbox\/state/);
	assert.match(uninstall, /\.git\/pi-docker-sandbox\/patches/);
	assert.match(uninstall, /dry run/i);
	assert.match(uninstall, /back(?:up|ed up)/i);
	assert.match(uninstall, /Do not delete[\s\S]*patch/i);
});

test("support and security policies state the Early Access boundary", async () => {
	const [support, security, compatibility] = await Promise.all([
		read("SUPPORT.md"),
		read("SECURITY.md"),
		read("COMPATIBILITY.md"),
	]);

	assert.match(support, /macOS ARM64/);
	assert.match(support, /latest `0\.1\.x`/);
	assert.match(
		support,
		/Linux and Windows reports are welcome but unsupported/i,
	);
	assert.match(support, /no (?:response-time )?SLA/i);
	assert.match(
		support,
		/https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/issues\/new\?template=bug\.yml/,
	);
	assert.match(
		support,
		/https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/issues\/new\?template=question\.yml/,
	);
	assert.match(compatibility, /macOS 26\.5\.2 \/ Apple Silicon/);
	assert.match(
		compatibility,
		/does not (?:establish|imply) support[^\n]*other macOS releases/i,
	);
	assert.match(
		security,
		/https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/security\/advisories\/new/,
	);
	assert.match(security, /Do not open a public issue/i);
	assert.doesNotMatch(security, /(?:security|vulnerability)[-\w.]*@[-\w.]+/i);
});

test("community files define contribution, conduct, and governance", async () => {
	const [contributing, conduct, governance, codeowners] = await Promise.all([
		read("CONTRIBUTING.md"),
		read("CODE_OF_CONDUCT.md"),
		read("GOVERNANCE.md"),
		read(".github/CODEOWNERS"),
	]);

	for (const requirement of [
		/Node(?:\.js)? `>=24\.12\.0 <25`/,
		/Pi 0\.84\.1/,
		/Docker Sandboxes (?:\(`sbx`\) )?0\.38\.x/,
		/npm ci --ignore-scripts/,
		/npm run check/,
		/npm run test:e2e/,
		/test-driven development|TDD/i,
		/security boundar/i,
		/Signed-off-by/,
		/no CLA/i,
	])
		assert.match(contributing, requirement);
	assert.match(
		contributing,
		/https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/security\/advisories\/new/,
	);

	assert.match(conduct, /Contributor Covenant Code of Conduct/);
	assert.match(conduct, /version 2\.1/);
	assert.match(conduct, /@gurkanguray/);
	assert.match(conduct, /private vulnerability reporting/i);
	assert.doesNotMatch(conduct, /[-\w.]+@[-\w.]+/);

	assert.match(governance, /Guray Gurkan.*project maintainer/i);
	assert.match(governance, /release approver/i);
	assert.match(governance, /issues and pull requests/i);
	assert.match(
		governance,
		/security.*breaking boundary changes.*maintainer approval/is,
	);
	assert.match(governance, /no promise of permanent.*benevolent dictator/i);

	for (const rule of [
		/^\* @gurkanguray$/m,
		/^\/\.github\/workflows\/ @gurkanguray$/m,
		/^\/docker\/ @gurkanguray$/m,
		/^\/SECURITY\.md @gurkanguray$/m,
		/^\/THREAT_MODEL\.md @gurkanguray$/m,
		/^\/src\/ @gurkanguray$/m,
	])
		assert.match(codeowners, rule);
});

test("README links to the contribution guide", async () => {
	assert.match(await read("README.md"), /\[Contributing\]\(CONTRIBUTING\.md\)/);
});

test("issue forms match pinned GitHub schemas", async () => {
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
		[".github/ISSUE_TEMPLATE/unsupported-platform.yml", validateForm],
	] as const;

	for (const [path, validate] of templates) {
		const yaml = await read(path);
		let value: unknown;
		assert.doesNotThrow(() => {
			value = parse(yaml, { strict: true, uniqueKeys: true });
		}, `${path}: invalid YAML`);
		assert.ok(validate(value), `${path}: ${ajv.errorsText(validate.errors)}`);
	}
});

test("issue form validation fails closed", async () => {
	assert.throws(
		() => parse("name: first\nname: duplicate\n", { uniqueKeys: true }),
		/Map keys must be unique/,
	);

	const ajv = new Ajv({ allErrors: true, strict: true });
	const validate = ajv.compile(
		await schema("test/schema/github-issue-forms.json"),
	);
	const malformed = parse(`
name: Invalid form
description: Missing required body
body: []
`);
	assert.equal(validate(malformed), false);
	assert.ok(validate.errors?.length);
});

test("issue forms provide structured public and private intake", async () => {
	const [config, bug, question, feature, unsupported] = await Promise.all([
		read(".github/ISSUE_TEMPLATE/config.yml"),
		read(".github/ISSUE_TEMPLATE/bug.yml"),
		read(".github/ISSUE_TEMPLATE/question.yml"),
		read(".github/ISSUE_TEMPLATE/feature.yml"),
		read(".github/ISSUE_TEMPLATE/unsupported-platform.yml"),
	]);

	assert.match(config, /^blank_issues_enabled: false$/m);
	assert.match(
		config,
		/https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/security\/advisories\/new/,
	);
	assert.match(config, /private (?:vulnerability |security )?report/i);

	for (const id of [
		"package_version",
		"pi_version",
		"node_version",
		"sbx_version",
		"macos_version",
		"architecture",
		"reproduction",
		"expected",
		"actual",
		"doctor",
	])
		assert.match(
			bug,
			new RegExp(
				`^  - type: [^\\n]+\\n(?:    [^\\n]*\\n)*    id: ${id}\\n[\\s\\S]*?^    validations:\\n      required: true$`,
				"m",
			),
			`${id} must be required`,
		);
	assert.match(bug, /pi-dsbx doctor/);
	assert.match(
		bug,
		/id: redaction[\s\S]*?options:[\s\S]*?required: true/,
		"redaction confirmation must be required",
	);
	assert.match(bug, /reviewed and redacted/i);
	assert.match(bug, /do not include[\s\S]*raw environment dumps/i);
	assert.doesNotMatch(
		bug,
		/paste (?:your )?(?:raw )?(?:environment|credentials)/i,
	);
	const macosField =
		bug.match(/id: macos_version[\s\S]*?(?=^ {2}- type:)/m)?.[0] ?? "";
	assert.match(macosField, /placeholder: ["']26\.5\.2["']/);
	assert.match(
		macosField,
		/other macOS\s+versions[\s\S]*?unsupported-platform form/i,
	);
	assert.match(macosField, /reports? (?:are )?welcome/i);

	assert.match(question, /supported platform boundary/i);
	assert.match(question, /do not include[^\n]*(?:credentials|secrets)/i);
	assert.match(question, /private source/i);
	for (const id of [
		"supported_area",
		"package_version",
		"question",
		"redaction",
	])
		assert.match(question, new RegExp(`id: ${id}`));
	assert.doesNotMatch(question, /id: (?:doctor|diagnostics|logs|environment)/i);

	assert.match(feature, /security boundar/i);
	assert.match(unsupported, /unsupported/i);
	assert.match(
		unsupported,
		/does not\s+(?:imply|establish|guarantee) support/i,
	);
	assert.doesNotMatch(unsupported, /(?:will|plan to) support/i);
});

test("pull request template covers quality and release boundaries", async () => {
	const template = await read(".github/pull_request_template.md");

	for (const requirement of [
		/tests?/i,
		/E2E.*(?:relevant|required|not required)/i,
		/docs|documentation/i,
		/security boundar/i,
		/data (?:preservation|loss)/i,
		/changelog/i,
		/no (?:secrets|credentials)/i,
	])
		assert.match(template, requirement);
});

test("release instructions bind dispatch to the signed tag on main", async () => {
	const [release, settings] = await Promise.all([
		read("RELEASE.md"),
		read("docs/repository-settings.md"),
	]);

	const dispatch =
		'gh workflow run release-candidate.yml --ref "$TAG" -f tag="$TAG"';
	for (const document of [release, settings]) {
		assert.ok(document.includes(dispatch));
		assert.match(document, /workflow ref and tag input must be identical/i);
		assert.match(
			document,
			/tag commit[^\r\n]*ancestor of[^\r\n]*origin\/main/i,
		);
		assert.doesNotMatch(document, /select the exact signed tag/i);
	}
});

test("repository settings record partial verification without overstating readiness", async () => {
	const settings = await read("docs/repository-settings.md");

	assert.match(settings, /Current status: Partially verified/i);
	assert.match(settings, /2026-08-15/);
	assert.match(settings, /Owner: `gurkanguray`/);
	assert.match(
		settings,
		/https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/issues\/8/,
	);
	assert.match(
		settings,
		/https:\/\/gurkanguray\.github\.io\/pi-docker-sandboxes\//,
	);
	assert.match(settings, /build_type: `workflow`/);
	assert.match(settings, /no candidate content (?:has been|was) deployed/i);
	assert.match(settings, /required status (?:check )?contexts[^\n]*pending/i);
	assert.match(settings, /npm trusted publisher[^\n]*pending/i);
	assert.match(settings, /self-hosted (?:release )?runner[^\n]*pending/i);
	assert.match(settings, /signing key[^\n]*pending/i);
	assert.match(settings, /signed tag[^\n]*pending/i);
	assert.match(settings, /hosted receipts[^\n]*pending/i);
	assert.match(settings, /publication[^\n]*pending/i);
	assert.doesNotMatch(settings, /Current status: (?:Ready|Fully verified)/i);
});

test("dependency updates follow the conservative review policy", async () => {
	const config = parse(await read(".github/dependabot.yml"), {
		strict: true,
		uniqueKeys: true,
	}) as {
		version: number;
		updates: Array<Record<string, unknown>>;
	};
	const updates = new Map(
		config.updates.map((update) => [update["package-ecosystem"], update]),
	);

	assert.equal(config.version, 2);
	assert.deepEqual([...updates.keys()].sort(), ["github-actions", "npm"]);
	for (const update of updates.values()) {
		assert.deepEqual(update.schedule, { interval: "weekly" });
		assert.ok(
			typeof update["open-pull-requests-limit"] === "number" &&
				update["open-pull-requests-limit"] > 0,
		);
		assert.ok(Array.isArray(update.labels) && update.labels.length > 0);
	}

	const npm = updates.get("npm")!;
	assert.deepEqual(npm.groups, {
		"development-tools": {
			"dependency-type": "development",
			"exclude-patterns": ["@earendil-works/*"],
		},
	});

	const policy = `${await read("CONTRIBUTING.md")}\n${await read("RELEASE.md")}`;
	assert.match(policy, /unit[\s\S]*package checks/i);
	assert.match(
		policy,
		/real macOS E2E[\s\S]*(?:Pi|`Pi`)[\s\S]*`sbx`[\s\S]*Docker base[\s\S]*image tool[\s\S]*security boundar/i,
	);
	assert.match(
		policy,
		/Pi peer compatibility[\s\S]*must not be widened[\s\S]*review/i,
	);
	assert.match(policy, /Action updates[\s\S]*SHA pins[\s\S]*version comments/i);
});

test("every relative Markdown link resolves", async () => {
	for (const document of documents) {
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
