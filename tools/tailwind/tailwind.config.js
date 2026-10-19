// Static Tailwind build for the site. The design tokens live in assets/lab-tailwind.js
// (kept as the single source of truth); this config reuses them for the CLI build.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "..");
const sandbox = { tailwind: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, "assets", "lab-tailwind.js"), "utf8"), sandbox);

module.exports = {
  content: [
    path.join(root, "*.html"),
    path.join(root, "{zh,en,jp}", "*.html"),
    path.join(root, "assets", "*.js"),
  ],
  theme: sandbox.tailwind.config.theme,
  corePlugins: { preflight: true },
};
