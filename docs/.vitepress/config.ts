import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Vsync",
  titleTemplate: ":title — Vsync",
  description:
    "One encrypted vault for your environment secrets, shared across your team, mirrored to GitHub & GCP, audited every time someone touches it.",
  base: "/vsync/",
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    siteTitle: "Vsync",

    nav: [
      { text: "Guide", link: "/guide/quickstart" },
      { text: "Architecture", link: "/architecture/mental-model" },
      {
        text: "0.5.0",
        items: [
          { text: "Changelog", link: "/guide/versioning" },
          { text: "npm", link: "https://www.npmjs.com/package/@muthuishere/vsync" },
          { text: "GitHub", link: "https://github.com/muthuishere/vsync" },
        ],
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Get started",
          items: [
            { text: "Quickstart", link: "/guide/quickstart" },
            { text: "Install", link: "/guide/install" },
          ],
        },
        {
          text: "Daily use",
          items: [
            { text: "What lives in the vault", link: "/guide/vault" },
            { text: "Switching envs — `vsync use`", link: "/guide/use" },
            { text: "Push / pull / versions", link: "/guide/daily" },
          ],
        },
        {
          text: "Teams & deployment",
          items: [
            { text: "Onboarding teammates", link: "/guide/share" },
            { text: "Fanout to GitHub / GCP", link: "/guide/sync" },
            { text: "Audit log", link: "/guide/audit" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Command reference", link: "/guide/commands" },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
            { text: "Versioning", link: "/guide/versioning" },
          ],
        },
      ],

      "/architecture/": [
        {
          text: "How vsync works",
          items: [
            { text: "Mental model", link: "/architecture/mental-model" },
            { text: "Crypto envelopes", link: "/architecture/crypto" },
            { text: "Audit append protocol", link: "/architecture/audit-protocol" },
            { text: "Repo identity", link: "/architecture/repo-identity" },
            { text: "Security model", link: "/architecture/security" },
          ],
        },
      ],

    },

    socialLinks: [
      { icon: "github", link: "https://github.com/muthuishere/vsync" },
      { icon: "npm", link: "https://www.npmjs.com/package/@muthuishere/vsync" },
    ],

    footer: {
      message: "Released under the MIT License.",
      copyright: "© Muthukumaran Navaneethakrishnan",
    },

    search: { provider: "local" },

    editLink: {
      pattern: "https://github.com/muthuishere/vsync/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});
