import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflows = new URL("../.github/workflows/", import.meta.url);

type Step = {
	id?: string;
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
};
type Job = {
	environment?: { name?: string; url?: string };
	needs?: string[];
	permissions?: Record<string, string>;
	steps?: Step[];
	uses?: string;
	with?: Record<string, unknown>;
};
type Workflow = { jobs: Record<string, Job> };

test("release workflows are valid npm-only gates", async () => {
	const names = (await readdir(workflows)).filter((name) =>
		name.endsWith(".yml"),
	);
	const parsed = new Map<string, Workflow>();
	for (const name of names) {
		const workflow = parse(
			await readFile(new URL(name, workflows), "utf8"),
		) as Workflow;
		assert.ok(workflow.jobs, name);
		parsed.set(name, workflow);
	}

	const docs = parsed.get("docs.yml")!;
	assert.ok(docs, "docs.yml");
	assert.deepEqual(docs.jobs.build.permissions, { contents: "read" });
	assert.deepEqual(docs.jobs.deploy.permissions, {
		pages: "write",
		"id-token": "write",
	});
	assert.deepEqual(docs.jobs.deploy.needs, ["build"]);
	assert.equal(docs.jobs.deploy.environment?.name, "github-pages");

	const docsText = await readFile(new URL("docs.yml", workflows), "utf8");
	assert.match(docsText, /node-version:\s*24\.12\.0/);
	assert.match(docsText, /npm ci --ignore-scripts/);
	assert.match(docsText, /npm run docs:build/);
	assert.match(docsText, /path:\s*docs\/\.vitepress\/dist/);
	assert.doesNotMatch(
		docsText,
		/npm publish|docker\/build-push-action|packages:\s*write/,
	);
	for (const action of docsText.matchAll(/uses:\s*([^\s]+)@([^\s]+)/g))
		assert.match(
			action[2]!,
			/^[0-9a-f]{40}$/,
			`${action[1]} must be SHA-pinned`,
		);

	const releaseText = await readFile(
		new URL("release-candidate.yml", workflows),
		"utf8",
	);
	const release = parsed.get("release-candidate.yml")!;
	assert.equal(release.jobs.security.permissions?.["security-events"], "write");
	assert.deepEqual(release.jobs["publish-npm"].needs, ["metadata", "receipt"]);
	assert.equal(release.jobs["publish-npm"].permissions?.["id-token"], "write");
	assert.equal(
		release.jobs["publish-npm"].with?.package_artifact,
		"npm-package-${{ needs.metadata.outputs.sha }}",
	);
	assert.match(releaseText, /fresh-install-receipt\.json/);
	assert.match(releaseText, /freshInstallReceipt/);
	assert.match(releaseText, /RUNNER_TEMP\/npm-package/);
	const sourceRun = release.jobs.metadata.steps?.find(
		(step) => step.id === "source",
	)?.run;
	assert.ok(sourceRun, "metadata source step must be executable");
	const sourceChecks = [
		'sha="$(git rev-list -n 1 "$TAG")"',
		'git fetch --force origin "refs/heads/main:refs/remotes/origin/main"',
		'git merge-base --is-ancestor "$sha" refs/remotes/origin/main',
		'test "$GITHUB_REF" = "refs/tags/$TAG"',
		'test "$GITHUB_SHA" = "$sha"',
	];
	const sourceOutput = sourceRun.indexOf('echo "sha=$sha" >> "$GITHUB_OUTPUT"');
	assert.ok(sourceOutput >= 0, "source step must emit its verified SHA");
	assert.match(sourceRun, /release versions must not be prereleases/);
	let previousCheck = -1;
	for (const check of sourceChecks) {
		const index = sourceRun.indexOf(check);
		assert.ok(index > previousCheck, `${check} must be ordered in source step`);
		assert.ok(index < sourceOutput, `${check} must precede source outputs`);
		previousCheck = index;
	}
	assert.doesNotMatch(releaseText, /packages: write|ghcr\.io|publish-image/);
	await assert.rejects(access(new URL("publish-image.yml", workflows)));

	const e2e = await readFile(new URL("e2e.yml", workflows), "utf8");
	assert.match(e2e, /expected_artifact="oci-candidate-\$SOURCE_SHA"/);
	assert.match(e2e, /image-verification\.json/);
	assert.match(e2e, /PI_DOCKER_SANDBOX_E2E_TEMPLATE_STORE_ID/);
	const imageRun = parsed
		.get("e2e.yml")!
		.jobs["macos-arm64"]!.steps?.find(
			(step) => step.name === "Load and bind the exact OCI candidate",
		)?.run;
	assert.ok(imageRun, "E2E image binding step must be executable");
	assert.match(
		imageRun,
		/const matches = \(templates\.images \?\? \[\]\)\.filter\(/,
	);
	assert.match(imageRun, /if \(matches\.length !== 1\) process\.exit\(1\);/);
	assert.match(imageRun, /console\.log\(matches\[0\]\.id\);/);
	assert.doesNotMatch(imageRun, /templates\.images\?\.find\(/);
	const security = await readFile(new URL("security.yml", workflows), "utf8");
	assert.match(security, /expected_artifact="oci-candidate-\$SOURCE_SHA"/);
	const publish = await readFile(new URL("publish-npm.yml", workflows), "utf8");
	assert.match(publish, /freshInstallReceipt\?\.sourceSha/);
	const publishSteps = parsed.get("publish-npm.yml")!.jobs.publish.steps ?? [];
	const verifyIndex = publishSteps.findIndex(
		(step) =>
			step.name === "Verify protected candidate receipt and npm configuration",
	);
	const npmPublishIndex = publishSteps.findIndex((step) =>
		step.run?.startsWith('npm publish "$tarball"'),
	);
	assert.ok(verifyIndex >= 0, "publish workflow must have a verification step");
	assert.ok(npmPublishIndex > verifyIndex, "verification must precede publish");
	assert.equal(
		publishSteps[npmPublishIndex]!.run,
		'npm publish "$tarball" --provenance --access public --tag latest',
	);
	const verifyRun = publishSteps[verifyIndex]!.run;
	assert.ok(verifyRun, "publish verification step must be executable");
	for (const check of [
		'test "$GITHUB_REF" = "refs/tags/$TAG"',
		'test "$GITHUB_SHA" = "$SOURCE_SHA"',
		"verification.binVersion !== pkg.version",
		"receipt.version !== pkg.version",
		"receipt.tag !== `v${pkg.version}`",
		"receipt.freshInstallReceipt?.version !== pkg.version",
		"receipt.e2eReceipt?.packageVersion !== pkg.version",
	])
		assert.ok(
			verifyRun.includes(check),
			`${check} must be enforced by publish verification`,
		);

	const receiptRun = release.jobs.receipt.steps?.find(
		(step) => step.name === "Join and verify candidate evidence",
	)?.run;
	assert.ok(receiptRun, "candidate receipt join must be executable");
	for (const check of [
		"packageReceipt.binVersion !== expected.VERSION",
		"freshInstallReceipt.version !== expected.VERSION",
		"e2eReceipt.packageVersion !== expected.VERSION",
	])
		assert.ok(
			receiptRun.includes(check),
			`${check} must bind candidate version evidence`,
		);

	const publication = release.jobs["verify-publication"];
	assert.deepEqual(publication.needs, ["metadata", "publish-npm"]);
	const publicationRun = publication.steps?.find(
		(step) => step.name === "Verify npm and Pi package gallery availability",
	)?.run;
	assert.ok(publicationRun, "publication verification must be executable");
	assert.match(publicationRun, /npm view "pi-docker-sandboxes" version/);
	assert.match(publicationRun, /npm install[^\n]*"pi-docker-sandboxes"/);
	assert.match(
		publicationRun,
		/https:\/\/pi\.dev\/packages\/pi-docker-sandboxes/,
	);
	assert.match(publicationRun, /grep -F "\$VERSION"/);

	for (const [name, workflow] of parsed)
		for (const job of Object.values(workflow.jobs))
			for (const step of job.steps ?? [])
				if (step.uses?.startsWith("docker/build-push-action@"))
					assert.equal(step.with?.push, false, `${name} must not push images`);

	const ci = await readFile(new URL("ci.yml", workflows), "utf8");
	assert.match(
		ci,
		/go run github\.com\/rhysd\/actionlint\/cmd\/actionlint@v1\.7\.7/,
	);

	const pkg = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
	assert.ok(pkg.keywords.includes("pi-package"));
	assert.deepEqual(pkg.pi.extensions, [
		"./extensions/docker-sandboxes/index.ts",
	]);
	assert.equal(pkg.engines.node, ">=24.12.0 <25");
});
