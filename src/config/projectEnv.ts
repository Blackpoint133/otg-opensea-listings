import path from "node:path";

/** The single environment file owned by this service. */
export function resolveProjectEnvPath(): string {
  // Both src/config and dist/config are two levels below the repository root.
  return path.resolve(import.meta.dirname, "..", "..", ".env");
}
