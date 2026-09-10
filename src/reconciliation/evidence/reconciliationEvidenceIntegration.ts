import { canonicalClone, canonicalEvidence, deepFreeze, sha256Canonical } from "./canonicalEvidence.js";
import { CANONICALIZATION_VERSION, EVIDENCE_SCHEMA_VERSION, type ArtifactRef, type EvidenceReadResult, type GenerationEvidenceReader, type GenerationEvidenceWriter, type RootManifest } from "./evidenceTypes.js";
import { OFFLINE_AUTHORITY_STATEMENT, OFFLINE_CANDIDATE_MODEL_VERSION, validateOfflineCandidateBundle } from "../offlineCandidateModel.js";
import { OFFLINE_GENERATION_MODEL_VERSION, validateOfflineGenerationResult } from "../offlineGenerationBarrierModel.js";

export const CANDIDATE_ENVELOPE_SCHEMA_VERSION = "candidate-bundle-envelope-v1" as const;
export const BARRIER_ENVELOPE_SCHEMA_VERSION = "barrier-evaluation-envelope-v1" as const;
export const INTEGRATION_SEMANTIC_STATEMENT = "BARRIER PREREQUISITES ONLY. NO ORDER VERIFICATION. NO DEACTIVATION AUTHORITY." as const;

export interface CandidateEvidenceEnvelope {
  artifactType: "candidate-bundle";
  artifactId: "candidate-bundle";
  artifactSchemaVersion: typeof CANDIDATE_ENVELOPE_SCHEMA_VERSION;
  sweepId: string;
  candidateModelVersion: typeof OFFLINE_CANDIDATE_MODEL_VERSION;
  sourceProvenance: Readonly<Record<string, string>>;
  candidateBundleHash: string;
  authorityGranted: false;
  payload: Readonly<Record<string, unknown>>;
}

export interface BarrierEvidenceEnvelope {
  artifactType: "barrier-evaluation";
  artifactId: "barrier-evaluation";
  artifactSchemaVersion: typeof BARRIER_ENVELOPE_SCHEMA_VERSION;
  sweepId: string;
  generationModelVersion: typeof OFFLINE_GENERATION_MODEL_VERSION;
  sourceProvenance: Readonly<Record<string, string>>;
  generationResultHash: string;
  candidateArtifactHash: string;
  state: string;
  fenceOutcome: string;
  semanticStatement: typeof INTEGRATION_SEMANTIC_STATEMENT;
  deactivationAuthorityGranted: false;
  payload: Readonly<Record<string, unknown>>;
}

export interface IntegratedEvidenceInput {
  candidateBundle: unknown;
  generationResult: unknown;
  sourceProvenance: Readonly<Record<string, string>>;
}

export interface IntegratedEvidenceResult {
  readonly status: "VALID" | "INCOMPLETE" | "CORRUPT" | "MISMATCHED";
  readonly manifest: Readonly<RootManifest> | null;
  readonly candidate: Readonly<CandidateEvidenceEnvelope> | null;
  readonly barrier: Readonly<BarrierEvidenceEnvelope> | null;
  readonly candidateRef: Readonly<ArtifactRef> | null;
  readonly barrierRef: Readonly<ArtifactRef> | null;
  readonly reasons: readonly string[];
  readonly authorityGranted: false;
  readonly deactivationAuthorityGranted: false;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function sortedProvenance(value: unknown): Readonly<Record<string, string>> | null {
  if (!record(value) || Object.keys(value).length === 0 || !Object.entries(value).every(([key, item]) => nonEmpty(key) && typeof item === "string" && nonEmpty(item))) return null;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) as Readonly<Record<string, string>>;
}
function sameProvenance(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean { return canonicalEvidence(left) === canonicalEvidence(right); }
function candidateGenerationConsistent(candidate: Record<string, unknown>, generation: Record<string, unknown>): boolean {
  if (!Array.isArray(candidate.orders) || !Array.isArray(generation.candidateAdvancement)) return false;
  const candidateOrders = candidate.orders as Array<Record<string, unknown>>;
  const advancements = generation.candidateAdvancement as Array<Record<string, unknown>>;
  if (candidateOrders.length !== advancements.length) return false;
  const left = candidateOrders.map((item) => `${String(item.orderHash)}\u0000${String(item.classification)}`).sort();
  const right = advancements.map((item) => `${String(item.orderHash)}\u0000${String(item.sourceClassification)}`).sort();
  return left.every((item, index) => item === right[index]);
}
function validCandidate(value: unknown, sweepId: string, provenance: Readonly<Record<string, string>>): value is Record<string, unknown> {
  return validateOfflineCandidateBundle(value).valid && record(value) && value.modelVersion === OFFLINE_CANDIDATE_MODEL_VERSION && value.sweepId === sweepId && value.authorityStatement === OFFLINE_AUTHORITY_STATEMENT && value.authorityGranted === false && sameProvenance(value.sourceProvenance as Readonly<Record<string, string>>, provenance);
}
function validGeneration(value: unknown, sweepId: string, provenance: Readonly<Record<string, string>>): value is Record<string, unknown> {
  return validateOfflineGenerationResult(value).valid && record(value) && value.modelVersion === OFFLINE_GENERATION_MODEL_VERSION && value.sweepId === sweepId && value.deactivationAuthorityGranted === false && sameProvenance(value.sourceProvenance as Readonly<Record<string, string>>, provenance);
}
function envelopeResult(status: IntegratedEvidenceResult["status"], reasons: readonly string[], manifest: Readonly<RootManifest> | null = null, candidate: Readonly<CandidateEvidenceEnvelope> | null = null, barrier: Readonly<BarrierEvidenceEnvelope> | null = null, candidateRef: Readonly<ArtifactRef> | null = null, barrierRef: Readonly<ArtifactRef> | null = null): IntegratedEvidenceResult {
  return deepFreeze({ status, manifest, candidate, barrier, candidateRef, barrierRef, reasons: [...new Set(reasons)].sort(), authorityGranted: false as const, deactivationAuthorityGranted: false as const });
}

export async function persistIntegratedEvidence(writer: GenerationEvidenceWriter, input: IntegratedEvidenceInput): Promise<Readonly<RootManifest>> {
  const provenance = sortedProvenance(input.sourceProvenance); if (!provenance) throw new Error("INVALID_INTEGRATION_PROVENANCE");
  const candidate = input.candidateBundle; const generation = input.generationResult;
  const sweepId = record(candidate) && typeof candidate.sweepId === "string" ? candidate.sweepId : record(generation) && typeof generation.sweepId === "string" ? generation.sweepId : "";
  if (!validCandidate(candidate, sweepId, provenance)) throw new Error("INVALID_CANDIDATE_INTEGRATION_INPUT");
  if (!validGeneration(generation, sweepId, provenance)) throw new Error("INVALID_GENERATION_INTEGRATION_INPUT");
  if (!candidateGenerationConsistent(candidate, generation)) throw new Error("CANDIDATE_GENERATION_HANDOFF_MISMATCH");
  const candidatePayload = canonicalClone(candidate) as Record<string, unknown>; const candidateBundleHash = sha256Canonical(candidatePayload);
  const candidateEnvelope: CandidateEvidenceEnvelope = { artifactType: "candidate-bundle", artifactId: "candidate-bundle", artifactSchemaVersion: CANDIDATE_ENVELOPE_SCHEMA_VERSION, sweepId, candidateModelVersion: OFFLINE_CANDIDATE_MODEL_VERSION, sourceProvenance: provenance, candidateBundleHash, authorityGranted: false, payload: candidatePayload };
  const candidateRef = await writer.writeArtifact({ artifactType: "candidate-bundle", artifactId: "candidate-bundle", relativePath: "candidate-bundle.json", schemaVersion: CANDIDATE_ENVELOPE_SCHEMA_VERSION, payload: candidateEnvelope });
  const generationPayload = canonicalClone(generation) as Record<string, unknown>; const generationResultHash = sha256Canonical(generationPayload);
  const barrierEnvelope: BarrierEvidenceEnvelope = { artifactType: "barrier-evaluation", artifactId: "barrier-evaluation", artifactSchemaVersion: BARRIER_ENVELOPE_SCHEMA_VERSION, sweepId, generationModelVersion: OFFLINE_GENERATION_MODEL_VERSION, sourceProvenance: provenance, generationResultHash, candidateArtifactHash: candidateRef.contentHash, state: String(generation.state), fenceOutcome: String((generation.finalFence as Record<string, unknown>).outcome), semanticStatement: INTEGRATION_SEMANTIC_STATEMENT, deactivationAuthorityGranted: false, payload: generationPayload };
  const barrierRef = await writer.writeArtifact({ artifactType: "barrier-evaluation", artifactId: "barrier-evaluation", relativePath: "barrier-evaluation.json", schemaVersion: BARRIER_ENVELOPE_SCHEMA_VERSION, payload: barrierEnvelope });
  const history = Array.isArray(generation.stateHistory) ? (generation.stateHistory as string[]) : [];
  const transitions = history.slice(1).map((toState, index) => ({ sweepId, sequence: index + 1, fromState: history[index], toState, reasonCodes: [], evidenceRootHash: barrierRef.contentHash, modelVersion: OFFLINE_GENERATION_MODEL_VERSION, recordedAt: String(generation.snapshotCompletedAt), writerInstance: "offline-integration" }));
  await writer.writeArtifact({ artifactType: "transitions", artifactId: "history", relativePath: "transitions.jsonl", payload: transitions });
  const manifest = await writer.finalizeManifest({ writerProvenance: provenance });
  if (manifest.sweepId !== sweepId) throw new Error("INTEGRATION_SWEEP_MISMATCH");
  return manifest;
}

function parseEnvelope<T>(bytes: ReadonlyArray<number>): T { return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as T; }
function artifact(result: EvidenceReadResult, type: string, id: string): ArtifactRef | null { return result.artifacts.find((item) => item.artifactType === type && item.artifactId === id) ?? null; }

export async function reconstructIntegratedEvidence(reader: GenerationEvidenceReader, expectedSweepId: string, expectedProvenance: Readonly<Record<string, string>>): Promise<IntegratedEvidenceResult> {
  let graph: EvidenceReadResult; try { graph = await reader.readGeneration(); } catch (error) { return envelopeResult("CORRUPT", [error instanceof Error ? error.message : "READ_FAILED"]); }
  if (graph.status === "INCOMPLETE") return envelopeResult("INCOMPLETE", graph.reasons, graph.manifest);
  if (graph.status !== "COMPLETE" || !graph.manifest) return envelopeResult("CORRUPT", graph.reasons, graph.manifest);
  if (graph.manifest.sweepId !== expectedSweepId || !sameProvenance(graph.manifest.sourceProvenance, expectedProvenance)) return envelopeResult("MISMATCHED", ["INTEGRATION_PROVENANCE_MISMATCH"], graph.manifest);
  const candidateRef = artifact(graph, "candidate-bundle", "candidate-bundle"); const barrierRef = artifact(graph, "barrier-evaluation", "barrier-evaluation");
  if (!candidateRef || !barrierRef) return envelopeResult("INCOMPLETE", ["INTEGRATION_ARTIFACT_MISSING"], graph.manifest, null, null, candidateRef, barrierRef);
  try {
    const candidate = parseEnvelope<CandidateEvidenceEnvelope>(await reader.readArtifact(candidateRef)); const barrier = parseEnvelope<BarrierEvidenceEnvelope>(await reader.readArtifact(barrierRef));
    deepFreeze(candidate.payload); deepFreeze(barrier.payload);
    const reasons: string[] = [];
    if (candidate.artifactType !== "candidate-bundle" || candidate.artifactId !== candidateRef.artifactId || candidate.sweepId !== expectedSweepId || candidate.candidateModelVersion !== OFFLINE_CANDIDATE_MODEL_VERSION || candidate.authorityGranted !== false || candidate.artifactSchemaVersion !== CANDIDATE_ENVELOPE_SCHEMA_VERSION || !sameProvenance(candidate.sourceProvenance, expectedProvenance) || candidate.candidateBundleHash !== sha256Canonical(candidate.payload) || !validateOfflineCandidateBundle(candidate.payload).valid) reasons.push("CANDIDATE_ENVELOPE_MISMATCH");
    if (barrier.artifactType !== "barrier-evaluation" || barrier.artifactId !== barrierRef.artifactId || barrier.sweepId !== expectedSweepId || barrier.generationModelVersion !== OFFLINE_GENERATION_MODEL_VERSION || barrier.deactivationAuthorityGranted !== false || barrier.artifactSchemaVersion !== BARRIER_ENVELOPE_SCHEMA_VERSION || barrier.semanticStatement !== INTEGRATION_SEMANTIC_STATEMENT || barrier.candidateArtifactHash !== candidateRef.contentHash || barrier.generationResultHash !== sha256Canonical(barrier.payload) || !sameProvenance(barrier.sourceProvenance, expectedProvenance) || !validateOfflineGenerationResult(barrier.payload).valid) reasons.push("BARRIER_ENVELOPE_MISMATCH");
    if (candidate.artifactType === "candidate-bundle" && barrier.artifactType === "barrier-evaluation" && barrier.state !== (barrier.payload as Record<string, unknown>).state) reasons.push("BARRIER_ENVELOPE_MISMATCH");
    if (candidate.artifactType === "candidate-bundle" && barrier.artifactType === "barrier-evaluation" && barrier.fenceOutcome !== ((barrier.payload as Record<string, unknown>).finalFence as Record<string, unknown> | undefined)?.outcome) reasons.push("BARRIER_ENVELOPE_MISMATCH");
    if (validateOfflineCandidateBundle(candidate.payload).valid && validateOfflineGenerationResult(barrier.payload).valid && !candidateGenerationConsistent(candidate.payload, barrier.payload)) reasons.push("CANDIDATE_GENERATION_HANDOFF_MISMATCH");
    if (reasons.length > 0) return envelopeResult("MISMATCHED", reasons, graph.manifest, candidate, barrier, candidateRef, barrierRef);
    return envelopeResult("VALID", [], graph.manifest, candidate, barrier, candidateRef, barrierRef);
  } catch (error) { return envelopeResult("CORRUPT", [error instanceof Error ? error.message : "INTEGRATION_PARSE_FAILED"], graph.manifest, null, null, candidateRef, barrierRef); }
}
