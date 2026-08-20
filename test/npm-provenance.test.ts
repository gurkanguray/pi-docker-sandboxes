import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @ts-expect-error The release verifier is plain JavaScript without declarations.
import { verifyNpmProvenance } from "../scripts/verify-npm-provenance.mjs";

const fixtures = new URL("fixtures/npm-provenance/", import.meta.url);
const repository = "https://github.com/gurkanguray/pi-docker-sandboxes";
const workflow = ".github/workflows/release-candidate.yml";
const integrity =
	"sha512-qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg==";
const sourceSha = "b".repeat(40);

async function evidence() {
	const metadata = JSON.parse(
		await readFile(new URL("metadata.json", fixtures), "utf8"),
	);
	const statement = JSON.parse(
		await readFile(new URL("statement.json", fixtures), "utf8"),
	);
	return {
		metadata,
		attestations: {
			attestations: [
				{
					predicateType: "https://slsa.dev/provenance/v1",
					bundle: {
						dsseEnvelope: {
							payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
							signatures: [{ sig: "fixture-signature" }],
						},
					},
				},
			],
		},
		candidate: {
			version: "1.2.3",
			tag: "v1.2.3",
			sourceSha,
			tarballIntegrity: integrity,
		},
		packageReceipt: { integrity },
		expectedRepository: repository,
		expectedWorkflow: workflow,
	};
}

test("npm provenance binds registry integrity, latest, repository, workflow, and source", async () => {
	const value = await evidence();
	assert.deepEqual(verifyNpmProvenance(value), {
		verified: true,
		tool: "npm audit signatures",
		name: "pi-docker-sandboxes",
		version: "1.2.3",
		integrity,
		latest: "1.2.3",
		repository,
		workflow,
		workflowRef: "refs/tags/v1.2.3",
		sourceSha,
		attestationUrl:
			"https://registry.npmjs.org/-/npm/v1/attestations/pi-docker-sandboxes@1.2.3",
		predicateType: "https://slsa.dev/provenance/v1",
		subject: "pkg:npm/pi-docker-sandboxes@1.2.3",
	});
});

for (const [name, mutate, message] of [
	[
		"integrity",
		(value: Awaited<ReturnType<typeof evidence>>) => {
			value.metadata.dist.integrity = "sha512-wrong";
		},
		/integrity/i,
	],
	[
		"latest",
		(value: Awaited<ReturnType<typeof evidence>>) => {
			value.metadata.distTags.latest = "1.2.2";
		},
		/npm latest/i,
	],
	[
		"repository",
		(value: Awaited<ReturnType<typeof evidence>>) => {
			value.metadata.repository.url = "https://github.com/example/other";
		},
		/repository/i,
	],
	[
		"workflow",
		(value: Awaited<ReturnType<typeof evidence>>) => {
			value.expectedWorkflow = ".github/workflows/other.yml";
		},
		/workflow/i,
	],
	[
		"source SHA",
		(value: Awaited<ReturnType<typeof evidence>>) => {
			value.candidate.sourceSha = "c".repeat(40);
		},
		/source SHA/i,
	],
] as const) {
	test(`npm provenance rejects differing ${name}`, async () => {
		const value = await evidence();
		mutate(value);
		assert.throws(() => verifyNpmProvenance(value), message);
	});
}
