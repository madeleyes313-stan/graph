import { randomUUID } from "node:crypto";
import { initDatabase, loadPersistedCases, persistCase } from "./db";
import type {
  DemoCase,
  DemoState,
  EntityRecord,
  RelationRecord,
  ReviewLogRecord,
  SourceRecord,
  TaskRecord,
  TimelineEvent,
  UploadedDocument,
  VersionRecord,
} from "./types";

export const state: DemoState = { cases: {} };

export async function initializeStateStorage() {
  await initDatabase();
  const persistedCases = await loadPersistedCases();

  if (Object.keys(persistedCases).length > 0) {
    state.cases = persistedCases;
    for (const caseData of Object.values(persistedCases)) {
      await persistCase(caseData);
    }
    return;
  }

  const demoCase = createDemoCase();
  state.cases[demoCase.caseId] = demoCase;
  await persistCase(demoCase, demoCase.currentVersionId);
}

export function getCaseById(caseId: string) {
  return state.cases[caseId];
}

export async function persistCaseState(caseData: DemoCase, snapshotVersionId?: string) {
  await persistCase(caseData, snapshotVersionId);
}

export function appendReviewLog(
  caseData: DemoCase,
  targetType: "entity" | "relation",
  targetId: string,
  actionType: string,
  beforeValue: string,
  afterValue: string,
) {
  caseData.reviewLogs.unshift({
    reviewId: randomUUID(),
    targetType,
    targetId,
    actionType,
    operator: "法官助理-演示账号",
    operatedAt: new Date().toISOString(),
    beforeValue,
    afterValue,
  });
}

export function createTask(caseId: string, versionId: string, stage: string): TaskRecord {
  return {
    taskId: `task_${Date.now()}`,
    caseId,
    status: "PROCESSING",
    progress: 20,
    currentStage: stage,
    versionId,
  };
}

export function publishVersion(caseData: DemoCase, version: VersionRecord) {
  caseData.versions = caseData.versions.map((item) => ({
    ...item,
    isPublished: false,
  }));
  caseData.versions.unshift(version);
  caseData.currentVersionId = version.versionId;
}

export function inferVersionTriggerSource(label: string) {
  if (label === "首次抽取版本") return "INITIAL";
  if (label === "上传卷宗后自动抽取") return "UPLOAD";
  if (label === "手动重跑后的自动版本" || label === "手动发起图谱重跑") return "RERUN";
  if (label.startsWith("删除卷宗后刷新图谱")) return "DELETE_REFRESH";
  return "AUTO";
}

export function buildVersionDocumentSnapshot(documents: UploadedDocument[]) {
  return Array.from(
    new Map(
      documents.map((document) => [
        document.documentId,
        {
          documentId: document.documentId,
          documentType: document.documentType || "卷宗材料",
          originalName: document.originalName,
          sourceParty: document.sourceParty,
        },
      ]),
    ).values(),
  );
}

export function summarizeVersionDocuments(
  documents: Array<{ documentType: string }>,
) {
  if (documents.length === 0) {
    return "无卷宗材料";
  }

  const counts = new Map<string, number>();
  documents.forEach((document) => {
    counts.set(document.documentType, (counts.get(document.documentType) ?? 0) + 1);
  });

  const labels = Array.from(counts.entries()).map(([documentType, count]) =>
    count > 1 ? `${documentType}${count}份` : documentType,
  );

  if (labels.length <= 4) {
    return labels.join("、");
  }

  return `${labels.slice(0, 3).join("、")}等${labels.length}类材料`;
}

export function buildVersionMaterialChangeSummary(
  previousDocuments: Array<{ documentId: string; documentType: string }> | undefined,
  nextDocuments: Array<{ documentId: string; documentType: string }>,
  triggerSource: string,
) {
  const nextSummary = summarizeVersionDocuments(nextDocuments);
  if (!previousDocuments || previousDocuments.length === 0) {
    return triggerSource === "INITIAL" ? `初始材料：${nextSummary}` : `本次材料：${nextSummary}`;
  }

  const previousIds = new Set(previousDocuments.map((document) => document.documentId));
  const nextIds = new Set(nextDocuments.map((document) => document.documentId));
  const added = nextDocuments.filter((document) => !previousIds.has(document.documentId));
  const removed = previousDocuments.filter((document) => !nextIds.has(document.documentId));

  if (added.length === 0 && removed.length === 0) {
    return `沿用上一版材料：${nextSummary}`;
  }

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`新增${summarizeVersionDocuments(added)}`);
  }
  if (removed.length > 0) {
    parts.push(`移除${summarizeVersionDocuments(removed)}`);
  }
  return parts.join("；");
}

function createDemoCase(): DemoCase {
  const sources: SourceRecord[] = [
    {
      sourceId: "src_complaint_p12",
      documentId: "doc_complaint",
      documentType: "起诉状",
      sourceParty: "原告",
      paragraph: "P12",
      page: 4,
      text: "原告张三于2024年3月1日向被告李四出借50万元，王五提供连带责任保证。",
      confidence: 0.95,
      extractionMethod: "规则+模型",
      reviewStatus: "UNREVIEWED",
    },
    {
      sourceId: "src_contract_p2",
      documentId: "doc_contract",
      documentType: "借款合同",
      sourceParty: "原告证据",
      paragraph: "P2",
      page: 1,
      text: "借款金额为人民币伍拾万元整，借款期限六个月，保证方式为连带责任保证。",
      confidence: 0.97,
      extractionMethod: "规则",
      reviewStatus: "CONFIRMED",
    },
    {
      sourceId: "src_defense_p6",
      documentId: "doc_defense",
      documentType: "答辩状",
      sourceParty: "被告",
      paragraph: "P6",
      page: 2,
      text: "被告李四认为上述50万元属于合作投资款，并非民间借贷。",
      confidence: 0.88,
      extractionMethod: "模型",
      reviewStatus: "UNREVIEWED",
    },
    {
      sourceId: "src_transfer_p1",
      documentId: "doc_transfer",
      documentType: "银行转账凭证",
      sourceParty: "原告证据",
      paragraph: "P1",
      page: 1,
      text: "2024年3月1日，张三向李四尾号8899账户转账500000元。",
      confidence: 0.99,
      extractionMethod: "规则",
      reviewStatus: "CONFIRMED",
    },
  ];

  const entities: EntityRecord[] = [
    {
      entityId: "person_zhangsan",
      entityType: "NaturalPerson",
      entitySubtype: "Plaintiff",
      displayName: "张三",
      tags: ["原告", "出借人"],
      x: 120,
      y: 110,
      attributes: { 诉讼地位: "原告", 身份证号: "3201********1234" },
      sourceIds: ["src_complaint_p12"],
      confirmed: true,
    },
    {
      entityId: "person_lisi",
      entityType: "NaturalPerson",
      entitySubtype: "Defendant",
      displayName: "李四",
      tags: ["被告", "借款相对方"],
      x: 370,
      y: 110,
      attributes: { 诉讼地位: "被告", 住址: "江苏省南京市" },
      sourceIds: ["src_complaint_p12", "src_defense_p6"],
      confirmed: false,
    },
    {
      entityId: "person_wangwu",
      entityType: "NaturalPerson",
      entitySubtype: "Guarantor",
      displayName: "王五",
      tags: ["保证人"],
      x: 620,
      y: 110,
      attributes: { 诉讼身份: "担保人", 保证方式: "连带责任保证" },
      sourceIds: ["src_complaint_p12", "src_contract_p2"],
      confirmed: false,
    },
    {
      entityId: "contract_loan",
      entityType: "VirtualAsset",
      entitySubtype: "Contract",
      displayName: "借款合同",
      tags: ["合同"],
      x: 230,
      y: 300,
      attributes: { 合同编号: "HT-2024-001", 签订时间: "2024-03-01" },
      sourceIds: ["src_contract_p2"],
      confirmed: true,
    },
    {
      entityId: "account_8899",
      entityType: "VirtualAsset",
      entitySubtype: "Account",
      displayName: "尾号8899账户",
      tags: ["涉案账户"],
      x: 500,
      y: 300,
      attributes: { 开户行: "演示银行南京分行", 账号尾号: "8899" },
      sourceIds: ["src_transfer_p1"],
      confirmed: true,
    },
    {
      entityId: "claim_investment",
      entityType: "FactClaim",
      entitySubtype: "DefenseClaim",
      displayName: "合作投资款主张",
      tags: ["争议主张"],
      x: 720,
      y: 300,
      attributes: { 提出方: "被告李四", 状态: "有争议" },
      sourceIds: ["src_defense_p6"],
      confirmed: false,
    },
  ];

  const relations: RelationRecord[] = [
    {
      relationId: "rel_lend",
      headEntityId: "person_zhangsan",
      relationType: "LEND_TO",
      relationName: "出借",
      tailEntityId: "person_lisi",
      status: "SYSTEM_GENERATED" as const,
      confidence: 0.91,
      sourceIds: ["src_complaint_p12", "src_transfer_p1"],
      stance: "PLAINTIFF" as const,
      attributes: { 金额: "500000元", 发生时间: "2024-03-01" },
    },
    {
      relationId: "rel_guarantee",
      headEntityId: "person_wangwu",
      relationType: "GUARANTEE_FOR",
      relationName: "保证担保",
      tailEntityId: "person_lisi",
      status: "SYSTEM_GENERATED" as const,
      confidence: 0.87,
      sourceIds: ["src_complaint_p12", "src_contract_p2"],
      stance: "PLAINTIFF" as const,
      attributes: { 担保金额: "500000元", 担保方式: "连带责任保证" },
    },
    {
      relationId: "rel_sign_contract",
      headEntityId: "person_lisi",
      relationType: "SIGN_CONTRACT",
      relationName: "签署合同",
      tailEntityId: "contract_loan",
      status: "CONFIRMED" as const,
      confidence: 0.95,
      sourceIds: ["src_contract_p2"],
      stance: "COMBINED" as const,
      attributes: { 合同编号: "HT-2024-001" },
    },
    {
      relationId: "rel_receive_transfer",
      headEntityId: "person_lisi",
      relationType: "RECEIVE_TRANSFER",
      relationName: "收款账户",
      tailEntityId: "account_8899",
      status: "CONFIRMED" as const,
      confidence: 0.97,
      sourceIds: ["src_transfer_p1"],
      stance: "COMBINED" as const,
      attributes: { 金额: "500000元" },
    },
    {
      relationId: "rel_investment_claim",
      headEntityId: "person_lisi",
      relationType: "INVESTMENT_CLAIM",
      relationName: "主张投资关系",
      tailEntityId: "claim_investment",
      status: "DISPUTED" as const,
      confidence: 0.63,
      sourceIds: ["src_defense_p6"],
      stance: "DEFENDANT" as const,
      attributes: { 争议点: "50万元性质认定" },
    },
  ];

  const timeline: TimelineEvent[] = [
    {
      eventId: "event_loan",
      title: "借款形成",
      date: "2024-03-01",
      summary: "张三主张向李四出借 50 万元，并签署借款合同。",
      relatedEntityIds: ["person_zhangsan", "person_lisi", "contract_loan"],
      relatedRelationIds: ["rel_lend", "rel_sign_contract"],
    },
    {
      eventId: "event_transfer",
      title: "资金转账",
      date: "2024-03-01",
      summary: "转账凭证显示张三向李四尾号 8899 账户支付 50 万元。",
      relatedEntityIds: ["person_zhangsan", "person_lisi", "account_8899"],
      relatedRelationIds: ["rel_receive_transfer"],
    },
    {
      eventId: "event_defense",
      title: "被告提出抗辩",
      date: "2024-05-09",
      summary: "李四在答辩状中主张该款项系合作投资款而非借款。",
      relatedEntityIds: ["person_lisi", "claim_investment"],
      relatedRelationIds: ["rel_investment_claim"],
    },
  ];

  const reviewLogs: ReviewLogRecord[] = [
    {
      reviewId: randomUUID(),
      targetType: "relation",
      targetId: "rel_sign_contract",
      actionType: "confirm_relation",
      operator: "法官助理-演示账号",
      operatedAt: "2026-03-25T10:12:00.000Z",
      beforeValue: "{}",
      afterValue: "{\"status\":\"CONFIRMED\"}",
    },
  ];

  const versions: VersionRecord[] = [
    {
      versionId: "ver_demo_v1",
      versionType: "AUTO",
      label: "首次抽取版本",
      createdAt: "2026-03-25T10:00:00.000Z",
      createdBy: "system",
      isPublished: true,
      triggerSource: "INITIAL",
    },
  ];

  const documents: UploadedDocument[] = [
    {
      documentId: "doc_complaint",
      caseId: "case_demo_001",
      fileName: "demo-complaint.txt",
      originalName: "演示起诉状.txt",
      mimeType: "text/plain",
      size: 0,
      uploadedAt: "2026-03-25T10:00:00.000Z",
      filePath: "",
      documentType: "起诉状",
      sourceParty: "原告",
      parseStatus: "PARSED",
      textContent: "原告张三于2024年3月1日向被告李四出借50万元，王五提供连带责任保证。",
      chunkCount: 1,
    },
  ];

  const initialDocumentSnapshot = buildVersionDocumentSnapshot(documents);
  versions[0] = {
    ...versions[0],
    documentCount: initialDocumentSnapshot.length,
    documentSummary: summarizeVersionDocuments(initialDocumentSnapshot),
    documentChangeSummary: buildVersionMaterialChangeSummary(undefined, initialDocumentSnapshot, "INITIAL"),
    documentSnapshot: initialDocumentSnapshot,
  };

  return {
    caseId: "case_demo_001",
    caseNo: "(2026) 苏01民初100号",
    caseName: "张三诉李四民间借贷纠纷",
    caseType: "民事",
    trialStage: "一审",
    stance: "COMBINED",
    versions,
    currentVersionId: "ver_demo_v1",
    entities,
    relations,
    sources,
    timeline,
    tasks: [],
    reviewLogs,
    documents,
  };
}
