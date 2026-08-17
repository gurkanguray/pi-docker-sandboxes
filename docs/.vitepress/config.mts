import { defineConfig } from "vitepress";

const repository = "https://github.com/gurkanguray/pi-docker-sandboxes";

export default defineConfig({
	title: "Pi Docker Sandboxes",
	description: "Run Pi inside isolated Docker Sandboxes microVMs.",
	base: "/pi-docker-sandboxes/",
	cleanUrls: true,
	srcExclude: ["superpowers/**"],
	themeConfig: {
		nav: [
			{
				text: "Guide",
				items: [
					{ text: "Getting Started", link: "/getting-started" },
					{ text: "Configuration", link: "/configuration" },
				],
			},
			{
				text: "Operations",
				items: [
					{ text: "Troubleshooting", link: "/troubleshooting" },
					{ text: "Migration", link: "/migration" },
					{ text: "Uninstall", link: "/uninstall" },
				],
			},
			{
				text: "Community",
				items: [
					{
						text: "Support",
						link: "https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/SUPPORT.md",
					},
					{
						text: "Security",
						link: "https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/SECURITY.md",
					},
					{
						text: "Contributing",
						link: "https://github.com/gurkanguray/pi-docker-sandboxes/blob/main/CONTRIBUTING.md",
					},
				],
			},
			{
				text: "Maintainers",
				items: [{ text: "Repository Settings", link: "/repository-settings" }],
			},
			{ text: "GitHub", link: repository },
		],
		sidebar: [
			{
				text: "Guide",
				items: [
					{ text: "Getting Started", link: "/getting-started" },
					{ text: "Configuration", link: "/configuration" },
				],
			},
			{
				text: "Operations",
				items: [
					{ text: "Troubleshooting", link: "/troubleshooting" },
					{ text: "Migration", link: "/migration" },
					{ text: "Uninstall", link: "/uninstall" },
				],
			},
			{
				text: "Maintainers",
				items: [{ text: "Repository Settings", link: "/repository-settings" }],
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
