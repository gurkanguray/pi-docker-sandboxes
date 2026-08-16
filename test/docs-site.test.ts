import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");
const repository = "https://github.com/gurkanguray/pi-docker-sandboxes";

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

test("documentation site uses the repository base and local search", async () => {
	const config = await read("docs/.vitepress/config.mts");
	assert.match(config, /base:\s*["']\/pi-docker-sandboxes\/["']/);
	assert.match(config, /search:\s*\{\s*provider:\s*["']local["']/s);
	assert.match(
		config,
		/const repository = ["']https:\/\/github\.com\/gurkanguray\/pi-docker-sandboxes["']/,
	);
	const nav = config.match(/nav:\s*(\[[\s\S]*?\]),\s*sidebar:/)?.[1] ?? "";
	for (const group of ["Guide", "Operations", "Community", "Maintainers"])
		assert.match(nav, new RegExp(`text: ["']${group}["'],\\s*items:`));
	for (const document of ["SUPPORT.md", "SECURITY.md", "CONTRIBUTING.md"])
		assert.match(
			nav,
			new RegExp(
				`link: ["']https://github\\.com/gurkanguray/pi-docker-sandboxes/blob/main/${document.replace(".", "\\.")}["']`,
			),
		);
	await assertLinksResolve(config);
});

test("documentation site excludes internal planning artifacts", async () => {
	const config = await read("docs/.vitepress/config.mts");
	assert.match(config, /srcExclude:\s*\[\s*["']superpowers\/\*\*["']\s*\]/s);
});

test("documentation home links to install, onboarding, and the project", async () => {
	const home = await read("docs/index.md");
	assert.match(home, /layout:\s*home/);
	assert.match(home, /link:\s*\/getting-started#install-and-diagnose/);
	assert.match(home, /link:\s*\/getting-started(?:\s|$)/);
	assert.match(home, /github\.com\/gurkanguray\/pi-docker-sandboxes/);
	assert.match(home, /tested on macOS 26\.5\.2[^\n]*Apple Silicon/i);
	assert.match(
		home,
		/other macOS releases[^\n]*(?:not yet validated|not supported|unsupported)/i,
	);
	for (const version of [
		/Pi 0\.84\.1/,
		/Node\.js 24\.12\.0/,
		/Docker Engine 29\.7\.1/,
		/Docker Sandboxes \(`sbx`\) 0\.38\.0/,
	])
		assert.match(home, version);
	assert.match(home, /Linux[^\n]*Windows[^\n]*(?:not supported|unsupported)/i);
	await assertLinksResolve(home);
});

test("documentation commands are source-checkout-only", async () => {
	const pkg = JSON.parse(await read("package.json"));
	assert.equal(pkg.devDependencies.vitepress, "1.6.4");
	for (const name of ["docs:dev", "docs:build"])
		assert.match(pkg.scripts[name], /^test -f \.source-checkout/);
});
