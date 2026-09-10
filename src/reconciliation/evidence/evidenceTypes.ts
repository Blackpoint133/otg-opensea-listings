export const EVIDENCE_SCHEMA_VERSION = "active-listings-evidence-v1" as const;
export const CANONICALIZATION_VERSION = "canonical-json-v1" as const;

export type EvidenceArtifactType = "transport" | "seen-orders" | "catchup-rounds" | "candidate-bundle" | "barrier-evaluation" | "transitions" | "custom";
export type EvidenceGenerationState = "OPEN" | "TRANSPORT_COMPLETE" | "CATCHING_UP" | "VERIFIED" | "ABORTED";

export interface GenerationIdentity {
  sweepId: string;
  modelVersion: string;
  scope: { chain: string; collection: string; contract: string; endpoint: string };
  snapshotStartedAt: string;
  sourceProvenance: Readonly<Record<string, string>>;
  policyHash: string;
}

export interface ArtifactRef {
  artifactType: EvidenceArtifactType;
  artifactId: string;
  sweepId: string;
  relativePath: string;
  schemaVersion: string;
  contentHash: string;
  byteLength: number;
}

export interface RootManifest extends GenerationIdentity {
  evidenceSchemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  canonicalizationVersion: typeof CANONICALIZATION_VERSION;
  generationKey: string;
  artifacts: readonly ArtifactRef[];
  writerProvenance: Readonly<Record<string, string>>;
  semanticStatement: "BARRIER PREREQUISITES ONLY. NO ORDER VERIFICATION. NO DEACTIVATION AUTHORITY.";
  rootContentHash: string;
}

export interface TransitionRecord {
  sweepId: string;
  sequence: number;
  fromState: EvidenceGenerationState;
  toState: EvidenceGenerationState;
  reasonCodes: readonly string[];
  evidenceRootHash: string;
  modelVersion: string;
  recordedAt: string;
  writerInstance: string;
}

export interface SeenOrderRecord {
  sweepId: string;
  orderHash: string;
  pageNumber: number;
  rawPageHash: string;
  normalizedMaterialHash: string;
}

export interface CatchUpRoundRecord {
  sweepId: string;
  roundNumber: number;
  eventId: string;
  receivedAt: string;
  pendingCount: number;
  processingCount: number;
  failedCount: number;
  reconciliationRequiredCount: number;
  unknownCount: number;
  observationProvenance: Readonly<Record<string, string>>;
}

export interface EvidenceReadResult {
  readonly status: "COMPLETE" | "INCOMPLETE" | "CORRUPT" | "CONFLICTED";
  readonly manifest: Readonly<RootManifest> | null;
  readonly artifacts: readonly ArtifactRef[];
  readonly transitions: readonly TransitionRecord[];
  readonly reasons: readonly string[];
}

export interface GenerationEvidenceReader {
  readGeneration(): Promise<EvidenceReadResult>;
  listArtifacts(): Promise<readonly ArtifactRef[]>;
  readArtifact(ref: ArtifactRef): Promise<ReadonlyArray<number>>;
  getSeenOrders(): Promise<readonly SeenOrderRecord[]>;
  getCatchUpRounds(): Promise<readonly CatchUpRoundRecord[]>;
  getTransitions(): Promise<readonly TransitionRecord[]>;
}

export interface GenerationEvidenceWriter extends GenerationEvidenceReader {
  writeArtifact(input: { artifactType: EvidenceArtifactType; artifactId: string; relativePath: string; schemaVersion?: string; payload: unknown }): Promise<ArtifactRef>;
  finalizeManifest(input?: { writerProvenance?: Readonly<Record<string, string>> }): Promise<Readonly<RootManifest>>;
}
