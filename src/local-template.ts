const DOCKER_IMAGE_ID = /^sha256:([0-9a-f]{64})$/;
const LOCAL_IMAGE =
	/^(?<repository>[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*):(?<tag>[A-Za-z0-9][A-Za-z0-9._-]*)$/;
const STORE_ID = /^[0-9a-f]{12,64}$/;
const CONTENT_IMAGE =
	/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*:local-[0-9a-f]{64}$/;
const REPOSITORY =
	/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_TEMPLATE_JSON_BYTES = 1024 * 1024;
const MAX_TEMPLATE_IMAGES = 1000;
const MAX_FIELD_LENGTH = 512;

export interface SbxTemplateImage {
	id: string;
	repository: string;
	tag: string;
}

export interface LocalTemplateSelection {
	image: string;
	storeId: string;
}

export function deriveLocalTemplateImage(
	localImage: string,
	verifiedDockerId: string,
): string {
	const parsed = localImage.match(LOCAL_IMAGE);
	const digest = verifiedDockerId.match(DOCKER_IMAGE_ID)?.[1];
	if (!parsed?.groups?.repository || !digest)
		throw new TypeError(
			"Invalid locked local image or verified Docker image ID",
		);
	return `${parsed.groups.repository}:local-${digest}`;
}

export function assertLocalTemplateAttestation(
	image: unknown,
	templateStoreId: unknown,
): asserts image is string {
	if (typeof image !== "string" || !CONTENT_IMAGE.test(image))
		throw new TypeError("Invalid content-addressed local template image");
	if (typeof templateStoreId !== "string" || !STORE_ID.test(templateStoreId))
		throw new TypeError("Invalid local template store ID");
}

export function splitLocalTemplateImage(image: string): {
	repository: string;
	tag: string;
} {
	const parsed = image.match(LOCAL_IMAGE);
	if (!parsed?.groups?.repository || !parsed.groups.tag)
		throw new TypeError("Invalid local template image");
	return { repository: parsed.groups.repository, tag: parsed.groups.tag };
}

export function parseSbxTemplateImages(output: string): SbxTemplateImage[] {
	if (Buffer.byteLength(output) > MAX_TEMPLATE_JSON_BYTES)
		throw new TypeError("sbx template list output is too large");
	if ((output.match(/"images"\s*:/g) ?? []).length !== 1)
		throw new TypeError("sbx template list must contain one images field");
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		throw new TypeError("sbx template list returned invalid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new TypeError("sbx template list returned an unexpected JSON shape");
	const images = (parsed as Record<string, unknown>).images;
	if (!Array.isArray(images) || images.length > MAX_TEMPLATE_IMAGES)
		throw new TypeError("sbx template list returned an invalid images array");
	return images.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new TypeError("sbx template list contains an invalid image");
		const { id, repository, tag } = value as Record<string, unknown>;
		if (
			typeof id !== "string" ||
			!STORE_ID.test(id) ||
			typeof repository !== "string" ||
			repository.length > MAX_FIELD_LENGTH ||
			!REPOSITORY.test(repository) ||
			typeof tag !== "string" ||
			tag.length > MAX_FIELD_LENGTH ||
			!TAG.test(tag)
		)
			throw new TypeError("sbx template list contains invalid image fields");
		return { id, repository, tag };
	});
}

export function requireLocalTemplate(
	output: string,
	image: string,
): LocalTemplateSelection {
	const expected = splitLocalTemplateImage(image);
	const matches = parseSbxTemplateImages(output).filter(
		(candidate) =>
			candidate.repository === expected.repository &&
			candidate.tag === expected.tag,
	);
	if (matches.length !== 1)
		throw new TypeError("Expected exactly one registered local template image");
	return { image, storeId: matches[0]!.id };
}
