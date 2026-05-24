import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Vsync",
  titleTemplate: ":title — Vsync",
  description:
    "One encrypted vault for your environment secrets, shared across your team, mirrored to GH / GCP / AWS / Azure / Vault, audited every time someone touches it.",
  base: "/vsync/",
  cleanUrls: true,
  lastUpdated: true,

  // The test-vectors corpus contains READMEs intended for GitHub browsing only —
  // its category dirs ship without index.md files, which would otherwise trigger
  // dead-link errors during the docs build. Exclude from the site build.
  srcExclude: ["**/test-vectors/**"],

  // Spec docs use angle-bracket placeholders like <env>, <name>, <repo>, <accountid>
  // inside code blocks and inline code. markdown-it's HTML pass-through otherwise
  // leaves them as live HTML and Vue's parser aborts the build complaining of
  // unclosed tags. Disable raw HTML so markdown-it escapes them at the source.
  markdown: {
    html: false,
  },

  themeConfig: {
    siteTitle: "Vsync",

    nav: [
      { text: "Guide", link: "/guide/quickstart" },
      { text: "Libraries", link: "/libraries/" },
      { text: "Architecture", link: "/architecture/mental-model" },
      {
        text: "0.11.0",
        items: [
          { text: "Changelog", link: "/guide/versioning" },
          { text: "npm — CLI", link: "https://www.npmjs.com/package/@muthuishere/vsync" },
          { text: "npm — TS lib", link: "https://www.npmjs.com/package/@muthuishere/vsync-s3-client" },
          { text: "PyPI — Python lib", link: "https://pypi.org/project/vsync-s3-client/" },
          { text: "pkg.go.dev — Go lib", link: "https://pkg.go.dev/github.com/muthuishere/vsync/libraries/go" },
          { text: "Maven Central — Java lib", link: "https://central.sonatype.com/artifact/io.github.muthuishere/vsync-s3-client" },
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
            { text: "Profiles", link: "/guide/profiles" },
          ],
        },
        {
          text: "Teams & deployment",
          items: [
            { text: "Onboarding teammates", link: "/guide/share" },
            { text: "Fanout to where prod runs", link: "/guide/sync" },
            { text: "Runtime tokens & rotation", link: "/guide/runtime-token" },
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

      "/libraries/": [
        {
          text: "Runtime libraries",
          items: [
            { text: "Overview & quickstart", link: "/libraries/" },
          ],
        },
        {
          text: "Specs",
          items: [
            { text: "Lib API (v0.12)", link: "/specs/v0.12-vsync-s3-client" },
            { text: "Conformance vectors (v0.11)", link: "/specs/v0.11-conformance-test-vectors" },
            { text: "Runtime-token CLI (v0.10)", link: "/specs/v0.10-runtime-token-cli" },
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
