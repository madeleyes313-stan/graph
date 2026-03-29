export interface EntityNode {
  entityId: string;
  entityType: string;
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

export interface RelationEdge {
  relationId: string;
  headEntityId: string;
  relationType: string;
  relationName: string;
  tailEntityId: string;
  status: "SYSTEM_GENERATED" | "CONFIRMED" | "DISPUTED" | "PENDING_EVIDENCE";
  confidence: number;
  sourceIds: string[];
  stance: "COMBINED" | "PLAINTIFF" | "DEFENDANT" | "COURT";
  attributes: Record<string, string>;
}

export interface SourceDetail {
  sourceId: string;
  documentId: string;
  documentType: string;
  sourceParty: string;
  paragraph: string;
  page: number;
  text: string;
  confidence: number;
  extractionMethod: string;
  reviewStatus: string;
}

export interface GraphResponse {
  caseId: string;
  caseNo: string;
  caseName: string;
  caseType: string;
  trialStage: string;
  versionId: string;
  stance: "COMBINED" | "PLAINTIFF" | "DEFENDANT" | "COURT";
  focusEntityId?: string | null;
  focusDepth?: number;
  nodes: EntityNode[];
  edges: RelationEdge[];
}

export interface EntityDetail extends EntityNode {
  sources: SourceDetail[];
  relations: RelationEdge[];
  reviewLogs: ReviewLog[];
}

export interface RelationDetail extends RelationEdge {
  headEntity: EntityNode;
  tailEntity: EntityNode;
  sources: SourceDetail[];
  reviewLogs: ReviewLog[];
}

export interface TimelineEvent {
  eventId: string;
  title: string;
  date: string;
  summary: string;
  relatedEntityIds: string[];
  relatedRelationIds: string[];
}

export interface VersionRecord {
  versionId: string;
  versionType: string;
  label: string;
  createdAt: string;
  createdBy: string;
  isPublished: boolean;
  triggerSource?: string;
  documentCount?: number;
  documentSummary?: string;
  documentChangeSummary?: string;
}

export interface VersionCompareEntity {
  entityId: string;
  displayName: string;
  entityType: string;
  entitySubtype: string;
  tags: string[];
  attributes: Record<string, string>;
}

export interface VersionCompareRelation {
  relationId: string;
  head: string;
  relationType: string;
  relationName: string;
  tail: string;
  status: string;
  stance: string;
  attributes: Record<string, string>;
}

export interface VersionCompareChanged<T> {
  key: string;
  before: T;
  after: T;
}

export interface VersionCompareResponse {
  leftVersionId: string;
  rightVersionId: string;
  entityDiff: {
    added: VersionCompareEntity[];
    removed: VersionCompareEntity[];
    changed: Array<VersionCompareChanged<VersionCompareEntity>>;
  };
  relationDiff: {
    added: VersionCompareRelation[];
    removed: VersionCompareRelation[];
    changed: Array<VersionCompareChanged<VersionCompareRelation>>;
  };
}

export interface ReviewLog {
  reviewId: string;
  targetType: "entity" | "relation";
  targetId: string;
  actionType: string;
  operator: string;
  operatedAt: string;
  beforeValue: string;
  afterValue: string;
}

export interface GraphStats {
  entityCount: number;
  relationCount: number;
  confirmedRelationCount: number;
  disputedRelationCount: number;
  lowConfidenceRelationCount: number;
  sourceCoverageRate: string;
}

export interface ViewOption {
  id: string;
  label: string;
}

export interface CaseSummary {
  caseId: string;
  caseNo: string;
  caseName: string;
  caseType: string;
  trialStage: string;
  stance: string;
  currentVersionId: string;
  entityCount: number;
  relationCount: number;
  disputedRelationCount: number;
  documentCount: number;
  updatedAt: string;
}

export interface CaseListResponse {
  items: CaseSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface EntityListResponse {
  items: EntityNode[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface DocumentSummary {
  documentId: string;
  originalName: string;
  mimeType: string;
  documentType: string;
  sourceParty: string;
  parseStatus: string;
  chunkCount: number;
  uploadedAt: string;
  latestTaskId: string | null;
  latestTaskStatus: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "CANCELLED" | null;
  latestTaskStage: string | null;
  latestTaskError: string | null;
  parseError: string | null;
}

export interface DocumentListResponse {
  items: DocumentSummary[];
  llmConfigured: boolean;
}

export interface HealthResponse {
  ok: boolean;
  llmConfigured: boolean;
  model: string;
  provider?: string;
  baseURL?: string | null;
}

export interface TaskResponse {
  taskId: string;
  caseId: string;
  status: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "CANCELLED";
  progress: number;
  currentStage: string;
  versionId: string;
  errorMessage?: string;
}

export interface UploadResponse {
  message: string;
  versionId: string;
  warnings: string[];
  taskId: string;
  status: string;
}

export interface DeleteDocumentResponse {
  message: string;
  documentId: string;
  taskId: string | null;
  versionId: string | null;
}

export interface GraphLayoutUpdateResponse {
  updated: number;
  entities: Array<{
    entityId: string;
    x: number;
    y: number;
    layoutLocked?: boolean;
  }>;
}
