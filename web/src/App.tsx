import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  cancelTask,
  confirmEntity,
  confirmRelation,
  createExtractTask,
  deleteDocument,
  fetchCases,
  fetchEntities,
  fetchTask,
  fetchDocuments,
  fetchEntityDetail,
  fetchGraph,
  publishVersion,
  fetchRelationDetail,
  saveGraphLayout,
  fetchStats,
  fetchTimeline,
  fetchVersionCompare,
  uploadDocuments,
  fetchVersions,
  fetchViews,
} from "./api";
import type {
  CaseSummary,
  DocumentSummary,
  EntityDetail,
  EntityNode,
  GraphResponse,
  GraphStats,
  RelationDetail,
  RelationEdge,
  TaskResponse,
  TimelineEvent,
  VersionCompareChanged,
  VersionCompareEntity,
  VersionCompareRelation,
  VersionCompareResponse,
  VersionRecord,
  ViewOption,
} from "./types";
import "./App.css";

const viewRelationMap: Record<string, string[]> = {
  all: [],
  people: ["SPOUSE", "PARENT_CHILD", "GUARDIAN", "APPOINT_AGENT"],
  funds: ["LEND_TO", "GUARANTEE_FOR", "RECEIVE_TRANSFER", "INVESTMENT_CLAIM"],
  control: ["LEGAL_REPRESENTATIVE", "ACTUAL_CONTROLLER", "SHAREHOLDER"],
  assets: ["OWN", "USE", "OCCUPY", "MORTGAGE"],
};

const NODE_WIDTH = 176;
const NODE_HEIGHT = 108;
const NODE_HALF_WIDTH = NODE_WIDTH / 2;
const NODE_HALF_HEIGHT = NODE_HEIGHT / 2;
const NODE_GAP_X = 24;
const NODE_GAP_Y = 28;
const FULLSCREEN_FILTER_PANEL_STORAGE_KEY = "fact-graph:fullscreen-filter-collapsed";
const FULLSCREEN_FILTER_SECTIONS_STORAGE_KEY = "fact-graph:fullscreen-filter-sections";

function App() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [versions, setVersions] = useState<VersionRecord[]>([]);
  const [views, setViews] = useState<ViewOption[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [versionCompare, setVersionCompare] = useState<VersionCompareResponse | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<EntityDetail | null>(null);
  const [selectedRelation, setSelectedRelation] = useState<RelationDetail | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [compareLeftVersionId, setCompareLeftVersionId] = useState("");
  const [compareRightVersionId, setCompareRightVersionId] = useState("");
  const [search, setSearch] = useState("");
  const [stance, setStance] = useState("COMBINED");
  const [onlyDisputed, setOnlyDisputed] = useState(false);
  const [activeView, setActiveView] = useState("all");
  const [relationFilters, setRelationFilters] = useState<string[]>([]);
  const [entityOptions, setEntityOptions] = useState<EntityNode[]>([]);
  const [legendEntityFilters, setLegendEntityFilters] = useState<string[]>([]);
  const [legendRelationFilters, setLegendRelationFilters] = useState<string[]>([]);
  const [focusEntityId, setFocusEntityId] = useState("");
  const [focusDepth, setFocusDepth] = useState(1);
  const [hoverPreviewEntity, setHoverPreviewEntity] = useState<EntityDetail | null>(null);
  const [hoverPreviewLoading, setHoverPreviewLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [compareLoading, setCompareLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const [isGraphFullscreenOpen, setIsGraphFullscreenOpen] = useState(false);
  const hoverPreviewTargetRef = useRef<string | null>(null);
  const entityDetailCacheRef = useRef(new Map<string, EntityDetail>());

  useEffect(() => {
    void loadCases();
  }, []);

  useEffect(() => {
    if (!selectedCaseId) return;
    void loadStaticData(selectedCaseId);
    void loadGraphData(selectedCaseId);
    setSelectedEntity(null);
    setSelectedRelation(null);
    setFocusEntityId("");
    setFocusDepth(1);
    setLegendEntityFilters([]);
    setLegendRelationFilters([]);
    setHoverPreviewEntity(null);
    hoverPreviewTargetRef.current = null;
    entityDetailCacheRef.current.clear();
  }, [selectedCaseId]);

  useEffect(() => {
    if (!selectedCaseId) return;
    void loadGraphData(selectedCaseId);
  }, [selectedCaseId, stance, search, onlyDisputed, relationFilters, focusEntityId, focusDepth]);

  useEffect(() => {
    if (versions.length === 0) return;

    setCompareRightVersionId((current) => {
      if (current && versions.some((version) => version.versionId === current)) {
        return current;
      }
      return versions[0]?.versionId ?? "";
    });

    setCompareLeftVersionId((current) => {
      if (current && versions.some((version) => version.versionId === current) && current !== versions[0]?.versionId) {
        return current;
      }
      return versions[1]?.versionId ?? versions[0]?.versionId ?? "";
    });
  }, [versions]);

  useEffect(() => {
    if (!selectedCaseId) {
      setVersionCompare(null);
      return;
    }
    if (!compareLeftVersionId || !compareRightVersionId || compareLeftVersionId === compareRightVersionId) {
      setVersionCompare(null);
      return;
    }
    void loadVersionCompare(selectedCaseId, compareLeftVersionId, compareRightVersionId);
  }, [selectedCaseId, compareLeftVersionId, compareRightVersionId]);

  const availableRelationTypes = useMemo(() => {
    const relationTypeMap = new Map<string, string>();
    graph?.edges.forEach((edge) => {
      relationTypeMap.set(edge.relationType, edge.relationName);
    });
    return Array.from(relationTypeMap.entries()).map(([type, name]) => ({ type, name }));
  }, [graph]);

  const selectedVersion = useMemo(
    () =>
      versions.find((version) => version.isPublished) ??
      versions.find((version) => version.versionId === graph?.versionId) ??
      null,
    [graph?.versionId, versions],
  );
  const selectedVersionLabel = useMemo(
    () => (selectedVersion ? getVersionDisplayName(selectedVersion, versions) : "-"),
    [selectedVersion, versions],
  );
  const selectedVersionMeta = useMemo(
    () => (selectedVersion ? getVersionMetaLine(selectedVersion, versions) : "暂无版本信息"),
    [selectedVersion, versions],
  );
  const selectedVersionChangeSummary = useMemo(
    () => selectedVersion?.documentChangeSummary ?? "",
    [selectedVersion],
  );

  const selectedCaseSummary = useMemo(
    () => cases.find((item) => item.caseId === selectedCaseId) ?? null,
    [cases, selectedCaseId],
  );

  const compareSummary = useMemo(() => {
    if (!versionCompare) return null;
    return {
      entityAdded: versionCompare.entityDiff.added.length,
      entityRemoved: versionCompare.entityDiff.removed.length,
      entityChanged: versionCompare.entityDiff.changed.length,
      relationAdded: versionCompare.relationDiff.added.length,
      relationRemoved: versionCompare.relationDiff.removed.length,
      relationChanged: versionCompare.relationDiff.changed.length,
    };
  }, [versionCompare]);

  const relationLegendOptions = useMemo(() => {
    if (!graph) return [];
    const familyOptions = Array.from(
      new Map(
        graph.edges.map((edge) => {
          const family = getRelationFamilyMeta(edge.relationType, graph.caseType);
          return [family.key, { key: `family:${family.key}`, label: family.label, className: `relation-family-${family.key}` }] as const;
        }),
      ).values(),
    );

    const statusOptions = [
      graph.edges.some((edge) => edge.status === "DISPUTED")
        ? { key: "status:DISPUTED", label: "争议关系", className: "legend-chip-status-disputed" }
        : null,
    ].filter(Boolean) as Array<{ key: string; label: string; className: string }>;

    return [...statusOptions, ...familyOptions];
  }, [graph]);

  const displayGraph = useMemo(() => {
    if (!graph) return null;
    if (legendEntityFilters.length === 0 && legendRelationFilters.length === 0) {
      return graph;
    }
    return applyLegendGraphFilters(graph, legendEntityFilters, legendRelationFilters);
  }, [graph, legendEntityFilters, legendRelationFilters]);

  async function loadCases() {
    try {
      const result = await fetchCases();
      setCases(result.items);
      setSelectedCaseId((current) =>
        current && result.items.some((item) => item.caseId === current) ? current : (result.items[0]?.caseId ?? ""),
      );
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    }
  }

  async function loadStaticData(caseId: string) {
    try {
      const [nextStats, nextTimeline, nextVersions, nextViews, nextDocuments, nextEntities] = await Promise.all([
        fetchStats(caseId),
        fetchTimeline(caseId),
        fetchVersions(caseId),
        fetchViews(caseId),
        fetchDocuments(caseId),
        fetchEntities(caseId),
      ]);
      setStats(nextStats);
      setTimeline(nextTimeline);
      setVersions(nextVersions);
      setViews(nextViews);
      setDocuments(nextDocuments.items);
      setEntityOptions(nextEntities.items);
      setFocusEntityId((current) =>
        current && nextEntities.items.some((entity) => entity.entityId === current) ? current : "",
      );
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    }
  }

  async function loadGraphData(caseId: string) {
    try {
      setLoading(true);
      setError("");
      const nextGraph = await fetchGraph({
        caseId,
        stance,
        search,
        relationTypes: relationFilters,
        onlyDisputed,
        focusEntityId,
        focusDepth,
      });
      setGraph(nextGraph);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }

  async function loadVersionCompare(caseId: string, leftVersionId: string, rightVersionId: string) {
    try {
      setCompareLoading(true);
      const nextCompare = await fetchVersionCompare(caseId, leftVersionId, rightVersionId);
      setVersionCompare(nextCompare);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setCompareLoading(false);
    }
  }

  async function handleSelectEntity(entity: EntityNode) {
    if (!selectedCaseId) return;
    try {
      setSelectedRelation(null);
      const detail = await fetchEntityDetail(selectedCaseId, entity.entityId);
      entityDetailCacheRef.current.set(entity.entityId, detail);
      setSelectedEntity(detail);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    }
  }

  function handleFocusEntity(entityId: string) {
    setFocusEntityId(entityId);
    setSelectedRelation(null);
  }

  function handleClearFocusEntity() {
    setFocusEntityId("");
  }

  function toggleLegendEntityFilter(entityType: string) {
    setLegendEntityFilters((current) =>
      current.includes(entityType) ? current.filter((item) => item !== entityType) : [...current, entityType],
    );
  }

  function toggleLegendRelationFilter(filterKey: string) {
    setLegendRelationFilters((current) =>
      current.includes(filterKey) ? current.filter((item) => item !== filterKey) : [...current, filterKey],
    );
  }

  function clearLegendGraphFilters() {
    setLegendEntityFilters([]);
    setLegendRelationFilters([]);
  }

  async function handleSelectRelation(relation: RelationEdge) {
    if (!selectedCaseId) return;
    try {
      setSelectedEntity(null);
      setSelectedRelation(await fetchRelationDetail(selectedCaseId, relation.relationId));
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    }
  }

  async function handleHoverEntityPreview(entity: EntityNode) {
    if (!selectedCaseId) return;
    hoverPreviewTargetRef.current = entity.entityId;

    const cached = entityDetailCacheRef.current.get(entity.entityId);
    if (cached) {
      setHoverPreviewEntity(cached);
      setHoverPreviewLoading(false);
      return;
    }

    setHoverPreviewLoading(true);
    try {
      const detail = await fetchEntityDetail(selectedCaseId, entity.entityId);
      entityDetailCacheRef.current.set(entity.entityId, detail);
      if (hoverPreviewTargetRef.current === entity.entityId) {
        setHoverPreviewEntity(detail);
      }
    } catch {
      if (hoverPreviewTargetRef.current === entity.entityId) {
        setHoverPreviewEntity(null);
      }
    } finally {
      if (hoverPreviewTargetRef.current === entity.entityId) {
        setHoverPreviewLoading(false);
      }
    }
  }

  function handleLeaveHoverEntity() {
    hoverPreviewTargetRef.current = null;
    setHoverPreviewLoading(false);
    setHoverPreviewEntity(null);
  }

  async function handleConfirmEntity() {
    if (!selectedEntity || !selectedCaseId) return;
    try {
      setActionLoading(true);
      await confirmEntity(selectedCaseId, selectedEntity.entityId);
      await Promise.all([loadGraphData(selectedCaseId), loadStaticData(selectedCaseId)]);
      setSelectedEntity(await fetchEntityDetail(selectedCaseId, selectedEntity.entityId));
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleConfirmRelation() {
    if (!selectedRelation || !selectedCaseId) return;
    try {
      setActionLoading(true);
      await confirmRelation(selectedCaseId, selectedRelation.relationId);
      await Promise.all([loadGraphData(selectedCaseId), loadStaticData(selectedCaseId)]);
      setSelectedRelation(await fetchRelationDetail(selectedCaseId, selectedRelation.relationId));
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRerun() {
    if (!selectedCaseId) return;
    try {
      setActionLoading(true);
      setError("");
      const task = await createExtractTask(selectedCaseId);
      setNotice("已发起后台重跑，正在抽取中...");
      setActiveTaskId(task.taskId);
      await loadStaticData(selectedCaseId);
      void pollTaskUntilFinished(selectedCaseId, task.taskId);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUpload() {
    if (selectedFiles.length === 0 || !selectedCaseId) return;
    try {
      setActionLoading(true);
      setError("");
      setNotice("");
      const result = await uploadDocuments(selectedCaseId, selectedFiles);
      setSelectedFiles([]);
      setNotice(result.message);
      setActiveTaskId(result.taskId);
      await loadStaticData(selectedCaseId);
      void pollTaskUntilFinished(selectedCaseId, result.taskId);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setActionLoading(false);
    }
  }

  async function pollTaskUntilFinished(caseId: string, taskId: string) {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      try {
        const task = await fetchTask(caseId, taskId);
        if (task.status === "SUCCESS") {
          setNotice(task.currentStage || "抽取完成");
          setActiveTaskId(null);
          await Promise.all([loadGraphData(caseId), loadStaticData(caseId), loadCases()]);
          return;
        }
        if (task.status === "FAILED") {
          setNotice("");
          setActiveTaskId(null);
          setError(task.errorMessage || "抽取失败");
          await loadStaticData(caseId);
          return;
        }
        if (task.status === "CANCELLED") {
          setNotice("后台任务已取消");
          setActiveTaskId(null);
          await loadStaticData(caseId);
          return;
        }
        setNotice(buildTaskNotice(task));
      } catch (requestError) {
        setActiveTaskId(null);
        setError(getErrorMessage(requestError));
        return;
      }
      await sleep(2000);
    }

    setNotice("后台任务仍在处理中，请稍后刷新查看最新结果。");
  }

  async function handleCancelTask(taskId: string) {
    if (!selectedCaseId) return;
    try {
      setActionLoading(true);
      setError("");
      await cancelTask(selectedCaseId, taskId);
      setNotice("后台任务已取消");
      setActiveTaskId(null);
      await loadStaticData(selectedCaseId);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDeleteDocument(documentId: string, originalName: string) {
    if (!selectedCaseId) return;
    if (!window.confirm(`确认删除卷宗“${originalName}”吗？`)) return;

    try {
      setActionLoading(true);
      setError("");
      setNotice("");
      const result = await deleteDocument(selectedCaseId, documentId);
      setNotice(result.message);
      await loadStaticData(selectedCaseId);
      if (result.taskId) {
        setActiveTaskId(result.taskId);
        void pollTaskUntilFinished(selectedCaseId, result.taskId);
      } else {
        await Promise.all([loadGraphData(selectedCaseId), loadCases()]);
      }
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setActionLoading(false);
    }
  }

  function handleChangeView(viewId: string) {
    setActiveView(viewId);
    setRelationFilters(viewRelationMap[viewId] ?? []);
  }

  function toggleRelationFilter(relationType: string) {
    setActiveView("all");
    setRelationFilters((current) =>
      current.includes(relationType)
        ? current.filter((item) => item !== relationType)
        : [...current, relationType],
    );
  }

  function getVersionLabel(versionId: string) {
    const version = versions.find((item) => item.versionId === versionId);
    if (!version) return versionId;
    return `${getVersionDisplayName(version, versions)} (${new Date(version.createdAt).toLocaleString()})`;
  }

  async function handlePublishVersion(versionId: string) {
    if (!selectedCaseId) return;
    try {
      setActionLoading(true);
      setError("");
      await publishVersion(selectedCaseId, versionId);
      setNotice("已切换到所选图谱版本");
      setSelectedEntity(null);
      setSelectedRelation(null);
      await Promise.all([loadStaticData(selectedCaseId), loadGraphData(selectedCaseId), loadCases()]);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <div className="page-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">法院演示工作台</p>
          <h1>案件事实-关系图谱</h1>
          <p className="subtitle">
            {graph?.caseName ?? selectedCaseSummary?.caseName ?? "案件加载中"} |{" "}
            {graph?.caseNo ?? selectedCaseSummary?.caseNo ?? "-"} |{" "}
            {graph?.caseType ?? selectedCaseSummary?.caseType ?? "-"} |{" "}
            {graph?.trialStage ?? selectedCaseSummary?.trialStage ?? "-"}
          </p>
        </div>
        <div className="header-actions topbar-toolgroup">
          <section className="version-card topbar-tool-card">
            <span className="topbar-tool-label">当前案件</span>
            <div className="topbar-select-wrap">
              <select className="topbar-select" value={selectedCaseId} onChange={(event) => setSelectedCaseId(event.target.value)}>
                {cases.map((item) => (
                  <option key={item.caseId} value={item.caseId}>
                    {item.caseName} {item.caseNo ? `· ${item.caseNo}` : ""}
                  </option>
                ))}
              </select>
              <span className="topbar-select-caret" aria-hidden="true">
                ▾
              </span>
            </div>
            <span className="version-card-note">切换后将同步刷新图谱、时间线和版本信息。</span>
          </section>
          <section className="version-card topbar-tool-card">
            <span className="topbar-tool-label">当前版本</span>
            <strong>{selectedVersionLabel}</strong>
            <span className="version-card-note">{selectedVersionMeta}</span>
            <span className="version-card-note">{selectedVersionChangeSummary || "当前版本尚未记录材料变化摘要。"}</span>
          </section>
          <button className="version-card topbar-tool-card topbar-tool-button topbar-tool-button-secondary" onClick={() => setIsCompareOpen(true)}>
            <span className="topbar-tool-label">版本记录</span>
            <strong>{`${versions.length} 个版本`}</strong>
            <span className="version-card-note">查看历史版本、触发来源，并选择两个版本做差异对比。</span>
          </button>
          <button
            className="version-card topbar-tool-card topbar-tool-button topbar-tool-button-primary"
            onClick={() => void handleRerun()}
            disabled={actionLoading}
          >
            <span className="topbar-tool-label">重新抽取</span>
            <strong>{actionLoading ? "处理中..." : "生成新版本"}</strong>
            <span className="version-card-note">基于当前选定卷宗重新抽取事实链、实体与关系，并沉淀为新版本。</span>
          </button>
        </div>
      </header>

      <section className="stats-grid">
        <StatCard label="主体/事项数" value={String(stats?.entityCount ?? "-")} />
        <StatCard label="关系数" value={String(stats?.relationCount ?? "-")} />
        <StatCard label="已确认关系" value={String(stats?.confirmedRelationCount ?? "-")} />
        <StatCard label="争议关系" value={String(stats?.disputedRelationCount ?? "-")} />
        <StatCard label="来源覆盖率" value={stats?.sourceCoverageRate ?? "-"} />
      </section>

      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? <div className="info-banner">{notice}</div> : null}

      <main className="workspace">
        <aside className="sidebar">
          <section className="panel">
            <h2>卷宗上传</h2>
            <p className="panel-desc">
              支持 PDF、DOC、DOCX、图片扫描件。上传后会自动执行文书解析、切分、规则抽取和大模型三元组生成。
            </p>
            <label className="upload-box">
              <input
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.txt"
                onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
                disabled={!selectedCaseId}
              />
              <span>{selectedFiles.length > 0 ? `已选择 ${selectedFiles.length} 个文件` : "选择卷宗文件"}</span>
            </label>
            <button
              className="primary-button full-width"
              onClick={() => void handleUpload()}
              disabled={actionLoading || selectedFiles.length === 0 || !selectedCaseId}
            >
              {actionLoading ? "抽取中..." : "上传并抽取"}
            </button>
          </section>

          <section className="panel">
            <h2>已上传卷宗</h2>
            <div className="document-list">
              {documents.length === 0 ? (
                <p className="empty-hint">当前还没有上传真实卷宗，仍可查看演示样例。</p>
              ) : (
                documents.map((document) => (
                  <article key={document.documentId} className="document-item">
                    <strong>{document.originalName}</strong>
                    <span>
                      {document.documentType} | {document.sourceParty}
                    </span>
                    <span>
                      {formatParseStatusLabel(document.parseStatus)} | 切片 {document.chunkCount}
                    </span>
                    {document.latestTaskStatus ? (
                      <span>
                        任务状态 {formatTaskStatusLabel(document.latestTaskStatus)}
                        {document.latestTaskStage ? ` | ${document.latestTaskStage}` : ""}
                      </span>
                    ) : null}
                    {document.latestTaskError || document.parseError ? (
                      <span className="document-error">{document.latestTaskError ?? document.parseError}</span>
                    ) : null}
                    {document.latestTaskStatus === "PROCESSING" && document.latestTaskId ? (
                      <button
                        className="secondary-button document-action"
                        onClick={() => void handleCancelTask(document.latestTaskId!)}
                        disabled={actionLoading || activeTaskId === document.latestTaskId}
                      >
                        {actionLoading && activeTaskId === document.latestTaskId ? "处理中..." : "取消任务"}
                      </button>
                    ) : null}
                    <button
                      className="secondary-button document-action danger"
                      onClick={() => void handleDeleteDocument(document.documentId, document.originalName)}
                      disabled={actionLoading}
                    >
                      删除
                    </button>
                  </article>
                ))
              )}
            </div>
          </section>

          <GraphFilterWorkspace
            search={search}
            onChangeSearch={setSearch}
            stance={stance}
            onChangeStance={setStance}
            onlyDisputed={onlyDisputed}
            onChangeOnlyDisputed={setOnlyDisputed}
            entityOptions={entityOptions}
            focusEntityId={focusEntityId}
            onFocusEntity={handleFocusEntity}
            onClearFocusEntity={handleClearFocusEntity}
            focusDepth={focusDepth}
            onChangeFocusDepth={setFocusDepth}
            views={views}
            activeView={activeView}
            onChangeView={handleChangeView}
            availableRelationTypes={availableRelationTypes}
            relationFilters={relationFilters}
            onToggleRelationFilter={toggleRelationFilter}
          />

        </aside>

        <section className="graph-panel">
          <div className="panel graph-wrapper">
            <div className="panel-header">
              <GraphHeaderSummary
                title="关系图谱"
                description="点击主体或事项卡片查看详情，点击关系标签查看证据来源与关系信息。"
                focusedEntityName={entityOptions.find((entity) => entity.entityId === focusEntityId)?.displayName}
                focusDepth={focusDepth}
                onChangeFocusDepth={setFocusDepth}
                hasLegendFilters={legendEntityFilters.length > 0 || legendRelationFilters.length > 0}
                onClearLegendFilters={clearLegendGraphFilters}
              />
              <div className="panel-header-actions">
                <span className="loading-text">{loading ? "图谱加载中..." : "已完成加载"}</span>
              </div>
            </div>
            <GraphCanvas
              caseId={selectedCaseId}
              graph={displayGraph}
              legendRelationOptions={relationLegendOptions}
              legendEntityFilters={legendEntityFilters}
              legendRelationFilters={legendRelationFilters}
              onOpenFullscreen={() => setIsGraphFullscreenOpen(true)}
              selectedEntityId={selectedEntity?.entityId}
              onSelectEntity={handleSelectEntity}
              onSelectRelation={handleSelectRelation}
              onFocusEntity={handleFocusEntity}
              onClearFocus={handleClearFocusEntity}
              onHoverEntity={handleHoverEntityPreview}
              onLeaveHoverEntity={handleLeaveHoverEntity}
              onToggleLegendEntityFilter={toggleLegendEntityFilter}
              onToggleLegendRelationFilter={toggleLegendRelationFilter}
              onChangeFocusDepth={setFocusDepth}
              onClearLegendFilters={clearLegendGraphFilters}
              focusedEntityId={focusEntityId}
            />
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>事实时间线</h2>
                <p>按时间梳理关键事实与争议事项。</p>
              </div>
            </div>
            <div className="timeline-list">
              {timeline.map((event) => (
                <button
                  key={event.eventId}
                  className="timeline-item"
                  onClick={() => {
                    const relation = graph?.edges.find((edge) => event.relatedRelationIds.includes(edge.relationId));
                    if (relation) {
                      void handleSelectRelation(relation);
                    }
                  }}
                >
                  <span className="timeline-date">{event.date}</span>
                  <strong>{event.title}</strong>
                  <p>{event.summary}</p>
                </button>
              ))}
            </div>
          </div>
        </section>

        <aside className="detail-panel">
          <section className="panel detail-card">
            <h2>详情与校核</h2>
            {hoverPreviewLoading ? <div className="info-banner">正在加载悬停预览...</div> : null}
            {hoverPreviewEntity && hoverPreviewEntity.entityId !== selectedEntity?.entityId ? (
              <EntityHoverPreviewPanel detail={hoverPreviewEntity} />
            ) : null}
            {selectedEntity ? (
              <EntityDetailPanel
                detail={selectedEntity}
                actionLoading={actionLoading}
                onConfirm={() => void handleConfirmEntity()}
                onFocusEntity={() => handleFocusEntity(selectedEntity.entityId)}
                isFocused={focusEntityId === selectedEntity.entityId}
                onClearFocus={handleClearFocusEntity}
              />
            ) : null}
            {selectedRelation ? (
              <RelationDetailPanel
                detail={selectedRelation}
                actionLoading={actionLoading}
                onConfirm={() => void handleConfirmRelation()}
              />
            ) : null}
            {!selectedEntity && !selectedRelation && !hoverPreviewLoading && !hoverPreviewEntity ? (
              <div className="empty-state">
                请选择一个主体、事项或关系。该区域会展示主体/事项信息、关系信息、证据来源和人工校核按钮。
              </div>
            ) : null}
          </section>
        </aside>
      </main>

      {isCompareOpen ? (
        <CompareModal
          versions={versions}
          actionLoading={actionLoading}
          compareLeftVersionId={compareLeftVersionId}
          compareRightVersionId={compareRightVersionId}
          onChangeLeftVersion={setCompareLeftVersionId}
          onChangeRightVersion={setCompareRightVersionId}
          getVersionLabel={getVersionLabel}
          onPublishVersion={handlePublishVersion}
          compareLoading={compareLoading}
          compareSummary={compareSummary}
          versionCompare={versionCompare}
          onClose={() => setIsCompareOpen(false)}
        />
      ) : null}

      {isGraphFullscreenOpen ? (
        <GraphFullscreenModal
          caseId={selectedCaseId}
          graph={displayGraph}
          search={search}
          onChangeSearch={setSearch}
          stance={stance}
          onChangeStance={setStance}
          onlyDisputed={onlyDisputed}
          onChangeOnlyDisputed={setOnlyDisputed}
          entityOptions={entityOptions}
          activeView={activeView}
          views={views}
          onChangeView={handleChangeView}
          availableRelationTypes={availableRelationTypes}
          relationFilters={relationFilters}
          onToggleRelationFilter={toggleRelationFilter}
          legendRelationOptions={relationLegendOptions}
          legendEntityFilters={legendEntityFilters}
          legendRelationFilters={legendRelationFilters}
          onSelectEntity={handleSelectEntity}
          onSelectRelation={handleSelectRelation}
          onFocusEntity={handleFocusEntity}
          onClearFocus={handleClearFocusEntity}
          onHoverEntity={handleHoverEntityPreview}
          onLeaveHoverEntity={handleLeaveHoverEntity}
          onToggleLegendEntityFilter={toggleLegendEntityFilter}
          onToggleLegendRelationFilter={toggleLegendRelationFilter}
          onChangeFocusDepth={setFocusDepth}
          onClearLegendFilters={clearLegendGraphFilters}
          focusedEntityId={focusEntityId}
          onClose={() => setIsGraphFullscreenOpen(false)}
        />
      ) : null}
    </div>
  );
}

function GraphCanvas(props: {
  caseId: string;
  graph: GraphResponse | null;
  legendRelationOptions: Array<{ key: string; label: string; className: string }>;
  legendEntityFilters: string[];
  legendRelationFilters: string[];
  onOpenFullscreen: () => void;
  selectedEntityId?: string;
  onSelectEntity: (entity: EntityNode) => void;
  onSelectRelation: (relation: RelationEdge) => void;
  onFocusEntity: (entityId: string) => void;
  onClearFocus: () => void;
  onHoverEntity: (entity: EntityNode) => void;
  onLeaveHoverEntity: () => void;
  onToggleLegendEntityFilter: (entityType: string) => void;
  onToggleLegendRelationFilter: (filterKey: string) => void;
  onChangeFocusDepth: (depth: number) => void;
  onClearLegendFilters: () => void;
  focusedEntityId?: string;
  fullscreen?: boolean;
}) {
  const {
    caseId,
    graph,
    legendRelationOptions,
    legendEntityFilters,
    legendRelationFilters,
    onOpenFullscreen,
    selectedEntityId,
    onSelectEntity,
    onSelectRelation,
    onFocusEntity,
    onClearFocus,
    onHoverEntity,
    onLeaveHoverEntity,
    onToggleLegendEntityFilter,
    onToggleLegendRelationFilter,
    onChangeFocusDepth,
    onClearLegendFilters,
    focusedEntityId,
    fullscreen = false,
  } = props;
  const [zoom, setZoom] = useState(1);
  const [renderNodes, setRenderNodes] = useState<EntityNode[]>([]);
  const [showEntityLegend, setShowEntityLegend] = useState(false);
  const [showRelationLegend, setShowRelationLegend] = useState(false);
  const [hoveredEntityId, setHoveredEntityId] = useState<string | null>(null);
  const [hoveredRelationId, setHoveredRelationId] = useState<string | null>(null);
  const [viewWindow, setViewWindow] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    surfaceWidth: 0,
    surfaceHeight: 0,
  });
  const graphMetrics = useMemo(() => (graph ? buildGraphMetrics(graph.edges) : {}), [graph]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasDragRef = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
  });
  const nodeDragRef = useRef<{
    nodeId: string | null;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  }>({
    nodeId: null,
    offsetX: 0,
    offsetY: 0,
    moved: false,
  });
  const [isCanvasDragging, setIsCanvasDragging] = useState(false);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [layoutStatus, setLayoutStatus] = useState("");
  const skipNodeClickRef = useRef<string | null>(null);
  const persistTimeoutRef = useRef<number | null>(null);
  const renderNodesRef = useRef<EntityNode[]>([]);
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const lastAutoCenterKeyRef = useRef("");
  const minimapDragRef = useRef({
    active: false,
    offsetX: 0,
    offsetY: 0,
  });
  const minimapWidth = 220;
  const minimapHeight = 140;
  const sceneWidth = 1240;
  const sceneHeight = 760;
  const focusGraphMeta = useMemo(() => buildFocusGraphMeta(graph, focusedEntityId), [graph, focusedEntityId]);
  const hoverGraphMeta = useMemo(
    () => buildHoverGraphMeta(graph, hoveredEntityId, hoveredRelationId),
    [graph, hoveredEntityId, hoveredRelationId],
  );
  const focusedEntity = useMemo(
    () => graph?.nodes.find((node) => node.entityId === focusedEntityId) ?? null,
    [graph, focusedEntityId],
  );
  const renderNodeMap = useMemo(
    () => Object.fromEntries(renderNodes.map((node) => [node.entityId, node])),
    [renderNodes],
  );

  useEffect(() => {
    setZoom(1);
  }, [graph?.versionId]);

  useEffect(() => {
    return () => {
      if (persistTimeoutRef.current) {
        window.clearTimeout(persistTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!graph) {
      setRenderNodes([]);
      renderNodesRef.current = [];
      return;
    }
    const nextNodes = resolveNodeLayout(graph.nodes, sceneWidth, sceneHeight);
    setRenderNodes(nextNodes);
    renderNodesRef.current = nextNodes;
  }, [graph, sceneHeight, sceneWidth]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !graph) return;

    window.requestAnimationFrame(() => {
      const left = Math.max((sceneWidth - viewport.clientWidth) / 2, 0);
      const top = Math.max((sceneHeight - viewport.clientHeight) / 2, 0);
      viewport.scrollTo({ left, top });
    });
  }, [graph, sceneHeight, sceneWidth, fullscreen]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !focusedEntityId || renderNodes.length === 0) {
      return;
    }
    const centerKey = `${graph?.versionId ?? ""}:${graph?.focusEntityId ?? focusedEntityId}:${graph?.focusDepth ?? 1}`;
    if (lastAutoCenterKeyRef.current === centerKey) {
      return;
    }
    lastAutoCenterKeyRef.current = centerKey;

    const nodesToCenter = renderNodes.filter((node) => {
      const depth = focusGraphMeta.nodeDepths[node.entityId];
      return depth !== undefined && depth <= 1;
    });
    if (nodesToCenter.length === 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      const leftBoundary = Math.min(...nodesToCenter.map((node) => node.x - NODE_HALF_WIDTH)) * zoom;
      const rightBoundary = Math.max(...nodesToCenter.map((node) => node.x + NODE_HALF_WIDTH)) * zoom;
      const topBoundary = Math.min(...nodesToCenter.map((node) => node.y - NODE_HALF_HEIGHT)) * zoom;
      const bottomBoundary = Math.max(...nodesToCenter.map((node) => node.y + NODE_HALF_HEIGHT)) * zoom;
      const padding = 72;
      const targetCenterX = (leftBoundary + rightBoundary) / 2;
      const targetCenterY = (topBoundary + bottomBoundary) / 2;
      scrollViewportTo(targetCenterX - viewport.clientWidth / 2, targetCenterY - viewport.clientHeight / 2 - padding / 2);
    });
  }, [focusedEntityId, graph?.versionId, graph?.focusDepth, graph?.focusEntityId, graph?.nodes.length, renderNodes.length, zoom]);

  useEffect(() => {
    if (!focusedEntityId) {
      lastAutoCenterKeyRef.current = "";
    }
  }, [focusedEntityId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !graph) return;

    const updateViewWindow = () => {
      setViewWindow({
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        surfaceWidth: sceneWidth * zoom,
        surfaceHeight: sceneHeight * zoom,
      });
    };

    updateViewWindow();
    viewport.addEventListener("scroll", updateViewWindow, { passive: true });
    window.addEventListener("resize", updateViewWindow);

    return () => {
      viewport.removeEventListener("scroll", updateViewWindow);
      window.removeEventListener("resize", updateViewWindow);
    };
  }, [graph, zoom, sceneWidth, sceneHeight]);

  useEffect(() => {
    if (!isCanvasDragging && !draggingNodeId && !minimapDragRef.current.active) {
      return;
    }

    const handleWindowMouseMove = (event: MouseEvent) => {
      handlePointerMove(event.clientX, event.clientY, event.movementX, event.movementY);
    };
    const handleWindowMouseUp = () => {
      if (minimapDragRef.current.active) {
        minimapDragRef.current.active = false;
      }
      stopDragging();
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [draggingNodeId, isCanvasDragging, zoom, fullscreen, viewWindow.surfaceWidth, viewWindow.surfaceHeight]);

  if (!graph) {
    return <div className="canvas-empty">图谱数据加载中...</div>;
  }

  const minimapScaleX = minimapWidth / Math.max(viewWindow.surfaceWidth || 1, 1);
  const minimapScaleY = minimapHeight / Math.max(viewWindow.surfaceHeight || 1, 1);
  const viewportIndicator = {
    left: viewWindow.left * minimapScaleX,
    top: viewWindow.top * minimapScaleY,
    width: Math.max(viewWindow.width * minimapScaleX, 24),
    height: Math.max(viewWindow.height * minimapScaleY, 18),
  };

  function scrollViewportTo(left: number, top: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({
      left: clamp(left, 0, Math.max(viewWindow.surfaceWidth - viewport.clientWidth, 0)),
      top: clamp(top, 0, Math.max(viewWindow.surfaceHeight - viewport.clientHeight, 0)),
    });
  }

  function handleZoom(delta: number) {
    setZoom((current) => clamp(current + delta, 0.8, 1.55));
  }

  async function persistLayout(nodes: EntityNode[], reviewComment: string) {
    try {
      setLayoutStatus("布局保存中...");
      await saveGraphLayout(
        caseId,
        nodes.map((node) => ({
          entityId: node.entityId,
          x: Math.round(node.x),
          y: Math.round(node.y),
          layoutLocked: node.layoutLocked ?? false,
        })),
        reviewComment,
      );
      setLayoutStatus("布局已保存");
      window.setTimeout(() => {
        setLayoutStatus((current) => (current === "布局已保存" ? "" : current));
      }, 1600);
    } catch {
      setLayoutStatus("布局保存失败");
    }
  }

  function schedulePersistLayout(nodes: EntityNode[], reviewComment: string) {
    if (persistTimeoutRef.current) {
      window.clearTimeout(persistTimeoutRef.current);
    }
    persistTimeoutRef.current = window.setTimeout(() => {
      void persistLayout(nodes, reviewComment);
      persistTimeoutRef.current = null;
    }, 350);
  }

  function handleAutoRelayout() {
    const nextNodes = resolveNodeLayout(renderNodesRef.current, sceneWidth, sceneHeight);
    setRenderNodes(nextNodes);
    renderNodesRef.current = nextNodes;
    void persistLayout(nextNodes, "自动重新排版图谱布局");
  }

  function handleRestoreDefaultLayout() {
    const nextNodes = resolveNodeLayout(buildDefaultNodeLayout(renderNodesRef.current, sceneWidth, sceneHeight), sceneWidth, sceneHeight, false);
    setRenderNodes(nextNodes);
    renderNodesRef.current = nextNodes;
    void persistLayout(nextNodes, "恢复默认图谱布局");
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    const viewport = viewportRef.current;
    if (!viewport) return;

    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;

    setZoom((current) => {
      const nextZoom = clamp(current + (event.deltaY < 0 ? 0.08 : -0.08), 0.8, 1.55);
      const contentX = (viewport.scrollLeft + pointerX) / current;
      const contentY = (viewport.scrollTop + pointerY) / current;

      window.requestAnimationFrame(() => {
        viewport.scrollTo({
          left: contentX * nextZoom - pointerX,
          top: contentY * nextZoom - pointerY,
        });
      });

      return nextZoom;
    });
  }

  function handleMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (nodeDragRef.current.nodeId) {
      return;
    }
    if ((event.target as Element).closest("button, .graph-minimap-shell")) {
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;

    canvasDragRef.current = {
      isDragging: true,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    setIsCanvasDragging(true);
  }

  function handlePointerMove(clientX: number, clientY: number, movementX = 0, movementY = 0) {
    const viewport = viewportRef.current;
    if (!viewport) return;

    if (minimapDragRef.current.active) {
      const minimap = minimapRef.current;
      if (!minimap) return;
      const rect = minimap.getBoundingClientRect();
      const indicatorWidth = Math.min(viewportIndicator.width, minimapWidth);
      const indicatorHeight = Math.min(viewportIndicator.height, minimapHeight);
      const nextLeft = clamp(clientX - rect.left - minimapDragRef.current.offsetX, 0, minimapWidth - indicatorWidth);
      const nextTop = clamp(clientY - rect.top - minimapDragRef.current.offsetY, 0, minimapHeight - indicatorHeight);
      scrollViewportTo(nextLeft / minimapScaleX, nextTop / minimapScaleY);
      return;
    }

    if (nodeDragRef.current.nodeId) {
      const rect = viewport.getBoundingClientRect();
      const pointerX = clientX - rect.left;
      const pointerY = clientY - rect.top;
      const sceneX = (viewport.scrollLeft + pointerX) / zoom - nodeDragRef.current.offsetX;
      const sceneY = (viewport.scrollTop + pointerY) / zoom - nodeDragRef.current.offsetY;

      if (Math.abs(movementX) > 0 || Math.abs(movementY) > 0) {
        nodeDragRef.current.moved = true;
      }

      setRenderNodes((current) => {
        const nextNodes = current.map((node) =>
          node.entityId === nodeDragRef.current.nodeId
            ? {
                ...node,
                x: clamp(sceneX, NODE_HALF_WIDTH + 24, sceneWidth - NODE_HALF_WIDTH - 24),
                y: clamp(sceneY, NODE_HALF_HEIGHT + 24, sceneHeight - NODE_HALF_HEIGHT - 24),
              }
            : node,
        );
        renderNodesRef.current = nextNodes;
        return nextNodes;
      });
      return;
    }

    if (!canvasDragRef.current.isDragging) return;

    const deltaX = clientX - canvasDragRef.current.startX;
    const deltaY = clientY - canvasDragRef.current.startY;
    viewport.scrollLeft = canvasDragRef.current.scrollLeft - deltaX;
    viewport.scrollTop = canvasDragRef.current.scrollTop - deltaY;
  }

  function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    if (canvasDragRef.current.isDragging || nodeDragRef.current.nodeId) {
      event.preventDefault();
    }
    handlePointerMove(event.clientX, event.clientY, event.movementX, event.movementY);
  }

  function handleNodeMouseDown(event: React.MouseEvent<HTMLButtonElement>, node: EntityNode) {
    event.stopPropagation();
    if (node.layoutLocked) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;

    const rect = viewport.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const sceneX = (viewport.scrollLeft + pointerX) / zoom;
    const sceneY = (viewport.scrollTop + pointerY) / zoom;

    nodeDragRef.current = {
      nodeId: node.entityId,
      offsetX: sceneX - node.x,
      offsetY: sceneY - node.y,
      moved: false,
    };
    setDraggingNodeId(node.entityId);
  }

  function stopDragging() {
    if (nodeDragRef.current.nodeId) {
      if (nodeDragRef.current.moved) {
        skipNodeClickRef.current = nodeDragRef.current.nodeId;
        schedulePersistLayout(renderNodesRef.current, "拖拽调整图谱布局");
      }
      nodeDragRef.current = {
        nodeId: null,
        offsetX: 0,
        offsetY: 0,
        moved: false,
      };
      setDraggingNodeId(null);
    }

    canvasDragRef.current.isDragging = false;
    setIsCanvasDragging(false);
  }

  function handleNodeClick(node: EntityNode) {
    if (skipNodeClickRef.current === node.entityId) {
      skipNodeClickRef.current = null;
      return;
    }
    onSelectEntity(node);
  }

  function handleToggleNodeLock(event: React.MouseEvent<HTMLButtonElement>, entityId: string) {
    event.stopPropagation();
    const nextNodes = renderNodesRef.current.map((node) =>
      node.entityId === entityId ? { ...node, layoutLocked: !node.layoutLocked } : node,
    );
    renderNodesRef.current = nextNodes;
    setRenderNodes(nextNodes);
    void persistLayout(nextNodes, "更新节点锁定状态");
  }

  function navigateFromMinimap(clientX: number, clientY: number) {
    const viewport = viewportRef.current;
    const minimap = minimapRef.current;
    if (!viewport || !minimap) return;
    const rect = minimap.getBoundingClientRect();
    const ratioX = clamp((clientX - rect.left) / rect.width, 0, 1);
    const ratioY = clamp((clientY - rect.top) / rect.height, 0, 1);
    const nextLeft = ratioX * viewWindow.surfaceWidth - viewport.clientWidth / 2;
    const nextTop = ratioY * viewWindow.surfaceHeight - viewport.clientHeight / 2;
    scrollViewportTo(nextLeft, nextTop);
  }

  function handleMinimapViewportMouseDown(event: React.MouseEvent<SVGRectElement>) {
    event.stopPropagation();
    const minimap = minimapRef.current;
    if (!minimap) return;
    const rect = minimap.getBoundingClientRect();
    minimapDragRef.current = {
      active: true,
      offsetX: event.clientX - rect.left - viewportIndicator.left,
      offsetY: event.clientY - rect.top - viewportIndicator.top,
    };
  }

  function handleMinimapMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if ((event.target as Element).closest(".graph-minimap-viewport")) {
      return;
    }
    navigateFromMinimap(event.clientX, event.clientY);
  }

  return (
    <div className={fullscreen ? "graph-canvas graph-canvas-fullscreen" : "graph-canvas"}>
      <GraphToolbar
        fullscreen={fullscreen}
        focusedEntityName={focusedEntity?.displayName}
        focusDepth={graph.focusDepth ?? 1}
        onChangeFocusDepth={onChangeFocusDepth}
        nodeCount={graph.nodes.length}
        edgeCount={graph.edges.length}
        hasLegendFilters={legendEntityFilters.length > 0 || legendRelationFilters.length > 0}
        onClearLegendFilters={onClearLegendFilters}
        showEntityLegend={showEntityLegend}
        onToggleEntityLegend={() => setShowEntityLegend((current) => !current)}
        showRelationLegend={showRelationLegend}
        onToggleRelationLegend={() => setShowRelationLegend((current) => !current)}
        onAutoRelayout={handleAutoRelayout}
        onRestoreDefaultLayout={handleRestoreDefaultLayout}
        zoom={zoom}
        onZoomOut={() => handleZoom(-0.1)}
        onZoomIn={() => handleZoom(0.1)}
        onResetView={() => setZoom(1)}
        onOpenFullscreen={onOpenFullscreen}
        layoutStatus={layoutStatus}
      />

      <GraphLegendPanels
        showEntityLegend={showEntityLegend}
        onCloseEntityLegend={() => setShowEntityLegend(false)}
        legendEntityFilters={legendEntityFilters}
        onToggleLegendEntityFilter={onToggleLegendEntityFilter}
        showRelationLegend={showRelationLegend}
        onCloseRelationLegend={() => setShowRelationLegend(false)}
        legendRelationOptions={legendRelationOptions}
        legendRelationFilters={legendRelationFilters}
        onToggleLegendRelationFilter={onToggleLegendRelationFilter}
      />

      <div
        ref={viewportRef}
        className={
          isCanvasDragging || draggingNodeId
            ? fullscreen
              ? "graph-viewport graph-viewport-fullscreen is-dragging"
              : "graph-viewport is-dragging"
            : fullscreen
              ? "graph-viewport graph-viewport-fullscreen"
              : "graph-viewport"
        }
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDragging}
        onMouseLeave={stopDragging}
      >
        {fullscreen ? (
          <div className="graph-minimap-shell">
            <div className="graph-minimap-header">
              <strong>导航</strong>
              <span>拖拽视窗 / 点击跳转</span>
            </div>
            <div ref={minimapRef} className="graph-minimap" onMouseDown={handleMinimapMouseDown}>
              <svg viewBox={`0 0 ${minimapWidth} ${minimapHeight}`} className="graph-minimap-svg" aria-hidden="true">
                {graph.edges.map((edge) => {
                  const source = renderNodeMap[edge.headEntityId];
                  const target = renderNodeMap[edge.tailEntityId];
                  if (!source || !target) return null;
                  const relationFamily = getRelationFamilyMeta(edge.relationType, graph.caseType);
                  return (
                    <line
                      key={`mini-${edge.relationId}`}
                      x1={(source.x / sceneWidth) * minimapWidth}
                      y1={(source.y / sceneHeight) * minimapHeight}
                      x2={(target.x / sceneWidth) * minimapWidth}
                      y2={(target.y / sceneHeight) * minimapHeight}
                      className={`graph-minimap-edge relation-family-${relationFamily.key}`}
                    />
                  );
                })}
                {renderNodes.map((node) => (
                  <circle
                    key={`mini-node-${node.entityId}`}
                    cx={(node.x / sceneWidth) * minimapWidth}
                    cy={(node.y / sceneHeight) * minimapHeight}
                    r={node.entityType === "NaturalPerson" ? 4.2 : 3.6}
                    className={`graph-minimap-node node-${node.entityType.toLowerCase()}`}
                  />
                ))}
                <rect
                  x={viewportIndicator.left}
                  y={viewportIndicator.top}
                  width={Math.min(viewportIndicator.width, minimapWidth)}
                  height={Math.min(viewportIndicator.height, minimapHeight)}
                  className="graph-minimap-viewport"
                  rx="8"
                  ry="8"
                  onMouseDown={handleMinimapViewportMouseDown}
                />
              </svg>
            </div>
          </div>
        ) : null}

        <div className="graph-surface" style={{ width: sceneWidth * zoom, height: sceneHeight * zoom }}>
          <div className="graph-scene" style={{ width: sceneWidth, height: sceneHeight, transform: `scale(${zoom})` }}>
            <svg className="graph-lines" viewBox={`0 0 ${sceneWidth} ${sceneHeight}`} aria-hidden="true">
              <defs>
                <marker
                  id="graph-arrow"
                  markerWidth="10"
                  markerHeight="10"
                  refX="8"
                  refY="5"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {graph.edges.map((edge) => {
                const source = renderNodeMap[edge.headEntityId];
                const target = renderNodeMap[edge.tailEntityId];
                if (!source || !target) return null;
                const geometry = getEdgeGeometry(source, target, graphMetrics[edge.relationId]?.offset ?? 0);
                const relationFamily = getRelationFamilyMeta(edge.relationType, graph.caseType);
                const focusClass = getFocusRelationClassName(edge.relationId, focusGraphMeta);
                const hoverClass = getHoverRelationClassName(edge.relationId, hoverGraphMeta);

                return (
                  <path
                    key={edge.relationId}
                    d={geometry.path}
                    className={`edge-line status-${edge.status.toLowerCase()} relation-family-${relationFamily.key} ${focusClass} ${hoverClass}`}
                    markerEnd="url(#graph-arrow)"
                  />
                );
              })}
            </svg>

            {graph.edges.map((edge) => {
              const source = renderNodeMap[edge.headEntityId];
              const target = renderNodeMap[edge.tailEntityId];
              if (!source || !target) return null;
              const geometry = getEdgeGeometry(source, target, graphMetrics[edge.relationId]?.offset ?? 0);
              const relationFamily = getRelationFamilyMeta(edge.relationType, graph.caseType);
              const labelPosition = resolveEdgeLabelPosition(geometry, renderNodes, source.entityId, target.entityId);
              const focusClass = getFocusRelationClassName(edge.relationId, focusGraphMeta);
              const hoverClass = getHoverRelationClassName(edge.relationId, hoverGraphMeta);

              return (
                <button
                  key={edge.relationId}
                  className={`edge-label status-${edge.status.toLowerCase()} relation-family-${relationFamily.key} ${focusClass} ${hoverClass}`}
                  style={{ left: labelPosition.x, top: labelPosition.y }}
                  onClick={() => onSelectRelation(edge)}
                  onMouseEnter={() => {
                    setHoveredRelationId(edge.relationId);
                    setHoveredEntityId(null);
                  }}
                  onMouseLeave={() => setHoveredRelationId((current) => (current === edge.relationId ? null : current))}
                >
                  <span className="edge-label-title">{edge.relationName}</span>
                  <span className="edge-label-meta">
                    {relationFamily.label} | {formatStatusLabel(edge.status)}
                  </span>
                </button>
              );
            })}

            {renderNodes.map((node) => (
              <div
                key={node.entityId}
                className={
                  draggingNodeId === node.entityId
                    ? `graph-node-shell is-dragging`
                    : selectedEntityId === node.entityId || focusedEntityId === node.entityId || hoveredEntityId === node.entityId
                      ? "graph-node-shell has-node-actions"
                    : "graph-node-shell"
                }
                style={{ left: node.x, top: node.y }}
                onMouseEnter={() => {
                  setHoveredEntityId(node.entityId);
                  setHoveredRelationId(null);
                  onHoverEntity(node);
                }}
                onMouseLeave={() => {
                  setHoveredEntityId((current) => (current === node.entityId ? null : current));
                  onLeaveHoverEntity();
                }}
              >
                <button
                  className={
                    draggingNodeId === node.entityId
                      ? `graph-node node-${node.entityType.toLowerCase()} is-dragging`
                      : hoverGraphMeta.active
                        ? `graph-node node-${node.entityType.toLowerCase()} ${getHoverNodeClassName(node.entityId, hoverGraphMeta)}`
                      : focusGraphMeta.nodeDepths[node.entityId] === 1
                        ? `graph-node node-${node.entityType.toLowerCase()} is-neighbor-direct`
                      : focusGraphMeta.nodeDepths[node.entityId] === 2
                        ? `graph-node node-${node.entityType.toLowerCase()} is-neighbor-contextual`
                      : focusedEntityId === node.entityId
                        ? `graph-node node-${node.entityType.toLowerCase()} is-focused`
                        : `graph-node node-${node.entityType.toLowerCase()}`
                  }
                  onMouseDown={(event) => handleNodeMouseDown(event, node)}
                  onClick={() => handleNodeClick(node)}
                >
                  <span className="graph-node-head">
                    <span className="graph-node-type">{formatEntityTypeLabel(node.entityType)}</span>
                    <span className="graph-node-focus-hint">{focusedEntityId === node.entityId ? "聚焦中" : "可聚焦"}</span>
                  </span>
                  <strong>{node.displayName}</strong>
                  <span className="graph-node-role">{formatEntitySubtypeLabel(node.entitySubtype)}</span>
                  <span className="graph-node-tags">{node.tags.slice(0, 2).join(" / ") || "点击查看详情"}</span>
                </button>
                <button
                  className={focusedEntityId === node.entityId ? "graph-node-focus is-active" : "graph-node-focus"}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (focusedEntityId === node.entityId) {
                      onClearFocus();
                    } else {
                      onFocusEntity(node.entityId);
                    }
                  }}
                  title={focusedEntityId === node.entityId ? "取消聚焦" : "聚焦到该实体"}
                  aria-label={focusedEntityId === node.entityId ? "取消聚焦" : "聚焦到该实体"}
                  data-tooltip={focusedEntityId === node.entityId ? "取消聚焦" : "聚焦"}
                >
                  <ToolbarIcon name={focusedEntityId === node.entityId ? "focusOff" : "focusOn"} />
                </button>
                <button
                  className={node.layoutLocked ? "graph-node-lock is-locked" : "graph-node-lock"}
                  onClick={(event) => handleToggleNodeLock(event, node.entityId)}
                  title={node.layoutLocked ? "取消锁定节点" : "锁定节点"}
                  aria-label={node.layoutLocked ? "取消锁定节点" : "锁定节点"}
                  data-tooltip={node.layoutLocked ? "取消锁定" : "锁定位置"}
                >
                  <ToolbarIcon name={node.layoutLocked ? "unlockNode" : "lockNode"} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function GraphFullscreenModal(props: {
  caseId: string;
  graph: GraphResponse | null;
  search: string;
  onChangeSearch: (value: string) => void;
  stance: string;
  onChangeStance: (value: string) => void;
  onlyDisputed: boolean;
  onChangeOnlyDisputed: (value: boolean) => void;
  entityOptions: EntityNode[];
  activeView: string;
  views: ViewOption[];
  onChangeView: (viewId: string) => void;
  availableRelationTypes: Array<{ type: string; name: string }>;
  relationFilters: string[];
  onToggleRelationFilter: (relationType: string) => void;
  legendRelationOptions: Array<{ key: string; label: string; className: string }>;
  legendEntityFilters: string[];
  legendRelationFilters: string[];
  onSelectEntity: (entity: EntityNode) => void;
  onSelectRelation: (relation: RelationEdge) => void;
  onFocusEntity: (entityId: string) => void;
  onClearFocus: () => void;
  onHoverEntity: (entity: EntityNode) => void;
  onLeaveHoverEntity: () => void;
  onToggleLegendEntityFilter: (entityType: string) => void;
  onToggleLegendRelationFilter: (filterKey: string) => void;
  onChangeFocusDepth: (depth: number) => void;
  onClearLegendFilters: () => void;
  focusedEntityId?: string;
  onClose: () => void;
}) {
  const {
    caseId,
    graph,
    search,
    onChangeSearch,
    stance,
    onChangeStance,
    onlyDisputed,
    onChangeOnlyDisputed,
    entityOptions,
    activeView,
    views,
    onChangeView,
    availableRelationTypes,
    relationFilters,
    onToggleRelationFilter,
    legendRelationOptions,
    legendEntityFilters,
    legendRelationFilters,
    onSelectEntity,
    onSelectRelation,
    onFocusEntity,
    onClearFocus,
    onHoverEntity,
    onLeaveHoverEntity,
    onToggleLegendEntityFilter,
    onToggleLegendRelationFilter,
    onChangeFocusDepth,
    onClearLegendFilters,
    focusedEntityId,
    onClose,
  } = props;
  const [isFilterCollapsed, setIsFilterCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(FULLSCREEN_FILTER_PANEL_STORAGE_KEY) === "true";
  });

  useEffect(() => {
    window.localStorage.setItem(FULLSCREEN_FILTER_PANEL_STORAGE_KEY, String(isFilterCollapsed));
  }, [isFilterCollapsed]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal-panel graph-fullscreen-modal" onClick={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <div>
            <h2>全屏关系图谱</h2>
            <p>可直接拖动画布、滚轮缩放，便于查看复杂主体和关系网络。</p>
          </div>
          <div className="panel-header-actions">
            <button
              className="secondary-button graph-tool-button graph-icon-button"
              onClick={() => setIsFilterCollapsed((current) => !current)}
              title={isFilterCollapsed ? "展开筛选面板" : "收起筛选面板"}
              aria-label={isFilterCollapsed ? "展开筛选面板" : "收起筛选面板"}
              data-tooltip={isFilterCollapsed ? "展开筛选面板" : "收起筛选面板"}
            >
              <ToolbarIcon name={isFilterCollapsed ? "panelExpand" : "panelCollapse"} />
            </button>
            <button className="secondary-button" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        <div className={isFilterCollapsed ? "graph-fullscreen-layout is-filter-collapsed" : "graph-fullscreen-layout"}>
          <aside className={isFilterCollapsed ? "graph-fullscreen-sidebar is-collapsed" : "graph-fullscreen-sidebar"}>
            <GraphFilterWorkspace
              search={search}
              onChangeSearch={onChangeSearch}
              stance={stance}
              onChangeStance={onChangeStance}
              onlyDisputed={onlyDisputed}
              onChangeOnlyDisputed={onChangeOnlyDisputed}
              entityOptions={entityOptions}
              focusEntityId={focusedEntityId ?? ""}
              onFocusEntity={onFocusEntity}
              onClearFocusEntity={onClearFocus}
              focusDepth={graph?.focusDepth ?? 1}
              onChangeFocusDepth={onChangeFocusDepth}
              views={views}
              activeView={activeView}
              onChangeView={onChangeView}
              availableRelationTypes={availableRelationTypes}
              relationFilters={relationFilters}
              onToggleRelationFilter={onToggleRelationFilter}
              fullscreen
            />
          </aside>
          <div className="graph-fullscreen-main">
            <GraphCanvas
              caseId={caseId}
              graph={graph}
              legendRelationOptions={legendRelationOptions}
              legendEntityFilters={legendEntityFilters}
              legendRelationFilters={legendRelationFilters}
              onOpenFullscreen={() => {}}
              selectedEntityId={focusedEntityId}
              onSelectEntity={onSelectEntity}
              onSelectRelation={onSelectRelation}
              onFocusEntity={onFocusEntity}
              onClearFocus={onClearFocus}
              onHoverEntity={onHoverEntity}
              onLeaveHoverEntity={onLeaveHoverEntity}
              onToggleLegendEntityFilter={onToggleLegendEntityFilter}
              onToggleLegendRelationFilter={onToggleLegendRelationFilter}
              onChangeFocusDepth={onChangeFocusDepth}
              onClearLegendFilters={onClearLegendFilters}
              focusedEntityId={focusedEntityId}
              fullscreen
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function GraphHeaderSummary(props: {
  title: string;
  description?: string;
  focusedEntityName?: string;
  focusDepth?: number;
  onChangeFocusDepth?: (depth: number) => void;
  nodeCount?: number;
  edgeCount?: number;
  hasLegendFilters?: boolean;
  onClearLegendFilters?: () => void;
  compact?: boolean;
}) {
  const {
    title,
    description,
    focusedEntityName,
    focusDepth = 1,
    onChangeFocusDepth,
    nodeCount,
    edgeCount,
    hasLegendFilters = false,
    onClearLegendFilters,
    compact = false,
  } = props;

  return (
    <div className={compact ? "graph-header-copy graph-header-copy-compact" : "graph-header-copy"}>
      <div>
        <strong>{title}</strong>
        {description ? <p className="graph-header-description">{description}</p> : null}
      </div>
      {focusedEntityName ? (
        <div className="graph-focus-trail" aria-label="当前聚焦路径">
          <span>全图</span>
          <span className="graph-focus-trail-sep">/</span>
          <span>{focusedEntityName}</span>
          <span className="graph-focus-trail-sep">/</span>
          <span>{focusDepth === 2 ? "扩展关联" : "直接关联"}</span>
          {onChangeFocusDepth ? (
            <div className="graph-focus-depth-toggle">
              <button className={focusDepth === 1 ? "chip active" : "chip"} onClick={() => onChangeFocusDepth(1)}>
                仅看 1 跳
              </button>
              <button className={focusDepth === 2 ? "chip active" : "chip"} onClick={() => onChangeFocusDepth(2)}>
                展开 2 跳
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="graph-focus-trail graph-focus-trail-muted">当前查看整张图谱</div>
      )}
      {hasLegendFilters ? (
        <div className="graph-filter-banner">
          <span>当前图例筛选已生效</span>
          {onClearLegendFilters ? (
            <button className="focus-clear-button" onClick={onClearLegendFilters}>
              清空筛选
            </button>
          ) : null}
        </div>
      ) : null}
      {nodeCount !== undefined && edgeCount !== undefined ? (
        <div className="graph-summary-badges">
          <span className="graph-summary-badge">主体/事项 {nodeCount}</span>
          <span className="graph-summary-badge">关系 {edgeCount}</span>
          {focusedEntityName ? <span className="graph-summary-badge graph-summary-badge-focus">1跳高亮 / 2跳弱化</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function GraphToolbar(props: {
  fullscreen: boolean;
  focusedEntityName?: string;
  focusDepth: number;
  onChangeFocusDepth: (depth: number) => void;
  nodeCount: number;
  edgeCount: number;
  hasLegendFilters: boolean;
  onClearLegendFilters: () => void;
  showEntityLegend: boolean;
  onToggleEntityLegend: () => void;
  showRelationLegend: boolean;
  onToggleRelationLegend: () => void;
  onAutoRelayout: () => void;
  onRestoreDefaultLayout: () => void;
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetView: () => void;
  onOpenFullscreen: () => void;
  layoutStatus: string;
}) {
  const {
    fullscreen,
    focusedEntityName,
    focusDepth,
    onChangeFocusDepth,
    nodeCount,
    edgeCount,
    hasLegendFilters,
    onClearLegendFilters,
    showEntityLegend,
    onToggleEntityLegend,
    showRelationLegend,
    onToggleRelationLegend,
    onAutoRelayout,
    onRestoreDefaultLayout,
    zoom,
    onZoomOut,
    onZoomIn,
    onResetView,
    onOpenFullscreen,
    layoutStatus,
  } = props;

  return (
    <div className={fullscreen ? "graph-toolbar graph-toolbar-fullscreen" : "graph-toolbar"}>
      <GraphHeaderSummary
        title="关系图谱"
        focusedEntityName={focusedEntityName}
        focusDepth={focusDepth}
        onChangeFocusDepth={onChangeFocusDepth}
        nodeCount={nodeCount}
        edgeCount={edgeCount}
        hasLegendFilters={hasLegendFilters}
        onClearLegendFilters={onClearLegendFilters}
        compact
      />
      <div className="graph-toolbar-actions graph-toolbar-actions-iconic">
        <div className="graph-action-group">
          <GraphIconActionButton
            label={showEntityLegend ? "隐藏实体图例" : "显示实体图例"}
            icon="entityLegend"
            active={showEntityLegend}
            onClick={onToggleEntityLegend}
          />
          <GraphIconActionButton
            label={showRelationLegend ? "隐藏关系图例" : "显示关系图例"}
            icon="relationLegend"
            active={showRelationLegend}
            onClick={onToggleRelationLegend}
          />
        </div>
        <div className="graph-action-group">
          <GraphIconActionButton label="自动重新排版" icon="relayout" onClick={onAutoRelayout} />
          <GraphIconActionButton label="恢复默认布局" icon="restoreLayout" onClick={onRestoreDefaultLayout} />
        </div>
        <div className="graph-action-group graph-action-group-zoom">
          <GraphIconActionButton label="缩小" icon="zoomOut" square onClick={onZoomOut} />
          <span className="graph-zoom-pill">{Math.round(zoom * 100)}%</span>
          <GraphIconActionButton label="放大" icon="zoomIn" square onClick={onZoomIn} />
          <GraphIconActionButton label="重置视图" icon="resetView" onClick={onResetView} />
        </div>
        {!fullscreen ? (
          <div className="graph-action-group">
            <GraphIconActionButton label="全屏查看" icon="fullscreenOpen" onClick={onOpenFullscreen} />
          </div>
        ) : null}
        {layoutStatus ? <span className="graph-layout-status">{layoutStatus}</span> : null}
      </div>
    </div>
  );
}

function GraphLegendPanels(props: {
  showEntityLegend: boolean;
  onCloseEntityLegend: () => void;
  legendEntityFilters: string[];
  onToggleLegendEntityFilter: (entityType: string) => void;
  showRelationLegend: boolean;
  onCloseRelationLegend: () => void;
  legendRelationOptions: Array<{ key: string; label: string; className: string }>;
  legendRelationFilters: string[];
  onToggleLegendRelationFilter: (filterKey: string) => void;
}) {
  const {
    showEntityLegend,
    onCloseEntityLegend,
    legendEntityFilters,
    onToggleLegendEntityFilter,
    showRelationLegend,
    onCloseRelationLegend,
    legendRelationOptions,
    legendRelationFilters,
    onToggleLegendRelationFilter,
  } = props;

  return (
    <>
      {showEntityLegend ? (
        <GraphLegendPanel title="实体图例" onClose={onCloseEntityLegend}>
          <EntityLegendContent
            legendEntityFilters={legendEntityFilters}
            onToggleLegendEntityFilter={onToggleLegendEntityFilter}
          />
        </GraphLegendPanel>
      ) : null}

      {showRelationLegend ? (
        <GraphLegendPanel title="关系图例" onClose={onCloseRelationLegend}>
          <RelationLegendContent
            legendRelationOptions={legendRelationOptions}
            legendRelationFilters={legendRelationFilters}
            onToggleLegendRelationFilter={onToggleLegendRelationFilter}
          />
        </GraphLegendPanel>
      ) : null}
    </>
  );
}

function GraphIconActionButton(props: {
  label: string;
  icon: Parameters<typeof ToolbarIcon>[0]["name"];
  onClick: () => void;
  active?: boolean;
  square?: boolean;
}) {
  const { label, icon, onClick, active = false, square = false } = props;
  const className = [
    "secondary-button",
    "graph-tool-button",
    "graph-icon-button",
    square ? "graph-tool-square" : "",
    active ? "active-floating-button" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={className} onClick={onClick} title={label} aria-label={label} data-tooltip={label}>
      <ToolbarIcon name={icon} />
    </button>
  );
}

function GraphFilterWorkspace(props: {
  search: string;
  onChangeSearch: (value: string) => void;
  stance: string;
  onChangeStance: (value: string) => void;
  onlyDisputed: boolean;
  onChangeOnlyDisputed: (value: boolean) => void;
  entityOptions: EntityNode[];
  focusEntityId: string;
  onFocusEntity: (entityId: string) => void;
  onClearFocusEntity: () => void;
  focusDepth: number;
  onChangeFocusDepth: (depth: number) => void;
  views: ViewOption[];
  activeView: string;
  onChangeView: (viewId: string) => void;
  availableRelationTypes: Array<{ type: string; name: string }>;
  relationFilters: string[];
  onToggleRelationFilter: (relationType: string) => void;
  fullscreen?: boolean;
}) {
  const {
    search,
    onChangeSearch,
    stance,
    onChangeStance,
    onlyDisputed,
    onChangeOnlyDisputed,
    entityOptions,
    focusEntityId,
    onFocusEntity,
    onClearFocusEntity,
    focusDepth,
    onChangeFocusDepth,
    views,
    activeView,
    onChangeView,
    availableRelationTypes,
    relationFilters,
    onToggleRelationFilter,
    fullscreen = false,
  } = props;
  const [sectionCollapsed, setSectionCollapsed] = useState(() => {
    if (!fullscreen || typeof window === "undefined") {
      return {
        filters: false,
        views: false,
        relationTypes: false,
      };
    }

    try {
      const raw = window.localStorage.getItem(FULLSCREEN_FILTER_SECTIONS_STORAGE_KEY);
      if (!raw) {
        return {
          filters: false,
          views: false,
          relationTypes: false,
        };
      }
      const parsed = JSON.parse(raw) as Partial<Record<"filters" | "views" | "relationTypes", boolean>>;
      return {
        filters: parsed.filters ?? false,
        views: parsed.views ?? false,
        relationTypes: parsed.relationTypes ?? false,
      };
    } catch {
      return {
        filters: false,
        views: false,
        relationTypes: false,
      };
    }
  });

  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    window.localStorage.setItem(FULLSCREEN_FILTER_SECTIONS_STORAGE_KEY, JSON.stringify(sectionCollapsed));
  }, [fullscreen, sectionCollapsed]);

  function toggleSection(sectionKey: "filters" | "views" | "relationTypes") {
    setSectionCollapsed((current) => ({
      ...current,
      [sectionKey]: !current[sectionKey],
    }));
  }

  const filterSummary = buildFilterSectionSummary({
    search,
    stance,
    onlyDisputed,
    focusEntityName: entityOptions.find((entity) => entity.entityId === focusEntityId)?.displayName,
    focusDepth,
  });
  const activeViewLabel = views.find((view) => view.id === activeView)?.label ?? "综合全景视图";
  const relationTypeSummary = relationFilters.length > 0 ? `${relationFilters.length} 项已选` : "全部关系";

  return (
    <div className={fullscreen ? "graph-filter-workspace graph-filter-workspace-fullscreen" : "graph-filter-workspace"}>
      <GraphFilterSection
        title="筛选条件"
        summary={filterSummary}
        fullscreen={fullscreen}
        collapsed={sectionCollapsed.filters}
        onToggle={() => toggleSection("filters")}
      >
        <label className="field-label">
          关键词搜索
          <input
            value={search}
            onChange={(event) => onChangeSearch(event.target.value)}
            placeholder="搜索人物、关系或合同"
          />
        </label>
        <label className="field-label">
          事实口径
          <select value={stance} onChange={(event) => onChangeStance(event.target.value)}>
            <option value="COMBINED">综合视图</option>
            <option value="PLAINTIFF">原告诉称</option>
            <option value="DEFENDANT">被告抗辩</option>
            <option value="COURT">法院查明</option>
          </select>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={onlyDisputed}
            onChange={(event) => onChangeOnlyDisputed(event.target.checked)}
          />
          只看争议关系
        </label>
        <div className="focus-filter-card">
          <div className="focus-filter-header">
            <strong>实体聚焦</strong>
            {focusEntityId ? (
              <button className="focus-clear-button" onClick={onClearFocusEntity}>
                返回全图
              </button>
            ) : null}
          </div>
          <label className="field-label compact">
            选择实体
            <select value={focusEntityId} onChange={(event) => onFocusEntity(event.target.value)}>
              <option value="">查看整张图谱</option>
              {entityOptions.map((entity) => (
                <option key={entity.entityId} value={entity.entityId}>
                  {entity.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label compact">
            展示范围
            <select value={focusDepth} onChange={(event) => onChangeFocusDepth(Number(event.target.value))}>
              <option value={1}>直接关联（1跳）</option>
              <option value={2}>扩展关联（2跳）</option>
            </select>
          </label>
          <p className="panel-desc">聚焦后只展示该实体周边关系与相邻主体，适合看单个角色的事实链。</p>
        </div>
      </GraphFilterSection>

      <GraphFilterSection
        title="预置视图"
        summary={activeViewLabel}
        fullscreen={fullscreen}
        collapsed={sectionCollapsed.views}
        onToggle={() => toggleSection("views")}
      >
        <div className="chip-group">
          {views.map((view) => (
            <button
              key={view.id}
              className={view.id === activeView ? "chip active" : "chip"}
              onClick={() => onChangeView(view.id)}
            >
              {view.label}
            </button>
          ))}
        </div>
      </GraphFilterSection>

      <GraphFilterSection
        title="关系类型"
        summary={relationTypeSummary}
        fullscreen={fullscreen}
        collapsed={sectionCollapsed.relationTypes}
        onToggle={() => toggleSection("relationTypes")}
      >
        <div className="chip-group">
          {availableRelationTypes.map((item) => (
            <button
              key={item.type}
              className={relationFilters.includes(item.type) ? "chip active" : "chip"}
              onClick={() => onToggleRelationFilter(item.type)}
            >
              {item.name}
            </button>
          ))}
        </div>
      </GraphFilterSection>
    </div>
  );
}

function GraphFilterSection(props: {
  title: string;
  summary: string;
  fullscreen: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { title, summary, fullscreen, collapsed, onToggle, children } = props;

  return (
    <section className={fullscreen ? "panel graph-filter-panel graph-filter-panel-fullscreen" : "panel graph-filter-panel"}>
      <div className="graph-filter-section-header">
        <div className="graph-filter-section-heading">
          <h2>{title}</h2>
          <span className="graph-filter-section-summary">{summary}</span>
        </div>
        {fullscreen ? (
          <button
            className="secondary-button graph-tool-button graph-icon-button graph-filter-toggle"
            onClick={onToggle}
            title={collapsed ? `展开${title}` : `收起${title}`}
            aria-label={collapsed ? `展开${title}` : `收起${title}`}
            data-tooltip={collapsed ? `展开${title}` : `收起${title}`}
          >
            <ToolbarIcon name={collapsed ? "sectionExpand" : "sectionCollapse"} />
          </button>
        ) : null}
      </div>
      {!collapsed ? children : null}
    </section>
  );
}

function GraphLegendPanel(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { title, onClose, children } = props;

  return (
    <section className="graph-inline-panel">
      <div className="graph-inline-panel-header">
        <strong>{title}</strong>
        <button className="secondary-button graph-panel-close" onClick={onClose}>
          收起
        </button>
      </div>
      {children}
    </section>
  );
}

function EntityLegendContent(props: {
  legendEntityFilters: string[];
  onToggleLegendEntityFilter: (entityType: string) => void;
}) {
  const { legendEntityFilters, onToggleLegendEntityFilter } = props;

  return (
    <div className="graph-legend graph-legend-entities">
      <button
        className={legendEntityFilters.includes("NaturalPerson") ? "legend-chip node-naturalperson active" : "legend-chip node-naturalperson"}
        onClick={() => onToggleLegendEntityFilter("NaturalPerson")}
      >
        人物主体
      </button>
      <button
        className={legendEntityFilters.includes("Organization") ? "legend-chip node-organization active" : "legend-chip node-organization"}
        onClick={() => onToggleLegendEntityFilter("Organization")}
      >
        单位/组织
      </button>
      <button
        className={legendEntityFilters.includes("VirtualAsset") ? "legend-chip node-virtualasset active" : "legend-chip node-virtualasset"}
        onClick={() => onToggleLegendEntityFilter("VirtualAsset")}
      >
        财产事项
      </button>
      <button
        className={legendEntityFilters.includes("FactClaim") ? "legend-chip node-factclaim active" : "legend-chip node-factclaim"}
        onClick={() => onToggleLegendEntityFilter("FactClaim")}
      >
        事实事项
      </button>
    </div>
  );
}

function RelationLegendContent(props: {
  legendRelationOptions: Array<{ key: string; label: string; className: string }>;
  legendRelationFilters: string[];
  onToggleLegendRelationFilter: (filterKey: string) => void;
}) {
  const { legendRelationOptions, legendRelationFilters, onToggleLegendRelationFilter } = props;

  return (
    <div className="graph-legend graph-legend-relations">
      {legendRelationOptions.map((option) => (
        <button
          key={option.key}
          className={legendRelationFilters.includes(option.key) ? `legend-chip ${option.className} active` : `legend-chip ${option.className}`}
          onClick={() => onToggleLegendRelationFilter(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function applyLegendGraphFilters(
  graph: GraphResponse,
  entityFilters: string[],
  relationFilters: string[],
): GraphResponse {
  if (entityFilters.length === 0 && relationFilters.length === 0) {
    return graph;
  }

  const entityTypeSet = new Set(entityFilters);
  const selectedFamilyKeys = new Set(
    relationFilters.filter((item) => item.startsWith("family:")).map((item) => item.replace("family:", "")),
  );
  const selectedStatuses = new Set(
    relationFilters.filter((item) => item.startsWith("status:")).map((item) => item.replace("status:", "")),
  );
  const entityTypeMap = new Map(graph.nodes.map((node) => [node.entityId, node.entityType]));

  const visibleEdges = graph.edges.filter((edge) => {
    const relationFamily = getRelationFamilyMeta(edge.relationType, graph.caseType);
    if (selectedFamilyKeys.size > 0 && !selectedFamilyKeys.has(relationFamily.key)) {
      return false;
    }
    if (selectedStatuses.size > 0 && !selectedStatuses.has(edge.status)) {
      return false;
    }
    if (entityTypeSet.size === 0) {
      return true;
    }
    return entityTypeSet.has(entityTypeMap.get(edge.headEntityId) ?? "") || entityTypeSet.has(entityTypeMap.get(edge.tailEntityId) ?? "");
  });

  const visibleNodeIds = new Set<string>();
  visibleEdges.forEach((edge) => {
    visibleNodeIds.add(edge.headEntityId);
    visibleNodeIds.add(edge.tailEntityId);
  });

  graph.nodes.forEach((node) => {
    if (entityTypeSet.has(node.entityType)) {
      visibleNodeIds.add(node.entityId);
    }
  });

  return {
    ...graph,
    nodes: graph.nodes.filter((node) => visibleNodeIds.has(node.entityId)),
    edges: visibleEdges,
  };
}

function buildFocusGraphMeta(graph: GraphResponse | null, focusedEntityId?: string) {
  if (!graph || !focusedEntityId) {
    return {
      focusedEntityId: "",
      nodeDepths: {} as Record<string, number>,
      relationEmphasis: {} as Record<string, "direct" | "contextual">,
    };
  }

  const adjacency = new Map<string, RelationEdge[]>();
  graph.edges.forEach((edge) => {
    const headList = adjacency.get(edge.headEntityId) ?? [];
    headList.push(edge);
    adjacency.set(edge.headEntityId, headList);

    const tailList = adjacency.get(edge.tailEntityId) ?? [];
    tailList.push(edge);
    adjacency.set(edge.tailEntityId, tailList);
  });

  const nodeDepths: Record<string, number> = { [focusedEntityId]: 0 };
  const queue = [focusedEntityId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId) continue;
    const currentDepth = nodeDepths[currentId];
    const nextDepth = currentDepth + 1;
    if (nextDepth > 2) {
      continue;
    }

    (adjacency.get(currentId) ?? []).forEach((edge) => {
      const neighborId = edge.headEntityId === currentId ? edge.tailEntityId : edge.headEntityId;
      if (nodeDepths[neighborId] === undefined || nodeDepths[neighborId] > nextDepth) {
        nodeDepths[neighborId] = nextDepth;
        queue.push(neighborId);
      }
    });
  }

  const relationEmphasis: Record<string, "direct" | "contextual"> = {};
  graph.edges.forEach((edge) => {
    relationEmphasis[edge.relationId] =
      edge.headEntityId === focusedEntityId || edge.tailEntityId === focusedEntityId ? "direct" : "contextual";
  });

  return { focusedEntityId, nodeDepths, relationEmphasis };
}

function buildHoverGraphMeta(graph: GraphResponse | null, hoveredEntityId?: string | null, hoveredRelationId?: string | null) {
  if (!graph) {
    return {
      active: false,
      highlightedNodeIds: new Set<string>(),
      highlightedRelationIds: new Set<string>(),
    };
  }

  if (hoveredEntityId) {
    const highlightedNodeIds = new Set<string>([hoveredEntityId]);
    const highlightedRelationIds = new Set<string>();
    graph.edges.forEach((edge) => {
      if (edge.headEntityId === hoveredEntityId || edge.tailEntityId === hoveredEntityId) {
        highlightedRelationIds.add(edge.relationId);
        highlightedNodeIds.add(edge.headEntityId);
        highlightedNodeIds.add(edge.tailEntityId);
      }
    });
    return { active: true, highlightedNodeIds, highlightedRelationIds };
  }

  if (hoveredRelationId) {
    const relation = graph.edges.find((edge) => edge.relationId === hoveredRelationId);
    if (!relation) {
      return {
        active: false,
        highlightedNodeIds: new Set<string>(),
        highlightedRelationIds: new Set<string>(),
      };
    }
    return {
      active: true,
      highlightedNodeIds: new Set<string>([relation.headEntityId, relation.tailEntityId]),
      highlightedRelationIds: new Set<string>([hoveredRelationId]),
    };
  }

  return {
    active: false,
    highlightedNodeIds: new Set<string>(),
    highlightedRelationIds: new Set<string>(),
  };
}

function getFocusRelationClassName(
  relationId: string,
  focusGraphMeta: ReturnType<typeof buildFocusGraphMeta>,
) {
  const emphasis = focusGraphMeta.relationEmphasis[relationId];
  if (!focusGraphMeta.focusedEntityId || !emphasis) {
    return "";
  }
  return emphasis === "direct" ? "edge-focus-direct" : "edge-focus-contextual";
}

function getHoverRelationClassName(
  relationId: string,
  hoverGraphMeta: ReturnType<typeof buildHoverGraphMeta>,
) {
  if (!hoverGraphMeta.active) {
    return "";
  }
  return hoverGraphMeta.highlightedRelationIds.has(relationId) ? "edge-hover-active" : "edge-hover-muted";
}

function getHoverNodeClassName(
  nodeId: string,
  hoverGraphMeta: ReturnType<typeof buildHoverGraphMeta>,
) {
  if (!hoverGraphMeta.active) {
    return "";
  }
  return hoverGraphMeta.highlightedNodeIds.has(nodeId) ? "node-hover-active" : "node-hover-muted";
}

function buildFilterSectionSummary(params: {
  search: string;
  stance: string;
  onlyDisputed: boolean;
  focusEntityName?: string;
  focusDepth: number;
}) {
  const items: string[] = [];
  if (params.search.trim()) {
    items.push(`搜:${params.search.trim()}`);
  }
  if (params.stance !== "COMBINED") {
    items.push(formatStanceLabel(params.stance as "COMBINED" | "PLAINTIFF" | "DEFENDANT" | "COURT"));
  }
  if (params.onlyDisputed) {
    items.push("争议");
  }
  if (params.focusEntityName) {
    items.push(`${params.focusEntityName} ${params.focusDepth === 2 ? "2跳" : "1跳"}`);
  }
  return items.length > 0 ? items.join(" / ") : "未设置";
}

function ToolbarIcon(props: {
  name:
    | "entityLegend"
    | "relationLegend"
    | "relayout"
    | "restoreLayout"
    | "zoomOut"
    | "zoomIn"
    | "resetView"
    | "fullscreenOpen"
    | "panelCollapse"
    | "panelExpand"
    | "sectionCollapse"
    | "sectionExpand"
    | "focusOn"
    | "focusOff"
    | "lockNode"
    | "unlockNode";
}) {
  const { name } = props;

  const iconMap = {
    entityLegend: (
      <path
        d="M5 6h6M5 12h14M5 18h10M15 6a1 1 0 1 0 0.001 0M11 18a1 1 0 1 0 0.001 0M17 12a1 1 0 1 0 0.001 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    ),
    relationLegend: (
      <path
        d="M6 7h3l2 3 2-3h5M6 17h3l2-3 2 3h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    relayout: (
      <path
        d="M7 7h4v4H7zM13 13h4v4h-4zM13 7h4v4h-4zM7 13h4v4H7zM11 9h2M9 11v2M15 11v2M11 15h2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    ),
    restoreLayout: (
      <path
        d="M6 8V5h3M18 16v3h-3M7 6a7 7 0 0 1 11 2M17 18a7 7 0 0 1-11-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    zoomOut: (
      <path d="M10 10h7M17 17l3 3M17 10a7 7 0 1 1-14 0a7 7 0 0 1 14 0Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    ),
    zoomIn: (
      <path d="M10 7v6M7 10h6M17 17l3 3M17 10a7 7 0 1 1-14 0a7 7 0 0 1 14 0Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    ),
    resetView: (
      <path
        d="M4 8l4-4 4 4M8 4v9a4 4 0 0 0 4 4h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    fullscreenOpen: (
      <path
        d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    panelCollapse: (
      <path
        d="M4 6h16M4 12h10M4 18h16M16 9l4 3l-4 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    panelExpand: (
      <path
        d="M4 6h16M10 12h10M4 18h16M8 9l-4 3l4 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    sectionCollapse: (
      <path d="M7 10l5 5l5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    ),
    sectionExpand: (
      <path d="M7 14l5-5l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    ),
    focusOn: (
      <path
        d="M12 5c4.8 0 8.7 4.1 9.5 5c-.8.9-4.7 5-9.5 5S3.3 10.9 2.5 10c.8-.9 4.7-5 9.5-5Zm0 3.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 0 0 0-3.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    focusOff: (
      <>
        <path
          d="M12 5c4.8 0 8.7 4.1 9.5 5c-.8.9-4.7 5-9.5 5S3.3 10.9 2.5 10c.8-.9 4.7-5 9.5-5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M4 4l16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
    lockNode: (
      <path
        d="M8 11V8a4 4 0 1 1 8 0v3M7 11h10v8H7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    unlockNode: (
      <path
        d="M8 11V8a4 4 0 0 1 7-2.7M7 11h10v8H7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  } as const;

  return (
    <svg viewBox="0 0 24 24" className="toolbar-icon" aria-hidden="true">
      {iconMap[name]}
    </svg>
  );
}

function buildGraphMetrics(edges: RelationEdge[]) {
  const grouped = new Map<string, RelationEdge[]>();

  edges.forEach((edge) => {
    const pairKey = [edge.headEntityId, edge.tailEntityId].sort().join("__");
    const list = grouped.get(pairKey) ?? [];
    list.push(edge);
    grouped.set(pairKey, list);
  });

  return Object.fromEntries(
    Array.from(grouped.values()).flatMap((group) => {
      const midpoint = (group.length - 1) / 2;
      return group.map((edge, index) => [edge.relationId, { offset: (index - midpoint) * 30 }]);
    }),
  ) as Record<string, { offset: number }>;
}

function getEdgeGeometry(source: EntityNode, target: EntityNode, offset: number) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2;
  const curveStrength = Math.min(Math.max(distance * 0.12, 22), 70);
  const controlX = midX + normalX * (curveStrength + offset);
  const controlY = midY + normalY * (curveStrength + offset);

  return {
    path: `M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`,
    labelX: midX + normalX * (curveStrength * 0.55 + offset * 0.4),
    labelY: midY + normalY * (curveStrength * 0.55 + offset * 0.4),
    normalX,
    normalY,
  };
}

function resolveNodeLayout(nodes: EntityNode[], sceneWidth: number, sceneHeight: number, respectLocks = true) {
  const laidOut = nodes.map((node) => ({
    ...node,
    x: clamp(node.x, NODE_HALF_WIDTH + 24, sceneWidth - NODE_HALF_WIDTH - 24),
    y: clamp(node.y, NODE_HALF_HEIGHT + 24, sceneHeight - NODE_HALF_HEIGHT - 24),
  }));

  for (let round = 0; round < 18; round += 1) {
    for (let i = 0; i < laidOut.length; i += 1) {
      for (let j = i + 1; j < laidOut.length; j += 1) {
        const first = laidOut[i];
        const second = laidOut[j];
        const dx = second.x - first.x || (i % 2 === 0 ? 1 : -1);
        const dy = second.y - first.y || (j % 2 === 0 ? 1 : -1);
        const overlapX = NODE_WIDTH + NODE_GAP_X - Math.abs(dx);
        const overlapY = NODE_HEIGHT + NODE_GAP_Y - Math.abs(dy);

        if (overlapX > 0 && overlapY > 0) {
          const firstLocked = respectLocks && !!first.layoutLocked;
          const secondLocked = respectLocks && !!second.layoutLocked;
          if (firstLocked && secondLocked) {
            continue;
          }

          const pushX = (overlapX / 2) * Math.sign(dx);
          const pushY = (overlapY / 2) * Math.sign(dy);

          if (firstLocked) {
            second.x = clamp(second.x + pushX * 2, NODE_HALF_WIDTH + 24, sceneWidth - NODE_HALF_WIDTH - 24);
            second.y = clamp(second.y + pushY * 2, NODE_HALF_HEIGHT + 24, sceneHeight - NODE_HALF_HEIGHT - 24);
          } else if (secondLocked) {
            first.x = clamp(first.x - pushX * 2, NODE_HALF_WIDTH + 24, sceneWidth - NODE_HALF_WIDTH - 24);
            first.y = clamp(first.y - pushY * 2, NODE_HALF_HEIGHT + 24, sceneHeight - NODE_HALF_HEIGHT - 24);
          } else {
            first.x = clamp(first.x - pushX, NODE_HALF_WIDTH + 24, sceneWidth - NODE_HALF_WIDTH - 24);
            second.x = clamp(second.x + pushX, NODE_HALF_WIDTH + 24, sceneWidth - NODE_HALF_WIDTH - 24);
            first.y = clamp(first.y - pushY, NODE_HALF_HEIGHT + 24, sceneHeight - NODE_HALF_HEIGHT - 24);
            second.y = clamp(second.y + pushY, NODE_HALF_HEIGHT + 24, sceneHeight - NODE_HALF_HEIGHT - 24);
          }
        }
      }
    }
  }

  return laidOut;
}

function buildDefaultNodeLayout(nodes: EntityNode[], sceneWidth: number, sceneHeight: number) {
  const columnAnchors = {
    NaturalPerson: 0,
    ProcedureEntity: 1,
    FactClaim: 2,
    Organization: 0,
    VirtualAsset: 2,
  } as const;
  const rowAnchors = {
    NaturalPerson: 0,
    ProcedureEntity: 1,
    FactClaim: 1,
    Organization: 3,
    VirtualAsset: 3,
  } as const;

  const counters = new Map<string, number>();
  const startX = 180;
  const startY = 120;
  const colStep = 250;
  const rowStep = 170;

  return nodes.map((node) => {
    const key = node.entityType in columnAnchors ? node.entityType : "FactClaim";
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);

    const baseColumn = columnAnchors[key as keyof typeof columnAnchors];
    const baseRow = rowAnchors[key as keyof typeof rowAnchors];
    const x = startX + (baseColumn + (index % 2)) * colStep + Math.floor(index / 4) * 24;
    const y = startY + (baseRow + Math.floor(index / 2)) * rowStep;

    return {
      ...node,
      x: clamp(x, NODE_HALF_WIDTH + 24, sceneWidth - NODE_HALF_WIDTH - 24),
      y: clamp(y, NODE_HALF_HEIGHT + 24, sceneHeight - NODE_HALF_HEIGHT - 24),
    };
  });
}

function resolveEdgeLabelPosition(
  geometry: ReturnType<typeof getEdgeGeometry>,
  nodes: EntityNode[],
  sourceId: string,
  targetId: string,
) {
  let x = geometry.labelX;
  let y = geometry.labelY;

  for (let step = 0; step < 6; step += 1) {
    const collision = nodes.some((node) => {
      if (node.entityId === sourceId || node.entityId === targetId) {
        return false;
      }

      return (
        Math.abs(node.x - x) < NODE_HALF_WIDTH * 0.9 &&
        Math.abs(node.y - y) < NODE_HALF_HEIGHT * 0.75
      );
    });

    if (!collision) {
      break;
    }

    x += geometry.normalX * 18;
    y += geometry.normalY * 18;
  }

  return { x, y };
}

function EntityDetailPanel(props: {
  detail: EntityDetail;
  actionLoading: boolean;
  onConfirm: () => void;
  onFocusEntity: () => void;
  isFocused: boolean;
  onClearFocus: () => void;
}) {
  const { detail, actionLoading, onConfirm, onFocusEntity, isFocused, onClearFocus } = props;

  return (
    <div className="detail-content">
      <div className="detail-header">
        <div>
          <span className="pill">{formatEntitySubtypeLabel(detail.entitySubtype)}</span>
          <h3>{detail.displayName}</h3>
        </div>
        <div className="detail-header-actions">
          <button className="secondary-button" onClick={isFocused ? onClearFocus : onFocusEntity}>
            {isFocused ? "返回全图" : "查看关联子图"}
          </button>
          <button className="secondary-button" onClick={onConfirm} disabled={actionLoading || detail.confirmed}>
            {detail.confirmed ? "已确认" : actionLoading ? "处理中..." : "确认主体/事项"}
          </button>
        </div>
      </div>

      <Section title="标签">
        <div className="chip-group static">
          {detail.tags.map((tag) => (
            <span key={tag} className="chip active">
              {tag}
            </span>
          ))}
        </div>
      </Section>

      <Section title="主体/事项信息">
        <KeyValueList values={detail.attributes} />
      </Section>

      <Section title="关联关系">
        <ul className="simple-list">
          {detail.relations.map((relation) => (
            <li key={relation.relationId}>
              {relation.relationName} | 置信度 {(relation.confidence * 100).toFixed(0)}%
            </li>
          ))}
        </ul>
      </Section>

      <Section title="来源片段">
        {detail.sources.map((source) => (
          <SourceCard key={source.sourceId} source={source} />
        ))}
      </Section>
    </div>
  );
}

function RelationDetailPanel(props: {
  detail: RelationDetail;
  actionLoading: boolean;
  onConfirm: () => void;
}) {
  const { detail, actionLoading, onConfirm } = props;

  return (
    <div className="detail-content">
      <div className="detail-header">
        <div>
          <span className={`pill status-${detail.status.toLowerCase()}`}>{formatStatusLabel(detail.status)}</span>
          <h3>
            {detail.headEntity.displayName} - {detail.relationName} - {detail.tailEntity.displayName}
          </h3>
        </div>
        <button className="secondary-button" onClick={onConfirm} disabled={actionLoading || detail.status === "CONFIRMED"}>
          {detail.status === "CONFIRMED" ? "已确认" : actionLoading ? "处理中..." : "确认关系"}
        </button>
      </div>

      <Section title="关系信息">
        <KeyValueList values={detail.attributes} />
      </Section>

      <Section title="识别信息">
        <KeyValueList
          values={{
            置信度: `${(detail.confidence * 100).toFixed(0)}%`,
            事实口径: formatStanceLabel(detail.stance),
            当前状态: formatStatusLabel(detail.status),
          }}
        />
      </Section>

      <Section title="来源片段">
        {detail.sources.map((source) => (
          <SourceCard key={source.sourceId} source={source} />
        ))}
      </Section>

      <Section title="校核记录">
        <ul className="simple-list">
          {detail.reviewLogs.map((log) => (
            <li key={log.reviewId}>
              {new Date(log.operatedAt).toLocaleString()} | {log.actionType} | {log.operator}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function EntityHoverPreviewPanel(props: {
  detail: EntityDetail;
}) {
  const { detail } = props;
  const previewAttributes = Object.fromEntries(Object.entries(detail.attributes).slice(0, 4));
  const previewRelations = detail.relations.slice(0, 3);
  const previewSources = detail.sources.slice(0, 2);

  return (
    <div className="hover-preview-card">
      <div className="hover-preview-header">
        <span className="pill">悬停预览</span>
        <strong>{detail.displayName}</strong>
      </div>
      <p className="panel-desc">
        {formatEntityTypeLabel(detail.entityType)} / {formatEntitySubtypeLabel(detail.entitySubtype)}
      </p>

      {Object.keys(previewAttributes).length > 0 ? (
        <Section title="关键信息">
          <KeyValueList values={previewAttributes} />
        </Section>
      ) : null}

      <Section title="关联关系预览">
        <ul className="simple-list">
          {previewRelations.map((relation) => (
            <li key={relation.relationId}>
              {relation.relationName} | {formatStatusLabel(relation.status)}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="来源片段预览">
        {previewSources.map((source) => (
          <SourceCard key={source.sourceId} source={source} />
        ))}
      </Section>
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="detail-section">
      <h4>{props.title}</h4>
      {props.children}
    </section>
  );
}

function KeyValueList(props: { values: Record<string, string> }) {
  return (
    <div className="kv-list">
      {Object.entries(props.values).map(([key, value]) => (
        <div key={key} className="kv-row">
          <span>{key}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function SourceCard(props: { source: RelationDetail["sources"][number] }) {
  const { source } = props;
  return (
    <article className="source-card">
      <header>
        <strong>
          {source.documentType} | {source.sourceParty}
        </strong>
        <span>
          第 {source.page} 页 {source.paragraph}
        </span>
      </header>
      <p>{source.text}</p>
    </article>
  );
}

function CompareModal(props: {
  versions: VersionRecord[];
  actionLoading: boolean;
  compareLeftVersionId: string;
  compareRightVersionId: string;
  onChangeLeftVersion: (value: string) => void;
  onChangeRightVersion: (value: string) => void;
  getVersionLabel: (versionId: string) => string;
  onPublishVersion: (versionId: string) => void;
  compareLoading: boolean;
  compareSummary: {
    entityAdded: number;
    entityRemoved: number;
    entityChanged: number;
    relationAdded: number;
    relationRemoved: number;
    relationChanged: number;
  } | null;
  versionCompare: VersionCompareResponse | null;
  onClose: () => void;
}) {
  const {
    versions,
    actionLoading,
    compareLeftVersionId,
    compareRightVersionId,
    onChangeLeftVersion,
    onChangeRightVersion,
    getVersionLabel,
    onPublishVersion,
    compareLoading,
    compareSummary,
    versionCompare,
    onClose,
  } = props;
  const [sourceFilter, setSourceFilter] = useState("ALL");
  const sourceOptions = useMemo(() => {
    const values = Array.from(new Set(versions.map((version) => getVersionTriggerSource(version))));
    return ["ALL", ...values];
  }, [versions]);
  const filteredVersions = useMemo(
    () =>
      sourceFilter === "ALL"
        ? versions
        : versions.filter((version) => getVersionTriggerSource(version) === sourceFilter),
    [sourceFilter, versions],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal-panel compare-modal" onClick={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <div>
            <h2>版本记录</h2>
            <p>集中查看历史版本，并按需选择两个版本进行差异对比。</p>
          </div>
          <button className="secondary-button" onClick={onClose}>
            关闭
          </button>
        </div>

        <section className="version-history-section">
          <div className="version-history-header">
            <div>
              <h3>历史版本</h3>
              <p>主页面默认展示当前最新图谱，历史版本与对比结果在此查看。</p>
            </div>
            <span className="version-history-count">共 {versions.length} 个版本</span>
          </div>
          <div className="compare-hint">
            版本生成规则：首次初始化会有一个初始版本；上传卷宗后会自动生成一个新版本；点击“重新抽取”也会生成一个新版本；切换到历史版本只会修改当前发布版本，不会新增版本。
          </div>
          <div className="version-filter-row">
            <span className="version-filter-label">按触发来源筛选</span>
            <div className="chip-group">
              {sourceOptions.map((option) => (
                <button
                  key={option}
                  className={sourceFilter === option ? "chip active" : "chip"}
                  onClick={() => setSourceFilter(option)}
                >
                  {option === "ALL" ? "全部来源" : formatVersionTriggerSourceLabel(option)}
                </button>
              ))}
            </div>
          </div>
          <div className="version-list version-list-modal">
            {filteredVersions.map((version) => {
              const statusLabels = [
                version.isPublished ? "当前发布" : formatVersionTypeLabel(version.versionType),
                formatVersionTriggerSourceLabel(getVersionTriggerSource(version)),
                version.versionId === compareLeftVersionId ? "基准版本" : "",
                version.versionId === compareRightVersionId ? "对比版本" : "",
              ].filter(Boolean);

              return (
                <div key={version.versionId} className={version.isPublished ? "version-item active" : "version-item"}>
                  <strong>{getVersionDisplayName(version, versions)}</strong>
                  <span>{getVersionSourceLabel(version.label)}</span>
                  <span>{new Date(version.createdAt).toLocaleString()}</span>
                  <span>{version.documentSummary ? `依赖卷宗：${version.documentSummary}` : "依赖卷宗：未记录"}</span>
                  <span>{version.documentChangeSummary ?? "材料变化：未记录"}</span>
                  <button
                    className="secondary-button document-action"
                    onClick={() => onPublishVersion(version.versionId)}
                    disabled={actionLoading || version.isPublished}
                  >
                    {version.isPublished ? "当前版本" : actionLoading ? "切换中..." : "切换到此版本"}
                  </button>
                  <div className="version-tag-row">
                    {statusLabels.map((label) => (
                      <span key={`${version.versionId}-${label}`} className="version-tag">
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {filteredVersions.length === 0 ? <div className="empty-state">当前筛选下暂无版本记录。</div> : null}
        </section>

        <div className="compare-controls modal-controls">
          <label className="field-label">
            基准版本
            <select value={compareLeftVersionId} onChange={(event) => onChangeLeftVersion(event.target.value)}>
              {versions.map((version) => (
                <option key={version.versionId} value={version.versionId}>
                  {version.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            对比版本
            <select value={compareRightVersionId} onChange={(event) => onChangeRightVersion(event.target.value)}>
              {versions.map((version) => (
                <option key={version.versionId} value={version.versionId}>
                  {version.label}
                </option>
              ))}
            </select>
          </label>
          <div className="compare-hint">
            {compareLeftVersionId && compareRightVersionId && compareLeftVersionId !== compareRightVersionId
              ? `${getVersionLabel(compareLeftVersionId)} -> ${getVersionLabel(compareRightVersionId)}`
              : "请选择两个不同版本进行对比"}
          </div>
          <div className="loading-text">{compareLoading ? "差异计算中..." : "差异已加载"}</div>
        </div>

        {compareSummary ? (
          <>
            <div className="compare-summary-grid">
              <StatCard label="新增识别主体/事项" value={String(compareSummary.entityAdded)} tone="added" />
              <StatCard label="移除识别主体/事项" value={String(compareSummary.entityRemoved)} tone="removed" />
              <StatCard label="主体/事项识别结果变化" value={String(compareSummary.entityChanged)} tone="changed" />
              <StatCard label="新增识别关系" value={String(compareSummary.relationAdded)} tone="added" />
              <StatCard label="移除识别关系" value={String(compareSummary.relationRemoved)} tone="removed" />
              <StatCard label="关系识别结果变化" value={String(compareSummary.relationChanged)} tone="changed" />
            </div>

            <div className="compare-layout">
              <CompareColumn
                title="新增识别主体/事项"
                tone="added"
                emptyText="没有新增识别主体/事项"
                items={versionCompare?.entityDiff.added ?? []}
                renderItem={(item) => <EntityCompareCard entity={item} tone="added" />}
              />
              <CompareColumn
                title="移除识别主体/事项"
                tone="removed"
                emptyText="没有移除识别主体/事项"
                items={versionCompare?.entityDiff.removed ?? []}
                renderItem={(item) => <EntityCompareCard entity={item} tone="removed" />}
              />
              <CompareColumn
                title="主体/事项识别结果变化"
                tone="changed"
                emptyText="没有主体/事项识别结果变化"
                items={versionCompare?.entityDiff.changed ?? []}
                renderItem={(item) => <ChangedEntityCard diff={item} />}
              />
            </div>

            <div className="compare-layout">
              <CompareColumn
                title="新增识别关系"
                tone="added"
                emptyText="没有新增识别关系"
                items={versionCompare?.relationDiff.added ?? []}
                renderItem={(item) => <RelationCompareCard relation={item} tone="added" />}
              />
              <CompareColumn
                title="移除识别关系"
                tone="removed"
                emptyText="没有移除识别关系"
                items={versionCompare?.relationDiff.removed ?? []}
                renderItem={(item) => <RelationCompareCard relation={item} tone="removed" />}
              />
              <CompareColumn
                title="关系识别结果变化"
                tone="changed"
                emptyText="没有关系识别结果变化"
                items={versionCompare?.relationDiff.changed ?? []}
                renderItem={(item) => <ChangedRelationCard diff={item} />}
              />
            </div>
          </>
        ) : (
          <div className="empty-state compare-empty">
            {versions.length < 2 ? "至少生成两个版本后，才能查看版本对比结果。" : "请选择两个不同版本进行对比。"}
          </div>
        )}
      </section>
    </div>
  );
}

function CompareColumn<T>(props: {
  title: string;
  tone: "added" | "removed" | "changed";
  emptyText: string;
  items: T[];
  renderItem: (item: T) => ReactNode;
}) {
  return (
    <section className="compare-column">
      <div className="compare-column-header">
        <h3>{props.title}</h3>
        <span className={`compare-badge tone-${props.tone}`}>{props.items.length}</span>
      </div>
      <div className="compare-card-list">
        {props.items.length === 0 ? (
          <div className="compare-empty-list">{props.emptyText}</div>
        ) : (
          props.items.map((item, index) => <div key={index}>{props.renderItem(item)}</div>)
        )}
      </div>
    </section>
  );
}

function EntityCompareCard(props: { entity: VersionCompareEntity; tone: "added" | "removed" }) {
  const { entity, tone } = props;
  return (
    <article className={`compare-card tone-${tone}`}>
      <div className="compare-card-header">
        <strong>{entity.displayName}</strong>
        <span className="pill">{formatEntitySubtypeLabel(entity.entitySubtype)}</span>
      </div>
      <p className="compare-card-meta">{formatEntityTypeLabel(entity.entityType)}</p>
      <div className="chip-group static">
        {entity.tags.map((tag) => (
          <span key={tag} className="chip">
            {tag}
          </span>
        ))}
      </div>
      <KeyValueList values={entity.attributes} />
    </article>
  );
}

function RelationCompareCard(props: { relation: VersionCompareRelation; tone: "added" | "removed" }) {
  const { relation, tone } = props;
  return (
    <article className={`compare-card tone-${tone}`}>
      <div className="compare-card-header">
        <strong>
          {relation.head} - {relation.relationName} - {relation.tail}
        </strong>
        <span className={`pill status-${relation.status.toLowerCase()}`}>{formatStatusLabel(relation.status)}</span>
      </div>
      <p className="compare-card-meta">
        {formatRelationTypeLabel(relation.relationType)} | {formatStanceLabel(relation.stance)}
      </p>
      <KeyValueList values={relation.attributes} />
    </article>
  );
}

function ChangedEntityCard(props: { diff: VersionCompareChanged<VersionCompareEntity> }) {
  const { diff } = props;
  const onlyIdChanged =
    JSON.stringify(omitId(diff.before)) === JSON.stringify(omitId(diff.after)) &&
    diff.before.entityId !== diff.after.entityId;

  return (
    <article className="compare-card tone-changed">
      <div className="compare-card-header">
        <strong>{diff.after.displayName}</strong>
        <span className="pill">主体/事项识别结果变化</span>
      </div>
      <p className="compare-card-meta">{diff.key}</p>
      {onlyIdChanged ? (
        <div className="compare-note">识别语义未变，仅内部编号发生变化。</div>
      ) : null}
      <ComparePair
        leftTitle="基准版本"
        rightTitle="对比版本"
        left={<KeyValueList values={buildEntityDiffView(diff.before)} />}
        right={<KeyValueList values={buildEntityDiffView(diff.after)} />}
      />
    </article>
  );
}

function ChangedRelationCard(props: { diff: VersionCompareChanged<VersionCompareRelation> }) {
  const { diff } = props;
  const onlyIdChanged =
    JSON.stringify(omitId(diff.before)) === JSON.stringify(omitId(diff.after)) &&
    diff.before.relationId !== diff.after.relationId;

  return (
    <article className="compare-card tone-changed">
      <div className="compare-card-header">
        <strong>
          {diff.after.head} - {diff.after.relationName} - {diff.after.tail}
        </strong>
        <span className="pill">关系识别结果变化</span>
      </div>
      <p className="compare-card-meta">{diff.key}</p>
      {onlyIdChanged ? (
        <div className="compare-note">识别语义未变，仅内部编号发生变化。</div>
      ) : null}
      <ComparePair
        leftTitle="基准版本"
        rightTitle="对比版本"
        left={<KeyValueList values={buildRelationDiffView(diff.before)} />}
        right={<KeyValueList values={buildRelationDiffView(diff.after)} />}
      />
    </article>
  );
}

function ComparePair(props: {
  leftTitle: string;
  rightTitle: string;
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className="compare-pair">
      <div className="compare-side">
        <h4>{props.leftTitle}</h4>
        {props.left}
      </div>
      <div className="compare-side">
        <h4>{props.rightTitle}</h4>
        {props.right}
      </div>
    </div>
  );
}

function StatCard(props: { label: string; value: string; tone?: "default" | "added" | "removed" | "changed" }) {
  return (
    <article className={`stat-card ${props.tone ? `tone-${props.tone}` : ""}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </article>
  );
}

function buildEntityDiffView(entity: VersionCompareEntity) {
  return {
    类别: formatEntityTypeLabel(entity.entityType),
    细分类型: formatEntitySubtypeLabel(entity.entitySubtype),
    标签: entity.tags.join(" / ") || "-",
    属性: Object.entries(entity.attributes)
      .map(([key, value]) => `${key}:${value}`)
      .join("；") || "-",
  };
}

function buildRelationDiffView(relation: VersionCompareRelation) {
  return {
    关系类型: formatRelationTypeLabel(relation.relationType),
    当前状态: formatStatusLabel(relation.status),
    事实口径: formatStanceLabel(relation.stance),
    属性: Object.entries(relation.attributes)
      .map(([key, value]) => `${key}:${value}`)
      .join("；") || "-",
  };
}

function omitId<T extends { entityId?: string; relationId?: string }>(value: T) {
  const next = { ...value };
  delete next.entityId;
  delete next.relationId;
  return next;
}

function buildTaskNotice(task: TaskResponse) {
  const progress = Number.isFinite(task.progress) ? `${task.progress}%` : "";
  return [task.currentStage, progress].filter(Boolean).join(" | ");
}

function formatEntityTypeLabel(value: string) {
  return (
    {
      NaturalPerson: "自然人主体",
      Organization: "单位/组织",
      VirtualAsset: "财产/标的事项",
      ProcedureEntity: "程序事项",
      FactClaim: "事实主张事项",
    }[value] ?? value
  );
}

function formatEntitySubtypeLabel(value: string) {
  return (
    {
      Plaintiff: "原告",
      Defendant: "被告",
      ThirdParty: "第三人",
      Agent: "代理人",
      Guarantor: "保证人",
      Witness: "证人",
      LegalRepresentative: "法定代表人",
      ActualController: "实际控制人",
      Contract: "合同事项",
      Account: "涉案账户",
      Money: "款项",
      Property: "涉案财产",
      DefenseClaim: "抗辩主张",
      Claim: "事实主张",
      Event: "事件事项",
      Evidence: "证据材料",
      Application: "申请事项",
      Judgment: "裁判文书",
      Document: "文书材料",
      LawFirm: "律师事务所",
    }[value] ?? value
  );
}

function formatRelationTypeLabel(value: string) {
  return (
    {
      LEND_TO: "借贷关系",
      GUARANTEE_FOR: "保证关系",
      INVESTMENT_CLAIM: "投资主张关系",
      DISPUTE_OVER: "争议关系",
      TRANSFER_CLAIM_TO: "债权转让关系",
      OWE_TO: "偿还义务关系",
      SIGN_NOTE: "借条确认关系",
      DEMAND_PAYMENT: "催款关系",
      APPEAL: "上诉关系",
      SUBMIT_EVIDENCE: "提交证据关系",
      APPLY_APPRAISAL: "鉴定申请关系",
      APPLY_PRESERVATION: "保全申请关系",
      SERVICE_AT: "执业机构关系",
      SIGN_CONTRACT: "签约关系",
      RECEIVE_TRANSFER: "收款关系",
      SPOUSE: "夫妻关系",
      PARENT_CHILD: "父母子女关系",
      GUARDIAN: "监护关系",
      APPOINT_AGENT: "委托代理关系",
      LEGAL_REPRESENTATIVE: "法定代表人关系",
      ACTUAL_CONTROLLER: "实际控制关系",
      SHAREHOLDER: "股东关系",
      OWN: "所有关系",
      USE: "使用关系",
      OCCUPY: "占用关系",
      MORTGAGE: "抵押关系",
    }[value] ?? value
  );
}

function formatStatusLabel(value: string) {
  return (
    {
      SYSTEM_GENERATED: "系统识别",
      CONFIRMED: "已确认",
      DISPUTED: "存在争议",
      PENDING_EVIDENCE: "待补证据",
    }[value] ?? value
  );
}

function formatStanceLabel(value: string) {
  return (
    {
      COMBINED: "综合视图",
      PLAINTIFF: "原告诉称",
      DEFENDANT: "被告抗辩",
      COURT: "法院查明",
    }[value] ?? value
  );
}

function formatParseStatusLabel(value: string) {
  return (
    {
      UPLOADED: "已上传",
      PARSED: "已解析",
      FAILED: "解析失败",
    }[value] ?? value
  );
}

function formatTaskStatusLabel(value: string | null) {
  if (!value) return "-";
  return (
    {
      PENDING: "待处理",
      PROCESSING: "处理中",
      SUCCESS: "已完成",
      FAILED: "失败",
      CANCELLED: "已取消",
    }[value] ?? value
  );
}

function formatVersionTypeLabel(value: string) {
  return (
    {
      AUTO: "自动生成",
      REVIEWED: "人工校核版",
    }[value] ?? value
  );
}

function getVersionTriggerSource(version: VersionRecord) {
  if (version.triggerSource) {
    return version.triggerSource;
  }
  return (
    {
      首次抽取版本: "INITIAL",
      上传卷宗后自动抽取: "UPLOAD",
      手动重跑后的自动版本: "RERUN",
      手动发起图谱重跑: "RERUN",
    }[version.label] ?? (version.label.startsWith("删除卷宗后刷新图谱") ? "DELETE_REFRESH" : "AUTO")
  );
}

function formatVersionTriggerSourceLabel(value: string) {
  return (
    {
      INITIAL: "初始化",
      UPLOAD: "上传卷宗",
      RERUN: "手动重跑",
      DELETE_REFRESH: "删除卷宗刷新",
      REVIEW: "人工校核",
      AUTO: "自动生成",
    }[value] ?? value
  );
}

function getVersionDisplayName(version: VersionRecord, versions: VersionRecord[]) {
  const index = versions.findIndex((item) => item.versionId === version.versionId);
  const sequence = index >= 0 ? versions.length - index : null;
  if (sequence === null) {
    return `${formatVersionTriggerSourceLabel(getVersionTriggerSource(version))}版本`;
  }
  return `第 ${sequence} 版`;
}

function getVersionSourceLabel(value: string) {
  return (
    {
      首次抽取版本: "初始抽取",
      上传卷宗后自动抽取: "上传卷宗触发",
      手动重跑后的自动版本: "手动重新抽取",
      手动发起图谱重跑: "手动重新抽取",
    }[value] ?? value
  );
}

function getVersionMetaLine(version: VersionRecord, versions: VersionRecord[]) {
  const typeLabel = formatVersionTypeLabel(version.versionType);
  const sourceLabel = formatVersionTriggerSourceLabel(getVersionTriggerSource(version));
  const triggerDetail = getVersionSourceLabel(version.label);
  const createdAt = new Date(version.createdAt).toLocaleString();
  const index = versions.findIndex((item) => item.versionId === version.versionId);
  const sequence = index >= 0 ? versions.length - index : null;
  return [sequence ? `${sequence}/${versions.length}` : "", typeLabel, sourceLabel, triggerDetail, createdAt]
    .filter(Boolean)
    .join(" · ");
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getRelationFamilyMeta(relationType: string, caseType: string) {
  const familyMap: Record<string, { key: string; label: string }> = {
    LEND_TO: { key: "loan", label: caseType === "民事" ? "借贷关系" : "资金往来" },
    RECEIVE_TRANSFER: { key: "loan", label: caseType === "民事" ? "借贷关系" : "资金往来" },
    GUARANTEE_FOR: { key: "guarantee", label: "担保关系" },
    MORTGAGE: { key: "guarantee", label: "担保关系" },
    SPOUSE: { key: "inheritance", label: "亲属关系" },
    PARENT_CHILD: { key: "inheritance", label: "亲属关系" },
    GUARDIAN: { key: "inheritance", label: "亲属关系" },
    APPOINT_AGENT: { key: "agency", label: "代理关系" },
    LEGAL_REPRESENTATIVE: { key: "agency", label: "代表/代理关系" },
    DISPUTE_OVER: { key: "general", label: "争议关系" },
    TRANSFER_CLAIM_TO: { key: "asset", label: "债权流转" },
    OWE_TO: { key: "loan", label: "债务履行" },
    SIGN_NOTE: { key: "asset", label: "债权凭证" },
    DEMAND_PAYMENT: { key: "loan", label: "催款过程" },
    APPEAL: { key: "general", label: "诉讼程序" },
    SUBMIT_EVIDENCE: { key: "general", label: "证据关系" },
    APPLY_APPRAISAL: { key: "general", label: "诉讼程序" },
    APPLY_PRESERVATION: { key: "general", label: "诉讼程序" },
    SERVICE_AT: { key: "agency", label: "代理关系" },
    ACTUAL_CONTROLLER: { key: "control", label: "控制关系" },
    SHAREHOLDER: { key: "control", label: "控制关系" },
    OWN: { key: "asset", label: "财产关系" },
    USE: { key: "asset", label: "财产关系" },
    OCCUPY: { key: "asset", label: "财产关系" },
  };

  return familyMap[relationType] ?? { key: "general", label: "一般关系" };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "发生未知错误";
}

export default App;
