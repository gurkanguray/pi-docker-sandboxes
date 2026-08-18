import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");
const repository = "https://github.com/gurkanguray/pi-docker-sandboxes";

function proseWords(source: string): number {
	return (
		source
			.replace(/```[\s\S]*?```/g, "")
			.replace(/^\|.*$/gm, "")
			.match(/\b[\w'-]+\b/g)?.length ?? 0
	);
}

async function assertLinksResolve(source: string): Promise<void> {
	const links = [
		...source.matchAll(/\blink:\s*(?:["']([^"']+)["']|([^\s,}]+))/g),
	].map(([, quoted, bare]) =>
		bare === "repository" ? repository : (quoted ?? bare),
	);
	assert.ok(links.length > 0);
	for (const link of links) {
		if (link.startsWith("/")) {
			const route = link.slice(1).split("#", 1)[0] || "index";
			await assert.doesNotReject(access(`docs/${route}.md`), link);
		} else {
			assert.ok(
				link.startsWith(repository),
				`non-canonical external link: ${link}`,
			);
		}
	}
}

test("documentation site is a focused product guide", async () => {
	const config = await read("docs/.vitepress/config.mts");
	assert.match(config, /base:\s*["']\/pi-docker-sandboxes\/["']/);
	assert.match(config, /search:\s*\{\s*provider:\s*["']local["']/s);
	for (const [text, link] of [
		["Get Started", "/getting-started"],
		["CLI Reference", "/cli-reference"],
		["Configuration", "/configuration"],
		["Troubleshooting", "/troubleshooting"],
	] as const)
		assert.match(
			config,
			new RegExp(
				`text: ["']${text}["'],\\s*link: ["']${link.replace("/", "\\/")}["']`,
			),
		);
	for (const document of ["COMPATIBILITY.md", "SUPPORT.md", "SECURITY.md"])
		assert.match(
			config,
			new RegExp(
				`link: ["']https://github\\.com/gurkanguray/pi-docker-sandboxes/blob/main/${document.replace(".", "\\.")}["']`,
			),
		);
	assert.doesNotMatch(config, /Maintainers|Repository Settings|Migration/);
	await assert.rejects(access("docs/migration.md"));
	await assert.rejects(access("docs/repository-settings.md"));
	await assertLinksResolve(config);
});

test("documentation site excludes internal planning artifacts", async () => {
	const config = await read("docs/.vitepress/config.mts");
	assert.match(config, /srcExclude:\s*\[\s*["']superpowers\/\*\*["']\s*\]/s);
});

test("home leads with the product instead of support caveats", async () => {
	const home = await read("docs/index.md");
	assert.match(home, /layout:\s*home/);
	assert.match(home, /text:\s*Run Pi in an isolated workspace/);
	assert.match(home, /tagline:\s*Review changes before they reach your project\./);
	assert.match(home, /link:\s*\/getting-started(?:\s|$)/);
	assert.match(home, /github\.com\/gurkanguray\/pi-docker-sandboxes/);
	assert.doesNotMatch(home, /26\.5\.2|0\.84\.1|24\.12\.0|29\.7\.1|0\.38\.0/);
	assert.doesNotMatch(home, /other macOS releases|Linux|Windows/i);
	assert.ok(proseWords(home) <= 80, `${proseWords(home)} home words`);
	await assertLinksResolve(home);
});

test("public guides stay concise", async () => {
	const limits = {
		"README.md": 600,
		"SUPPORT.md": 250,
		"COMPATIBILITY.md": 250,
		"SECURITY.md": 250,
		"docs/index.md": 80,
		"docs/getting-started.md": 300,
		"docs/configuration.md": 420,
		"docs/troubleshooting.md": 500,
		"docs/uninstall.md": 300,
	} as const;
	for (const [path, limit] of Object.entries(limits)) {
		const words = proseWords(await read(path));
		assert.ok(words <= limit, `${path}: ${words} prose words (limit ${limit})`);
	}
});

test("documentation commands are source-checkout-only", async () => {
	const pkg = JSON.parse(await read("package.json"));
	assert.equal(pkg.devDependencies.vitepress, "1.6.4");
	for (const name of ["docs:dev", "docs:build"])
		assert.match(pkg.scripts[name], /^test -f \.source-checkout/);
});
