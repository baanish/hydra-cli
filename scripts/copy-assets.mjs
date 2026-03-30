import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(rootDir, "src", "web");
const targetDir = resolve(rootDir, "dist", "web");

mkdirSync(targetDir, { recursive: true });
cpSync(resolve(sourceDir, "app.html"), resolve(targetDir, "app.html"));
