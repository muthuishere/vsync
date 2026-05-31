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
      { text: "Handbook", link: "/handbook/" },
      { text: "Libraries", link: "/libraries/" },
      { text: "Examples", link: "/examples/" },
      { text: "Architecture", link: "/architecture/mental-model" },
      {
        text: "0.14.0",
        items: [
          { text: "Changelog", link: "/guide/versioning" },
          { text: "Upgrade to 0.11", link: "/guide/upgrade-to-0.11" },
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
            { text: "First team setup", link: "/guide/first-team-setup" },
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
          text: "Runbooks & incident response",
          items: [
            { text: "Rotate the passphrase", link: "/guide/rotate-passphrase-runbook" },
            { text: "Rotate the IAM key", link: "/guide/iam-rotation-runbook" },
            { text: "Incident response", link: "/guide/incident-response" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Command reference", link: "/guide/commands" },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
            { text: "FAQ", link: "/guide/faq" },
            { text: "Upgrade to 0.11", link: "/guide/upgrade-to-0.11" },
            { text: "Versioning", link: "/guide/versioning" },
          ],
        },
      ],

      "/handbook/": [
        {
          text: "Onboarding handbook",
          items: [
            { text: "Overview", link: "/handbook/" },
            { text: "Bucket on AWS S3", link: "/handbook/awss3" },
            { text: "Bucket on GCP (GCS)", link: "/handbook/gcps3" },
            { text: "Bucket on your own S3 / VPS", link: "/handbook/customs3" },
          ],
        },
      ],

      "/libraries/": [
        {
          text: "Runtime libraries",
          items: [
            { text: "Overview & comparison", link: "/libraries/" },
          ],
        },
        {
          text: "Per language",
          items: [
            { text: "Python", link: "/libraries/python" },
            { text: "TypeScript / Node", link: "/libraries/typescript" },
            { text: "Go", link: "/libraries/go" },
            { text: "Java", link: "/libraries/java" },
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

      "/examples/": [
        {
          text: "Examples gallery",
          items: [
            { text: "Index", link: "/examples/" },
          ],
        },
        {
          text: "Python",
          items: [
            { text: "Django + Vercel", link: "/examples/django-vercel" },
            { text: "FastAPI + Cloud Run", link: "/examples/fastapi-cloud-run" },
          ],
        },
        {
          text: "TypeScript / Node",
          items: [
            { text: "Next.js + Vercel", link: "/examples/nextjs-vercel" },
            { text: "Express + Fly.io", link: "/examples/express-fly" },
          ],
        },
        {
          text: "Go",
          items: [
            { text: "Go HTTP service + AWS ECS", link: "/examples/go-service-ecs" },
          ],
        },
        {
          text: "Java",
          items: [
            { text: "Spring Boot + AWS EKS", link: "/examples/spring-boot-eks" },
          ],
        },
        {
          text: "Any language",
          items: [
            { text: "VPS + docker-compose", link: "/examples/vps-docker-compose" },
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
            { text: "Storage layout", link: "/architecture/storage-layout" },
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
