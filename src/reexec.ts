const BOOLEAN_MAP: Readonly<Record<string, string>> = {
	"--docker-sandbox-fresh": "--fresh",
	"--docker-sandbox-keep": "--keep",
	"--docker-sandbox-discard-changes": "--discard-changes",
	"--docker-sandbox-no-host-auth": "--no-host-auth",
	"--yes": "--yes",
};
const SESSION_FLAG = "--docker-sandbox-session";
const VALUE_MAP: Readonly<Record<string, string>> = {
	"--docker-sandbox-profile": "--profile",
	"--docker-sandbox-name": "--name",
	"--docker-sandbox-sync": "--sync",
};

export interface ReexecArguments {
	launcherArgs: string[];
	innerPiArgs: string[];
}

function inlineBoolean(
	value: string,
): { key: string; enabled: boolean } | undefined {
	const [key, inline] = value.split("=", 2);
	if (!key || inline === undefined) return undefined;
	if (inline !== "true" && inline !== "false")
		throw new TypeError(`${key} requires a boolean true or false value`);
	return { key, enabled: inline === "true" };
}

export function buildReexecArguments(
	argv: readonly string[],
): ReexecArguments | undefined {
	const activations = argv.filter(
		(value) =>
			value === "--docker-sandbox" || value.startsWith("--docker-sandbox="),
	);
	if (activations.length === 0) return undefined;
	const active = activations.some((value) => {
		if (value === "--docker-sandbox") return true;
		return inlineBoolean(value)?.enabled === true;
	});
	if (!active) return undefined;
	const sessionFlags = argv.filter(
		(value) => value === SESSION_FLAG || value.startsWith(`${SESSION_FLAG}=`),
	);
	if (sessionFlags.length > 1)
		throw new TypeError(`${SESSION_FLAG} may be set only once`);
	const launcherArgs = ["run", "--cwd", process.cwd()];
	const innerPiArgs: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index]!;
		if (value === "--docker-sandbox" || value.startsWith("--docker-sandbox=")) {
			if (value !== "--docker-sandbox") inlineBoolean(value);
			continue;
		}
		const [key, inline] = value.split("=", 2);
		if (key === SESSION_FLAG) {
			const argument = inline ?? argv[index + 1];
			if (!argument || argument.startsWith("-"))
				throw new TypeError(`${key} requires a value`);
			if (inline === undefined) index++;
			innerPiArgs.push("--session", argument);
			continue;
		}
		const directBoolean = BOOLEAN_MAP[value];
		if (directBoolean) {
			launcherArgs.push(directBoolean);
			continue;
		}
		if (BOOLEAN_MAP[key!]) {
			const parsedBoolean = inlineBoolean(value)!;
			if (parsedBoolean.enabled) launcherArgs.push(BOOLEAN_MAP[key!]!);
			continue;
		}
		const mapped = VALUE_MAP[key!];
		if (mapped) {
			const argument = inline ?? argv[++index];
			if (!argument) throw new TypeError(`${key} requires a value`);
			launcherArgs.push(mapped, argument);
			continue;
		}
		innerPiArgs.push(value);
	}
	launcherArgs.push("--", ...innerPiArgs);
	return { launcherArgs, innerPiArgs };
}
