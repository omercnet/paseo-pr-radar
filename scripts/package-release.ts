import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import packageJson from "../package.json";

const releaseFiles = [
  "bun.lock",
  "LICENSE",
  "README.md",
  "index.ts",
  "src/components/pr-radar.client.tsx",
  "src/lib/radar.shared.ts",
  "src/lib/viewer-scope.server.ts",
  "src/lib/viewer-scope.shared.ts",
  "package.json",
  "paseo-plugin.d.ts",
  "paseo-plugin.json",
  "tsconfig.json",
] as const;

const output = Bun.argv[2] ?? `dist/pr-radar-v${packageJson.version}.zip`;
const root = "pr-radar";
const files: Record<string, Uint8Array> = {};

for (const path of releaseFiles) {
  files[join(root, path)] = await Bun.file(path).bytes();
}

await mkdir("dist", { recursive: true });
await rm(output, { force: true });
await Bun.write(output, zipSync(files, { level: 9 }));
console.log(output);
