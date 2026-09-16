import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolveProjectEnvPath } from "../src/config/projectEnv.js";
import { loadCanonicalProductionOpenSeaApiKey } from "../src/runtime/productionOpenSeaCredential.js";
import { loadDatabaseConfig } from "../src/db/pool.js";

const repositoryRoot = path.resolve(process.cwd());
const expectedEnvPath = path.join(repositoryRoot, ".env");
const parentEnvPath = path.resolve(path.dirname(expectedEnvPath), "..", ".env");

function runResolver(modulePath: string, cwd: string): string {
  const code = `import { resolveProjectEnvPath } from ${JSON.stringify(pathToFileURL(modulePath).href)}; console.log(resolveProjectEnvPath());`;
  const result = spawnSync(process.execPath, modulePath.endsWith(".ts") ? ["--experimental-strip-types", "--input-type=module", "-e", code] : ["--input-type=module", "-e", code], { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("project environment path is cwd-independent and source/dist equivalent", () => {
  const sourcePath = path.join(repositoryRoot, "src", "config", "projectEnv.ts");
  const distPath = path.join(repositoryRoot, "dist", "config", "projectEnv.js");
  const foreignCwd = path.join(repositoryRoot, "runtime");
  assert.equal(path.normalize(runResolver(sourcePath, foreignCwd)), path.normalize(expectedEnvPath));
  assert.equal(path.normalize(runResolver(distPath, foreignCwd)), path.normalize(expectedEnvPath));
  assert.equal(path.normalize(runResolver(sourcePath, foreignCwd)), path.normalize(runResolver(distPath, foreignCwd)));
});

test("credential loader reads only the project-local file seam", () => {
  const requested: string[] = [];
  const project = "OPENSEA_API_KEY=project-only-sentinel\nPOSTGRES_HOST=project-host\n";
  const result = loadCanonicalProductionOpenSeaApiKey({ readFileSync: (filePath) => { requested.push(filePath); return project; }, ambientValue: undefined });
  assert.equal(result, "project-only-sentinel");
  assert.deepEqual(requested.map(path.normalize), [path.normalize(resolveProjectEnvPath())]);
  assert.equal(requested.some((filePath) => path.normalize(filePath) === path.normalize(parentEnvPath)), false);
});

test("database config uses the project-local file and never a parent sentinel", () => {
  const requested: string[] = [];
  const project = "POSTGRES_USER=project-user\nPOSTGRES_PASSWORD=project-password\nPOSTGRES_HOST=project-host\nPOSTGRES_PORT=5432\nPOSTGRES_DB=project-db\n";
  const config = loadDatabaseConfig({}, { readFileSync: (filePath) => { requested.push(filePath); return project; } });
  assert.equal(config.host, "project-host");
  assert.equal(config.database, "project-db");
  assert.deepEqual(requested.map(path.normalize), [path.normalize(resolveProjectEnvPath())]);
  assert.equal(requested.some((filePath) => path.normalize(filePath) === path.normalize(parentEnvPath)), false);
});

test("default database loading keeps canonical values when ambient values match", () => {
  const project = "POSTGRES_USER=project-user\nPOSTGRES_PASSWORD=project-password\nPOSTGRES_HOST=project-host\nPOSTGRES_PORT=5432\nPOSTGRES_DB=project-db\n";
  const config = loadDatabaseConfig(undefined, { readFileSync: () => project, ambientEnv: {
    POSTGRES_USER: " project-user ", POSTGRES_PASSWORD: "project-password", POSTGRES_HOST: "project-host", POSTGRES_PORT: "5432", POSTGRES_DB: "project-db"
  } });
  assert.deepEqual({ user: config.user, password: config.password, host: config.host, port: config.port, database: config.database }, { user: "project-user", password: "project-password", host: "project-host", port: 5432, database: "project-db" });
});

test("differing ambient PostgreSQL values fail closed before pool construction", () => {
  const project = "POSTGRES_USER=project-user\nPOSTGRES_PASSWORD=project-password\nPOSTGRES_HOST=project-host\nPOSTGRES_PORT=5432\nPOSTGRES_DB=project-db\n";
  const values: Record<string, string> = { POSTGRES_USER: "other-user", POSTGRES_PASSWORD: "other-password", POSTGRES_HOST: "other-host", POSTGRES_PORT: "6543", POSTGRES_DB: "other-db" };
  for (const [key, value] of Object.entries(values)) {
    let poolConstructed = false;
    assert.throws(() => {
      loadDatabaseConfig(undefined, { readFileSync: () => project, ambientEnv: { [key]: value } });
      poolConstructed = true;
    }, (error: unknown) => error instanceof Error && error.message === `PRODUCTION_POSTGRES_CONFIG_SOURCE_CONFLICT:${key}` && !error.message.includes(value));
    assert.equal(poolConstructed, false);
  }
});

test("explicit hermetic database environment does not read a production file", () => {
  const config = loadDatabaseConfig({ POSTGRES_USER: "test-user", POSTGRES_PASSWORD: "test-password", POSTGRES_HOST: "test-host", POSTGRES_PORT: "5432", POSTGRES_DB: "test-db" }, { fileEnv: {} });
  assert.deepEqual({ user: config.user, host: config.host, port: config.port, database: config.database }, { user: "test-user", host: "test-host", port: 5432, database: "test-db" });
});
