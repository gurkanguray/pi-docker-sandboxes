import assert from "node:assert/strict";
import test from "node:test";
import {
	deriveLocalTemplateImage,
	parseSbxTemplateImages,
} from "../src/local-template.ts";

const localImage = "docker.io/pi-docker-sandboxes/pi:0.1.0-alpha.1";
const hex = "a".repeat(64);
const contentImage = `docker.io/pi-docker-sandboxes/pi:local-${hex}`;

test("derives the only accepted local template tag from the verified Docker ID", () => {
	assert.equal(
		deriveLocalTemplateImage(localImage, `sha256:${hex}`),
		contentImage,
	);
	for (const [image, id] of [
		["pi:latest", `sha256:${hex}`],
		[localImage, hex],
		[localImage, `sha256:${"A".repeat(64)}`],
		[localImage, `sha256:${hex}extra`],
	] as const)
		assert.throws(() => deriveLocalTemplateImage(image, id), TypeError);
});

test("strictly parses bounded sbx template image JSON", () => {
	assert.deepEqual(
		parseSbxTemplateImages(
			JSON.stringify({
				images: [
					{
						id: "abc123def456",
						repository: "docker.io/pi-docker-sandboxes/pi",
						tag: `local-${hex}`,
						created_at: "ignored",
					},
				],
			}),
		),
		[
			{
				id: "abc123def456",
				repository: "docker.io/pi-docker-sandboxes/pi",
				tag: `local-${hex}`,
			},
		],
	);
});

test("rejects malformed, duplicate-field, oversized, or invalid template lists", () => {
	const invalid = [
		"not json",
		'{"images":[],"images":[]}',
		JSON.stringify([]),
		JSON.stringify({}),
		JSON.stringify({ images: "bad" }),
		JSON.stringify({ images: [{ id: "abc", repository: "repo", tag: "tag" }] }),
		JSON.stringify({
			images: [{ id: "ABC123DEF456", repository: "repo", tag: "tag" }],
		}),
		JSON.stringify({
			images: [{ id: "abc123def456", repository: "", tag: "tag" }],
		}),
		JSON.stringify({
			images: [{ id: "abc123def456", repository: "repo\n", tag: "tag" }],
		}),
		JSON.stringify({
			images: [{ id: "abc123def456", repository: "repo", tag: "" }],
		}),
		JSON.stringify({
			images: new Array(1001).fill({
				id: "abc123def456",
				repository: "repo",
				tag: "tag",
			}),
		}),
		" ".repeat(1_048_577),
	];
	for (const value of invalid)
		assert.throws(() => parseSbxTemplateImages(value), TypeError);
});
