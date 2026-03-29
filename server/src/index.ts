import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { getAIConfig, isAIConfigured } from "./aiConfig";
import {
  compareVersionSnapshots,
  getStorageStats,
  listCaseEntities,
  listCaseRelations,
  listCases,
} from "./db";
import { runExtractionPipeline } from "./extraction";
import {
  appendReviewLog,
  buildVersionDocumentSnapshot,
  buildVersionMaterialChangeSummary,
  createTask,
  getCaseById,
  inferVersionTriggerSource,
  initializeStateStorage,
  persistCaseState,
  publishVersion,
  summarizeVersionDocuments,
} from "./state";
import type { DemoCase, Stance, UploadedDocument } from "./types";

const uploadDir = path.resolve(process.cwd(), "uploads");
void fs.mkdir(uploadDir, { recursive: true });
const EXTRACTION_TIMEOUT_MS = Number(process.env.EXTRACTION_TIMEOUT_MS ?? 180000);

const upload = multer({ dest: uploadDir });

const taskSchema = z.object({
  documentIds: z.array(z.string()).min(1).optional(),
  taskType: z.string().default("full_extract"),
  versionDescription: z.string().default("手动发起图谱重跑"),
  triggerSource: z.string().default("manual"),
});

const patchEntitySchema = z.object({
  displayName: z.string().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  reviewComment: z.string().default("人工修改实体"),
});

const patchRelationSchema = z.object({
  relationType: z.string().optional(),
  relationName: z.string().optional(),
  status: z
    .enum(["SYSTEM_GENERATED", "CONFIRMED", "DISPUTED", "PENDING_EVIDENCE"])
    .optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  reviewComment: z.string().default("人工修改关系"),
});

const mergeEntitySchema = z.object({
  sourceEntityIds: z.array(z.string()).min(2),
  targetEntityId: z.string(),
  reviewComment: z.string().default("人工合并实体"),
});

const updateLayoutSchema = z.object({
  entities: z.array(
    z.object({
      entityId: z.string(),
      x: z.number(),
      y: z.number(),
      layoutLocked: z.boolean().optional(),
    }),
  ),
  reviewComment: z.string().default("更新图谱布局"),
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => {
  const aiConfig = getAIConfig();
  res.json({
    ok: true,
    llmConfigured: isAIConfigured(aiConfig),
    model: aiConfig.model,
    provider: aiConfig.providerLabel,
    baseURL: aiConfig.baseURL ?? null,
  });
});

app.get("/api/cases", async (req, res) => {
  const result = await listCases({
    page: req.query.page ? Number(req.query.page) : undefined,
    pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    search: typeof req.query.search === "string" ? req.query.search.trim() : undefined,
    caseType: typeof req.query.caseType === "string" ? req.query.caseType.trim() : undefined,
    trialStage: typeof req.query.trialStage === "string" ? req.query.trialStage.trim() : undefined,
  });
  res.json(result);
});

app.get("/api/storage/stats", async (_req, res) => {
  const result = await getStorageStats();
  res.json(result);
});

app.get("/api/cases/:caseId/documents", (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  res.json({
    items: caseData.documents.map((document) => ({
      documentId: document.documentId,
      originalName: normalizeUploadedFileName(document.originalName),
      mimeType: document.mimeType,
      documentType: document.documentType,
      sourceParty: document.sourceParty,
      parseStatus: document.parseStatus,
      chunkCount: document.chunkCount ?? 0,
      uploadedAt: document.uploadedAt,
      latestTaskId: document.latestTaskId ?? null,
      latestTaskStatus: document.latestTaskStatus ?? null,
      latestTaskStage: document.latestTaskStage ?? null,
      latestTaskError: document.latestTaskError ?? null,
      parseError: document.parseError ?? null,
    })),
    llmConfigured: isAIConfigured(getAIConfig()),
  });
});

app.post("/api/cases/:caseId/documents/upload", upload.array("files", 10), async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ code: "FG010", message: "未上传文件" });
    return;
  }

  const uploadedDocuments = files.map((file) => createUploadedDocument(caseData, file));
  caseData.documents.push(...uploadedDocuments);
  await persistCaseState(caseData);

  try {
    const task = await enqueueGraphRegeneration(caseData, caseData.documents, "上传卷宗后自动抽取", "UPLOAD");
    res.status(202).json({
      message: "文件上传成功，正在后台抽取",
      documents: uploadedDocuments.map((item) => ({
        documentId: item.documentId,
        originalName: normalizeUploadedFileName(item.originalName),
        documentType: item.documentType,
        parseStatus: item.parseStatus,
      })),
      warnings: [],
      taskId: task.taskId,
      versionId: task.versionId,
      status: task.status,
    });
  } catch (error) {
    uploadedDocuments.forEach((document) => {
      document.parseStatus = "FAILED";
      document.parseError = getErrorMessage(error);
    });
    await persistCaseState(caseData);
    res.status(500).json({ code: "FG020", message: getErrorMessage(error) });
  }
});

app.delete("/api/cases/:caseId/documents/:documentId", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const documentIndex = caseData.documents.findIndex((item) => item.documentId === req.params.documentId);
  if (documentIndex < 0) {
    res.status(404).json({ code: "FG009", message: "卷宗不存在" });
    return;
  }

  const document = caseData.documents[documentIndex];
  const linkedTask = document.latestTaskId
    ? caseData.tasks.find((item) => item.taskId === document.latestTaskId)
    : undefined;

  if (linkedTask?.status === "PROCESSING") {
    linkedTask.cancelRequested = true;
    linkedTask.status = "CANCELLED";
    linkedTask.progress = 100;
    linkedTask.currentStage = "卷宗已删除，任务取消";
    linkedTask.errorMessage = undefined;
  }

  caseData.documents.splice(documentIndex, 1);

  if (document.filePath) {
    await fs.rm(document.filePath, { force: true }).catch(() => undefined);
  }

  let taskId: string | null = null;
  let versionId: string | null = null;
  const shouldRefreshGraph = document.parseStatus === "PARSED";
  if (shouldRefreshGraph) {
    const remainingDocuments = caseData.documents.filter((item) => item.parseStatus === "PARSED" || item.parseStatus === "UPLOADED");
    if (remainingDocuments.length > 0) {
      const task = await enqueueGraphRegeneration(
        caseData,
        remainingDocuments,
        `删除卷宗后刷新图谱：${normalizeUploadedFileName(document.originalName)}`,
        "DELETE_REFRESH",
      );
      taskId = task.taskId;
      versionId = task.versionId;
    } else {
      caseData.entities = [];
      caseData.relations = [];
      caseData.sources = [];
      caseData.timeline = [];
      caseData.currentVersionId = "";
      await persistCaseState(caseData);
    }
  } else {
    await persistCaseState(caseData);
  }

  res.json({
    message: "卷宗已删除",
    documentId: document.documentId,
    taskId,
    versionId,
  });
});

app.post("/api/cases/:caseId/fact-graph/tasks", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const payload = taskSchema.parse(req.body);
  const selectedDocuments =
    payload.documentIds && payload.documentIds.length > 0
      ? caseData.documents.filter((document) => payload.documentIds?.includes(document.documentId))
      : caseData.documents;

  if (selectedDocuments.length === 0) {
    res.status(400).json({ code: "FG010", message: "当前案件没有可处理的卷宗" });
    return;
  }

  try {
    const task = await enqueueGraphRegeneration(
      caseData,
      selectedDocuments,
      payload.versionDescription,
      payload.triggerSource,
    );
    res.status(202).json({
      taskId: task.taskId,
      caseId: caseData.caseId,
      status: task.status,
      versionId: task.versionId,
      warnings: [],
      documentCount: selectedDocuments.length,
      triggerSource: payload.triggerSource,
    });
  } catch (error) {
    res.status(500).json({ code: "FG020", message: getErrorMessage(error) });
  }
});

app.get("/api/cases/:caseId/fact-graph/tasks/:taskId", (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const task = caseData.tasks.find((item) => item.taskId === req.params.taskId);
  if (!task) {
    res.status(404).json({ code: "FG003", message: "抽取任务不存在" });
    return;
  }

  res.json(task);
});

app.post("/api/cases/:caseId/fact-graph/tasks/:taskId/cancel", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const task = caseData.tasks.find((item) => item.taskId === req.params.taskId);
  if (!task) {
    res.status(404).json({ code: "FG003", message: "抽取任务不存在" });
    return;
  }

  if (task.status !== "PROCESSING") {
    res.status(400).json({ code: "FG011", message: "当前任务不可取消" });
    return;
  }

  task.cancelRequested = true;
  task.status = "CANCELLED";
  task.progress = 100;
  task.currentStage = "任务已取消";
  syncDocumentsWithTaskStatus(caseData, task, caseData.documents.filter((document) => document.latestTaskId === task.taskId));
  await persistCaseState(caseData);
  res.json(task);
});

app.get("/api/cases/:caseId/fact-graph", (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const stance = normalizeStance(req.query.stance);
  const relationTypes = toStringArray(req.query.relationTypes);
  const onlyDisputed = req.query.onlyDisputed === "true";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const focusEntityId = typeof req.query.focusEntityId === "string" ? req.query.focusEntityId.trim() : "";
  const focusDepth = normalizeFocusDepth(req.query.focusDepth);

  let visibleRelations = caseData.relations.filter((relation) => {
    if (stance && stance !== "COMBINED" && relation.stance !== "COMBINED" && relation.stance !== stance) {
      return false;
    }
    if (relationTypes.length > 0 && !relationTypes.includes(relation.relationType)) {
      return false;
    }
    if (onlyDisputed && relation.status !== "DISPUTED") {
      return false;
    }
    if (!search) return true;
    const head = caseData.entities.find((entity) => entity.entityId === relation.headEntityId)?.displayName ?? "";
    const tail = caseData.entities.find((entity) => entity.entityId === relation.tailEntityId)?.displayName ?? "";
    return [head, tail, relation.relationName].some((item) => item.includes(search));
  });

  let entityIds = new Set<string>();
  visibleRelations.forEach((relation) => {
    entityIds.add(relation.headEntityId);
    entityIds.add(relation.tailEntityId);
  });

  if (focusEntityId) {
    const focused = collectFocusedSubgraph(visibleRelations, focusEntityId, focusDepth);
    visibleRelations = visibleRelations.filter((relation) => focused.relationIds.has(relation.relationId));
    entityIds = focused.entityIds;
  }

  const visibleEntities = caseData.entities.filter((entity) => {
    if (entityIds.has(entity.entityId)) return true;
    return !focusEntityId && search ? entity.displayName.includes(search) : false;
  });

  res.json({
    caseId: caseData.caseId,
    caseNo: caseData.caseNo,
    caseName: caseData.caseName,
    caseType: caseData.caseType,
    trialStage: caseData.trialStage,
    versionId: caseData.currentVersionId,
    stance: stance ?? "COMBINED",
    focusEntityId: focusEntityId || null,
    focusDepth,
    nodes: visibleEntities,
    edges: visibleRelations,
  });
});

app.get("/api/cases/:caseId/fact-graph/entities", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const confirmedParam =
    typeof req.query.confirmed === "string"
      ? req.query.confirmed === "true"
        ? true
        : req.query.confirmed === "false"
          ? false
          : undefined
      : undefined;

  const result = await listCaseEntities(caseData.caseId, {
    page: req.query.page ? Number(req.query.page) : undefined,
    pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    search: typeof req.query.search === "string" ? req.query.search.trim() : undefined,
    entityType: typeof req.query.entityType === "string" ? req.query.entityType.trim() : undefined,
    confirmed: confirmedParam,
  });
  res.json(result);
});

app.get("/api/cases/:caseId/fact-graph/entities/:entityId", (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const entity = caseData.entities.find((item) => item.entityId === req.params.entityId);
  if (!entity) {
    res.status(404).json({ code: "FG006", message: "实体不存在" });
    return;
  }

  res.json({
    ...entity,
    sources: uniqueBy(
      entity.sourceIds
        .map((sourceId) => caseData.sources.find((source) => source.sourceId === sourceId))
        .filter((source): source is NonNullable<typeof source> => Boolean(source)),
      (source) => `${source.documentType}-${source.sourceParty}-${source.page}-${source.paragraph}-${source.text}`,
    ),
    relations: caseData.relations.filter(
      (relation) => relation.headEntityId === entity.entityId || relation.tailEntityId === entity.entityId,
    ),
    reviewLogs: caseData.reviewLogs.filter(
      (reviewLog) => reviewLog.targetType === "entity" && reviewLog.targetId === entity.entityId,
    ),
  });
});

app.get("/api/cases/:caseId/fact-graph/relations", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const result = await listCaseRelations(caseData.caseId, {
    page: req.query.page ? Number(req.query.page) : undefined,
    pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    search: typeof req.query.search === "string" ? req.query.search.trim() : undefined,
    relationType: typeof req.query.relationType === "string" ? req.query.relationType.trim() : undefined,
    status: typeof req.query.status === "string" ? req.query.status.trim() : undefined,
    stance: normalizeStance(req.query.stance),
  });
  res.json(result);
});

app.get("/api/cases/:caseId/fact-graph/relations/:relationId", (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const relation = caseData.relations.find((item) => item.relationId === req.params.relationId);
  if (!relation) {
    res.status(404).json({ code: "FG007", message: "关系不存在" });
    return;
  }

  res.json({
    ...relation,
    headEntity: caseData.entities.find((entity) => entity.entityId === relation.headEntityId),
    tailEntity: caseData.entities.find((entity) => entity.entityId === relation.tailEntityId),
    sources: uniqueBy(
      relation.sourceIds
        .map((sourceId) => caseData.sources.find((source) => source.sourceId === sourceId))
        .filter((source): source is NonNullable<typeof source> => Boolean(source)),
      (source) => `${source.documentType}-${source.sourceParty}-${source.page}-${source.paragraph}-${source.text}`,
    ),
    reviewLogs: caseData.reviewLogs.filter(
      (reviewLog) => reviewLog.targetType === "relation" && reviewLog.targetId === relation.relationId,
    ),
  });
});

app.get("/api/cases/:caseId/fact-graph/sources/:sourceId", (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const source = caseData.sources.find((item) => item.sourceId === req.params.sourceId);
  if (!source) {
    res.status(404).json({ code: "FG008", message: "来源不存在" });
    return;
  }

  res.json({
    ...source,
    relatedEntities: caseData.entities.filter((entity) => entity.sourceIds.includes(source.sourceId)),
    relatedRelations: caseData.relations.filter((relation) => relation.sourceIds.includes(source.sourceId)),
  });
});

app.get("/api/cases/:caseId/fact-graph/views", (_req, res) => {
  res.json([
    { id: "all", label: "综合全景视图" },
    { id: "people", label: "人物关系视图" },
    { id: "funds", label: "资金关系视图" },
    { id: "control", label: "公司控制视图" },
    { id: "assets", label: "涉案财产视图" },
  ]);
});

app.get("/api/cases/:caseId/fact-graph/versions", (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }
  res.json(caseData.versions);
});

app.get("/api/cases/:caseId/fact-graph/versions/compare", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const left = typeof req.query.left === "string" ? req.query.left : "";
  const right = typeof req.query.right === "string" ? req.query.right : "";
  if (!left || !right) {
    res.status(400).json({ code: "FG010", message: "缺少版本对比参数 left/right" });
    return;
  }

  const diff = await compareVersionSnapshots(caseData.caseId, left, right);
  if (!diff) {
    res.status(404).json({ code: "FG005", message: "版本快照不存在，无法对比" });
    return;
  }

  res.json(diff);
});

app.get("/api/cases/:caseId/fact-graph/timeline", (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }
  res.json(caseData.timeline);
});

app.get("/api/cases/:caseId/fact-graph/stats", (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  res.json({
    entityCount: caseData.entities.length,
    relationCount: caseData.relations.length,
    confirmedRelationCount: caseData.relations.filter((item) => item.status === "CONFIRMED").length,
    disputedRelationCount: caseData.relations.filter((item) => item.status === "DISPUTED").length,
    lowConfidenceRelationCount: caseData.relations.filter((item) => item.confidence < 0.7).length,
    sourceCoverageRate: caseData.sources.length > 0 ? "100%" : "0%",
  });
});

app.post("/api/cases/:caseId/fact-graph/entities/:entityId/confirm", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const entity = caseData.entities.find((item) => item.entityId === req.params.entityId);
  if (!entity) {
    res.status(404).json({ code: "FG006", message: "实体不存在" });
    return;
  }

  const before = JSON.stringify(entity);
  entity.confirmed = true;
  entity.tags = Array.from(new Set([...entity.tags, "已确认"]));
  appendReviewLog(caseData, "entity", entity.entityId, "confirm_entity", before, JSON.stringify(entity));
  await persistCaseState(caseData);
  res.json(entity);
});

app.patch("/api/cases/:caseId/fact-graph/entities/:entityId", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const entity = caseData.entities.find((item) => item.entityId === req.params.entityId);
  if (!entity) {
    res.status(404).json({ code: "FG006", message: "实体不存在" });
    return;
  }

  const payload = patchEntitySchema.parse(req.body);
  const before = JSON.stringify(entity);
  if (payload.displayName) entity.displayName = payload.displayName;
  if (payload.attributes) entity.attributes = { ...entity.attributes, ...payload.attributes };
  appendReviewLog(caseData, "entity", entity.entityId, payload.reviewComment, before, JSON.stringify(entity));
  await persistCaseState(caseData);
  res.json(entity);
});

app.post("/api/cases/:caseId/fact-graph/layout", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const payload = updateLayoutSchema.parse(req.body);
  const entityMap = new Map(caseData.entities.map((entity) => [entity.entityId, entity]));
  const before = JSON.stringify(
    payload.entities.map((item) => {
      const entity = entityMap.get(item.entityId);
      return entity
        ? { entityId: entity.entityId, x: entity.x, y: entity.y, layoutLocked: entity.layoutLocked ?? false }
        : item;
    }),
  );

  payload.entities.forEach((item) => {
    const entity = entityMap.get(item.entityId);
    if (!entity) return;
    entity.x = Math.round(item.x);
    entity.y = Math.round(item.y);
    if (typeof item.layoutLocked === "boolean") {
      entity.layoutLocked = item.layoutLocked;
    }
  });

  appendReviewLog(caseData, "entity", "graph_layout", payload.reviewComment, before, JSON.stringify(payload.entities));
  await persistCaseState(caseData);
  res.json({
    updated: payload.entities.length,
    entities: payload.entities,
  });
});

app.post("/api/cases/:caseId/fact-graph/entities/merge", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const payload = mergeEntitySchema.parse(req.body);
  const target = caseData.entities.find((item) => item.entityId === payload.targetEntityId);
  if (!target) {
    res.status(404).json({ code: "FG006", message: "目标实体不存在" });
    return;
  }

  payload.sourceEntityIds
    .filter((entityId) => entityId !== target.entityId)
    .forEach((entityId) => {
      const source = caseData.entities.find((item) => item.entityId === entityId);
      if (!source) return;
      target.tags = Array.from(new Set([...target.tags, ...source.tags]));
      target.sourceIds = Array.from(new Set([...target.sourceIds, ...source.sourceIds]));
      target.attributes = { ...source.attributes, ...target.attributes };
      caseData.relations.forEach((relation) => {
        if (relation.headEntityId === source.entityId) relation.headEntityId = target.entityId;
        if (relation.tailEntityId === source.entityId) relation.tailEntityId = target.entityId;
      });
      caseData.entities = caseData.entities.filter((item) => item.entityId !== source.entityId);
    });

  appendReviewLog(caseData, "entity", target.entityId, payload.reviewComment, "merge", JSON.stringify(target));
  await persistCaseState(caseData);
  res.json(target);
});

app.post("/api/cases/:caseId/fact-graph/relations/:relationId/confirm", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const relation = caseData.relations.find((item) => item.relationId === req.params.relationId);
  if (!relation) {
    res.status(404).json({ code: "FG007", message: "关系不存在" });
    return;
  }

  const before = JSON.stringify(relation);
  relation.status = "CONFIRMED";
  relation.confidence = Math.max(relation.confidence, 0.92);
  appendReviewLog(caseData, "relation", relation.relationId, "confirm_relation", before, JSON.stringify(relation));
  await persistCaseState(caseData);
  res.json(relation);
});

app.patch("/api/cases/:caseId/fact-graph/relations/:relationId", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const relation = caseData.relations.find((item) => item.relationId === req.params.relationId);
  if (!relation) {
    res.status(404).json({ code: "FG007", message: "关系不存在" });
    return;
  }

  const payload = patchRelationSchema.parse(req.body);
  const before = JSON.stringify(relation);
  if (payload.relationType) relation.relationType = payload.relationType;
  if (payload.relationName) relation.relationName = payload.relationName;
  if (payload.status) relation.status = payload.status;
  if (payload.attributes) relation.attributes = { ...relation.attributes, ...payload.attributes };
  appendReviewLog(caseData, "relation", relation.relationId, payload.reviewComment, before, JSON.stringify(relation));
  await persistCaseState(caseData);
  res.json(relation);
});

app.post("/api/cases/:caseId/fact-graph/versions/:versionId/publish", async (req, res) => {
  const caseData = getCase(req.params.caseId);
  if (!caseData) {
    res.status(404).json({ code: "FG001", message: "案件不存在" });
    return;
  }

  const version = caseData.versions.find((item) => item.versionId === req.params.versionId);
  if (!version) {
    res.status(404).json({ code: "FG005", message: "图谱版本不存在" });
    return;
  }

  caseData.versions = caseData.versions.map((item) => ({
    ...item,
    isPublished: item.versionId === version.versionId,
  }));
  caseData.currentVersionId = version.versionId;
  await persistCaseState(caseData);
  res.json(version);
});

function getCase(caseId: unknown) {
  return getCaseById(String(caseId));
}

const port = Number(process.env.PORT ?? 3001);
void bootstrap();

async function bootstrap() {
  await initializeStateStorage();
  app.listen(port, () => {
    console.log(`Fact graph demo server listening on http://localhost:${port}`);
  });
}

async function enqueueGraphRegeneration(
  caseData: DemoCase,
  documents: UploadedDocument[],
  versionLabel: string,
  triggerSource?: string,
) {
  const nextVersionId = `ver_${Date.now()}`;
  const previousVersion =
    caseData.versions.find((item) => item.versionId === caseData.currentVersionId) ??
    caseData.versions.find((item) => item.isPublished);
  const nextDocumentSnapshot = buildVersionDocumentSnapshot(documents);
  const resolvedTriggerSource = triggerSource ?? inferVersionTriggerSource(versionLabel);
  const nextVersionRecord = {
    versionId: nextVersionId,
    versionType: "AUTO" as const,
    label: versionLabel,
    createdAt: new Date().toISOString(),
    createdBy: "system",
    isPublished: true,
    triggerSource: resolvedTriggerSource,
    documentCount: nextDocumentSnapshot.length,
    documentSummary: summarizeVersionDocuments(nextDocumentSnapshot),
    documentChangeSummary: buildVersionMaterialChangeSummary(
      previousVersion?.documentSnapshot,
      nextDocumentSnapshot,
      resolvedTriggerSource,
    ),
    documentSnapshot: nextDocumentSnapshot,
  };
  const task = createTask(caseData.caseId, nextVersionId, "卷宗解析与图谱抽取中");
  caseData.tasks.unshift(task);
  syncDocumentsWithTaskStatus(caseData, task, documents);
  await persistCaseState(caseData);
  void runGraphRegeneration(caseData, documents, task, nextVersionRecord);
  return task;
}

async function runGraphRegeneration(
  caseData: DemoCase,
  documents: UploadedDocument[],
  task: DemoCase["tasks"][number],
  nextVersionRecord: DemoCase["versions"][number],
) {
  const timeoutHandle = setTimeout(() => {
    if (task.status !== "PROCESSING") return;
    task.status = "FAILED";
    task.progress = 100;
    task.currentStage = "图谱抽取超时";
    task.errorMessage = `抽取耗时超过 ${Math.round(EXTRACTION_TIMEOUT_MS / 1000)} 秒，请拆分文书后重试。`;
    syncDocumentsWithTaskStatus(caseData, task, documents);
    void persistCaseState(caseData);
  }, EXTRACTION_TIMEOUT_MS);

  try {
    const result = await runExtractionPipeline(caseData, documents);
    if (task.status !== "PROCESSING" || task.cancelRequested) {
      clearTimeout(timeoutHandle);
      return;
    }
    caseData.entities = result.entities;
    caseData.relations = result.relations;
    caseData.sources = result.sources;
    caseData.timeline = result.timeline;
    refreshCaseMetadata(caseData);

    task.status = "SUCCESS";
    task.progress = 100;
    task.currentStage = result.warnings.length > 0 ? result.warnings.join("；") : "图谱抽取完成";
    task.errorMessage = undefined;
    syncDocumentsWithTaskStatus(caseData, task, documents);

    publishVersion(caseData, nextVersionRecord);
    await persistCaseState(caseData, nextVersionRecord.versionId);
    clearTimeout(timeoutHandle);

    return result;
  } catch (error) {
    clearTimeout(timeoutHandle);
    if (task.status !== "PROCESSING") {
      return;
    }
    task.status = "FAILED";
    task.progress = 100;
    task.currentStage = "图谱抽取失败";
    task.errorMessage = getErrorMessage(error);
    syncDocumentsWithTaskStatus(caseData, task, documents);
    await persistCaseState(caseData);
  }
}

function createUploadedDocument(caseData: DemoCase, file: Express.Multer.File): UploadedDocument {
  const originalName = normalizeUploadedFileName(file.originalname);
  return {
    documentId: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    caseId: caseData.caseId,
    fileName: file.filename,
    originalName,
    mimeType: file.mimetype,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    filePath: file.path,
    documentType: detectDocumentType(originalName),
    sourceParty: detectSourceParty(originalName),
    parseStatus: "UPLOADED",
  };
}

function detectDocumentType(fileName: string) {
  if (fileName.includes("起诉")) return "起诉状";
  if (fileName.includes("答辩")) return "答辩状";
  if (fileName.includes("上诉")) return "上诉状";
  if (fileName.includes("合同")) return "合同";
  if (fileName.includes("证据")) return "证据材料";
  return "卷宗材料";
}

function detectSourceParty(fileName: string) {
  if (fileName.includes("原告")) return "原告";
  if (fileName.includes("被告")) return "被告";
  if (fileName.includes("上诉人")) return "上诉人";
  return "案件材料";
}

function normalizeStance(value: unknown): Stance | undefined {
  if (typeof value !== "string") return undefined;
  const allowed: Stance[] = ["COMBINED", "PLAINTIFF", "DEFENDANT", "COURT"];
  return allowed.includes(value as Stance) ? (value as Stance) : undefined;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}

function syncDocumentsWithTaskStatus(
  caseData: DemoCase,
  task: DemoCase["tasks"][number],
  documents: UploadedDocument[],
) {
  const documentIds = new Set(documents.map((document) => document.documentId));
  caseData.documents.forEach((document) => {
    if (!documentIds.has(document.documentId)) return;
    document.latestTaskId = task.taskId;
    document.latestTaskStatus = task.status;
    document.latestTaskStage = task.currentStage;
    document.latestTaskError = task.errorMessage;
  });
}

function normalizeUploadedFileName(fileName: string) {
  if (!looksLikeMojibake(fileName)) {
    return fileName;
  }

  try {
    const decoded = Buffer.from(fileName, "latin1").toString("utf8");
    return countChineseChars(decoded) > countChineseChars(fileName) ? decoded : fileName;
  } catch {
    return fileName;
  }
}

function looksLikeMojibake(fileName: string) {
  return /[ÃÂÐÑØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö]/.test(fileName);
}

function countChineseChars(value: string) {
  const matches = value.match(/[\u4e00-\u9fff]/g);
  return matches?.length ?? 0;
}

function refreshCaseMetadata(caseData: DemoCase) {
  const parsedDocuments = caseData.documents.filter((document) => document.parseStatus === "PARSED");
  if (parsedDocuments.length === 0) {
    return;
  }

  const combinedText = parsedDocuments
    .map((document) => document.textContent?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const combinedNames = parsedDocuments.map((document) => normalizeUploadedFileName(document.originalName)).join("\n");
  const searchableText = `${combinedNames}\n${combinedText}`;

  const inferredCaseNo = extractCaseNo(searchableText);
  const inferredCaseType = inferCaseType(searchableText, inferredCaseNo);
  const inferredTrialStage = inferTrialStage(searchableText, inferredCaseNo);
  const inferredCause = extractCaseCause(combinedNames, combinedText);
  const primaryPlaintiff = caseData.entities.find((entity) => entity.entitySubtype === "Plaintiff")?.displayName;
  const primaryDefendant = caseData.entities.find((entity) => entity.entitySubtype === "Defendant")?.displayName;

  if (inferredCaseNo) {
    caseData.caseNo = inferredCaseNo;
  }
  if (inferredCaseType) {
    caseData.caseType = inferredCaseType;
  }
  if (inferredTrialStage) {
    caseData.trialStage = inferredTrialStage;
  }

  const inferredCaseName = buildCaseName(primaryPlaintiff, primaryDefendant, inferredCause);
  if (inferredCaseName) {
    caseData.caseName = inferredCaseName;
  }
}

function extractCaseNo(text: string) {
  const match = text.match(/[（(]\d{4}[)）][^\n]{2,24}?号/);
  return match?.[0]?.replace(/\s+/g, "");
}

function inferCaseType(text: string, caseNo: string | undefined) {
  const headerText = text.slice(0, 240);
  if (caseNo?.includes("刑")) return "刑事";
  if (caseNo?.includes("行")) return "行政";
  if (caseNo?.includes("执")) return "执行";
  if (caseNo?.includes("民")) return "民事";
  if (/刑\s*事\s*(判决书|裁定书|调解书)|刑事/.test(headerText)) return "刑事";
  if (/行\s*政\s*(判决书|裁定书|调解书)|行政诉讼/.test(headerText)) return "行政";
  if (/执\s*行\s*(裁定书|通知书)|执行案件/.test(headerText)) return "执行";
  if (/民\s*事\s*(判决书|裁定书|调解书)|民事/.test(headerText)) return "民事";
  return "";
}

function inferTrialStage(text: string, caseNo: string | undefined) {
  const target = `${caseNo ?? ""}\n${text}`;
  if (/再审|申诉/.test(target)) return "再审";
  if (/终\d*号|上诉人|被上诉人|二审/.test(target)) return "二审";
  if (/初\d*号|原告|被告|一审/.test(target)) return "一审";
  return "";
}

function extractCaseCause(fileNames: string, text: string) {
  const fromFileName =
    fileNames.match(/([\u4e00-\u9fff]{2,16}纠纷)(?:.*?(判决书|裁定书|调解书|决定书)|$)/)?.[1] ??
    text.match(/因与[^。\n]{0,20}?([\u4e00-\u9fff]{2,16}纠纷)一案/)?.[1];
  if (fromFileName) {
    return normalizeCaseCause(fromFileName);
  }

  const matches = (text.match(/[\u4e00-\u9fff]{2,20}纠纷/g) ?? [])
    .map(normalizeCaseCause)
    .filter(Boolean);
  if (matches.length === 0) {
    return "";
  }

  return matches.sort((left, right) => left.length - right.length)[0] ?? "";
}

function buildCaseName(plaintiff: string | undefined, defendant: string | undefined, cause: string) {
  if (plaintiff && defendant && cause) {
    return `${plaintiff}诉${defendant}${cause}`;
  }
  if (plaintiff && defendant) {
    return `${plaintiff}诉${defendant}`;
  }
  return cause;
}

function normalizeCaseCause(value: string) {
  return value
    .replace(/^[\u4e00-\u9fff]{2,16}(?=民间借贷纠纷|买卖合同纠纷|借款合同纠纷|股权纠纷|离婚纠纷|劳动争议|执行异议之诉)/, "")
    .replace(/民法典施行前的法律事实引起的/g, "")
    .trim();
}

function normalizeFocusDepth(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(2, Math.max(1, Math.round(parsed)));
}

function collectFocusedSubgraph(
  relations: DemoCase["relations"],
  focusEntityId: string,
  depth: number,
) {
  const adjacency = new Map<string, DemoCase["relations"]>();
  relations.forEach((relation) => {
    const headList = adjacency.get(relation.headEntityId) ?? [];
    headList.push(relation);
    adjacency.set(relation.headEntityId, headList);

    const tailList = adjacency.get(relation.tailEntityId) ?? [];
    tailList.push(relation);
    adjacency.set(relation.tailEntityId, tailList);
  });

  const entityIds = new Set<string>([focusEntityId]);
  const relationIds = new Set<string>();
  let frontier = new Set<string>([focusEntityId]);

  for (let step = 0; step < depth; step += 1) {
    const nextFrontier = new Set<string>();
    frontier.forEach((entityId) => {
      const connectedRelations = adjacency.get(entityId) ?? [];
      connectedRelations.forEach((relation) => {
        relationIds.add(relation.relationId);
        const neighborId = relation.headEntityId === entityId ? relation.tailEntityId : relation.headEntityId;
        if (!entityIds.has(neighborId)) {
          entityIds.add(neighborId);
          nextFrontier.add(neighborId);
        }
      });
    });
    frontier = nextFrontier;
  }

  return { entityIds, relationIds };
}

function uniqueBy<T>(items: T[], buildKey: (item: T) => string) {
  const map = new Map<string, T>();
  items.forEach((item) => {
    map.set(buildKey(item), item);
  });
  return Array.from(map.values());
}
