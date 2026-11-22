import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const root = new URL("../", import.meta.url);
const sourcePath = fileURLToPath(new URL("storefront-src/countdown.js", root));
const assetPath = fileURLToPath(
  new URL(
    "extensions/notice-pro-storefront/assets/countdown.js",
    root,
  ),
);
const checkOnly = process.argv[2] === "--check";

if (process.argv.length > (checkOnly ? 3 : 2)) {
  throw new Error("Usage: node scripts/countdown-asset.mjs [--check]");
}

const source = await readFile(sourcePath, "utf8");
const { code } = await transform(source, {
  loader: "js",
  minifyWhitespace: true,
  minifyIdentifiers: false,
  minifySyntax: false,
  legalComments: "none",
});

if (!checkOnly) {
  await writeFile(assetPath, code);
  console.log(`Generated ${assetPath}`);
} else {
  const asset = await readFile(assetPath, "utf8");
  const assetBytes = Buffer.byteLength(asset);
  const generatedBytes = Buffer.byteLength(code);

  if (asset !== code) {
    throw new Error("Countdown asset is stale; run npm run countdown:generate.");
  }

  if (assetBytes > 10_000 || generatedBytes > 10_000) {
    throw new Error(
      `Countdown asset exceeds the 10,000-byte limit (${assetBytes} checked-in, ${generatedBytes} generated).`,
    );
  }

  console.log(`Countdown asset is fresh (${assetBytes} bytes).`);
}
