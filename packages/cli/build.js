import { build } from "esbuild";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: "dist/cli.js",
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
  },
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import{createRequire}from"module";const require=createRequire(import.meta.url);',
    ].join("\n"),
  },
  external: ["qrcode-terminal"],
});
