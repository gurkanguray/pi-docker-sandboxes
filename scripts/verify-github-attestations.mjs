#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
	throw new Error(message);
}

function repository(value) {
	return String(value ?? "")
		.replace(/^git\+/, "")
		.replace(/\.git$/, "")
		.replace(/^git:\/\//, "https://")
		.replace(/^https:\/\/github\.com\//, "")
		.toLowerCase();
}

function statements(document) {
	const entries = Array.isArray(document) ? document : [document];
	const result = entries
		.map((entry) => entry?.verificationResult?.statement ?? entry?.statement)
		.filter(Boolean);
	if (result.length === 0) fail("GitHub verification returned no statements");
	return result;
}

export function verifyGithubAttestations({
	documents,
	expectedRepository,
	expectedSourceSha,
	expectedRunId,
	expectedRunAttempt,
	expectedWorkflow,
}) {
	const expectedRepo = repository(expectedRepository);
	const expectedInvocation =
		`/actions/runs/${expectedRunId}/attempts/${expectedRunAttempt}`;
	const subjects = new Map();
	for (const document of documents) {
		for (const statement of statements(document)) {
			if (statement?._type !== "https://in-toto.io/Statement/v1" ||
				statement?.predicateType !== "https://slsa.dev/provenance/v1")
				fail("GitHub attestation statement type is invalid");
			const predicate = statement.predicate;
			const definition = predicate?.buildDefinition;
			const workflow = definition?.externalParameters?.workflow;
			if (repository(workflow?.repository) !== expectedRepo ||
				workflow?.path !== expectedWorkflow)
				fail("GitHub attestation does not bind the runtime workflow/repository");
			const source = (definition?.resolvedDependencies ?? []).find(
				(item) => item?.digest?.gitCommit === expectedSourceSha,
			);
			if (!source || repository(String(source.uri).split("@")[0]) !== expectedRepo)
				fail("GitHub attestation does not bind the locked source SHA");
			const invocation = predicate?.runDetails?.metadata?.invocationId;
			if (typeof invocation !== "string" || !invocation.endsWith(expectedInvocation))
				fail("GitHub attestation does not bind the locked workflow run");
			const builder = predicate?.runDetails?.builder?.id;
			if (typeof builder !== "string" ||
				!builder.includes(`/${expectedRepo}/${expectedWorkflow}@`))
				fail("GitHub attestation builder identity is invalid");
			for (const subject of statement.subject ?? []) {
				const digest = subject?.digest?.sha256;
				if (typeof subject?.name !== "string" ||
					!/^[-./:@A-Za-z0-9_]+$/.test(subject.name) ||
					!/^[0-9a-f]{64}$/.test(digest ?? ""))
					fail("GitHub attestation subject is invalid");
				subjects.set(`${subject.name}\0${digest}`, {
					name: basename(subject.name),
					sha256: digest,
				});
			}
		}
	}
	if (subjects.size === 0) fail("GitHub attestations contain no subjects");
	return {
		verified: true,
		repository: expectedRepo,
		workflow: expectedWorkflow,
		sourceSha: expectedSourceSha,
		runId: Number(expectedRunId),
		runAttempt: Number(expectedRunAttempt),
		subjects: [...subjects.values()].sort((left, right) =>
			left.name.localeCompare(right.name) || left.sha256.localeCompare(right.sha256),
		),
	};
}

async function main() {
	const [lockPath, outputPath, ...documentPaths] = process.argv.slice(2);
	if (!lockPath || !outputPath || documentPaths.length === 0)
		fail("Usage: verify-github-attestations <lock> <output> <verification JSON...>");
	const lock = JSON.parse(await readFile(resolve(lockPath), "utf8"));
	const documents = await Promise.all(
		documentPaths.map(async (path) =>
			JSON.parse(await readFile(resolve(path), "utf8"))),
	);
	const result = verifyGithubAttestations({
		documents,
		expectedRepository: process.env.GITHUB_REPOSITORY,
		expectedSourceSha: lock.sourceSha,
		expectedRunId: lock.runId,
		expectedRunAttempt: lock.runAttempt,
		expectedWorkflow: ".github/workflows/runtime-image.yml",
	});
	await writeFile(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	main().catch((error) => {
		console.error(
			`GitHub attestation verification failed: ${error instanceof Error ? error.message : error}`,
		);
		process.exitCode = 1;
	});
