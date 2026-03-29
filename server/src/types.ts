export type EntityType =
  | "NaturalPerson"
  | "Organization"
  | "VirtualAsset"
  | "ProcedureEntity"
  | "FactClaim";

export type RelationStatus =
  | "SYSTEM_GENERATED"
  | "CONFIRMED"
  | "DISPUTED"
  | "PENDING_EVIDENCE";

export type ReviewStatus = "UNREVIEWED" | "CONFIRMED" | "UPDATED";
export type Stance = "COMBINED" | "PLAINTIFF" | "DEFENDANT" | "COURT";
export type TaskStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "CANCELLED";

export interface SourceRecord {
  sourceId: string;
  documentId: string;
  documentType: string;
  sourceParty: string;
  paragraph: string;
  page: number;
  text: string;
  confidence: number;
  extractionMethod: string;
  reviewStatus: ReviewStatus;
}

export interface TimelineEvent {
  eventId: string;
  title: string;
  date: string;
  summary: string;
  relatedEntityIds: string[];
  relatedRelationIds: string[];
}

export interface EntityRecord {
  entityId: string;
  entityType: EntityType;
  entitySubtype: string;
  displayName: string;
  tags: string[];
  x: number;
  y: number;
  layoutLocked?: boolean;
  attributes: Record<string, string>;
  sourceIds: string[];
  confirmed: boolean;
}

export interface RelationRecord {
  relationId: string;
  headEntityId: string;
  relationType: string;
  relationName: string;
  tailEntityId: string;
  status: RelationStatus;
  confidence: number;
  sourceIds: string[];
  stance: Stance;
  attributes: Record<string, string>;
}

export interface VersionRecord {
  versionId: string;
  versionType: "AUTO" | "REVIEWED";
  label: string;
  createdAt: string;
  createdBy: string;
  isPublished: boolean;
  triggerSource?: string;
  documentCount?: number;
  documentSummary?: string;
  documentChangeSummary?: string;
  documentSnapshot?: Array<{
    documentId: string;
    documentType: string;
    originalName: string;
    sourceParty: string;
  }>;
}

export interface TaskRecord {
  taskId: string;
  caseId: string;
  status: TaskStatus;
  progress: number;
  currentStage: string;
  versionId: string;
  errorMessage?: string;
  cancelRequested?: boolean;
}

export interface ReviewLogRecord {
  reviewId: string;
  targetType: "entity" | "relation";
  targetId: string;
  actionType: string;
  operator: string;
  operatedAt: string;
  beforeValue: string;
  afterValue: string;
}

export interface UploadedDocument {
  documentId: string;
  caseId: string;
  fileName: string;
  originalName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  filePath: string;
  documentType: string;
  sourceParty: string;
  parseStatus: "UPLOADED" | "PARSED" | "FAILED";
  parseError?: string;
  textContent?: string;
  chunkCount?: number;
  latestTaskId?: string;
  latestTaskStatus?: TaskStatus;
  latestTaskStage?: string;
  latestTaskError?: string;
}

export interface DemoCase {
  caseId: string;
  caseNo: string;
  caseName: string;
  caseType: string;
  trialStage: string;
  stance: Stance;
  versions: VersionRecord[];
  currentVersionId: string;
  entities: EntityRecord[];
  relations: RelationRecord[];
  sources: SourceRecord[];
  timeline: TimelineEvent[];
  tasks: TaskRecord[];
  reviewLogs: ReviewLogRecord[];
  documents: UploadedDocument[];
}

export interface DemoState {
  cases: Record<string, DemoCase>;
}

export interface ExtractedChunk {
  chunkId: string;
  text: string;
  paragraph: string;
  page: number;
}

export interface PipelineDocument {
  document: UploadedDocument;
  text: string;
  chunks: ExtractedChunk[];
}

export interface PipelineOutput {
  entities: EntityRecord[];
  relations: RelationRecord[];
  sources: SourceRecord[];
  timeline: TimelineEvent[];
  warnings: string[];
}
