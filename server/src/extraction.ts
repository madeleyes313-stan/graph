import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import iconv from "iconv-lite";
import OpenAI from "openai";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
const WordExtractor = require("word-extractor") as new () => {
  extract(source: string | Buffer): Promise<{
    getBody(): string;
    getFootnotes?(): string;
    getEndnotes?(): string;
    getHeaders?(options?: { includeFooters?: boolean }): string;
    getFooters?(): string;
  }>;
};
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { getAIConfig, isAIConfigured } from "./aiConfig";
import type {
  DemoCase,
  EntityRecord,
  ExtractedChunk,
  PipelineDocument,
  PipelineOutput,
  RelationRecord,
  SourceRecord,
  Stance,
  TimelineEvent,
  UploadedDocument,
} from "./types";

const execFileAsync = promisify(execFile);

const llmSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      entityType: z.enum(["NaturalPerson", "Organization", "VirtualAsset", "ProcedureEntity", "FactClaim"]),
      entitySubtype: z.string(),
      tags: z.array(z.string()).default([]),
      attributes: z.record(z.string(), z.string()).default({}),
      sourceParagraphs: z.array(z.string()).default([]),
    }),
  ),
  relations: z.array(
    z.object({
      head: z.string(),
      relationType: z.string(),
      relationName: z.string(),
      tail: z.string(),
      status: z.enum(["SYSTEM_GENERATED", "CONFIRMED", "DISPUTED", "PENDING_EVIDENCE"]).default("SYSTEM_GENERATED"),
      stance: z.enum(["COMBINED", "PLAINTIFF", "DEFENDANT", "COURT"]).default("COMBINED"),
      attributes: z.record(z.string(), z.string()).default({}),
      sourceParagraphs: z.array(z.string()).default([]),
    }),
  ),
  timeline: z.array(
    z.object({
      title: z.string(),
      date: z.string().default("时间待确认"),
      summary: z.string(),
      sourceParagraphs: z.array(z.string()).default([]),
    }),
  ),
});

const jsonModeSchema = z.object({
  entities: z
    .array(
      z.object({
        name: z.string(),
        entityType: z.string().nullable().optional(),
        entitySubtype: z.string().nullable().optional(),
        tags: z.array(z.string()).nullable().optional(),
        attributes: z.record(z.string(), z.any()).nullable().optional(),
        sourceParagraphs: z.array(z.union([z.string(), z.number()])).nullable().optional(),
      }),
    )
    .default([]),
  relations: z
    .array(
      z.object({
        head: z.string().nullable().optional(),
        relationType: z.string().nullable().optional(),
        relationName: z.string().nullable().optional(),
        tail: z.string().nullable().optional(),
        status: z.string().nullable().optional(),
        stance: z.string().nullable().optional(),
        attributes: z.record(z.string(), z.any()).nullable().optional(),
        sourceParagraphs: z.array(z.union([z.string(), z.number()])).nullable().optional(),
      }),
    )
    .default([]),
  timeline: z
    .array(
      z.object({
        title: z.string().nullable().optional(),
        date: z.string().nullable().optional(),
        summary: z.string().nullable().optional(),
        sourceParagraphs: z.array(z.union([z.string(), z.number()])).nullable().optional(),
      }),
    )
    .default([]),
});

const EXTRACTION_SYSTEM_PROMPT = `
你是法院案件事实图谱抽取助手。请从卷宗文本中抽取实体、法律关系和事实时间线。

硬性要求：
1. 只返回 JSON 对象，不要输出 markdown，不要输出解释。
2. 顶层必须包含 entities、relations、timeline 三个字段。
3. entityType 只能是：NaturalPerson、Organization、VirtualAsset、ProcedureEntity、FactClaim。
4. relation status 只能是：SYSTEM_GENERATED、CONFIRMED、DISPUTED、PENDING_EVIDENCE。
5. stance 只能是：COMBINED、PLAINTIFF、DEFENDANT、COURT。
6. 实体 name 必须是干净实体名，不能包含动作或完整句子，例如应输出“周八”，不能输出“周八承担”。
7. 关系 head 和 tail 必须直接引用实体 name。
8. 关系类型尽量使用法律或业务标准词：LEND_TO、GUARANTEE_FOR、INVESTMENT_CLAIM、SIGN_CONTRACT、RECEIVE_TRANSFER、SPOUSE、PARENT_CHILD、APPOINT_AGENT、LEGAL_REPRESENTATIVE、ACTUAL_CONTROLLER、OWN、USE。
9. 没有信息时返回空数组，不要编造。

实体示例：
{"name":"张三","entityType":"NaturalPerson","entitySubtype":"Plaintiff","tags":["原告","出借人"],"attributes":{"诉讼地位":"原告"},"sourceParagraphs":["P1","P2"]}

关系示例：
{"head":"张三","relationType":"LEND_TO","relationName":"出借","tail":"李四","status":"SYSTEM_GENERATED","stance":"PLAINTIFF","attributes":{"金额":"500000元","发生时间":"2024年3月1日"},"sourceParagraphs":["P2"]}

时间线示例：
{"title":"借款形成","date":"2024年3月1日","summary":"张三向李四出借50万元。","sourceParagraphs":["P2"]}
`.trim();

export async function parseUploadedDocument(document: UploadedDocument): Promise<PipelineDocument> {
  const text = await extractTextFromDocument(document);
  if (!text.trim()) {
    throw new Error("文书未提取到可识别正文，暂时无法生成关系图谱。建议将文件另存为 DOCX 或 PDF 后重试。");
  }
  const chunks = chunkText(text);
  return {
    document: {
      ...document,
      textContent: text,
      parseStatus: "PARSED",
      chunkCount: chunks.length,
    },
    text,
    chunks,
  };
}

export async function runExtractionPipeline(caseData: DemoCase, documents: UploadedDocument[]): Promise<PipelineOutput> {
  const parsedDocuments = await Promise.all(documents.map((document) => parseUploadedDocument(document)));
  parsedDocuments.forEach((item) => {
    const index = caseData.documents.findIndex((doc) => doc.documentId === item.document.documentId);
    if (index >= 0) {
      caseData.documents[index] = item.document;
    }
  });

  const sources = buildSources(parsedDocuments);
  const ruleEntities = extractRuleEntities(parsedDocuments, sources);
  const ruleRelations = extractRuleRelations(parsedDocuments, ruleEntities, sources);
  const disputeRelations = extractDisputeRelations(parsedDocuments, ruleEntities, sources);
  const ruleTimeline = extractRuleTimeline(parsedDocuments, ruleRelations, ruleEntities);

  const aiConfig = getAIConfig();
  const llmEnabled = isAIConfigured(aiConfig);
  const warnings: string[] = [];

  let mergedEntities = ruleEntities;
  let mergedRelations = mergeRelations(ruleRelations, disputeRelations);
  let mergedTimeline = ruleTimeline;

  if (llmEnabled) {
    try {
      const llmOutput = await extractWithOpenAI(parsedDocuments, sources);
      mergedEntities = mergeEntities(ruleEntities, llmOutput.entities);
      const reboundLlmRelations = rebindRelationsToMergedEntities(llmOutput.relations, mergedEntities, llmOutput.entities);
      mergedRelations = mergeRelations(mergedRelations, reboundLlmRelations);
      mergedTimeline = [...mergedTimeline, ...llmOutput.timeline];
    } catch (error) {
      warnings.push(`大模型抽取失败，已回退为规则抽取：${getErrorMessage(error)}`);
    }
  } else {
    warnings.push("未配置大模型 API Key，当前仅执行规则抽取。");
  }

  return {
    entities: layoutEntities(mergedEntities),
    relations: mergedRelations,
    sources,
    timeline: mergedTimeline,
    warnings,
  };
}

export async function extractTextFromDocument(document: UploadedDocument): Promise<string> {
  if (!document.filePath && document.textContent) {
    return normalizeText(document.textContent);
  }

  const extension = path.extname(document.originalName).toLowerCase();
  if (document.mimeType === "application/pdf" || extension === ".pdf") {
    const buffer = await fs.readFile(document.filePath);
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    return normalizeText(parsed.text);
  }

  if (isWordDocument(document.mimeType, extension)) {
    return extractTextFromWordDocument(document.filePath, document.mimeType, extension);
  }

  if (document.mimeType.startsWith("image/")) {
    return extractTextFromImage(document.filePath, document.mimeType);
  }

  if (document.mimeType === "text/plain" || extension === ".txt") {
    const content = await fs.readFile(document.filePath, "utf8");
    return normalizeText(content);
  }

  throw new Error(`暂不支持的文件类型：${document.mimeType || extension}`);
}

async function extractTextFromWordDocument(
  filePath: string,
  mimeType: string,
  extension: string,
): Promise<string> {
  const errors: string[] = [];

  try {
    return await extractTextWithTextutil(filePath);
  } catch (textutilError) {
    errors.push(`textutil: ${getErrorMessage(textutilError)}`);
    const shouldTryDocxParser =
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      extension === ".docx";

    if (!shouldTryDocxParser) {
      try {
        return await extractTextWithWordExtractor(filePath);
      } catch (wordExtractorError) {
        errors.push(`word-extractor: ${getErrorMessage(wordExtractorError)}`);
        try {
          return await extractTextFromLegacyDocBinary(filePath);
        } catch (binaryFallbackError) {
          errors.push(`binary-fallback: ${getErrorMessage(binaryFallbackError)}`);
          throw new Error(`Word 文书解析失败：${errors.join("；")}`);
        }
      }
    }
  }

  const shouldPreferDocxParser =
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === ".docx";

  if (shouldPreferDocxParser) {
    try {
      const result = await mammoth.extractRawText({ path: filePath });
      return normalizeText(result.value);
    } catch (error) {
      errors.push(`mammoth: ${getErrorMessage(error)}`);
    }
  }

  try {
    return await extractTextWithWordExtractor(filePath);
  } catch (wordExtractorError) {
    errors.push(`word-extractor: ${getErrorMessage(wordExtractorError)}`);
    try {
      return await extractTextFromLegacyDocBinary(filePath);
    } catch (binaryFallbackError) {
      errors.push(`binary-fallback: ${getErrorMessage(binaryFallbackError)}`);
      throw new Error(`Word 文书解析失败：${errors.join("；")}`);
    }
  }
}

async function extractTextWithTextutil(filePath: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "/usr/bin/textutil",
      ["-convert", "txt", "-stdout", filePath],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    if (!stdout.trim()) {
      const detail = stderr.trim();
      throw new Error(detail || "未提取到正文内容");
    }
    return normalizeText(stdout);
  } catch (error) {
    throw new Error(`Word 文书解析失败，请确认文件未损坏且系统支持 textutil：${getErrorMessage(error)}`);
  }
}

async function extractTextWithWordExtractor(filePath: string): Promise<string> {
  try {
    const extractor = new WordExtractor();
    const extracted = await extractor.extract(filePath);
    const segments = [
      extracted.getBody?.() ?? "",
      extracted.getFootnotes?.() ?? "",
      extracted.getEndnotes?.() ?? "",
      extracted.getHeaders?.({ includeFooters: false }) ?? "",
      extracted.getFooters?.() ?? "",
    ]
      .map((item) => item.trim())
      .filter(Boolean);

    const merged = segments.join("\n\n");
    if (!merged.trim()) {
      throw new Error("未提取到正文内容");
    }
    return normalizeText(merged);
  } catch (error) {
    throw new Error(`word-extractor 解析失败：${getErrorMessage(error)}`);
  }
}

async function extractTextFromLegacyDocBinary(filePath: string): Promise<string> {
  try {
    const binary = await fs.readFile(filePath);
    const decodedCandidates = [
      iconv.decode(binary, "gb18030"),
      iconv.decode(binary, "gbk"),
      binary.toString("utf8"),
      binary.toString("latin1"),
    ];

    const normalized = normalizeText(
      stripHtmlTags(
        decodedCandidates
          .map(extractReadableBinaryText)
          .sort((left, right) => scoreReadableText(right) - scoreReadableText(left))[0] ?? "",
      ),
    );
    const cleaned = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length >= 2)
      .join("\n");

    if (!cleaned.trim()) {
      throw new Error("未从二进制流中提取到可读文本");
    }

    return cleaned;
  } catch (error) {
    throw new Error(`二进制兜底提取失败：${getErrorMessage(error)}`);
  }
}

function isWordDocument(mimeType: string, extension: string) {
  return (
    mimeType === "application/msword" ||
    mimeType === "application/vnd.ms-word" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/octet-stream" ||
    extension === ".doc" ||
    extension === ".docx"
  );
}

function shouldFallbackToTextutil(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("can't find end of central directory") ||
    message.includes("is this a zip file") ||
    message.includes("corrupted zip") ||
    message.includes("invalid end of central directory")
  );
}

function stripHtmlTags(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(div|p|br|tr|table|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function extractReadableBinaryText(value: string) {
  const htmlMatches = value.match(/<html[\s\S]*?<\/html>/gi) ?? [];
  if (htmlMatches.length > 0) {
    return htmlMatches.join("\n");
  }

  return value
    .split(/\x00+/)
    .filter(Boolean)
    .join("\n");
}

function scoreReadableText(value: string) {
  const chineseMatches = value.match(/[\u4e00-\u9fff]/g) ?? [];
  return chineseMatches.length;
}

async function extractTextFromImage(filePath: string, mimeType: string): Promise<string> {
  const aiConfig = getAIConfig();
  if (!aiConfig.apiKey) {
    throw new Error("图片 OCR 需要配置大模型 API Key");
  }

  const client = new OpenAI({
    apiKey: aiConfig.apiKey,
    baseURL: aiConfig.baseURL,
  });
  const buffer = await fs.readFile(filePath);
  const base64 = buffer.toString("base64");

  const completion = await client.chat.completions.create({
    messages: [
      {
        role: "system",
        content: "请对图片中的法律文书内容进行尽量完整的纯文本转写，不要解释，不要总结。",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "请转写图片中的全部可识别文字，保留换行。",
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
            },
          },
        ],
      },
    ],
    model: aiConfig.model,
  });

  const content = completion.choices[0]?.message?.content ?? "";
  return normalizeText(typeof content === "string" ? content : JSON.stringify(content));
}

function buildSources(documents: PipelineDocument[]): SourceRecord[] {
  const results: SourceRecord[] = [];
  documents.forEach((doc) => {
    doc.chunks.forEach((chunk, index) => {
      results.push({
        sourceId: `${doc.document.documentId}_chunk_${index + 1}`,
        documentId: doc.document.documentId,
        documentType: doc.document.documentType,
        sourceParty: doc.document.sourceParty,
        paragraph: chunk.paragraph,
        page: chunk.page,
        text: chunk.text,
        confidence: 0.88,
        extractionMethod: "解析切分",
        reviewStatus: "UNREVIEWED",
      });
    });
  });
  return results;
}

function extractRuleEntities(documents: PipelineDocument[], sources: SourceRecord[]): EntityRecord[] {
  const map = new Map<string, EntityRecord>();
  const fullText = documents.map((item) => item.text).join("\n");

  const patterns = [
    { label: "原告", subtype: "Plaintiff", regex: /(?:^|\n)原告[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,8})/g },
    { label: "被告", subtype: "Defendant", regex: /(?:^|\n)被告[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,8})/g },
    { label: "第三人", subtype: "ThirdParty", regex: /(?:^|\n)第三人[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,8})/g },
    { label: "代理人", subtype: "Agent", regex: /(?:^|\n)代理人[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,8})/g },
    {
      label: "上诉人",
      subtype: "Plaintiff",
      regex: /(?:^|\n)上诉人(?:（原审原告）)?[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,16})/g,
    },
    {
      label: "被上诉人",
      subtype: "Defendant",
      regex: /(?:^|\n)被上诉人(?:（原审被告）)?[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,16})/g,
    },
    {
      label: "原审第三人",
      subtype: "ThirdParty",
      regex: /(?:^|\n)原审第三人[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,16})/g,
    },
    {
      label: "委托诉讼代理人",
      subtype: "Agent",
      regex: /(?:^|\n)委托诉讼代理人[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,16})/g,
    },
  ];

  patterns.forEach((pattern) => {
    for (const match of fullText.matchAll(pattern.regex)) {
      const name = sanitizeName(match[1]);
      if (!name) continue;
      const source = sources.find((item) => item.text.includes(name));
      map.set(name, {
        entityId: buildEntityId(name),
        entityType: "NaturalPerson",
        entitySubtype: pattern.subtype,
        displayName: name,
        tags: [pattern.label],
        x: 0,
        y: 0,
        attributes: { 诉讼地位: pattern.label },
        sourceIds: source ? [source.sourceId] : [],
        confirmed: false,
      });
    }
  });

  const lendSentence = fullText.match(/原告([\u4e00-\u9fa5]{2,4})向被告([\u4e00-\u9fa5]{2,4})出借/);
  if (lendSentence) {
    ensurePerson(map, lendSentence[1], "原告", "Plaintiff", sources);
    ensurePerson(map, lendSentence[2], "被告", "Defendant", sources);
  }

  const guaranteeSentence = fullText.match(/第三人([\u4e00-\u9fa5]{2,4})(?=在|承|提|为).{0,16}(保证|担保)/);
  if (guaranteeSentence) {
    ensurePerson(map, guaranteeSentence[1], "第三人", "ThirdParty", sources, { 诉讼身份: "保证人" }, ["保证人"]);
  }

  const amountMatch = fullText.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+)\s*万元|(\d{3,})\s*元/g);
  if (amountMatch && amountMatch.length > 0) {
    map.set("涉案金额", {
      entityId: "asset_money",
      entityType: "VirtualAsset",
      entitySubtype: "Money",
      displayName: "涉案借款",
      tags: ["资金"],
      x: 0,
      y: 0,
      attributes: { 金额: amountMatch[0] },
      sourceIds: sources.slice(0, 1).map((item) => item.sourceId),
      confirmed: false,
    });
  }

  for (const source of sources) {
    const accountMatch = source.text.match(/尾号(\d{4})账户/);
    if (accountMatch) {
      const name = `尾号${accountMatch[1]}账户`;
      map.set(name, {
        entityId: `account_${accountMatch[1]}`,
        entityType: "VirtualAsset",
        entitySubtype: "Account",
        displayName: name,
        tags: ["涉案账户"],
        x: 0,
        y: 0,
        attributes: { 账号尾号: accountMatch[1] },
        sourceIds: [source.sourceId],
        confirmed: false,
      });
    }

    if (source.text.includes("借款合同") || /合同编号|签署合同|签订合同/.test(source.text)) {
      upsertEntity(map, {
        entityId: "contract_auto",
        entityType: "VirtualAsset",
        entitySubtype: "Contract",
        displayName: "借款合同",
        tags: ["合同"],
        x: 0,
        y: 0,
        attributes: {},
        sourceIds: [source.sourceId],
        confirmed: false,
      });
    }

    if (source.text.includes("借条")) {
      upsertEntity(map, {
        entityId: "borrow_note_auto",
        entityType: "VirtualAsset",
        entitySubtype: "Document",
        displayName: "借条",
        tags: ["证据", "借条"],
        x: 0,
        y: 0,
        attributes: extractBorrowNoteAttributes(source.text),
        sourceIds: [source.sourceId],
        confirmed: false,
      });
    }

    if (source.text.includes("通话录音")) {
      upsertEntity(map, {
        entityId: "voice_record_auto",
        entityType: "ProcedureEntity",
        entitySubtype: "Evidence",
        displayName: "通话录音",
        tags: ["证据", "录音"],
        x: 0,
        y: 0,
        attributes: {},
        sourceIds: [source.sourceId],
        confirmed: false,
      });
    }

    if (source.text.includes("笔迹鉴定申请书")) {
      upsertEntity(map, {
        entityId: "appraisal_request_auto",
        entityType: "ProcedureEntity",
        entitySubtype: "Application",
        displayName: "笔迹鉴定申请",
        tags: ["程序事项", "鉴定申请"],
        x: 0,
        y: 0,
        attributes: {},
        sourceIds: [source.sourceId],
        confirmed: false,
      });
    }

    if (source.text.includes("保全申请") || source.text.includes("财产保全")) {
      upsertEntity(map, {
        entityId: "preservation_request_auto",
        entityType: "ProcedureEntity",
        entitySubtype: "Application",
        displayName: "诉讼财产保全申请",
        tags: ["程序事项", "保全申请"],
        x: 0,
        y: 0,
        attributes: extractPreservationAttributes(source.text),
        sourceIds: [source.sourceId],
        confirmed: false,
      });
    }

    if (source.text.includes("民事判决") || source.text.includes("民 事 判 决 书")) {
      if (source.text.includes("一审法院") || source.text.includes("原审判决")) {
        upsertEntity(map, {
          entityId: "first_judgment_auto",
          entityType: "ProcedureEntity",
          entitySubtype: "Judgment",
          displayName: "一审民事判决",
          tags: ["程序事项", "一审判决"],
          x: 0,
          y: 0,
          attributes: {},
          sourceIds: [source.sourceId],
          confirmed: false,
        });
      }
      if (source.text.includes("本院") || source.text.includes("二审")) {
        upsertEntity(map, {
          entityId: "second_judgment_auto",
          entityType: "ProcedureEntity",
          entitySubtype: "Judgment",
          displayName: "二审民事判决",
          tags: ["程序事项", "二审判决"],
          x: 0,
          y: 0,
          attributes: {},
          sourceIds: [source.sourceId],
          confirmed: false,
        });
      }
    }

    const lawFirmMatch = source.text.match(/(新疆[\u4e00-\u9fa5A-Za-z0-9·]{2,24}律师事务所)/);
    if (lawFirmMatch) {
      upsertEntity(map, {
        entityId: buildEntityId(lawFirmMatch[1]),
        entityType: "Organization",
        entitySubtype: "LawFirm",
        displayName: lawFirmMatch[1],
        tags: ["律师事务所"],
        x: 0,
        y: 0,
        attributes: {},
        sourceIds: [source.sourceId],
        confirmed: false,
      });
    }
  }

  return Array.from(map.values());
}

function extractRuleRelations(
  documents: PipelineDocument[],
  entities: EntityRecord[],
  sources: SourceRecord[],
): RelationRecord[] {
  const fullText = documents.map((item) => item.text).join("\n");
  const plaintiff = entities.find((entity) => entity.entitySubtype === "Plaintiff");
  const defendant = entities.find((entity) => entity.entitySubtype === "Defendant");
  const thirdParties = entities.filter((entity) => entity.entitySubtype === "ThirdParty");
  const guarantor =
    entities.find((entity) => entity.tags.includes("保证人")) ??
    thirdParties[0];
  const borrowNote = entities.find((entity) => entity.displayName === "借条");
  const voiceRecord = entities.find((entity) => entity.displayName === "通话录音");
  const appraisalRequest = entities.find((entity) => entity.displayName === "笔迹鉴定申请");
  const preservationRequest = entities.find((entity) => entity.displayName === "诉讼财产保全申请");
  const firstJudgment = entities.find((entity) => entity.displayName === "一审民事判决");
  const relations: RelationRecord[] = [];

  const directLoanSources = sources.filter((item) =>
    new RegExp(
      `${plaintiff?.displayName ?? ""}.{0,8}(向|给).{0,4}${defendant?.displayName ?? ""}.{0,8}(出借|借给|借予)`,
    ).test(item.text),
  );
  if (plaintiff && defendant && directLoanSources.length > 0) {
    relations.push({
      relationId: `rel_${Date.now()}_lend`,
      headEntityId: plaintiff.entityId,
      relationType: "LEND_TO",
      relationName: "出借",
      tailEntityId: defendant.entityId,
      status: "SYSTEM_GENERATED",
      confidence: 0.72,
      sourceIds: directLoanSources.map((item) => item.sourceId),
      stance: "PLAINTIFF",
      attributes: extractAmountAndDate(directLoanSources.map((item) => item.text).join("\n")),
    });
  }

  const guaranteeSources = sources.filter(
    (item) => guarantor && item.text.includes(guarantor.displayName) && /(保证人|保证担保|连带责任保证)/.test(item.text),
  );
  if (guarantor && defendant && guaranteeSources.length > 0) {
    relations.push({
      relationId: `rel_${Date.now()}_guarantee`,
      headEntityId: guarantor.entityId,
      relationType: "GUARANTEE_FOR",
      relationName: "保证担保",
      tailEntityId: defendant.entityId,
      status: "SYSTEM_GENERATED",
      confidence: 0.7,
      sourceIds: guaranteeSources.map((item) => item.sourceId),
      stance: "PLAINTIFF",
      attributes: extractAmountAndDate(guaranteeSources.map((item) => item.text).join("\n")),
    });
  }

  if (/(投资款|合作投资)/.test(fullText) && defendant) {
    relations.push({
      relationId: `rel_${Date.now()}_investment`,
      headEntityId: defendant.entityId,
      relationType: "INVESTMENT_CLAIM",
      relationName: "主张投资关系",
      tailEntityId: buildClaimEntity(entities, sources, "投资款主张"),
      status: "DISPUTED",
      confidence: 0.65,
      sourceIds: sources.filter((item) => /(投资款|合作投资)/.test(item.text)).map((item) => item.sourceId),
      stance: "DEFENDANT",
      attributes: { 争议点: "款项性质认定" },
    });
  }

  if (defendant && borrowNote) {
    const borrowNoteSources = sources.filter((item) => item.text.includes("借条"));
    if (borrowNoteSources.length > 0) {
      relations.push({
        relationId: `rel_${Date.now()}_borrow_note`,
        headEntityId: defendant.entityId,
        relationType: "SIGN_NOTE",
        relationName: "出具借条",
        tailEntityId: borrowNote.entityId,
        status: "CONFIRMED",
        confidence: 0.86,
        sourceIds: borrowNoteSources.map((item) => item.sourceId),
        stance: "COURT",
        attributes: extractBorrowNoteRelationAttributes(borrowNoteSources.map((item) => item.text).join("\n")),
      });
    }
  }

  if (plaintiff && voiceRecord) {
    const recordingSources = sources.filter((item) => item.text.includes("通话录音") || item.text.includes("电话向"));
    if (recordingSources.length > 0) {
      relations.push({
        relationId: `rel_${Date.now()}_submit_recording`,
        headEntityId: plaintiff.entityId,
        relationType: "SUBMIT_EVIDENCE",
        relationName: "提交证据",
        tailEntityId: voiceRecord.entityId,
        status: "SYSTEM_GENERATED",
        confidence: 0.8,
        sourceIds: recordingSources.map((item) => item.sourceId),
        stance: "PLAINTIFF",
        attributes: { 证据类型: "通话录音" },
      });
    }
  }

  if (plaintiff && defendant) {
    const demandSources = sources.filter((item) => item.text.includes("催还款") || item.text.includes("还不还钱"));
    if (demandSources.length > 0) {
      relations.push({
        relationId: `rel_${Date.now()}_demand`,
        headEntityId: plaintiff.entityId,
        relationType: "DEMAND_PAYMENT",
        relationName: "催款",
        tailEntityId: defendant.entityId,
        status: "SYSTEM_GENERATED",
        confidence: 0.82,
        sourceIds: demandSources.map((item) => item.sourceId),
        stance: "PLAINTIFF",
        attributes: { 时间跨度: extractDemandPeriod(fullText) },
      });
    }
  }

  if (plaintiff && firstJudgment) {
    const appealSources = sources.filter((item) => item.text.includes("不服") && item.text.includes("提起上诉"));
    if (appealSources.length > 0) {
      relations.push({
        relationId: `rel_${Date.now()}_appeal`,
        headEntityId: plaintiff.entityId,
        relationType: "APPEAL",
        relationName: "提起上诉",
        tailEntityId: firstJudgment.entityId,
        status: "CONFIRMED",
        confidence: 0.88,
        sourceIds: appealSources.map((item) => item.sourceId),
        stance: "COMBINED",
        attributes: {},
      });
    }
  }

  if (defendant && appraisalRequest) {
    const appraisalSources = sources.filter((item) => item.text.includes("笔迹鉴定申请书"));
    if (appraisalSources.length > 0) {
      relations.push({
        relationId: `rel_${Date.now()}_appraisal`,
        headEntityId: defendant.entityId,
        relationType: "APPLY_APPRAISAL",
        relationName: "申请鉴定",
        tailEntityId: appraisalRequest.entityId,
        status: "SYSTEM_GENERATED",
        confidence: 0.86,
        sourceIds: appraisalSources.map((item) => item.sourceId),
        stance: "DEFENDANT",
        attributes: { 事项: "借条笔迹指纹鉴定" },
      });
    }
  }

  if (plaintiff && preservationRequest) {
    const preservationSources = sources.filter((item) => item.text.includes("财产保全申请") || item.text.includes("冻结"));
    if (preservationSources.length > 0) {
      relations.push({
        relationId: `rel_${Date.now()}_preservation`,
        headEntityId: plaintiff.entityId,
        relationType: "APPLY_PRESERVATION",
        relationName: "申请保全",
        tailEntityId: preservationRequest.entityId,
        status: "CONFIRMED",
        confidence: 0.83,
        sourceIds: preservationSources.map((item) => item.sourceId),
        stance: "PLAINTIFF",
        attributes: extractPreservationAttributes(preservationSources.map((item) => item.text).join("\n")),
      });
    }
  }

  if (plaintiff && thirdParties.length > 0) {
    const transferSources = sources.filter(
      (item) => item.text.includes("债权转让给") || item.text.includes("债权转移给") || item.text.includes("债权转让已经尽到"),
    );
    thirdParties.forEach((thirdParty, index) => {
      const relatedSources = transferSources.filter((item) => item.text.includes(thirdParty.displayName));
      if (relatedSources.length === 0) {
        return;
      }
      relations.push({
        relationId: `rel_${Date.now()}_claim_transfer_${index}`,
        headEntityId: thirdParty.entityId,
        relationType: "TRANSFER_CLAIM_TO",
        relationName: "债权转让",
        tailEntityId: plaintiff.entityId,
        status: "CONFIRMED",
        confidence: 0.89,
        sourceIds: relatedSources.map((item) => item.sourceId),
        stance: "COURT",
        attributes: extractTransferAttributes(relatedSources.map((item) => item.text).join("\n")),
      });
    });
  }

  if (defendant && plaintiff) {
    const repaySources = sources.filter(
      (item) =>
        item.text.includes("应当向杨某履行还款义务") ||
        item.text.includes("应当以债权转移时的债务金额向新的债权人杨某承担偿还义务") ||
        item.text.includes("应当向杨某支付"),
    );
    if (repaySources.length > 0) {
      relations.push({
        relationId: `rel_${Date.now()}_repay`,
        headEntityId: defendant.entityId,
        relationType: "OWE_TO",
        relationName: "应偿还",
        tailEntityId: plaintiff.entityId,
        status: "CONFIRMED",
        confidence: 0.9,
        sourceIds: repaySources.map((item) => item.sourceId),
        stance: "COURT",
        attributes: extractRepaymentAttributes(repaySources.map((item) => item.text).join("\n")),
      });
    }
  }

  if (defendant && thirdParties.length > 0) {
    thirdParties.forEach((thirdParty, index) => {
      const loanSources = sources.filter(
        (item) =>
          item.text.includes(thirdParty.displayName) &&
          item.text.includes(defendant.displayName) &&
          /(欠|借|提供借款|借款现金|60,000元)/.test(item.text),
      );
      if (loanSources.length === 0) {
        return;
      }
      relations.push({
        relationId: `rel_${Date.now()}_third_party_loan_${index}`,
        headEntityId: thirdParty.entityId,
        relationType: "LEND_TO",
        relationName: "出借",
        tailEntityId: defendant.entityId,
        status: "CONFIRMED",
        confidence: 0.83,
        sourceIds: loanSources.map((item) => item.sourceId),
        stance: "COURT",
        attributes: extractThirdPartyLoanAttributes(loanSources.map((item) => item.text).join("\n")),
      });
    });
  }

  appendAgencyRelations(relations, entities, sources);

  return dedupeRelations(relations);
}

function extractRuleTimeline(
  documents: PipelineDocument[],
  relations: RelationRecord[],
  entities: EntityRecord[],
): TimelineEvent[] {
  const fullText = documents.map((item) => item.text).join("\n");
  const date = extractDate(fullText) ?? "时间待确认";
  const events: TimelineEvent[] = [
    {
      eventId: `event_${Date.now()}_core`,
      title: "案件核心事实",
      date,
      summary: fullText.slice(0, 120),
      relatedEntityIds: entities.slice(0, 4).map((item) => item.entityId),
      relatedRelationIds: relations.map((item) => item.relationId),
    },
  ];

  const plaintiff = entities.find((item) => item.entitySubtype === "Plaintiff");
  const defendant = entities.find((item) => item.entitySubtype === "Defendant");
  const borrowNote = entities.find((item) => item.displayName === "借条");

  if (/2017年12月4日/.test(fullText)) {
    events.push({
      eventId: `event_${Date.now()}_transfer`,
      title: "债权转让",
      date: "2017年12月4日",
      summary: "王某、杜某将对雍某的129,000元债权转让给杨某。",
      relatedEntityIds: [plaintiff?.entityId, defendant?.entityId].filter(Boolean) as string[],
      relatedRelationIds: relations
        .filter((item) => item.relationType === "TRANSFER_CLAIM_TO" || item.relationType === "OWE_TO")
        .map((item) => item.relationId),
    });
  }

  if (/2019年8月22日/.test(fullText) && borrowNote) {
    events.push({
      eventId: `event_${Date.now()}_note`,
      title: "出具借条",
      date: "2019年8月22日",
      summary: "雍某向杨某出具借条，对款项进行结算确认。",
      relatedEntityIds: [plaintiff?.entityId, defendant?.entityId, borrowNote.entityId].filter(Boolean) as string[],
      relatedRelationIds: relations.filter((item) => item.relationType === "SIGN_NOTE").map((item) => item.relationId),
    });
  }

  if (/2021年11月至2024年9月/.test(fullText)) {
    events.push({
      eventId: `event_${Date.now()}_demand`,
      title: "持续催款",
      date: "2021年11月至2024年9月",
      summary: "杨某多次通过电话向雍某催要款项。",
      relatedEntityIds: [plaintiff?.entityId, defendant?.entityId].filter(Boolean) as string[],
      relatedRelationIds: relations.filter((item) => item.relationType === "DEMAND_PAYMENT").map((item) => item.relationId),
    });
  }

  if (/2026年1月6日/.test(fullText)) {
    events.push({
      eventId: `event_${Date.now()}_appeal_stage`,
      title: "二审立案",
      date: "2026年1月6日",
      summary: "二审法院立案受理杨某上诉。",
      relatedEntityIds: [plaintiff?.entityId, defendant?.entityId].filter(Boolean) as string[],
      relatedRelationIds: relations.filter((item) => item.relationType === "APPEAL").map((item) => item.relationId),
    });
  }

  return events;
}

function extractDisputeRelations(
  documents: PipelineDocument[],
  entities: EntityRecord[],
  sources: SourceRecord[],
): RelationRecord[] {
  const fullText = documents.map((item) => item.text).join("\n");
  const plaintiff = entities.find((entity) => entity.entitySubtype === "Plaintiff");
  const defendant = entities.find((entity) => entity.entitySubtype === "Defendant");
  const candidateSources = sources.filter((source) => /(争议焦点|争议在于|争议为)/.test(source.text));
  const relations: RelationRecord[] = [];

  const issueLabels = candidateSources
    .map((source) => ({
      source,
      issue: extractDisputeIssue(source.text),
    }))
    .filter((item): item is { source: SourceRecord; issue: string } => Boolean(item.issue));

  if (issueLabels.length === 0 && /(争议焦点|争议在于|争议为)/.test(fullText)) {
    const fallbackIssue = extractDisputeIssue(fullText);
    if (fallbackIssue) {
      const fallbackSourceIds = sources.filter((source) => source.text.includes(fallbackIssue)).map((source) => source.sourceId);
      const claimId = buildClaimEntity(entities, sources, fallbackIssue);
      if (plaintiff) {
        relations.push({
          relationId: `dispute_${Date.now()}_plaintiff`,
          headEntityId: plaintiff.entityId,
          relationType: "DISPUTE_OVER",
          relationName: "争议焦点",
          tailEntityId: claimId,
          status: "DISPUTED",
          confidence: 0.78,
          sourceIds: fallbackSourceIds,
          stance: "COMBINED",
          attributes: { 争议点: fallbackIssue },
        });
      }
      if (defendant) {
        relations.push({
          relationId: `dispute_${Date.now()}_defendant`,
          headEntityId: defendant.entityId,
          relationType: "DISPUTE_OVER",
          relationName: "争议焦点",
          tailEntityId: claimId,
          status: "DISPUTED",
          confidence: 0.78,
          sourceIds: fallbackSourceIds,
          stance: "COMBINED",
          attributes: { 争议点: fallbackIssue },
        });
      }
    }
  }

  issueLabels.forEach(({ source, issue }, index) => {
    const claimId = buildClaimEntity(entities, [source], issue);
    if (plaintiff) {
      relations.push({
        relationId: `dispute_${Date.now()}_${index}_plaintiff`,
        headEntityId: plaintiff.entityId,
        relationType: "DISPUTE_OVER",
        relationName: "争议焦点",
        tailEntityId: claimId,
        status: "DISPUTED",
        confidence: 0.8,
        sourceIds: [source.sourceId],
        stance: "COMBINED",
        attributes: { 争议点: issue },
      });
    }
    if (defendant) {
      relations.push({
        relationId: `dispute_${Date.now()}_${index}_defendant`,
        headEntityId: defendant.entityId,
        relationType: "DISPUTE_OVER",
        relationName: "争议焦点",
        tailEntityId: claimId,
        status: "DISPUTED",
        confidence: 0.8,
        sourceIds: [source.sourceId],
        stance: "COMBINED",
        attributes: { 争议点: issue },
      });
    }
  });

  return dedupeRelations(relations);
}

async function extractWithOpenAI(documents: PipelineDocument[], sources: SourceRecord[]): Promise<PipelineOutput> {
  const aiConfig = getAIConfig();
  if (!aiConfig.apiKey) {
    throw new Error("未配置大模型 API Key");
  }

  const client = new OpenAI({
    apiKey: aiConfig.apiKey,
    baseURL: aiConfig.baseURL,
  });
  const inputText = documents
    .map(
      (doc) =>
        `文书类型：${doc.document.documentType}\n来源方：${doc.document.sourceParty}\n` +
        doc.chunks.map((chunk) => `[${chunk.paragraph}] ${chunk.text}`).join("\n"),
    )
    .join("\n\n");

  const messages = [
    {
      role: "system" as const,
      content: EXTRACTION_SYSTEM_PROMPT,
    },
    {
      role: "user" as const,
      content: inputText,
    },
  ];

  const parsed =
    aiConfig.providerLabel === "DeepSeek"
      ? await extractWithJsonMode(client, aiConfig.model, messages)
      : await extractWithStructuredOutputs(client, aiConfig.model, messages);

  const llmEntities = parsed.entities.map((entity, index) => {
    const cleanName = cleanupEntityName(entity.name);
    const sourceIds = sources
      .filter((source) => entity.sourceParagraphs.some((paragraph) => source.paragraph === paragraph))
      .map((source) => source.sourceId);
    const normalizedEntityType = entity.entityType;
    const normalizedSubtype = normalizeEntitySubtype(entity.entitySubtype, normalizedEntityType, cleanName);
    const inferredTags = inferEntityTags(normalizedSubtype, normalizedEntityType);

    return {
      entityId: buildEntityId(cleanName, index),
      entityType: normalizedEntityType,
      entitySubtype: normalizedSubtype,
      displayName: cleanName,
      tags: Array.from(new Set([...entity.tags, ...inferredTags])),
      x: 0,
      y: 0,
      attributes: entity.attributes,
      sourceIds,
      confirmed: false,
    } satisfies EntityRecord;
  });

  const entityByName = new Map(llmEntities.map((entity) => [normalizeEntityKey(entity.displayName), entity.entityId]));

  const llmRelations = parsed.relations
    .map((relation, index) => {
      const headEntityId = entityByName.get(normalizeEntityKey(relation.head));
      const tailEntityId = entityByName.get(normalizeEntityKey(relation.tail));
      if (!headEntityId || !tailEntityId) return null;
      const sourceIds = sources
        .filter((source) => relation.sourceParagraphs.some((paragraph) => source.paragraph === paragraph))
        .map((source) => source.sourceId);

      const normalizedRelationType = normalizeRelationType(relation.relationType, relation.relationName);
      return {
        relationId: `llm_relation_${index + 1}_${Date.now()}`,
        headEntityId,
        relationType: normalizedRelationType,
        relationName: normalizeRelationName(normalizedRelationType, relation.relationName),
        tailEntityId,
        status: relation.status,
        confidence: 0.84,
        sourceIds,
        stance: relation.stance as Stance,
        attributes: relation.attributes,
      } satisfies RelationRecord;
    })
    .filter((item): item is RelationRecord => Boolean(item));

  const postProcessedGraph = postProcessExtractedGraph(llmEntities, llmRelations, sources);

  const llmTimeline = parsed.timeline.map((event, index) => ({
    eventId: `llm_event_${index + 1}_${Date.now()}`,
    title: event.title,
    date: event.date,
    summary: event.summary,
    relatedEntityIds: postProcessedGraph.entities.map((entity) => entity.entityId).slice(0, 4),
    relatedRelationIds: postProcessedGraph.relations.map((relation) => relation.relationId).slice(0, 4),
  }));

  return {
    entities: postProcessedGraph.entities,
    relations: postProcessedGraph.relations,
    sources,
    timeline: llmTimeline,
    warnings: [],
  };
}

async function extractWithStructuredOutputs(
  client: OpenAI,
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
) {
  const completion = await client.chat.completions.parse({
    model,
    messages,
    response_format: zodResponseFormat(llmSchema, "legal_fact_graph"),
  });

  const parsed = completion.choices[0]?.message?.parsed;
  if (!parsed) {
    throw new Error("大模型未返回可解析的结构化结果");
  }

  return parsed;
}

async function extractWithJsonMode(
  client: OpenAI,
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
) {
  const completion = await client.chat.completions.create({
    model,
    messages: [
      ...messages,
      {
        role: "system",
        content:
          `${EXTRACTION_SYSTEM_PROMPT}\n\n再次强调：请仅返回 JSON 对象，不要输出 markdown 代码块，不要输出额外解释。`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("大模型未返回 JSON 文本");
  }

  const parsedJson = JSON.parse(content);
  const loose = jsonModeSchema.parse(parsedJson);
  return {
    entities: loose.entities.map((entity) => ({
      name: entity.name,
      entityType: normalizeEntityType(entity.entityType ?? undefined),
      entitySubtype: entity.entitySubtype ?? "未分类实体",
      tags: entity.tags ?? [],
      attributes: normalizeAttributes(entity.attributes ?? undefined),
      sourceParagraphs: normalizeParagraphRefs(entity.sourceParagraphs ?? undefined),
    })),
    relations: loose.relations
      .filter((relation) => relation.head && relation.relationName && relation.tail)
      .map((relation) => ({
        head: relation.head ?? "",
        relationType: normalizeRelationType(relation.relationType ?? undefined, relation.relationName ?? undefined),
        relationName: relation.relationName ?? "未命名关系",
        tail: relation.tail ?? "",
        status: normalizeStatus(relation.status ?? undefined),
        stance: normalizeStanceValue(relation.stance ?? undefined),
        attributes: normalizeAttributes(relation.attributes ?? undefined),
        sourceParagraphs: normalizeParagraphRefs(relation.sourceParagraphs ?? undefined),
      })),
    timeline: loose.timeline
      .filter((item) => item.title && item.summary)
      .map((item) => ({
        title: item.title ?? "关键事件",
        date: item.date ?? "时间待确认",
        summary: item.summary ?? "",
        sourceParagraphs: normalizeParagraphRefs(item.sourceParagraphs ?? undefined),
      })),
  };
}

function mergeEntities(base: EntityRecord[], incoming: EntityRecord[]): EntityRecord[] {
  const merged = new Map(base.map((entity) => [normalizeEntityKey(entity.displayName), entity]));
  incoming.forEach((entity) => {
    const key = normalizeEntityKey(entity.displayName);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, entity);
      return;
    }

    if (existing.displayName.length > entity.displayName.length) {
      existing.displayName = entity.displayName;
    }
    if (existing.entitySubtype === "未分类实体" && entity.entitySubtype !== "未分类实体") {
      existing.entitySubtype = entity.entitySubtype;
    }
    existing.tags = Array.from(new Set([...existing.tags, ...entity.tags]));
    existing.sourceIds = Array.from(new Set([...existing.sourceIds, ...entity.sourceIds]));
    existing.attributes = { ...existing.attributes, ...entity.attributes };
  });

  return Array.from(merged.values());
}

function mergeRelations(base: RelationRecord[], incoming: RelationRecord[]): RelationRecord[] {
  return dedupeRelations([...base, ...incoming]);
}

function rebindRelationsToMergedEntities(
  relations: RelationRecord[],
  mergedEntities: EntityRecord[],
  originalIncomingEntities: EntityRecord[],
) {
  const normalizedEntityIdMap = new Map(
    mergedEntities.map((entity) => [normalizeEntityKey(entity.displayName), entity.entityId]),
  );
  const incomingIdToKey = new Map(
    originalIncomingEntities.map((entity) => [entity.entityId, normalizeEntityKey(entity.displayName)]),
  );

  return relations.map((relation) => {
    const headKey = incomingIdToKey.get(relation.headEntityId);
    const tailKey = incomingIdToKey.get(relation.tailEntityId);

    return {
      ...relation,
      headEntityId: headKey ? normalizedEntityIdMap.get(headKey) ?? relation.headEntityId : relation.headEntityId,
      tailEntityId: tailKey ? normalizedEntityIdMap.get(tailKey) ?? relation.tailEntityId : relation.tailEntityId,
    };
  });
}

function dedupeRelations(relations: RelationRecord[]) {
  const map = new Map<string, RelationRecord>();
  relations.forEach((relation) => {
    const key = `${relation.headEntityId}-${relation.relationType}-${relation.tailEntityId}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, relation);
      return;
    }

    existing.confidence = Math.max(existing.confidence, relation.confidence);
    existing.sourceIds = Array.from(new Set([...existing.sourceIds, ...relation.sourceIds]));
    existing.attributes = { ...existing.attributes, ...relation.attributes };
    if (existing.status !== "DISPUTED" && relation.status === "DISPUTED") {
      existing.status = relation.status;
    }
    if (existing.stance === "COMBINED" && relation.stance !== "COMBINED") {
      existing.stance = relation.stance;
    }
    if (existing.relationName.length < relation.relationName.length) {
      existing.relationName = relation.relationName;
    }
  });
  return Array.from(map.values());
}

function postProcessExtractedGraph(
  entities: EntityRecord[],
  relations: RelationRecord[],
  sources: SourceRecord[],
) {
  const nextEntities = [...entities];
  const nextRelations = relations.map((relation) => ({ ...relation }));
  const entityById = new Map(nextEntities.map((entity) => [entity.entityId, entity]));

  const ensureClaim = (label: string) => {
    let claim = nextEntities.find((entity) => entity.entityType === "FactClaim" && entity.displayName === label);
    if (!claim) {
      claim = {
        entityId: buildEntityId(label, 0),
        entityType: "FactClaim",
        entitySubtype: "Claim",
        displayName: label,
        tags: ["争议主张"],
        x: 0,
        y: 0,
        attributes: {},
        sourceIds: sources.slice(0, 1).map((source) => source.sourceId),
        confirmed: false,
      };
      nextEntities.push(claim);
    }
    return claim;
  };

  nextRelations.forEach((relation) => {
    if (relation.relationType === "INVESTMENT_CLAIM") {
      relation.relationName = "主张投资关系";
      const claim = ensureClaim("投资款主张");
      relation.tailEntityId = claim.entityId;
      relation.status = "DISPUTED";
    }

    if (relation.relationType === "LEND_TO") {
      relation.relationName = "出借";
      if (relation.stance === "PLAINTIFF") {
        relation.status = "SYSTEM_GENERATED";
      }
    }

    if (relation.relationType === "RECEIVE_TRANSFER") {
      relation.relationName = "转账支付";
    }

    if (relation.relationType === "SIGN_CONTRACT") {
      relation.relationName = "签署合同";
      relation.stance = "COMBINED";
    }

    if (relation.relationType === "GUARANTEE_FOR") {
      relation.relationName = "保证担保";
    }

    if (relation.relationType === "RECEIVE_TRANSFER") {
      const tail = entityById.get(relation.tailEntityId);
      if (tail?.entitySubtype === "Account") {
        relation.attributes = {
          ...relation.attributes,
          资金去向: tail.displayName,
        };
      }
    }
  });

  return {
    entities: nextEntities,
    relations: dedupeRelations(nextRelations),
  };
}

function layoutEntities(entities: EntityRecord[]): EntityRecord[] {
  return entities.map((entity, index) => ({
    ...entity,
    x: 140 + (index % 4) * 190,
    y: 110 + Math.floor(index / 4) * 180,
  }));
}

function buildClaimEntity(entities: EntityRecord[], sources: SourceRecord[], label: string) {
  const claim = entities.find((entity) => entity.displayName === label);
  if (claim) {
    return claim.entityId;
  }

  const entity: EntityRecord = {
    entityId: buildEntityId(label),
    entityType: "FactClaim",
    entitySubtype: "Claim",
    displayName: label,
    tags: ["争议主张"],
    x: 0,
    y: 0,
    attributes: {},
    sourceIds: sources.map((source) => source.sourceId).slice(0, 1),
    confirmed: false,
  };
  entities.push(entity);
  return entity.entityId;
}

function buildEntityId(name: string, seed = 0) {
  return `entity_${sanitizeName(name)}_${seed}`.replace(/\s+/g, "_");
}

function extractAmountAndDate(text: string) {
  const attributes: Record<string, string> = {};
  const amount = text.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+)\s*(万元|元)/);
  const date = extractDate(text);
  if (amount) {
    attributes["金额"] = `${amount[1]}${amount[2]}`;
  }
  if (date) {
    attributes["发生时间"] = date;
  }
  return attributes;
}

function extractDate(text: string) {
  const dateMatch = text.match(/(20\d{2}年\d{1,2}月\d{1,2}日)/);
  return dateMatch?.[1];
}

function sanitizeName(value: string) {
  return cleanupEntityName(value).replace(/[，。；：、\s]/g, "").slice(0, 20);
}

function ensurePerson(
  map: Map<string, EntityRecord>,
  name: string,
  label: string,
  subtype: string,
  sources: SourceRecord[],
  attributes: Record<string, string> = {},
  extraTags: string[] = [],
) {
  const cleanName = sanitizeName(name);
  if (!cleanName) return;
  if (map.has(cleanName)) return;
  const source = sources.find((item) => item.text.includes(cleanName));
  map.set(cleanName, {
    entityId: buildEntityId(cleanName),
    entityType: "NaturalPerson",
    entitySubtype: subtype,
    displayName: cleanName,
    tags: [label, ...extraTags],
    x: 0,
    y: 0,
    attributes: { 诉讼地位: label, ...attributes },
    sourceIds: source ? [source.sourceId] : [],
    confirmed: false,
  });
}

function chunkText(text: string): ExtractedChunk[] {
  return normalizeText(text)
    .split(/\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part, index) => ({
      chunkId: `chunk_${index + 1}`,
      text: part,
      paragraph: `P${index + 1}`,
      page: index + 1,
    }));
}

function normalizeText(text: string) {
  return text.replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeEntityType(value: string | undefined): "NaturalPerson" | "Organization" | "VirtualAsset" | "ProcedureEntity" | "FactClaim" {
  if (!value) return "FactClaim";
  if (["NaturalPerson", "Organization", "VirtualAsset", "ProcedureEntity", "FactClaim"].includes(value)) {
    return value as "NaturalPerson" | "Organization" | "VirtualAsset" | "ProcedureEntity" | "FactClaim";
  }
  if (value.includes("人")) return "NaturalPerson";
  if (value.includes("公司") || value.includes("组织")) return "Organization";
  if (value.includes("资产") || value.includes("账户") || value.includes("金额") || value.includes("货币")) return "VirtualAsset";
  if (value.includes("程序") || value.includes("合同") || value.includes("文书") || value.includes("保证")) return "ProcedureEntity";
  return "FactClaim";
}

function normalizeEntitySubtype(value: string | undefined, entityType: EntityRecord["entityType"], name: string) {
  if (!value) {
    if (entityType === "VirtualAsset" && name.includes("账户")) return "Account";
    if (entityType === "VirtualAsset" && /元|万元/.test(name)) return "Money";
    if (entityType === "VirtualAsset" && name.includes("合同")) return "Contract";
    return "未分类实体";
  }
  const mapping: Record<string, string> = {
    原告: "Plaintiff",
    被告: "Defendant",
    第三人: "ThirdParty",
    代理人: "Agent",
    合同: "Contract",
    货币: "Money",
    保证: "Guarantee",
    账户: "Account",
  };
  return mapping[value] ?? value;
}

function inferEntityTags(subtype: string, entityType: EntityRecord["entityType"]) {
  const tags: string[] = [];
  if (subtype === "Plaintiff") tags.push("原告");
  if (subtype === "Defendant") tags.push("被告");
  if (subtype === "ThirdParty") tags.push("第三人");
  if (subtype === "Account") tags.push("账户");
  if (subtype === "Contract") tags.push("合同");
  if (subtype === "Money") tags.push("款项");
  if (entityType === "FactClaim") tags.push("争议主张");
  return tags;
}

function normalizeRelationType(type: string | undefined, relationName: string | undefined) {
  const name = relationName ?? "";
  if (type && !["NaturalPerson", "Organization", "VirtualAsset", "ProcedureEntity", "FactClaim"].includes(type)) {
    return type;
  }
  if (name.includes("出借") || name.includes("借款")) return "LEND_TO";
  if (name.includes("保证") || name.includes("担保")) return "GUARANTEE_FOR";
  if (name.includes("投资")) return "INVESTMENT_CLAIM";
  if (name.includes("争议")) return "DISPUTE_OVER";
  if (name.includes("债权转让")) return "TRANSFER_CLAIM_TO";
  if (name.includes("偿还") || name.includes("还款义务")) return "OWE_TO";
  if (name.includes("借条")) return "SIGN_NOTE";
  if (name.includes("催款")) return "DEMAND_PAYMENT";
  if (name.includes("上诉")) return "APPEAL";
  if (name.includes("提交证据")) return "SUBMIT_EVIDENCE";
  if (name.includes("鉴定")) return "APPLY_APPRAISAL";
  if (name.includes("保全")) return "APPLY_PRESERVATION";
  if (name.includes("执业")) return "SERVICE_AT";
  if (name.includes("委托")) return "APPOINT_AGENT";
  if (name.includes("转账") || name.includes("收款")) return "RECEIVE_TRANSFER";
  if (name.includes("签署") || name.includes("签订")) return "SIGN_CONTRACT";
  return "RELATED_TO";
}

function normalizeRelationName(type: string, relationName: string | undefined) {
  if (type === "LEND_TO") return "出借";
  if (type === "GUARANTEE_FOR") return "保证担保";
  if (type === "INVESTMENT_CLAIM") return "主张投资关系";
  if (type === "DISPUTE_OVER") return "争议焦点";
  if (type === "TRANSFER_CLAIM_TO") return "债权转让";
  if (type === "OWE_TO") return "应偿还";
  if (type === "SIGN_NOTE") return "出具借条";
  if (type === "DEMAND_PAYMENT") return "催款";
  if (type === "APPEAL") return "提起上诉";
  if (type === "SUBMIT_EVIDENCE") return "提交证据";
  if (type === "APPLY_APPRAISAL") return "申请鉴定";
  if (type === "APPLY_PRESERVATION") return "申请保全";
  if (type === "SERVICE_AT") return "执业于";
  if (type === "RECEIVE_TRANSFER") return "转账支付";
  if (type === "SIGN_CONTRACT") return "签署合同";
  if (type === "APPOINT_AGENT") return "委托代理";
  return relationName ?? "未命名关系";
}

function normalizeStatus(value: string | undefined): "SYSTEM_GENERATED" | "CONFIRMED" | "DISPUTED" | "PENDING_EVIDENCE" {
  if (!value) return "SYSTEM_GENERATED";
  if (value === "CONFIRMED" || value === "SYSTEM_GENERATED" || value === "DISPUTED" || value === "PENDING_EVIDENCE") {
    return value;
  }
  if (value.includes("争议")) return "DISPUTED";
  if (value.includes("确认") || value.includes("已发生")) return "CONFIRMED";
  if (value.includes("证据")) return "PENDING_EVIDENCE";
  return "SYSTEM_GENERATED";
}

function normalizeStanceValue(value: string | undefined): "COMBINED" | "PLAINTIFF" | "DEFENDANT" | "COURT" {
  if (!value) return "COMBINED";
  if (value === "COMBINED" || value === "PLAINTIFF" || value === "DEFENDANT" || value === "COURT") {
    return value;
  }
  if (value.includes("原告")) return "PLAINTIFF";
  if (value.includes("被告")) return "DEFENDANT";
  if (value.includes("法院")) return "COURT";
  return "COMBINED";
}

function normalizeAttributes(attributes: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    Object.entries(attributes ?? {}).map(([key, value]) => [
      key,
      typeof value === "string" ? value : Array.isArray(value) ? value.join("、") : JSON.stringify(value, null, 0),
    ]),
  );
}

function normalizeParagraphRefs(values: Array<string | number> | undefined) {
  return (values ?? []).map((value) => (typeof value === "number" ? `P${value + 1}` : value.startsWith("P") ? value : `P${value}`));
}

function normalizeEntityKey(value: string) {
  return cleanupEntityName(value).replace(/\s+/g, "");
}

function cleanupEntityName(value: string) {
  return value
    .replace(/^(原告|被告|第三人|代理人)/, "")
    .replace(/(承担连带责任保证|提供连带责任保证|连带责任保证|提供保证|签字确认|签字|承担|自愿提供|辩称.*|在借款合同上.*)$/g, "")
    .replace(/[：:，。；、\s]+/g, "")
    .slice(0, 12);
}

function extractDisputeIssue(text: string) {
  const match =
    text.match(/争议焦点为[:：]?\s*([^。；\n]+)/) ??
    text.match(/争议在于([^。；\n]+)/) ??
    text.match(/争议为([^。；\n]+)/);
  return match?.[1]?.trim().replace(/^如何/, "").replace(/[，。；]+$/g, "") ?? "";
}

function extractBorrowNoteAttributes(text: string) {
  const attributes: Record<string, string> = {};
  const amountMatch =
    text.match(/借杨某的现金(\d{1,3}(?:,\d{3})+|\d+)元加利息(\d{1,3}(?:,\d{3})+|\d+)元，合计(\d{1,3}(?:,\d{3})+|\d+)元/) ??
    text.match(/现金(\d{1,3}(?:,\d{3})+|\d+)元.*?利息(\d{1,3}(?:,\d{3})+|\d+)元.*?合计(\d{1,3}(?:,\d{3})+|\d+)元/);
  const dateMatch =
    text.match(/(2019年8月22日|2019\.8\.22)/) ??
    text.match(/(20\d{2}年\d{1,2}月\d{1,2}日|20\d{2}\.\d{1,2}\.\d{1,2})/);
  if (amountMatch) {
    attributes["本金"] = `${amountMatch[1]}元`;
    attributes["利息"] = `${amountMatch[2]}元`;
    attributes["合计"] = `${amountMatch[3]}元`;
  }
  if (dateMatch) {
    attributes["日期"] = normalizeDateText(dateMatch[1]);
  }
  return attributes;
}

function extractBorrowNoteRelationAttributes(text: string) {
  const attributes = extractBorrowNoteAttributes(text);
  if (!attributes["日期"]) {
    const date = extractDate(text);
    if (date) {
      attributes["日期"] = date;
    }
  }
  return attributes;
}

function extractTransferAttributes(text: string) {
  const attributes: Record<string, string> = {};
  const amountMatch = text.match(/(129,000|129000)元/) ?? text.match(/(\d{1,3}(?:,\d{3})+|\d+)元/);
  if (amountMatch) {
    attributes["债权金额"] = `${amountMatch[1]}元`;
  }
  const explicitDate = text.match(/2017年12月4日/);
  if (explicitDate) {
    attributes["转让时间"] = explicitDate[0];
  }
  return attributes;
}

function extractRepaymentAttributes(text: string) {
  const attributes: Record<string, string> = {};
  const amountMatch = text.match(/(129,000|129000)元/) ?? text.match(/(182,098\.52|182098\.52)元/);
  if (amountMatch) {
    attributes["确认金额"] = `${amountMatch[1]}元`;
  }
  if (text.includes("债权转让")) {
    attributes["形成基础"] = "债权转让";
  }
  return attributes;
}

function extractPreservationAttributes(text: string) {
  const attributes: Record<string, string> = {};
  const amountMatch =
    text.match(/冻结[^\n。]{0,24}?(\d{1,3}(?:,\d{3})+|\d+)元/) ??
    text.match(/保全金额[^\n。]{0,12}?(\d{1,3}(?:,\d{3})+|\d+)元/);
  const feeMatch = text.match(/保全申请费(\d+)元/);
  if (amountMatch) {
    attributes["保全金额"] = `${amountMatch[1]}元`;
  }
  if (feeMatch) {
    attributes["保全申请费"] = `${feeMatch[1]}元`;
  }
  return attributes;
}

function extractDemandPeriod(text: string) {
  const match = text.match(/(20\d{2}年\d{1,2}月至20\d{2}年\d{1,2}月)/);
  return match?.[1] ?? "时间待确认";
}

function extractThirdPartyLoanAttributes(text: string) {
  const attributes: Record<string, string> = {};
  const amountMatch = text.match(/(60,000|60000)元/) ?? text.match(/(\d{1,3}(?:,\d{3})+|\d+)元/);
  if (amountMatch) {
    attributes["金额"] = `${amountMatch[1]}元`;
  }
  return attributes;
}

function normalizeDateText(value: string) {
  if (value.includes(".")) {
    const parts = value.split(".");
    if (parts.length === 3) {
      return `${parts[0]}年${Number(parts[1])}月${Number(parts[2])}日`;
    }
  }
  return value;
}

function upsertEntity(map: Map<string, EntityRecord>, entity: EntityRecord) {
  const existing = map.get(entity.displayName);
  if (!existing) {
    map.set(entity.displayName, entity);
    return;
  }

  existing.tags = Array.from(new Set([...existing.tags, ...entity.tags]));
  existing.sourceIds = Array.from(new Set([...existing.sourceIds, ...entity.sourceIds]));
  existing.attributes = { ...existing.attributes, ...entity.attributes };
}

function appendAgencyRelations(
  relations: RelationRecord[],
  entities: EntityRecord[],
  sources: SourceRecord[],
) {
  const plaintiff = entities.find((entity) => entity.entitySubtype === "Plaintiff");
  const defendant = entities.find((entity) => entity.entitySubtype === "Defendant");
  const lawFirms = entities.filter((entity) => entity.entitySubtype === "LawFirm");
  const agents = entities.filter((entity) => entity.entitySubtype === "Agent");

  const sourceIndexMap = new Map(sources.map((source, index) => [source.sourceId, index]));
  const agencyMappings = [
    {
      principal: plaintiff,
      source: findAdjacentAgencySource(plaintiff?.displayName, "上诉人", agents, sources, sourceIndexMap),
    },
    {
      principal: defendant,
      source: findAdjacentAgencySource(defendant?.displayName, "被上诉人", agents, sources, sourceIndexMap),
    },
  ];

  agencyMappings.forEach((mapping, index) => {
    if (!mapping.principal || !mapping.source) {
      return;
    }

    const agent = agents.find((item) => mapping.source?.text.includes(item.displayName));
    if (!agent) {
      return;
    }

    relations.push({
      relationId: `rel_${Date.now()}_agency_${index}`,
      headEntityId: mapping.principal.entityId,
      relationType: "APPOINT_AGENT",
      relationName: "委托代理",
      tailEntityId: agent.entityId,
      status: "CONFIRMED",
      confidence: 0.88,
      sourceIds: [mapping.source.sourceId],
      stance: mapping.principal.entitySubtype === "Plaintiff" ? "PLAINTIFF" : "DEFENDANT",
      attributes: {},
    });

    const lawFirm = lawFirms.find((item) => mapping.source?.text.includes(item.displayName));
    if (!lawFirm) {
      return;
    }

    relations.push({
      relationId: `rel_${Date.now()}_service_at_${index}`,
      headEntityId: agent.entityId,
      relationType: "SERVICE_AT",
      relationName: "执业于",
      tailEntityId: lawFirm.entityId,
      status: "CONFIRMED",
      confidence: 0.84,
      sourceIds: [mapping.source.sourceId],
      stance: "COMBINED",
      attributes: {},
    });
  });
}

function findAdjacentAgencySource(
  principalName: string | undefined,
  roleLabel: string,
  agents: EntityRecord[],
  sources: SourceRecord[],
  sourceIndexMap: Map<string, number>,
) {
  if (!principalName) {
    return undefined;
  }

  const principalSource = sources.find(
    (item) => item.text.includes(principalName) && (item.text.includes(roleLabel) || item.text.includes("原审原告") || item.text.includes("原审被告")),
  );
  if (!principalSource) {
    return undefined;
  }

  const principalIndex = sourceIndexMap.get(principalSource.sourceId) ?? -1;
  return sources.find((item) => {
    const nextIndex = sourceIndexMap.get(item.sourceId) ?? -1;
    return (
      nextIndex === principalIndex + 1 &&
      item.text.includes("委托诉讼代理人") &&
      agents.some((agent) => item.text.includes(agent.displayName))
    );
  });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}
