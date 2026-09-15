import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";
mkdirSync(outdir, { recursive: true });

const options = {
  entryPoints: {
    content: "src/content.ts",
    options: "src/options.ts",
    background: "node_modules/@inboxsdk/core/background.js",
    pageWorld: "node_modules/@inboxsdk/core/pageWorld.js",
  },
  bundle: true,
  format: "iife" as const,
  target: "chrome120",
  outdir,
  sourcemap: true,
  logLevel: "info" as const,
};

cpSync("static", outdir, { recursive: true });
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
