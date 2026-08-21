import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertWorkspacePath(workspace) {
  if (!workspace.startsWith("packages/") || workspace.includes("..") || workspace.includes("\0")) {
    throw new Error(`Unsupported release workspace: ${workspace}`);
  }
}

function normalizedDependencyMap(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function assertNestedLockDependencies(workspace, packageJson, lockRoot) {
  const mismatchedFields = dependencyFields.filter((field) => (
    JSON.stringify(normalizedDependencyMap(packageJson[field]))
      !== JSON.stringify(normalizedDependencyMap(lockRoot[field]))
  ));

  if (mismatchedFields.length > 0) {
    throw new Error(
      `${workspace}/package-lock.json is out of sync with package.json (${mismatchedFields.join(", ")}). `
        + `Run \`cd ${workspace} && npm install --package-lock-only --workspaces=false\` and commit the lockfile before releasing.`,
    );
  }
}

async function validateNestedLock(workspace) {
  const packageJson = await readJson(path.join(repoRoot, workspace, "package.json"));
  const lock = await readJson(path.join(repoRoot, workspace, "package-lock.json"));
  const lockRoot = lock.packages?.[""];
  if (!lockRoot) {
    throw new Error(`${workspace}/package-lock.json is missing the root package entry`);
  }
  assertNestedLockDependencies(workspace, packageJson, lockRoot);
}

async function syncRootLock(workspaces) {
  const lockPath = path.join(repoRoot, "package-lock.json");
  const lock = await readJson(lockPath);
  for (const workspace of workspaces) {
    const packageJson = await readJson(path.join(repoRoot, workspace, "package.json"));
    const entry = lock.packages?.[workspace];
    if (!entry) {
      throw new Error(`Root package-lock.json is missing ${workspace}`);
    }
    entry.version = packageJson.version;
  }
  await writeJson(lockPath, lock);
}

async function syncNestedLock(workspace) {
  const packageJson = await readJson(path.join(repoRoot, workspace, "package.json"));
  const lockPath = path.join(repoRoot, workspace, "package-lock.json");
  const lock = await readJson(lockPath);
  lock.version = packageJson.version;
  if (!lock.packages?.[""]) {
    throw new Error(`${workspace}/package-lock.json is missing the root package entry`);
  }
  lock.packages[""].version = packageJson.version;
  await writeJson(lockPath, lock);
}

async function main() {
  const workspaces = process.argv.slice(2);
  if (workspaces.length === 0) {
    throw new Error("At least one workspace path is required");
  }
  for (const workspace of workspaces) {
    assertWorkspacePath(workspace);
  }
  if (workspaces.includes("packages/hub")) {
    await validateNestedLock("packages/hub");
  }
  await syncRootLock(workspaces);
  if (workspaces.includes("packages/hub")) {
    await syncNestedLock("packages/hub");
  }
}

await main();
