import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

// Native `_locales` are required by the manifest's localized store listing
// (default_locale + __MSG__). They are not committed; we materialize them from
// the single source of truth, the @lurkloot/locales package, at build time.
const messagesDir = dirname(createRequire(import.meta.url).resolve("@lurkloot/locales/messages/en.json"));

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  hooks: {
    "build:publicAssets"(_wxt, files) {
      for (const file of readdirSync(messagesDir)) {
        if (!file.endsWith(".json")) continue;
        files.push({
          absoluteSrc: join(messagesDir, file),
          relativeDest: `_locales/${basename(file, ".json")}/messages.json`,
        });
      }
    },
  },
  vite: () => ({
    build: {
      sourcemap: false,
    },
    plugins: [tailwindcss()],
  }),
  manifest: {
    default_locale: "en",
    name: "__MSG_extensionStoreName__",
    description: "__MSG_extensionDescription__",
    permissions: ["alarms", "storage", "tabs", "scripting", "notifications", "cookies", "webRequest"],
    host_permissions: [
      "https://*.twitch.tv/*",
      "https://*.kick.com/*"
    ],
    // The in-page panel is an extension page the twitch/kick content scripts
    // embed in an iframe, so its document must be web-accessible. Scoped to the
    // two origins that inject it — never <all_urls>: a listed resource is
    // fetchable, and so fingerprintable, by every origin it is exposed to.
    // Note MV2 (Firefox) has no `matches` field and downlevels this to a flat
    // string array, exposing the page to all origins there.
    web_accessible_resources: [
      {
        resources: ["inpagePanel.html"],
        matches: ["https://*.twitch.tv/*", "https://*.kick.com/*"]
      }
    ],
    icons: {
      "16": "icon/16.png",
      "32": "icon/32.png",
      "48": "icon/48.png",
      "128": "icon/128.png"
    },
    action: {
      default_title: "__MSG_extensionName__",
      default_icon: {
        "16": "icon/16.png",
        "32": "icon/32.png"
      }
    },
    browser_specific_settings: {
      gecko: {
        id: "lurkloot@jamezrin.name",
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: ["none"]
        }
      }
    }
  },
  zip: {
    sourcesRoot: ".",
    artifactTemplate: "{{name}}-{{version}}-{{browser}}.zip",
    sourcesTemplate: "{{name}}-{{version}}-sources.zip",
    // Generated, gitignored outputs (store screenshots/promo tiles) live here;
    // keep them out of the AMO sources zip.
    excludeSources: ["artifacts/**"],
  }
});
