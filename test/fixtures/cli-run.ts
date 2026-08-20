import { run } from "../../src/cli.ts";
import { launch } from "../../src/launch.ts";

process.exitCode = await run(process.argv.slice(2), {
	launch: (options) =>
		launch({
			...options,
			certifyPlatform: async () => ({
				os: "linux",
				arch: "x64",
				runtimePlatform: "linux/amd64",
			}),
			kvmPreflight: {
				statKvm: async () => ({ isCharacterDevice: () => true }),
				openKvm: async () => ({ close: async () => undefined }),
			},
		}),
});
