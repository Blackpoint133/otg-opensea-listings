import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export const PRODUCTION_OPENSEA_API_KEY_SOURCE_CONFLICT = "PRODUCTION_OPENSEA_API_KEY_SOURCE_CONFLICT";

export interface CanonicalOpenSeaCredentialLoaderOptions {
  /** Test-only seams; production uses the module-relative path and process environment. */
  readonly readFileSync?: (filePath: string, encoding: "utf8") => string;
  readonly ambientValue?: string | undefined;
}
function canonicalEnvPath(): string {
  return path.resolve(import.meta.dirname, "..", "..", "..", ".env");
}

function activeAssignmentCount(contents: string): number {
  return contents.split(/\r?\n/u).filter((line) => /^\s*(?:export\s+)?OPENSEA_API_KEY\s*=/u.test(line)).length;
}

/**
 * Loads the production OpenSea credential from the repository-adjacent .env.
 * The file is authoritative; an inherited value is only checked for conflict.
 */
export function loadCanonicalProductionOpenSeaApiKey(options: CanonicalOpenSeaCredentialLoaderOptions = {}): string {
  const readFileSync = options.readFileSync ?? ((filePath: string, encoding: "utf8") => fs.readFileSync(filePath, encoding));
  let contents: string;
  try {
    contents = readFileSync(canonicalEnvPath(), "utf8");
  } catch {
    throw new Error("PRODUCTION_OPENSEA_API_KEY_FILE_MISSING");
  }
  if (activeAssignmentCount(contents) !== 1) throw new Error(activeAssignmentCount(contents) > 1 ? "DUPLICATE_CANONICAL_KEY_ASSIGNMENTS" : "OPENSEA_API_KEY_MISSING");
  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(contents);
  } catch {
    throw new Error("PRODUCTION_OPENSEA_API_KEY_FILE_INVALID");
  }
  const canonical = parsed.OPENSEA_API_KEY?.trim();
  if (!canonical) throw new Error("OPENSEA_API_KEY_MISSING");
  const ambient = Object.prototype.hasOwnProperty.call(options, "ambientValue") ? options.ambientValue : process.env.OPENSEA_API_KEY;
  if (ambient !== undefined && ambient.trim() !== canonical) throw new Error(PRODUCTION_OPENSEA_API_KEY_SOURCE_CONFLICT);
  return canonical;
}
