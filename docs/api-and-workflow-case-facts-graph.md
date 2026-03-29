# 案件事实-关系图谱 任务流与接口草案

## 1. 目标
本文档用于为研发、后端、前端和算法团队提供统一的接口与任务编排草案，覆盖案件事实-关系图谱首版的核心流程：

- 卷宗进入系统
- 发起抽取任务
- 查询图谱结果
- 查看来源与证据
- 发起人工校核
- 重新抽取并版本对比

## 2. 总体任务流

```mermaid
flowchart LR
  upload[上传卷宗] --> createTask[创建抽取任务]
  createTask --> parseDocs[解析文书]
  parseDocs --> extractEntities[抽取实体]
  extractEntities --> extractRelations[抽取关系]
  extractRelations --> buildGraph[生成图谱版本]
  buildGraph --> publishVersion[发布默认版本]
  publishVersion --> queryGraph[前端查询图谱]
  queryGraph --> humanReview[人工校核]
  humanReview --> saveReview[保存校核结果]
  saveReview --> publishReviewed[生成校核版本]
```

## 3. 接口设计原则
- 接口按“案件维度”组织，避免前端直接感知复杂底层对象
- 图谱结果查询与抽取任务控制分离
- 所有写操作必须保留操作人和版本信息
- 所有返回结果应尽量包含来源和状态字段
- 首版优先保证接口清晰可用，不追求一次性覆盖全部扩展场景

## 4. 任务编排接口

### 4.1 创建抽取任务
用于在案件下发起一次新的图谱抽取。

`POST /api/cases/{caseId}/fact-graph/tasks`

请求示例：
```json
{
  "documentIds": ["doc_001", "doc_002", "doc_003"],
  "taskType": "full_extract",
  "versionDescription": "首次生成案件事实关系图谱",
  "triggerSource": "manual"
}
```

返回示例：
```json
{
  "taskId": "task_1001",
  "caseId": "case_123",
  "status": "PENDING"
}
```

### 4.2 查询任务状态
`GET /api/cases/{caseId}/fact-graph/tasks/{taskId}`

返回关键字段：
- `taskId`
- `status`
- `progress`
- `currentStage`
- `errorCode`
- `errorMessage`
- `versionId`

### 4.3 取消任务
`POST /api/cases/{caseId}/fact-graph/tasks/{taskId}/cancel`

适用场景：
- 用户误触发
- 文书上传错误
- 模型版本切换后需重新发起

## 5. 图谱查询接口

### 5.1 查询案件默认图谱
`GET /api/cases/{caseId}/fact-graph`

查询参数建议：
- `versionId`
- `viewType`
- `stance`
- `entityTypes`
- `relationTypes`
- `confidenceLevel`
- `onlyDisputed`

返回示例：
```json
{
  "caseId": "case_123",
  "versionId": "ver_20260325_01",
  "stance": "COMBINED",
  "nodes": [
    {
      "entityId": "person_zhangsan",
      "entityType": "NaturalPerson",
      "entitySubtype": "Plaintiff",
      "displayName": "张三",
      "tags": ["原告"]
    }
  ],
  "edges": [
    {
      "relationId": "rel_001",
      "headEntityId": "person_zhangsan",
      "relationType": "LEND_TO",
      "relationName": "出借",
      "tailEntityId": "person_lisi",
      "status": "SYSTEM_GENERATED",
      "confidence": 0.86,
      "sourceCount": 2
    }
  ]
}
```

### 5.2 查询单个实体详情
`GET /api/cases/{caseId}/fact-graph/entities/{entityId}`

返回建议包含：
- 实体基本信息
- 实体属性
- 关联关系摘要
- 来源文书摘要
- 人工校核记录

### 5.3 查询单个关系详情
`GET /api/cases/{caseId}/fact-graph/relations/{relationId}`

返回建议包含：
- 头实体和尾实体
- 关系名称与关系类型编码
- 关系属性
- 状态与置信度
- 来源列表
- 相关证据列表
- 关联时间线事件

### 5.4 查询来源片段
`GET /api/cases/{caseId}/fact-graph/sources/{sourceId}`

返回建议包含：
- 来源文书信息
- 页码和段落号
- 原文内容
- 该片段生成的实体和关系

## 6. 视图与筛选接口

### 6.1 获取预置视图
`GET /api/cases/{caseId}/fact-graph/views`

返回建议：
- 综合全景视图
- 人物关系视图
- 资金关系视图
- 公司控制视图
- 涉案财产视图

### 6.2 图谱筛选查询
`POST /api/cases/{caseId}/fact-graph/query`

请求示例：
```json
{
  "versionId": "ver_20260325_01",
  "stance": "PLAINTIFF",
  "filters": {
    "entityTypes": ["NaturalPerson", "Organization"],
    "relationTypes": ["SPOUSE", "LEND_TO", "GUARANTEE_FOR"],
    "onlyDisputed": false,
    "minConfidence": 0.6
  },
  "focusEntityId": "person_zhangsan",
  "depth": 2
}
```

## 7. 人工校核接口

### 7.1 确认实体
`POST /api/cases/{caseId}/fact-graph/entities/{entityId}/confirm`

### 7.2 修改实体
`PATCH /api/cases/{caseId}/fact-graph/entities/{entityId}`

请求示例：
```json
{
  "displayName": "张三",
  "attributes": {
    "idNumber": "3201********1234",
    "litigationRole": "原告"
  },
  "reviewComment": "根据起诉状首页信息补全"
}
```

### 7.3 合并实体
`POST /api/cases/{caseId}/fact-graph/entities/merge`

请求示例：
```json
{
  "sourceEntityIds": ["person_tmp_01", "person_tmp_02"],
  "targetEntityId": "person_zhangsan",
  "reviewComment": "同名同证件号，人工合并"
}
```

### 7.4 拆分实体
`POST /api/cases/{caseId}/fact-graph/entities/{entityId}/split`

### 7.5 确认关系
`POST /api/cases/{caseId}/fact-graph/relations/{relationId}/confirm`

### 7.6 修改关系
`PATCH /api/cases/{caseId}/fact-graph/relations/{relationId}`

请求示例：
```json
{
  "relationType": "GUARANTEE_FOR",
  "attributes": {
    "amount": 500000,
    "guaranteeType": "连带责任保证"
  },
  "status": "CONFIRMED",
  "reviewComment": "根据借款合同与保证书修正"
}
```

### 7.7 删除关系
`DELETE /api/cases/{caseId}/fact-graph/relations/{relationId}`

### 7.8 补充来源
`POST /api/cases/{caseId}/fact-graph/relations/{relationId}/sources`

## 8. 版本管理接口

### 8.1 查询版本列表
`GET /api/cases/{caseId}/fact-graph/versions`

返回建议包含：
- 版本号
- 版本类型
- 创建时间
- 创建人
- 来源任务
- 是否默认发布

### 8.2 发布版本
`POST /api/cases/{caseId}/fact-graph/versions/{versionId}/publish`

### 8.3 版本对比
`GET /api/cases/{caseId}/fact-graph/versions/compare?left={versionA}&right={versionB}`

返回建议包含：
- 新增实体
- 删除实体
- 新增关系
- 删除关系
- 变更属性

### 8.4 基于已有版本重跑
`POST /api/cases/{caseId}/fact-graph/versions/{versionId}/rerun`

## 9. 时间线接口

### 9.1 查询案件时间线
`GET /api/cases/{caseId}/fact-graph/timeline`

查询参数建议：
- `versionId`
- `stance`
- `eventTypes`
- `focusEntityId`

返回建议包含：
- 时间
- 事件名称
- 关联实体
- 关联关系
- 来源

## 10. 统计与运营接口

### 10.1 图谱统计摘要
`GET /api/cases/{caseId}/fact-graph/stats`

建议返回：
- 实体总数
- 关系总数
- 已确认关系数
- 争议关系数
- 低置信关系数
- 来源覆盖率

### 10.2 校核工作量统计
`GET /api/cases/{caseId}/fact-graph/review-stats`

## 11. 权限与审计要求

### 11.1 权限控制
- 查看图谱：仅案件承办相关人员
- 发起重跑：法官、法官助理或授权管理员
- 人工校核：法官、法官助理
- 版本发布：法官或授权管理员

### 11.2 审计要求
对以下操作记录审计日志：
- 查看图谱
- 查看来源片段
- 修改实体
- 修改关系
- 合并/拆分实体
- 发布版本
- 导出图谱

## 12. 错误码建议
| 错误码 | 含义 |
| --- | --- |
| FG001 | 案件不存在 |
| FG002 | 文书不存在或无权限 |
| FG003 | 抽取任务不存在 |
| FG004 | 当前任务不可取消 |
| FG005 | 图谱版本不存在 |
| FG006 | 实体不存在 |
| FG007 | 关系不存在 |
| FG008 | 来源不存在 |
| FG009 | 当前版本不可编辑 |
| FG010 | 参数校验失败 |

## 13. 首版接口边界
首版建议优先交付以下接口：
- 抽取任务创建与状态查询
- 默认图谱查询
- 实体详情查询
- 关系详情查询
- 来源片段查询
- 实体确认/修改/合并
- 关系确认/修改/删除
- 版本查询与发布

时间线、版本对比、复杂统计等接口可作为 P1 补充。

## 14. 结论
接口设计的核心不是追求“大而全”，而是围绕法院实际使用路径形成闭环：

1. 有材料可发起抽取
2. 有图谱可查询
3. 有来源可回溯
4. 有错误可校核
5. 有变更可版本化管理

只要这条闭环链路打通，案件事实-关系图谱就能真正进入法院业务系统的可用阶段。
