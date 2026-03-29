import type {
  CaseListResponse,
  DocumentListResponse,
  DeleteDocumentResponse,
  EntityDetail,
  EntityListResponse,
  GraphResponse,
  GraphLayoutUpdateResponse,
  GraphStats,
  HealthResponse,
  RelationDetail,
  TaskResponse,
  TimelineEvent,
  UploadResponse,
  VersionCompareResponse,
  VersionRecord,
  ViewOption,
} from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, "");

function apiPath(path: string) {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "请求失败");
  }

  return response.json() as Promise<T>;
}

export function fetchCases() {
  return request<CaseListResponse>(apiPath("/cases"));
}

export async function fetchGraph(params: {
  caseId: string;
  stance: string;
  search: string;
  relationTypes: string[];
  onlyDisputed: boolean;
  focusEntityId?: string;
  focusDepth?: number;
}) {
  const searchParams = new URLSearchParams();
  searchParams.set("stance", params.stance);
  if (params.search.trim()) {
    searchParams.set("search", params.search.trim());
  }
  if (params.relationTypes.length > 0) {
    searchParams.set("relationTypes", params.relationTypes.join(","));
  }
  if (params.onlyDisputed) {
    searchParams.set("onlyDisputed", "true");
  }
  if (params.focusEntityId) {
    searchParams.set("focusEntityId", params.focusEntityId);
  }
  if (params.focusDepth) {
    searchParams.set("focusDepth", String(params.focusDepth));
  }

  return request<GraphResponse>(apiPath(`/cases/${params.caseId}/fact-graph?${searchParams.toString()}`));
}

export function fetchHealth() {
  return request<HealthResponse>(apiPath("/health"));
}

export function fetchDocuments(caseId: string) {
  return request<DocumentListResponse>(apiPath(`/cases/${caseId}/documents`));
}

export function deleteDocument(caseId: string, documentId: string) {
  return request<DeleteDocumentResponse>(apiPath(`/cases/${caseId}/documents/${documentId}`), {
    method: "DELETE",
  });
}

export function fetchEntityDetail(caseId: string, entityId: string) {
  return request<EntityDetail>(apiPath(`/cases/${caseId}/fact-graph/entities/${entityId}`));
}

export function fetchEntities(caseId: string, pageSize = 200) {
  return request<EntityListResponse>(apiPath(`/cases/${caseId}/fact-graph/entities?page=1&pageSize=${pageSize}`));
}

export function fetchRelationDetail(caseId: string, relationId: string) {
  return request<RelationDetail>(apiPath(`/cases/${caseId}/fact-graph/relations/${relationId}`));
}

export function fetchTimeline(caseId: string) {
  return request<TimelineEvent[]>(apiPath(`/cases/${caseId}/fact-graph/timeline`));
}

export function fetchVersions(caseId: string) {
  return request<VersionRecord[]>(apiPath(`/cases/${caseId}/fact-graph/versions`));
}

export function fetchVersionCompare(caseId: string, leftVersionId: string, rightVersionId: string) {
  const searchParams = new URLSearchParams({
    left: leftVersionId,
    right: rightVersionId,
  });
  return request<VersionCompareResponse>(
    apiPath(`/cases/${caseId}/fact-graph/versions/compare?${searchParams.toString()}`),
  );
}

export function fetchStats(caseId: string) {
  return request<GraphStats>(apiPath(`/cases/${caseId}/fact-graph/stats`));
}

export function fetchViews(caseId: string) {
  return request<ViewOption[]>(apiPath(`/cases/${caseId}/fact-graph/views`));
}

export function createExtractTask(caseId: string) {
  return request<{ taskId: string; versionId: string; status: string }>(apiPath(`/cases/${caseId}/fact-graph/tasks`), {
    method: "POST",
    body: JSON.stringify({
      taskType: "full_extract",
      versionDescription: "手动重跑后的自动版本",
      triggerSource: "RERUN",
    }),
  });
}

export function fetchTask(caseId: string, taskId: string) {
  return request<TaskResponse>(apiPath(`/cases/${caseId}/fact-graph/tasks/${taskId}`));
}

export function cancelTask(caseId: string, taskId: string) {
  return request<TaskResponse>(apiPath(`/cases/${caseId}/fact-graph/tasks/${taskId}/cancel`), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function uploadDocuments(caseId: string, files: File[]) {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  const response = await fetch(apiPath(`/cases/${caseId}/documents/upload`), {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "上传失败");
  }

  return response.json() as Promise<UploadResponse>;
}

export function confirmEntity(caseId: string, entityId: string) {
  return request<EntityDetail>(apiPath(`/cases/${caseId}/fact-graph/entities/${entityId}/confirm`), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function confirmRelation(caseId: string, relationId: string) {
  return request<RelationDetail>(apiPath(`/cases/${caseId}/fact-graph/relations/${relationId}/confirm`), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function publishVersion(caseId: string, versionId: string) {
  return request<VersionRecord>(apiPath(`/cases/${caseId}/fact-graph/versions/${versionId}/publish`), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function saveGraphLayout(
  caseId: string,
  entities: Array<{ entityId: string; x: number; y: number; layoutLocked?: boolean }>,
  reviewComment?: string,
) {
  return request<GraphLayoutUpdateResponse>(apiPath(`/cases/${caseId}/fact-graph/layout`), {
    method: "POST",
    body: JSON.stringify({
      entities,
      reviewComment: reviewComment ?? "保存图谱布局",
    }),
  });
}
