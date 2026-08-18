import { defineConfig } from "vitepress";

const repository = "https://github.com/gurkanguray/pi-docker-sandboxes";

export default defineConfig({
	title: "Pi Docker Sandboxes",
	description: "Run Pi inside an isolated Docker Sandboxes microVM.",
	base: "/pi-docker-sandboxes/",
	cleanUrls: true,
	srcExclude: ["superpowers/**"],
	themeConfig: {
		nav: [
			{ text: "Get Started", link: "/getting-started" },
			{ text: "CLI Reference", link: "/cli-reference" },
			{ text: "Configuration", link: "/configuration" },
			{ text: "Troubleshooting", link: "/troubleshooting" },
			{ text: "GitHub", link: repository },
		],
		sidebar: [
			{
				text: "Documentation",
				items: [
					{ text: "Getting Started", link: "/getting-started" },
					{ text: "CLI Reference", link: "/cli-reference" },
					{ text: "Configuration", link: "/configuration" },
					{ text: "Troubleshooting", link: "/troubleshooting" },
					{ text: "Uninstall", link: "/uninstall" },
				],
			},
			{
				text: "Project",
				items: [
					{
						text: "Compatibility",
						link: "https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/COMPATIBILITY.md",
					},
					{
						text: "Support",
						link: "https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/SUPPORT.md",
					},
					{
						text: "Security",
						link: "https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/SECURITY.md",
					},
				],
			},
		],
		search: { provider: "local" },
		socialLinks: [{ icon: "github", link: repository }],
		editLink: {
			pattern: `${repository}/edit/main/docs/:path`,
			text: "Edit this page on GitHub",
		},
	},
});
