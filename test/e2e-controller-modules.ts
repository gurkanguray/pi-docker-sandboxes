import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

function assertInside(packageRoot: string, modulePath: string): void {
	const pathFromRoot = relative(packageRoot, modulePath);
	if (
		pathFromRoot === ".." ||
		pathFromRoot.startsWith(`..${sep}`) ||
		isAbsolute(pathFromRoot)
	)
		throw new Error(`${modulePath} resolves outside installed package`);
}

export async function importControllerModule(
	packageRoot: string,
	relativePath: string,
): Promise<{ modulePath: string; module: Record<string, unknown> }> {
	const installedRoot = await realpath(packageRoot);
	const requestedPath = resolve(installedRoot, relativePath);
	assertInside(installedRoot, requestedPath);
	const modulePath = await realpath(requestedPath);
	assertInside(installedRoot, modulePath);
	return {
		modulePath,
		module: await import(pathToFileURL(modulePath).href),
	};
}
