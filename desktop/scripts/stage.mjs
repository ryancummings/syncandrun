import { cp, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const source = resolve(root, "companion/dist");
const target = resolve(root, "desktop/companion/dist");
const compiled = await stat(resolve(source, "runtime.js")).catch(() => undefined);
const ui = await stat(resolve(source, "ui/index.html")).catch(() => undefined);
if (!compiled?.isFile() || !ui?.isFile()) {
  throw new Error("Build the companion first: pnpm --dir companion build");
}
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
