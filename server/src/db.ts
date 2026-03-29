import fs from "node:fs/promises";
import path from "node:path";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
import type { DemoCase, EntityRecord, RelationRecord, Stance } from "./types";

let dbPromise: Promise<Database<sqlite3.Database, sqlite3.Statement>> | undefined;

type VersionRow = {
  case_id: string;
  version_id: string;
  version_type: string;
  label: string;
  created_at: string;
  created_by: string;
  is_published: number;
  snapshot_json: string;
};

type CaseIndexRow = {
  case_id: string;
  case_no: string;
  case_name: string;
  case_type: string;
  trial_stage: string;
  stance: string;
  current_version_id: string;
  entity_count: number;
  relation_count: number;
  disputed_relation_count: number;
  document_count: number;
  updated_at: string;
};

type CurrentEntityRow = {
  case_id: string;
  version_id: string;
  entity_id: string;
  entity_type: string;
  entity_subtype: string;
  display_name: string;
  tags_json: string;
  attributes_json: string;
  source_ids_json: string;
  source_count: number;
  confirmed: number;
  x: number;
  y: number;
  updated_at: string;
};

type CurrentRelationRow = {
  case_id: string;
  version_id: string;
  relation_id: string;
  relation_type: string;
  relation_name: string;
  head_entity_id: string;
  head_display_name: string;
  tail_entity_id: string;
  tail_display_name: string;
  status: string;
  stance: string;
  confidence: number;
  source_ids_json: string;
  source_count: number;
  attributes_json: string;
  updated_at: string;
};

export type PaginationQuery = {
  page?: number;
  pageSize?: number;
};

export type CaseListQuery = PaginationQuery & {
  search?: string;
  caseType?: string;
  trialStage?: string;
};

export type EntityListQuery = PaginationQuery & {
  search?: string;
  entityType?: string;
  confirmed?: boolean;
};

export type RelationListQuery = PaginationQuery & {
  search?: string;
  relationType?: string;
  status?: string;
  stance?: Stance;
};

export async function getDb() {
  if (!dbPromise) {
    dbPromise = createDb();
  }
  return dbPromise;
}

export async function initDatabase() {
  const db = await getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      case_id TEXT PRIMARY KEY,
      case_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS version_snapshots (
      case_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      version_type TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      is_published INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY (case_id, version_id)
    );

    CREATE TABLE IF NOT EXISTS case_index (
      case_id TEXT PRIMARY KEY,
      case_no TEXT NOT NULL,
      case_name TEXT NOT NULL,
      case_type TEXT NOT NULL,
      trial_stage TEXT NOT NULL,
      stance TEXT NOT NULL,
      current_version_id TEXT NOT NULL,
      entity_count INTEGER NOT NULL,
      relation_count INTEGER NOT NULL,
      disputed_relation_count INTEGER NOT NULL,
      document_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS current_entities (
      case_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_subtype TEXT NOT NULL,
      display_name TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      source_ids_json TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      confirmed INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (case_id, entity_id)
    );

    CREATE TABLE IF NOT EXISTS current_relations (
      case_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      relation_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      relation_name TEXT NOT NULL,
      head_entity_id TEXT NOT NULL,
      head_display_name TEXT NOT NULL,
      tail_entity_id TEXT NOT NULL,
      tail_display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      stance TEXT NOT NULL,
      confidence REAL NOT NULL,
      source_ids_json TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      attributes_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (case_id, relation_id)
    );

    CREATE INDEX IF NOT EXISTS idx_case_index_updated_at ON case_index(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_case_index_case_type ON case_index(case_type);
    CREATE INDEX IF NOT EXISTS idx_case_index_trial_stage ON case_index(trial_stage);
    CREATE INDEX IF NOT EXISTS idx_case_index_case_no ON case_index(case_no);
    CREATE INDEX IF NOT EXISTS idx_case_index_case_name ON case_index(case_name);
    CREATE INDEX IF NOT EXISTS idx_version_snapshots_case_created ON version_snapshots(case_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_current_entities_case_type ON current_entities(case_id, entity_type);
    CREATE INDEX IF NOT EXISTS idx_current_entities_case_name ON current_entities(case_id, display_name);
    CREATE INDEX IF NOT EXISTS idx_current_entities_confirmed ON current_entities(case_id, confirmed);
    CREATE INDEX IF NOT EXISTS idx_current_relations_case_type ON current_relations(case_id, relation_type);
    CREATE INDEX IF NOT EXISTS idx_current_relations_case_status ON current_relations(case_id, status);
    CREATE INDEX IF NOT EXISTS idx_current_relations_case_stance ON current_relations(case_id, stance);
    CREATE INDEX IF NOT EXISTS idx_current_relations_case_head ON current_relations(case_id, head_display_name);
    CREATE INDEX IF NOT EXISTS idx_current_relations_case_tail ON current_relations(case_id, tail_display_name);
  `);
}

export async function loadPersistedCases(): Promise<Record<string, DemoCase>> {
  const db = await getDb();
  const rows = await db.all<Array<{ case_id: string; case_json: string }>>(
    "SELECT case_id, case_json FROM cases",
  );

  return Object.fromEntries(
    rows.map((row) => {
      const parsed = JSON.parse(row.case_json) as DemoCase;
      return [row.case_id, parsed];
    }),
  );
}

export async function persistCase(caseData: DemoCase, snapshotVersionId?: string) {
  const db = await getDb();
  const updatedAt = new Date().toISOString();

  await db.exec("BEGIN");
  try {
    await db.run(
      `
        INSERT INTO cases (case_id, case_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(case_id) DO UPDATE SET
          case_json = excluded.case_json,
          updated_at = excluded.updated_at
      `,
      caseData.caseId,
      JSON.stringify(caseData),
      updatedAt,
    );

    await db.run(
      `
        INSERT INTO case_index (
          case_id, case_no, case_name, case_type, trial_stage, stance, current_version_id,
          entity_count, relation_count, disputed_relation_count, document_count, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(case_id) DO UPDATE SET
          case_no = excluded.case_no,
          case_name = excluded.case_name,
          case_type = excluded.case_type,
          trial_stage = excluded.trial_stage,
          stance = excluded.stance,
          current_version_id = excluded.current_version_id,
          entity_count = excluded.entity_count,
          relation_count = excluded.relation_count,
          disputed_relation_count = excluded.disputed_relation_count,
          document_count = excluded.document_count,
          updated_at = excluded.updated_at
      `,
      caseData.caseId,
      caseData.caseNo,
      caseData.caseName,
      caseData.caseType,
      caseData.trialStage,
      caseData.stance,
      caseData.currentVersionId,
      caseData.entities.length,
      caseData.relations.length,
      caseData.relations.filter((item) => item.status === "DISPUTED").length,
      caseData.documents.length,
      updatedAt,
    );

    await refreshCurrentEntityRows(db, caseData, updatedAt);
    await refreshCurrentRelationRows(db, caseData, updatedAt);
    await upsertVersionMetadata(db, caseData);

    if (snapshotVersionId) {
      const version = caseData.versions.find((item) => item.versionId === snapshotVersionId);
      if (version) {
        await db.run(
          `
            INSERT INTO version_snapshots
            (case_id, version_id, version_type, label, created_at, created_by, is_published, snapshot_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(case_id, version_id) DO UPDATE SET
              version_type = excluded.version_type,
              label = excluded.label,
              created_at = excluded.created_at,
              created_by = excluded.created_by,
              is_published = excluded.is_published,
              snapshot_json = excluded.snapshot_json
          `,
          caseData.caseId,
          version.versionId,
          version.versionType,
          version.label,
          version.createdAt,
          version.createdBy,
          version.isPublished ? 1 : 0,
          JSON.stringify(caseData),
        );
      }
    }

    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

export async function listCases(query: CaseListQuery) {
  const db = await getDb();
  const pagination = normalizePagination(query);
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (query.search) {
    where.push("(case_no LIKE ? OR case_name LIKE ?)");
    params.push(like(query.search), like(query.search));
  }
  if (query.caseType) {
    where.push("case_type = ?");
    params.push(query.caseType);
  }
  if (query.trialStage) {
    where.push("trial_stage = ?");
    params.push(query.trialStage);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = await db.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM case_index ${whereClause}`,
    ...params,
  );
  const items = await db.all<Array<CaseIndexRow>>(
    `
      SELECT
        case_id, case_no, case_name, case_type, trial_stage, stance, current_version_id,
        entity_count, relation_count, disputed_relation_count, document_count, updated_at
      FROM case_index
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `,
    ...params,
    pagination.limit,
    pagination.offset,
  );

  return buildPaginationResult(
    items.map((item) => ({
      caseId: item.case_id,
      caseNo: item.case_no,
      caseName: item.case_name,
      caseType: item.case_type,
      trialStage: item.trial_stage,
      stance: item.stance,
      currentVersionId: item.current_version_id,
      entityCount: item.entity_count,
      relationCount: item.relation_count,
      disputedRelationCount: item.disputed_relation_count,
      documentCount: item.document_count,
      updatedAt: item.updated_at,
    })),
    totalRow?.total ?? 0,
    pagination,
  );
}

export async function listCaseEntities(caseId: string, query: EntityListQuery) {
  const db = await getDb();
  const pagination = normalizePagination(query);
  const where = ["case_id = ?"];
  const params: Array<string | number> = [caseId];

  if (query.search) {
    where.push("display_name LIKE ?");
    params.push(like(query.search));
  }
  if (query.entityType) {
    where.push("entity_type = ?");
    params.push(query.entityType);
  }
  if (typeof query.confirmed === "boolean") {
    where.push("confirmed = ?");
    params.push(query.confirmed ? 1 : 0);
  }

  const whereClause = `WHERE ${where.join(" AND ")}`;
  const totalRow = await db.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM current_entities ${whereClause}`,
    ...params,
  );
  const items = await db.all<Array<CurrentEntityRow>>(
    `
      SELECT
        case_id, version_id, entity_id, entity_type, entity_subtype, display_name,
        tags_json, attributes_json, source_ids_json, source_count, confirmed, x, y, updated_at
      FROM current_entities
      ${whereClause}
      ORDER BY display_name ASC
      LIMIT ? OFFSET ?
    `,
    ...params,
    pagination.limit,
    pagination.offset,
  );

  return buildPaginationResult(
    items.map((item) => ({
      caseId: item.case_id,
      versionId: item.version_id,
      entityId: item.entity_id,
      entityType: item.entity_type,
      entitySubtype: item.entity_subtype,
      displayName: item.display_name,
      tags: parseJson<string[]>(item.tags_json),
      attributes: parseJson<Record<string, string>>(item.attributes_json),
      sourceIds: parseJson<string[]>(item.source_ids_json),
      sourceCount: item.source_count,
      confirmed: item.confirmed === 1,
      x: item.x,
      y: item.y,
      updatedAt: item.updated_at,
    })),
    totalRow?.total ?? 0,
    pagination,
  );
}

export async function listCaseRelations(caseId: string, query: RelationListQuery) {
  const db = await getDb();
  const pagination = normalizePagination(query);
  const where = ["case_id = ?"];
  const params: Array<string | number> = [caseId];

  if (query.search) {
    where.push("(head_display_name LIKE ? OR tail_display_name LIKE ? OR relation_name LIKE ?)");
    params.push(like(query.search), like(query.search), like(query.search));
  }
  if (query.relationType) {
    where.push("relation_type = ?");
    params.push(query.relationType);
  }
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.stance) {
    where.push("stance = ?");
    params.push(query.stance);
  }

  const whereClause = `WHERE ${where.join(" AND ")}`;
  const totalRow = await db.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM current_relations ${whereClause}`,
    ...params,
  );
  const items = await db.all<Array<CurrentRelationRow>>(
    `
      SELECT
        case_id, version_id, relation_id, relation_type, relation_name, head_entity_id, head_display_name,
        tail_entity_id, tail_display_name, status, stance, confidence, source_ids_json, source_count,
        attributes_json, updated_at
      FROM current_relations
      ${whereClause}
      ORDER BY confidence DESC, relation_name ASC
      LIMIT ? OFFSET ?
    `,
    ...params,
    pagination.limit,
    pagination.offset,
  );

  return buildPaginationResult(
    items.map((item) => ({
      caseId: item.case_id,
      versionId: item.version_id,
      relationId: item.relation_id,
      relationType: item.relation_type,
      relationName: item.relation_name,
      headEntityId: item.head_entity_id,
      headDisplayName: item.head_display_name,
      tailEntityId: item.tail_entity_id,
      tailDisplayName: item.tail_display_name,
      status: item.status,
      stance: item.stance,
      confidence: item.confidence,
      sourceIds: parseJson<string[]>(item.source_ids_json),
      sourceCount: item.source_count,
      attributes: parseJson<Record<string, string>>(item.attributes_json),
      updatedAt: item.updated_at,
    })),
    totalRow?.total ?? 0,
    pagination,
  );
}

export async function getStorageStats() {
  const db = await getDb();
  const [caseTotals, entityTotals, relationTotals, caseTypeRows, relationStatusRows] = await Promise.all([
    db.get<{ totalCases: number; totalDocuments: number }>(
      `
        SELECT
          COUNT(*) AS totalCases,
          COALESCE(SUM(document_count), 0) AS totalDocuments
        FROM case_index
      `,
    ),
    db.get<{ totalEntities: number; confirmedEntities: number }>(
      `
        SELECT
          COUNT(*) AS totalEntities,
          COALESCE(SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END), 0) AS confirmedEntities
        FROM current_entities
      `,
    ),
    db.get<{ totalRelations: number; disputedRelations: number }>(
      `
        SELECT
          COUNT(*) AS totalRelations,
          COALESCE(SUM(CASE WHEN status = 'DISPUTED' THEN 1 ELSE 0 END), 0) AS disputedRelations
        FROM current_relations
      `,
    ),
    db.all<Array<{ case_type: string; count: number }>>(
      `
        SELECT case_type, COUNT(*) AS count
        FROM case_index
        GROUP BY case_type
        ORDER BY count DESC, case_type ASC
      `,
    ),
    db.all<Array<{ status: string; count: number }>>(
      `
        SELECT status, COUNT(*) AS count
        FROM current_relations
        GROUP BY status
        ORDER BY count DESC, status ASC
      `,
    ),
  ]);

  return {
    totalCases: caseTotals?.totalCases ?? 0,
    totalDocuments: caseTotals?.totalDocuments ?? 0,
    totalEntities: entityTotals?.totalEntities ?? 0,
    confirmedEntities: entityTotals?.confirmedEntities ?? 0,
    totalRelations: relationTotals?.totalRelations ?? 0,
    disputedRelations: relationTotals?.disputedRelations ?? 0,
    caseTypeDistribution: caseTypeRows.map((item) => ({
      caseType: item.case_type,
      count: item.count,
    })),
    relationStatusDistribution: relationStatusRows.map((item) => ({
      status: item.status,
      count: item.count,
    })),
  };
}

export async function getVersionSnapshot(caseId: string, versionId: string): Promise<DemoCase | null> {
  const db = await getDb();
  const row = await db.get<VersionRow>(
    `
      SELECT case_id, version_id, version_type, label, created_at, created_by, is_published, snapshot_json
      FROM version_snapshots
      WHERE case_id = ? AND version_id = ?
    `,
    caseId,
    versionId,
  );
  if (!row) return null;
  return JSON.parse(row.snapshot_json) as DemoCase;
}

export async function compareVersionSnapshots(caseId: string, leftVersionId: string, rightVersionId: string) {
  const [left, right] = await Promise.all([
    getVersionSnapshot(caseId, leftVersionId),
    getVersionSnapshot(caseId, rightVersionId),
  ]);

  if (!left || !right) {
    return null;
  }

  const leftEntities = new Map(left.entities.map((entity) => [entitySemanticKey(entity), entity]));
  const rightEntities = new Map(right.entities.map((entity) => [entitySemanticKey(entity), entity]));
  const leftRelations = new Map(left.relations.map((relation) => [relationSemanticKey(relation, left.entities), relation]));
  const rightRelations = new Map(right.relations.map((relation) => [relationSemanticKey(relation, right.entities), relation]));

  return {
    leftVersionId,
    rightVersionId,
    entityDiff: {
      added: diffAdded(rightEntities, leftEntities).map(formatEntitySummary),
      removed: diffAdded(leftEntities, rightEntities).map(formatEntitySummary),
      changed: diffChanged(leftEntities, rightEntities).map(([before, after]) => ({
        key: entitySemanticKey(before),
        before: formatEntitySummary(before),
        after: formatEntitySummary(after),
      })),
    },
    relationDiff: {
      added: diffAdded(rightRelations, leftRelations).map((relation) =>
        formatRelationSummary(relation, right.entities),
      ),
      removed: diffAdded(leftRelations, rightRelations).map((relation) =>
        formatRelationSummary(relation, left.entities),
      ),
      changed: diffChanged(leftRelations, rightRelations).map(([before, after]) => ({
        key: relationSemanticKey(before, left.entities),
        before: formatRelationSummary(before, left.entities),
        after: formatRelationSummary(after, right.entities),
      })),
    },
  };
}

async function createDb() {
  const dbPath = process.env.DB_PATH
    ? path.resolve(process.cwd(), process.env.DB_PATH)
    : path.resolve(process.cwd(), "data", "fact-graph.sqlite");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  return open({
    filename: dbPath,
    driver: sqlite3.Database,
  });
}

async function upsertVersionMetadata(db: Database, caseData: DemoCase) {
  for (const version of caseData.versions) {
    await db.run(
      `
        UPDATE version_snapshots
        SET version_type = ?, label = ?, created_at = ?, created_by = ?, is_published = ?
        WHERE case_id = ? AND version_id = ?
      `,
      version.versionType,
      version.label,
      version.createdAt,
      version.createdBy,
      version.isPublished ? 1 : 0,
      caseData.caseId,
      version.versionId,
    );
  }
}

async function refreshCurrentEntityRows(db: Database, caseData: DemoCase, updatedAt: string) {
  await db.run("DELETE FROM current_entities WHERE case_id = ?", caseData.caseId);

  for (const entity of caseData.entities) {
    await db.run(
      `
        INSERT INTO current_entities (
          case_id, version_id, entity_id, entity_type, entity_subtype, display_name,
          tags_json, attributes_json, source_ids_json, source_count, confirmed, x, y, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      caseData.caseId,
      caseData.currentVersionId,
      entity.entityId,
      entity.entityType,
      entity.entitySubtype,
      entity.displayName,
      JSON.stringify(entity.tags),
      JSON.stringify(entity.attributes),
      JSON.stringify(entity.sourceIds),
      entity.sourceIds.length,
      entity.confirmed ? 1 : 0,
      entity.x,
      entity.y,
      updatedAt,
    );
  }
}

async function refreshCurrentRelationRows(db: Database, caseData: DemoCase, updatedAt: string) {
  await db.run("DELETE FROM current_relations WHERE case_id = ?", caseData.caseId);

  for (const relation of caseData.relations) {
    const head = caseData.entities.find((entity) => entity.entityId === relation.headEntityId)?.displayName ?? relation.headEntityId;
    const tail = caseData.entities.find((entity) => entity.entityId === relation.tailEntityId)?.displayName ?? relation.tailEntityId;
    await db.run(
      `
        INSERT INTO current_relations (
          case_id, version_id, relation_id, relation_type, relation_name, head_entity_id, head_display_name,
          tail_entity_id, tail_display_name, status, stance, confidence, source_ids_json, source_count,
          attributes_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      caseData.caseId,
      caseData.currentVersionId,
      relation.relationId,
      relation.relationType,
      relation.relationName,
      relation.headEntityId,
      head,
      relation.tailEntityId,
      tail,
      relation.status,
      relation.stance,
      relation.confidence,
      JSON.stringify(relation.sourceIds),
      relation.sourceIds.length,
      JSON.stringify(relation.attributes),
      updatedAt,
    );
  }
}

function normalizePagination(query: PaginationQuery) {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20) || 20));
  return {
    page,
    pageSize,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
}

function buildPaginationResult<T>(
  items: T[],
  total: number,
  pagination: ReturnType<typeof normalizePagination>,
) {
  return {
    items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pagination.pageSize),
  };
}

function like(value: string) {
  return `%${value.trim()}%`;
}

function parseJson<T>(value: string) {
  return JSON.parse(value) as T;
}

function diffAdded<T>(nextMap: Map<string, T>, prevMap: Map<string, T>) {
  return Array.from(nextMap.entries())
    .filter(([key]) => !prevMap.has(key))
    .map(([, value]) => value);
}

function diffChanged<T>(leftMap: Map<string, T>, rightMap: Map<string, T>) {
  const changed: Array<[T, T]> = [];
  leftMap.forEach((leftValue, key) => {
    const rightValue = rightMap.get(key);
    if (!rightValue) return;
    if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
      changed.push([leftValue, rightValue]);
    }
  });
  return changed;
}

function entitySemanticKey(entity: EntityRecord) {
  return `${entity.entityType}:${entity.displayName}`;
}

function relationSemanticKey(relation: RelationRecord, entities: EntityRecord[]) {
  const head = entities.find((entity) => entity.entityId === relation.headEntityId)?.displayName ?? relation.headEntityId;
  const tail = entities.find((entity) => entity.entityId === relation.tailEntityId)?.displayName ?? relation.tailEntityId;
  return `${head}:${relation.relationType}:${tail}`;
}

function formatEntitySummary(entity: EntityRecord) {
  return {
    entityId: entity.entityId,
    displayName: entity.displayName,
    entityType: entity.entityType,
    entitySubtype: entity.entitySubtype,
    tags: entity.tags,
    attributes: entity.attributes,
  };
}

function formatRelationSummary(relation: RelationRecord, entities: EntityRecord[]) {
  const head = entities.find((entity) => entity.entityId === relation.headEntityId)?.displayName ?? relation.headEntityId;
  const tail = entities.find((entity) => entity.entityId === relation.tailEntityId)?.displayName ?? relation.tailEntityId;
  return {
    relationId: relation.relationId,
    head,
    relationType: relation.relationType,
    relationName: relation.relationName,
    tail,
    status: relation.status,
    stance: relation.stance,
    attributes: relation.attributes,
  };
}
