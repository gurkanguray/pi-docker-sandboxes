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
	"RELEASE.md",
	"docs/getting-started.md",
	"docs/cli-reference.md",
	"docs/configuration.md",
	"docs/troubleshooting.md",
	"docs/uninstall.md",
] as const;

async function read(path: string): Promise<string> {
	return readFile(resolve(path), "utf8");
}

async function schema(path: string): Promise<object> {
	return JSON.parse(await read(path)) as object;
}

test("README gives a concise path into the product documentation", async () => {
	const readme = await read("README.md");
	const top = readme.split("\n").slice(0, 12).join("\n");

	assert.doesNotMatch(top, /tested on macOS|other macOS releases|Linux|Windows/i);
	assert.match(readme, /pi-dsbx image build/);
	assert.match(readme, /pi --docker-sandbox/);
	assert.match(readme, /if[^\n]*repository[^\n]*has no commits/i);
	assert.match(
		readme,
		/git commit --allow-empty --only -m ["']Initial commit["']/,
	);
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
});

test("CLI reference stays aligned with the CLI and extension", async () => {
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
	const extensionFlags = [...extension.matchAll(/registerFlag\("([^"]+)"/g)].map(
		([, flag]) => `--${flag}`,
	);
	for (const flag of extensionFlags)
		assert.ok(reference.includes("`" + flag + "`"), flag);
	for (const command of ["status", "doctor", "config"])
		assert.ok(
			reference.includes("`/docker-sandbox " + command + "`"),
			command,
		);

	assert.match(
		reference,
		new RegExp(
			"`--sync`[^\\n]*`" +
				DEFAULT_CONFIG.syncProfile +
				"` \\(default\\)[^\\n]*`clean`[^\\n]*`mirror`",
		),
	);
	assert.match(reference, /`--image`[^\n]*immutable[^\n]*digest/i);
	assert.doesNotMatch(reference, /`--image`[^\n]*local content tag/i);
	assert.match(reference, /`--fresh`[^\n]*cannot[^\n]*`--name`/i);
	assert.match(reference, /`--discard-changes`[^\n]*noninteractive/i);
	assert.match(
		reference,
		/interactive confirmation[^\n]*(?:changed|uninspectable)[^\n]*(?:remove|discard|destroy)/i,
	);
	assert.match(reference, /`pi-dsbx`[^\n]*same as `pi-dsbx run`/i);
	assert.match(reference, /`pi-dsbx status`[^\n]*on the host[^\n]*list/i);
	assert.match(
		reference,
		/pi --docker-sandbox --docker-sandbox-session (?:ID|SESSION_ID)/,
	);
	assert.match(reference, /host `--session`[^\r\n]*unsupported/i);
	assert.match(reference, /\/resume/);
	assert.match(reference, /--keep[^\r\n]*same sandbox/i);
	assert.match(reference, /pi-dsbx run[^\n]*-- --session (?:ID|SESSION_ID)/);
	assert.doesNotMatch(
		reference,
		/`pi-dsbx image build`[^\n]*accepts no flags/i,
	);
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
});

test("getting started separates compatibility from release validation", async () => {
	const [gettingStarted, packageJson] = await Promise.all([
		read("docs/getting-started.md"),
		read("package.json").then(JSON.parse),
	]);
	const ordered = [
		"## Requirements",
		"## Install after release",
		"## Build the image",
		"## Run",
		"## Keep your work",
		"## Next steps",
	].map((heading) => gettingStarted.indexOf(heading));
	assert.ok(ordered.every((index) => index >= 0));
	assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));
	for (const value of [
		packageJson.engines.node,
		packageJson.peerDependencies["@earendil-works/pi-coding-agent"],
	])
		assert.ok(gettingStarted.includes(value), value);
	assert.match(gettingStarted, /macOS 14\+[^\r\n]*Apple silicon/i);
	assert.match(gettingStarted, /Ubuntu 24\.04\+[^\r\n]*(?:ARM64|Arm64)/i);
	assert.match(gettingStarted, /macOS 26\.5\.2[^\r\n]*(?:validated|tested)/i);
	assert.doesNotMatch(
		gettingStarted,
		/other macOS releases[^\n]*unsupported|Linux[^\n]*unsupported/i,
	);
	assert.match(gettingStarted, /if[^\n]*repository[^\n]*has no commits/i);
	assert.match(
		gettingStarted,
		/git commit --allow-empty --only -m ["']Initial commit["']/,
	);
	assert.match(gettingStarted, /eligible host credentials[^\n]*sync/i);
	assert.match(gettingStarted, /--docker-sandbox-no-host-auth/);
	assert.match(gettingStarted, /sandbox-local `?\/login`?[^\n]*unsupported/i);
	assert.match(gettingStarted, /accept[^\n]*exit prompt[^\n]*export/i);
	assert.match(gettingStarted, /accept[^\n]*\.git\/pi-docker-sandbox\/patches\//i);
	assert.match(gettingStarted, /decline[^\n]*export[^\n]*later/i);
	assert.doesNotMatch(gettingStarted, /printed patch/i);
	assert.doesNotMatch(gettingStarted, /pi-dsbx: checking Docker Sandboxes/);
});

test("configuration explains every user-facing choice", async () => {
	const configuration = await read("docs/configuration.md");
	for (const choice of [
		/development[^\n]*network/i,
		/hardened[^\n]*network/i,
		/clean[^\n]*(?:nothing|minimal)/i,
		/custom[^\n]*settings[^\n]*models/i,
		/mirror[^\n]*packages[^\n]*skills/i,
		/anthropic[^\n]*google[^\n]*openai[^\n]*openrouter[^\n]*xai/i,
	])
		assert.match(configuration, choice);
});

test("README links to product and policy documentation", async () => {
	const readme = await read("README.md");

	for (const [text, target] of [
		["Get started", "getting-started"],
		["CLI reference", "cli-reference"],
		["Configuration", "configuration"],
		["Troubleshooting", "troubleshooting"],
	] as const)
		assert.match(
			readme,
			new RegExp(
				`\\[${text}\\]\\(https://gurkanguray\\.github\\.io/pi-docker-sandboxes/${target}\\)`,
				"i",
			),
		);
	for (const [text, target] of [
		["Compatibility", "COMPATIBILITY.md"],
		["Support", "SUPPORT.md"],
		["Security", "SECURITY.md"],
		["Contributing", "CONTRIBUTING.md"],
	] as const)
		assert.ok(readme.includes(`[${text}](${target})`));
	assert.doesNotMatch(readme, /Migration|docs\/migration\.md/);
});

test("troubleshooting puts common fixes before work recovery", async () => {
	const troubleshooting = await read("docs/troubleshooting.md");
	const common = troubleshooting.indexOf("## Common fixes");
	const recovery = troubleshooting.indexOf("## Recover your work");
	assert.ok(common >= 0 && recovery > common);

	assert.match(troubleshooting, /pi-dsbx doctor/);
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

test("uninstall preserves data and follows the safe removal order", async () => {
	const uninstall = await read("docs/uninstall.md");
	const ordered = [
		"## 1. Export wanted work",
		"## 2. Remove sandboxes",
		"## 3. Remove the package",
		"## 4. Optional cleanup",
	].map((heading) => uninstall.indexOf(heading));

	assert.ok(ordered.every((index) => index >= 0));
	assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));
	assert.match(uninstall, /sbx ls/);
	assert.match(uninstall, /pi-dsbx export --name NAME/);
	assert.match(uninstall, /pi-dsbx destroy --name NAME/);
	assert.match(uninstall, /--discard-changes/);
	assert.match(uninstall, /pi remove npm:pi-docker-sandboxes/);
	assert.match(
		uninstall,
		/docker image rm docker\.io\/pi-docker-sandboxes\/pi:/,
	);
	assert.match(uninstall, /~\/\.pi\/agent\/docker-sandboxes\.json/);
	assert.match(uninstall, /\.pi\/docker-sandboxes\.json/);
	assert.match(uninstall, /\.git\/pi-docker-sandbox\/(?:state|patches)/);
	assert.match(uninstall, /configuration[^\n]*state[^\n]*remove[^\n]*after[^\n]*sandbox/i);
	assert.match(uninstall, /patch[^\n]*(?:keep|retain|preserve)/i);
});

test("support, compatibility, and security each have one job", async () => {
	const [support, security, compatibility, packageJson] = await Promise.all([
		read("SUPPORT.md"),
		read("SECURITY.md"),
		read("COMPATIBILITY.md"),
		read("package.json").then(JSON.parse),
	]);

	assert.match(support, /\[Compatibility\]\(COMPATIBILITY\.md\)/);
	assert.match(support, /no (?:response-time )?SLA/i);
	assert.match(
		support,
		/https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/issues\/new\?template=bug\.yml/,
	);
	assert.match(
		support,
		/https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/issues\/new\?template=question\.yml/,
	);
	assert.match(support, /template=platform\.yml/);
	assert.doesNotMatch(support, /unsupported platform/i);
	assert.doesNotMatch(support, /26\.5\.2|Linux and Windows/i);

	for (const heading of [
		"## Package requirements",
		"## Supported hosts",
		"## Release validation",
		"## Known limitations",
	])
		assert.ok(compatibility.includes(heading), heading);
	for (const value of [
		packageJson.engines.node,
		packageJson.peerDependencies["@earendil-works/pi-coding-agent"],
	])
		assert.ok(compatibility.includes(value), value);
	for (const requirement of [
		/macOS 14\+[^\r\n]*Apple Silicon[^\r\n]*supported/i,
		/Ubuntu 24\.04\+[^\r\n]*(?:ARM64|Arm64)[^\r\n]*supported/i,
		/macOS 26\.5\.2[^\r\n]*(?:validated|tested)/i,
		/Docker Sandboxes[^\r\n]*0\.38\.x/i,
		/Windows 11[^\r\n]*(?:current package|package currently)[^\r\n]*incompatible/i,
		/(?:x64|amd64)[^\r\n]*`linux\/arm64`/i,
	])
		assert.match(compatibility, requirement);
	assert.doesNotMatch(
		compatibility,
		/other macOS releases[^\n]*unsupported|Linux (?:is )?unsupported|Windows (?:is )?unsupported/i,
	);

	assert.match(
		security,
		/https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/security\/advisories\/new/,
	);
	assert.match(security, /Do not open a public issue/i);
	assert.match(security, /\[threat model\]\(THREAT_MODEL\.md\)/i);
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
		/Pi `?>=0\.84\.1 <0\.85\.0`?/,
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
	assert.match(conduct, /\[Code of Conduct\]/i);
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
		[".github/ISSUE_TEMPLATE/platform.yml", validateForm],
	] as const;
	await assert.rejects(access(".github/ISSUE_TEMPLATE/unsupported-platform.yml"));

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

test("issue forms accept every documented host status", async () => {
	const [config, bug, question, feature, platform] = await Promise.all([
		read(".github/ISSUE_TEMPLATE/config.yml"),
		read(".github/ISSUE_TEMPLATE/bug.yml"),
		read(".github/ISSUE_TEMPLATE/question.yml"),
		read(".github/ISSUE_TEMPLATE/feature.yml"),
		read(".github/ISSUE_TEMPLATE/platform.yml"),
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
		"host_os",
		"host_version",
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
	assert.doesNotMatch(bug, /macos_version|unsupported-platform/i);
	assert.match(bug, /OS name/i);
	assert.match(bug, /architecture/i);

	assert.doesNotMatch(question, /supported platform boundary/i);
	assert.match(question, /do not include[^\n]*(?:credentials|secrets)/i);
	assert.match(question, /private source/i);
	for (const id of [
		"documented_area",
		"package_version",
		"question",
		"redaction",
	])
		assert.match(question, new RegExp(`id: ${id}`));
	assert.doesNotMatch(question, /id: (?:doctor|diagnostics|logs|environment)/i);

	assert.match(feature, /security boundar/i);
	assert.match(platform, /Platform report/i);
	assert.match(platform, /upstream-supported|Docker Sandboxes/i);
	assert.match(platform, /`linux\/arm64`/i);
	assert.match(platform, /does not\s+(?:establish|guarantee)[^\n]*roadmap/i);
	assert.doesNotMatch(platform, /Linux[^\n]*unsupported|Windows[^\n]*unsupported/i);
});

test("diagnostics stay truthful", async () => {
	const [cli, troubleshooting, release] = await Promise.all([
		read("docs/cli-reference.md"),
		read("docs/troubleshooting.md"),
		read("RELEASE.md"),
	]);
	assert.doesNotMatch(
		cli,
		/`pi-dsbx doctor`[^\n]*(?:platform|tools|image)/i,
	);
	assert.doesNotMatch(troubleshooting, /sw_vers/);
	assert.match(troubleshooting, /process\.platform/);
	assert.match(troubleshooting, /process\.arch/);
	assert.match(
		release,
		/docs\/release-signing\.asc[^\n]*(?:missing|must be committed|before the first release)/i,
	);
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

test("release instructions bind dispatch and repository prerequisites", async () => {
	const release = await read("RELEASE.md");
	const dispatch =
		'gh workflow run release-candidate.yml --ref "$TAG" -f tag="$TAG"';
	assert.ok(release.includes(dispatch));
	assert.match(release, /workflow ref and tag input must be identical/i);
	assert.match(
		release,
		/tag commit[^\r\n]*ancestor of[^\r\n]*origin\/main/i,
	);
	assert.match(
		release,
		/https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes\/issues\/8/,
	);
	for (const prerequisite of [
		/Main Protection/i,
		/protected `release` environment/i,
		/signing key/i,
		/self-hosted runner/i,
		/npm trusted publish/i,
	])
		assert.match(release, prerequisite);
	const manualE2E =
		release.match(/For manual `workflow_dispatch`[\s\S]*?does not[\s\S]*?candidate\./i)?.[0] ?? "";
	for (const input of [
		"source_sha",
		"package_artifact",
		"image_artifact",
		"image_digest",
		"run_id",
	])
		assert.match(manualE2E, new RegExp("`" + input + "`"));
	assert.match(manualE2E, /image-verification\.json[^\n]*`ociDigest`/i);
	assert.doesNotMatch(release, /docs\/repository-settings\.md/);
	assert.doesNotMatch(release, /proved red locally|disposable `?\/tmp/i);
	assert.doesNotMatch(release, /select the exact signed tag/i);
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
