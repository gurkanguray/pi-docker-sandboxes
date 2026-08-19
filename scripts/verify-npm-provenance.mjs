#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
	throw new Error(message);
}

function repositoryUrl(value) {
	const raw = typeof value === "string" ? value : value?.url;
	return raw
		?.replace(/^git\+/, "")
		.replace(/\.git$/, "")
		.replace(/^git:\/\//, "https://");
}

function integrityHex(integrity) {
	const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? "");
	if (!match) fail("candidate integrity is not sha512 SRI");
	return Buffer.from(match[1], "base64").toString("hex");
}

function provenanceStatement(attestations) {
	const entries = attestations?.attestations;
	if (!Array.isArray(entries)) fail("registry returned no attestations");
	const provenance = entries.filter(
		(entry) => entry?.predicateType === "https://slsa.dev/provenance/v1",
	);
	if (provenance.length !== 1)
		fail("registry must return exactly one SLSA v1 provenance attestation");
	const bundle = provenance[0].bundle;
	const envelope = bundle?.content?.dsseEnvelope ?? bundle?.dsseEnvelope;
	if (typeof envelope?.payload !== "string")
		fail("npm provenance has no Sigstore DSSE payload");
	try {
		return {
			statement: JSON.parse(Buffer.from(envelope.payload, "base64").toString()),
			bundle,
		};
	} catch {
		fail("npm provenance DSSE payload is not valid JSON");
	}
}

export function verifyNpmProvenance({
	metadata,
	attestations,
	candidate,
	packageReceipt,
	expectedRepository,
	expectedWorkflow,
}) {
	const name = metadata?.name;
	const version = metadata?.version;
	const integrity = metadata?.dist?.integrity;
	if (name !== "pi-docker-sandboxes" || version !== candidate?.version)
		fail("registry package name/version differs from candidate");
	if (
		integrity !== candidate?.tarballIntegrity ||
		integrity !== packageReceipt?.integrity
	)
		fail("registry package integrity differs from candidate");
	if (metadata?.distTags?.latest !== version)
		fail("npm latest does not identify the candidate version");
	if (repositoryUrl(metadata?.repository) !== repositoryUrl(expectedRepository))
		fail("registry repository differs from candidate repository");
	const attestationUrl = metadata?.dist?.attestations?.url;
	let parsedUrl;
	try {
		parsedUrl = new URL(attestationUrl);
	} catch {
		fail("registry package has no valid attestation URL");
	}
	if (
		parsedUrl.protocol !== "https:" ||
		parsedUrl.hostname !== "registry.npmjs.org" ||
		!parsedUrl.pathname.startsWith("/-/npm/v1/attestations/")
	)
		fail("npm attestation URL is outside the public registry");

	const { statement } = provenanceStatement(attestations);
	if (
		statement?._type !== "https://in-toto.io/Statement/v1" ||
		statement?.predicateType !== "https://slsa.dev/provenance/v1"
	)
		fail("npm provenance statement type is invalid");
	const expectedDigest = Buffer.from(integrityHex(integrity), "hex");
	const subjects = statement.subject ?? [];
	const subject = subjects.find(
		(item) =>
			item?.name === `pkg:npm/${name}@${version}` &&
			typeof item?.digest?.sha512 === "string",
	);
	const actualDigest = Buffer.from(subject?.digest?.sha512 ?? "", "hex");
	if (
		actualDigest.length !== expectedDigest.length ||
		!timingSafeEqual(actualDigest, expectedDigest)
	)
		fail("signed npm provenance subject does not bind package integrity");
	const definition = statement?.predicate?.buildDefinition;
	if (
		definition?.buildType !==
		"https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1"
	)
		fail("signed npm provenance has an unexpected build type");
	const workflow = definition?.externalParameters?.workflow;
	if (
		repositoryUrl(workflow?.repository) !== repositoryUrl(expectedRepository) ||
		workflow?.path !== expectedWorkflow ||
		workflow?.ref !== `refs/tags/${candidate?.tag}`
	)
		fail("signed npm provenance does not bind the release workflow");
	const source = (definition?.resolvedDependencies ?? []).find(
		(item) => item?.digest?.gitCommit === candidate?.sourceSha,
	);
	if (!source || !repositoryUrl(source.uri)?.startsWith(repositoryUrl(expectedRepository)))
		fail("signed npm provenance does not bind the candidate source SHA");

	return {
		verified: true,
		tool: "npm audit signatures",
		name,
		version,
		integrity,
		latest: metadata.distTags.latest,
		repository: repositoryUrl(expectedRepository),
		workflow: expectedWorkflow,
		workflowRef: workflow.ref,
		sourceSha: candidate.sourceSha,
		attestationUrl,
		predicateType: statement.predicateType,
		subject: subject.name,
	};
}

async function main() {
	const [metadataPath, attestationsPath, candidatePath, packagePath, outputPath] =
		process.argv.slice(2);
	if (!outputPath)
		fail(
			"Usage: verify-npm-provenance <metadata> <attestations> <candidate> <package receipt> <output>",
		);
	const [metadata, attestations, candidate, packageReceipt] = await Promise.all(
		[metadataPath, attestationsPath, candidatePath, packagePath].map(
			async (path) => JSON.parse(await readFile(resolve(path), "utf8")),
		),
	);
	const evidence = verifyNpmProvenance({
		metadata,
		attestations,
		candidate,
		packageReceipt,
		expectedRepository: "https://github.com/gurkanguray/pi-docker-sandboxes",
		expectedWorkflow: ".github/workflows/release-candidate.yml",
	});
	await writeFile(resolve(outputPath), `${JSON.stringify(evidence, null, 2)}\n`);
	console.log(JSON.stringify(evidence));
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		console.error(
			`npm provenance verification failed: ${error instanceof Error ? error.message : error}`,
		);
		process.exitCode = 1;
	});
}
