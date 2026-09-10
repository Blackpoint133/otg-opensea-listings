import { access, mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { canonicalBytes, canonicalClone, canonicalDecimal, canonicalEvidence, deepFreeze, sha256Bytes, sha256Canonical } from "./canonicalEvidence.js";
import { CANONICALIZATION_VERSION, EVIDENCE_SCHEMA_VERSION, type ArtifactRef, type CatchUpRoundRecord, type EvidenceArtifactType, type EvidenceReadResult, type EvidenceGenerationState, type GenerationEvidenceReader, type GenerationEvidenceWriter, type GenerationIdentity, type RootManifest, type SeenOrderRecord, type TransitionRecord } from "./evidenceTypes.js";

const SEMANTIC_STATEMENT = "BARRIER PREREQUISITES ONLY. NO ORDER VERIFICATION. NO DEACTIVATION AUTHORITY." as const;
const ROOT_NAME = "root-manifest.json";
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set<EvidenceGenerationState>(["OPEN", "TRANSPORT_COMPLETE", "CATCHING_UP", "VERIFIED", "ABORTED"]);
const EDGES = new Map<EvidenceGenerationState, ReadonlySet<EvidenceGenerationState>>([
  ["OPEN", new Set(["TRANSPORT_COMPLETE", "ABORTED"])],
  ["TRANSPORT_COMPLETE", new Set(["CATCHING_UP", "ABORTED"])],
  ["CATCHING_UP", new Set(["VERIFIED", "ABORTED"])],
  ["VERIFIED", new Set()], ["ABORTED", new Set()]
]);

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validIso(value: unknown): value is string { return nonEmpty(value) && Number.isFinite(Date.parse(value)); }
function safeCounter(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validHash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function validSweep(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function safeRelative(root: string, relative: unknown): string {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative) || relative.startsWith("\\\\")) throw new Error("INVALID_ARTIFACT_PATH");
  const normalized = relative.replace(/\\/g, path.sep);
  const full = path.resolve(root, normalized);
  const base = path.resolve(root) + path.sep;
  if (!full.startsWith(base) || normalized.split(/[\\/]+/).includes("..")) throw new Error("INVALID_ARTIFACT_PATH");
  return full;
}
function relativeSafe(root: string, full: string): string { const relative = path.relative(root, full); safeRelative(root, relative); return relative.split(path.sep).join("/"); }
function identityValid(identity: GenerationIdentity): void {
  if (!validSweep(identity.sweepId) || !nonEmpty(identity.modelVersion) || !validIso(identity.snapshotStartedAt) || !nonEmpty(identity.policyHash)) throw new Error("INVALID_GENERATION_IDENTITY");
  if (!record(identity.scope) || !nonEmpty(identity.scope.chain) || !nonEmpty(identity.scope.collection) || !/^0x[0-9a-f]{40}$/i.test(identity.scope.contract) || !/^https:\/\//.test(identity.scope.endpoint)) throw new Error("INVALID_GENERATION_SCOPE");
  if (!record(identity.sourceProvenance) || Object.keys(identity.sourceProvenance).length === 0 || !Object.entries(identity.sourceProvenance).every(([key, value]) => nonEmpty(key) && validHash(value))) throw new Error("INVALID_PROVENANCE");
}
function manifestPayload(manifest: Omit<RootManifest, "rootContentHash">): Omit<RootManifest, "rootContentHash"> { return manifest; }
function buildManifest(identity: GenerationIdentity, artifacts: readonly ArtifactRef[], writerProvenance: Readonly<Record<string, string>>): RootManifest {
  const base = { ...canonicalClone(identity), evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION, canonicalizationVersion: CANONICALIZATION_VERSION, generationKey: sha256Canonical(identity), artifacts: [...artifacts].sort((a, b) => `${a.artifactType}:${a.artifactId}`.localeCompare(`${b.artifactType}:${b.artifactId}`)), writerProvenance: Object.fromEntries(Object.entries(writerProvenance).sort(([a], [b]) => a.localeCompare(b))), semanticStatement: SEMANTIC_STATEMENT } as Omit<RootManifest, "rootContentHash">;
  return { ...base, rootContentHash: sha256Canonical(manifestPayload(base)) };
}
function validateManifest(value: unknown, sweepId: string): RootManifest {
  if (!record(value) || value.evidenceSchemaVersion !== EVIDENCE_SCHEMA_VERSION || value.canonicalizationVersion !== CANONICALIZATION_VERSION || value.sweepId !== sweepId || value.semanticStatement !== SEMANTIC_STATEMENT || !validHash(value.rootContentHash) || !Array.isArray(value.artifacts) || !record(value.writerProvenance)) throw new Error("INVALID_ROOT_MANIFEST");
  const copy = canonicalClone(value) as unknown as RootManifest; const { rootContentHash, ...base } = copy;
  if (rootContentHash !== sha256Canonical(base)) throw new Error("ROOT_HASH_MISMATCH");
  identityValid(copy);
  const seen = new Set<string>();
  for (const item of copy.artifacts) {
    if (!record(item) || item.sweepId !== sweepId || !nonEmpty(item.artifactType) || !nonEmpty(item.artifactId) || !nonEmpty(item.schemaVersion) || !validHash(item.contentHash) || !safeCounter(item.byteLength)) throw new Error("INVALID_ARTIFACT_REF");
    const key = `${item.artifactType}:${item.artifactId}`; if (seen.has(key)) throw new Error("DUPLICATE_ARTIFACT_IDENTITY"); seen.add(key); safeRelative(path.join("C:\\evidence-root"), item.relativePath);
  }
  return deepFreeze(copy);
}
function validateTransitionSequence(transitions: readonly TransitionRecord[], sweepId: string): void {
  let previous: EvidenceGenerationState = "OPEN";
  transitions.forEach((item, index) => { if (!record(item) || item.sweepId !== sweepId || item.sequence !== index + 1 || item.fromState !== previous || !STATES.has(item.toState) || !EDGES.get(previous)?.has(item.toState) || !validIso(item.recordedAt)) throw new Error("INVALID_TRANSITION_HISTORY"); previous = item.toState; });
}
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
async function writeOnce(file: string, bytes: Uint8Array): Promise<void> {
  if (await exists(file)) { const old = new Uint8Array(await readFile(file)); if (sha256Bytes(old) !== sha256Bytes(bytes) || old.byteLength !== bytes.byteLength) throw new Error("ARTIFACT_CONFLICT"); return; }
  const tmp = `${file}.tmp`;
  const handle = await open(tmp, "wx"); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (await exists(file)) { const old = new Uint8Array(await readFile(file)); if (sha256Bytes(old) !== sha256Bytes(bytes)) throw new Error("ARTIFACT_CONFLICT"); return; }
  await rename(tmp, file);
}
async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }); const result: string[] = [];
  for (const entry of entries) { const full = path.join(current, entry.name); if (entry.isDirectory()) result.push(...await walkFiles(root, full)); else result.push(relativeSafe(root, full)); }
  return result;
}

class FileEvidenceStore implements GenerationEvidenceWriter {
  private readonly root: string;
  private readonly identity: GenerationIdentity;
  private readonly refs = new Map<string, ArtifactRef>();
  constructor(root: string, identity: GenerationIdentity) { this.root = root; this.identity = identity; }
  private file(relative: string): string { return safeRelative(this.root, relative); }
  async writeArtifact(input: { artifactType: EvidenceArtifactType; artifactId: string; relativePath: string; schemaVersion?: string; payload: unknown }): Promise<ArtifactRef> {
    if (input.relativePath === ROOT_NAME || input.relativePath.endsWith(".tmp")) throw new Error("INVALID_ARTIFACT_PATH");
    if (!nonEmpty(input.artifactId)) throw new Error("INVALID_ARTIFACT_ID");
    const bytes = input.relativePath.endsWith(".jsonl")
      ? new TextEncoder().encode((Array.isArray(input.payload) ? input.payload : [input.payload]).map((item) => `${canonicalEvidence(item)}\n`).join(""))
      : canonicalBytes(input.payload);
    const file = this.file(input.relativePath); await mkdir(path.dirname(file), { recursive: true });
    const ref = deepFreeze({ artifactType: input.artifactType, artifactId: input.artifactId, sweepId: this.identity.sweepId, relativePath: input.relativePath.replace(/\\/g, "/"), schemaVersion: input.schemaVersion ?? EVIDENCE_SCHEMA_VERSION, contentHash: sha256Bytes(bytes), byteLength: bytes.byteLength });
    const key = `${ref.artifactType}:${ref.artifactId}`; const existing = this.refs.get(key);
    if (existing && (!equalRef(existing, ref))) throw new Error("ARTIFACT_CONFLICT");
    await writeOnce(file, bytes); this.refs.set(key, ref); return ref;
  }
  async finalizeManifest(input: { writerProvenance?: Readonly<Record<string, string>> } = {}): Promise<Readonly<RootManifest>> {
    const files = await walkFiles(this.root); if (files.some((file) => file.endsWith(".tmp"))) throw new Error("PARTIAL_ARTIFACT_PRESENT");
    const existing = path.join(this.root, ROOT_NAME); const artifacts: ArtifactRef[] = [...this.refs.values()];
    if (artifacts.some((ref) => !files.includes(ref.relativePath))) throw new Error("DECLARED_ARTIFACT_MISSING");
    if (files.some((file) => file !== ROOT_NAME && !artifacts.some((ref) => ref.relativePath === file))) throw new Error("UNREGISTERED_ARTIFACT");
    const manifest = buildManifest(this.identity, artifacts, input.writerProvenance ?? {}); await writeOnce(existing, canonicalBytes(manifest)); return deepFreeze(manifest);
  }
  async readGeneration(): Promise<EvidenceReadResult> { return readGenerationDirectory(this.root, this.identity.sweepId); }
  async listArtifacts(): Promise<readonly ArtifactRef[]> { return (await this.readGeneration()).artifacts; }
  async readArtifact(ref: ArtifactRef): Promise<ReadonlyArray<number>> { const bytes = new Uint8Array(await readFile(this.file(ref.relativePath))); if (bytes.byteLength !== ref.byteLength || sha256Bytes(bytes) !== ref.contentHash) throw new Error("ARTIFACT_HASH_MISMATCH"); return deepFreeze(Array.from(bytes)); }
  async getSeenOrders(): Promise<readonly SeenOrderRecord[]> { const rows = await this.readJsonl<SeenOrderRecord>("seen-orders.jsonl"); const seen = new Set<string>(); let previous = ""; for (const row of rows) { if (row.sweepId !== this.identity.sweepId || !/^0x[0-9a-f]{64}$/i.test(row.orderHash) || !safeCounter(row.pageNumber) || row.pageNumber < 1 || !validHash(row.rawPageHash) || !validHash(row.normalizedMaterialHash) || seen.has(row.orderHash.toLowerCase()) || row.orderHash.toLowerCase() < previous) throw new Error("INVALID_SEEN_ORDERS"); seen.add(row.orderHash.toLowerCase()); previous = row.orderHash.toLowerCase(); } return rows; }
  async getCatchUpRounds(): Promise<readonly CatchUpRoundRecord[]> { const rows = await this.readJsonl<CatchUpRoundRecord>("catchup-rounds.jsonl"); let previous = 0; for (const row of rows) { if (row.sweepId !== this.identity.sweepId || !safeCounter(row.roundNumber) || row.roundNumber !== previous + 1 || canonicalDecimal(row.eventId) !== row.eventId || !validIso(row.receivedAt) || !safeCounter(row.pendingCount) || !safeCounter(row.processingCount) || !safeCounter(row.failedCount) || !safeCounter(row.reconciliationRequiredCount) || !safeCounter(row.unknownCount)) throw new Error("INVALID_CATCHUP_ROUNDS"); previous = row.roundNumber; } return rows; }
  async getTransitions(): Promise<readonly TransitionRecord[]> { return this.readJsonl<TransitionRecord>("transitions.jsonl"); }
  private async readJsonl<T>(relative: string): Promise<readonly T[]> { const bytes = await this.readArtifact((await this.listArtifacts()).find((item) => item.relativePath === relative) ?? (() => { throw new Error("ARTIFACT_MISSING"); })()); const text = new TextDecoder().decode(Uint8Array.from(bytes)); return deepFreeze(text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T)); }
}

function equalRef(left: ArtifactRef, right: ArtifactRef): boolean { return left.artifactType === right.artifactType && left.artifactId === right.artifactId && left.relativePath === right.relativePath && left.schemaVersion === right.schemaVersion && left.contentHash === right.contentHash && left.byteLength === right.byteLength; }

export async function createGenerationEvidenceWriter(root: string, identity: GenerationIdentity): Promise<GenerationEvidenceWriter> {
  identityValid(identity); const directory = path.resolve(root, identity.sweepId); await mkdir(directory, { recursive: true });
  const files = await readdir(directory); if (files.length > 0 && !files.includes(ROOT_NAME)) throw new Error("GENERATION_CONFLICT");
  return new FileEvidenceStore(directory, canonicalClone(identity));
}

export async function readGenerationDirectory(directory: string, sweepId: string): Promise<EvidenceReadResult> {
  const reasons: string[] = []; const manifestFile = path.join(path.resolve(directory), ROOT_NAME); if (!(await exists(manifestFile))) return deepFreeze({ status: "INCOMPLETE", manifest: null, artifacts: [], transitions: [], reasons: ["ROOT_MANIFEST_MISSING"] });
  let manifest: RootManifest; try { manifest = validateManifest(JSON.parse(await readFile(manifestFile, "utf8")), sweepId); } catch (error) { return deepFreeze({ status: "CORRUPT", manifest: null, artifacts: [], transitions: [], reasons: [error instanceof Error ? error.message : "INVALID_ROOT_MANIFEST"] }); }
  const committed = await walkFiles(path.resolve(directory)); if (committed.some((file) => file.endsWith(".tmp"))) reasons.push("PARTIAL_ARTIFACT_PRESENT");
  const declared = new Set(manifest.artifacts.map((item) => item.relativePath)); if (committed.some((file) => file !== ROOT_NAME && !declared.has(file))) reasons.push("UNREGISTERED_ARTIFACT");
  for (const ref of manifest.artifacts) { try { const file = safeRelative(path.resolve(directory), ref.relativePath); const bytes = new Uint8Array(await readFile(file)); if (bytes.byteLength !== ref.byteLength || sha256Bytes(bytes) !== ref.contentHash) reasons.push("ARTIFACT_HASH_MISMATCH"); } catch { reasons.push("DECLARED_ARTIFACT_MISSING"); } }
  const transitionRef = manifest.artifacts.find((item) => item.relativePath === "transitions.jsonl"); let transitions: TransitionRecord[] = [];
  if (transitionRef) { try { const bytes = new Uint8Array(await readFile(safeRelative(path.resolve(directory), transitionRef.relativePath))); transitions = new TextDecoder().decode(bytes).split("\n").filter(Boolean).map((line) => JSON.parse(line) as TransitionRecord); validateTransitionSequence(transitions, sweepId); } catch { reasons.push("INVALID_TRANSITION_HISTORY"); } }
  else reasons.push("TRANSITION_HISTORY_MISSING");
  return deepFreeze({ status: reasons.length > 0 ? "CORRUPT" : "COMPLETE", manifest, artifacts: manifest.artifacts, transitions, reasons });
}

export { FileEvidenceStore, validateTransitionSequence };
