# Langfuse 成本估算管线完整技术解析

## 概述

Langfuse 的成本估算管线是一个三段式处理流程：**模型匹配** → **定价层级匹配** → **Token 估算与成本计算**。该管线负责为每条 LLM 调用追踪记录匹配正确的模型定价，估算 Token 使用量，并最终累加计算出调用成本。

**本报告特别补充：** 完整的失败/回退路径分析、异常分支处理逻辑，以及从 Trace 输入到最终成本落库的端到端示例。

---

## 管线总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        成本估算管线总览                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────────────┐ │
│  │   模型匹配   │───▶│  定价层级匹配    │───▶│  Token估算与成本计算 │ │
│  │  (Model)     │    │  (Pricing Tier)  │    │  (Token + Cost)       │ │
│  └──────────────┘    └──────────────────┘    └───────────────────────┘ │
│         │                       │                        │              │
│         ▼                       ▼                        ▼              │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────────────┐ │
│  │ 正则匹配     │    │ 条件评估(AND)    │    │  OpenAI tokenizer     │ │
│  │ 缓存(Redis)  │    │ 优先级排序       │    │  Anthropic tokenizer  │ │
│  └──────────────┘    └──────────────────┘    └───────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  ★ 新增：完整失败/回退路径（第7章）                                 │  │
│  │  ★ 新增：端到端示例（第8章）                                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 第一部分：模型匹配 (Model Matching)

### 1.1 核心文件位置

| 文件 | 功能 |
|------|------|
| `packages/shared/src/server/ingestion/modelMatch.ts` | 模型匹配主逻辑 |
| `worker/src/constants/default-model-prices.json` | 内置模型定价数据 |

### 1.2 匹配流程

模型匹配采用 **PostgreSQL 正则匹配 + Redis 缓存** 的架构：

```
┌─────────────────────────────────────────────────────────────┐
│                     模型匹配流程                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 本地缓存检查 (Local L1 Cache)                           │
│     └─ TTL: 10秒, 最大容量: 20000条                          │
│                                                             │
│  2. Redis 缓存检查 (L2 Cache)                                │
│     └─ 支持 Redis Cluster 哈希标签                           │
│                                                             │
│  3. PostgreSQL 直接查询 (缓存未命中)                         │
│     └─ 使用正则 match_pattern 进行匹配                       │
│                                                             │
│  4. 缓存回填                                                │
│     └─ 查询结果同时写入 Redis 和本地缓存                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 PostgreSQL 匹配 SQL 逻辑

核心查询位于 `modelMatch.ts:266-306`：

```sql
SELECT
  id,
  created_at,
  updated_at,
  project_id,
  model_name,
  match_pattern,
  start_date,
  input_price,
  output_price,
  total_price,
  unit,
  tokenizer_id,
  tokenizer_config
FROM
  models
WHERE
  (project_id = ${projectId} OR project_id IS NULL)
  AND ${modelName} ~ match_pattern  -- 正则匹配
ORDER BY
  project_id ASC,          -- 用户自定义模型优先于内置模型
  start_date DESC NULLS LAST  -- 较新的定价优先
LIMIT 1
```

### 1.4 关键匹配规则

1. **优先级排序**：
   - `project_id ASC`：用户自定义模型（有 project_id）优先于 Langfuse 内置模型（project_id IS NULL）
   - `start_date DESC`：较新的定价生效日期优先

2. **正则匹配**：
   - 使用 PostgreSQL 正则操作符 `~`
   - 支持 `matchPattern` 如 `(?i)^(gpt-)(35|3.5)(-turbo)?(.*)`
   - 不区分大小写匹配（通过 `(?i)` 标志实现）

3. **缓存策略**：
   - **L1 本地内存缓存**：TTL = 10秒，最大 20000 条
   - **L2 Redis 缓存**：可配置 TTL（`LANGFUSE_CACHE_MODEL_MATCH_TTL_SECONDS`）
   - **未命中标记**：未找到的模型也会被缓存（标记为 "未找到"），避免重复查询

---

## 第二部分：定价层级匹配 (Pricing Tier Matching)

### 2.1 核心文件位置

| 文件 | 功能 |
|------|------|
| `packages/shared/src/server/pricing-tiers/matcher.ts` | 定价层级匹配器 |
| `packages/shared/src/server/pricing-tiers/types.ts` | 类型定义 |
| `fern/apis/server/definition/commons.yml` | API 文档定义 |

### 2.2 定价层级结构

每个模型可以包含多个定价层级（Pricing Tier），用于处理复杂的定价场景：

```typescript
interface PricingTier {
  id: string;
  name: string;           // 如 "Standard", "Large Context"
  isDefault: boolean;     // 是否为默认层级（必有一个默认）
  priority: number;       // 匹配优先级（数字越小越先评估）
  conditions: Array<{     // 匹配条件数组（AND 逻辑）
    usageDetailPattern: string;  // 匹配 usage_details 的键（正则）
    operator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
    value: number;        // 阈值
    caseSensitive?: boolean;
  }>;
  prices: Array<{         // 该层级下各 usageType 的单价
    usageType: string;    // "input", "output", "total" 等
    price: Decimal;       // 单位价格
  }>;
}
```

### 2.3 匹配算法

```
┌─────────────────────────────────────────────────────────────┐
│                  定价层级匹配算法                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  输入: tiers[], usageDetails                                │
│                                                             │
│  1. 分离默认层级和条件层级                                   │
│     └─ defaultTier = tiers.find(t => t.isDefault)           │
│     └─ conditionalTiers = tiers.filter(t => !t.isDefault)   │
│                                                             │
│  2. 条件层级按优先级升序排列 (priority ASC)                  │
│     └─ 优先级数字越小，越早被评估                            │
│                                                             │
│  3. 逐个评估条件层级（AND 逻辑）                             │
│     ┌─────────────────────────────────────────────────┐   │
│     │ 条件评估: evaluateCondition(condition, usage)    │   │
│     │   └─ 正则匹配 usageDetailPattern 找到所有键      │   │
│     │   └─ 匹配键的值求和                               │   │
│     │   └─ 应用操作符比较 (gt/gte/lt/lte/eq/neq)       │   │
│     │   └─ 所有条件都通过 → 该层级匹配成功              │   │
│     └─────────────────────────────────────────────────┘   │
│                                                             │
│  4. 匹配成功 → 返回该层级价格                                │
│     无匹配 → 返回默认层级价格                                │
│     无默认 → 返回 null                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.4 代码实现要点

`matchPricingTier` 函数位于 `matcher.ts:88-125`：

```typescript
export function matchPricingTier(
  tiers: PricingTierWithPrices[],
  usageDetails: Record<string, number>,
): PricingTierMatchResult | null {
  // 1. 按优先级排序条件层级
  const sortedTiers = tiers
    .filter((tier) => !tier.isDefault)
    .sort((a, b) => a.priority - b.priority);

  // 2. 尝试匹配每个条件层级
  for (const tier of sortedTiers) {
    if (evaluateConditions(tier.conditions, usageDetails)) {
      return {
        pricingTierId: tier.id,
        pricingTierName: tier.name,
        prices: Object.fromEntries(
          tier.prices.map((p) => [p.usageType, p.price]),
        ),
      };
    }
  }

  // 3. 回退到默认层级
  const defaultTier = tiers.find((tier) => tier.isDefault);
  return defaultTier ? { /* ... */ } : null;
}
```

### 2.5 典型场景：Claude Sonnet 大上下文定价

Anthropic Claude Sonnet 采用上下文窗口分段定价：

| 层级 | 条件 | 输入价格 | 说明 |
|------|------|----------|------|
| Standard | input_tokens ≤ 200K | $3 / M token | 常规上下文 |
| Large Context | input_tokens > 200K | $6 / M token | 大上下文加价 |

匹配逻辑（伪代码）：
```javascript
if (usageDetails.input_tokens > 200000) {
  return "Large Context" tier prices;
}
return "Standard" tier prices;
```

---

## 第三部分：Token 估算器 (Token Estimation)

### 3.1 核心文件位置

| 文件 | 功能 |
|------|------|
| `worker/src/features/tokenisation/usage.ts` | Token 计数主逻辑 |
| `worker/src/features/tokenisation/types.ts` | 类型定义 |

### 3.2 Tokenizer 配置结构

每个模型在数据库中存储 tokenizer 相关配置：

```typescript
interface Model {
  tokenizer_id: "openai" | "claude";  // Tokenizer 类型
  tokenizer_config: {
    // OpenAI Chat 模型专用
    tokensPerMessage?: number;    // 每条消息基础 token 数
    tokensPerName?: number;       // 每个角色名额外 token 数
    tokenizerModel?: string;      // 使用的 tiktoken 模型名
  };
}
```

### 3.3 OpenAI Tokenizer 实现

#### 3.3.1 文本 Token 计数

```typescript
function openAiTokenCount(params: { model: Model; text: unknown }) {
  const config = OpenAiTokenConfigSchema.safeParse(params.model.tokenizerConfig);
  if (!config.success) {
    logger.warn(`Invalid tokenizer config for model ${params.model.id}: ...`);
    return undefined;  // ← 配置解析失败直接返回 undefined
  }

  // 对于 Chat 消息数组，使用特殊公式
  if (isChatMessageArray(parsedText) && isChatModel(config.data.tokenizerModel)) {
    return openAiChatTokenCount({ messages: parsedText, config });
  }

  // 对于普通文本，直接使用 tiktoken
  return getTokensByModel(config.data.tokenizerModel, parsedText);
}
```

#### 3.3.2 Chat 消息特殊计算公式

OpenAI Chat Completions API 的 Token 计算遵循特定公式（参考 OpenAI 官方文档）：

```typescript
function openAiChatTokenCount(params: {
  messages: ChatMessage[];
  config: OpenAiChatTokenConfig;
}): number {
  let numTokens = 0;

  // 每条消息累加
  for (const message of params.messages) {
    numTokens += params.config.tokensPerMessage;  // 每条消息基础开销

    // 计算内容、角色名的 token
    for (const [key, value] of Object.entries(message)) {
      if (["content", "role", "name", "tool_calls", "function_call"].includes(key)) {
        numTokens += getTokensByModel(config.tokenizerModel, value);
      }
      if (key === "name") {
        numTokens += params.config.tokensPerName;  // name 字段的额外开销
      }
    }
  }

  numTokens += 3;  // 每条回复的固定基础开销（<|start|>assistant<|message|>）

  return numTokens;
}
```

#### 3.3.3 Tiktoken 缓存优化

```typescript
const cachedTokenizerByModel: Record<string, Tiktoken> = {};

function getTokensByModel(model: string, text: string): number {
  // 懒加载 + 缓存 tokenizer 实例，避免重复初始化开销
  try {
    cachedTokenizerByModel[model] =
      cachedTokenizerByModel[model] || encoding_for_model(model);
  } catch {
    logger.warn("Model not found. Using cl100k_base encoding.");  // ← 回退到通用编码
    encoding = get_encoding("cl100k_base");
  }

  const cleanedText = unicodeToBytesInString(text);  // 处理 Emoji 等多字节字符
  return encoding?.encode(cleanedText, "all").length;
}
```

### 3.4 Anthropic Tokenizer 实现

直接使用 Anthropic 官方 `@anthropic-ai/tokenizer` 包：

```typescript
function claudeTokenCount(text: unknown): number {
  // 统一转为字符串后计数
  return isString(text)
    ? countTokens(text)
    : countTokens(JSON.stringify(text));
}
```

### 3.5 Token 估算的失败出口（重点！）

**`tokenCount()` 函数可能返回 `undefined` 的 5 种情况：**

| 序号 | 场景 | 返回值 | 日志 |
|------|------|--------|------|
| 1 | 输入文本为 null/undefined/空数组 | `undefined` | 无 |
| 2 | `tokenizerId` 既不是 "openai" 也不是 "claude" | `undefined` | `logger.error("Unknown tokenizer xxx")` |
| 3 | `tokenizerId = "openai"` 但 `tokenizerConfig` 解析失败 | `undefined` | `logger.warn("Invalid tokenizer config...")` |
| 4 | Chat 模型但 Chat 配置解析失败 | `undefined` | `logger.error("Invalid tokenizer config for chat model...")` |
| 5 | Tiktoken 异常但回退到 cl100k_base 也失败 | `undefined` | （异常被 catch，但 encode 可能失败） |

**重要**：`undefined` 不是失败——它是一个明确的信号，表示"无法估算"，会沿着调用链向上传递。

---

## 第四部分：成本计算 (Cost Calculation)

### 4.1 核心文件位置

| 文件 | 功能 |
|------|------|
| `worker/src/services/IngestionService/index.ts` | `calculateUsageCosts` 方法 |
| `worker/src/services/IngestionService/tests/calculateTokenCost.unit.test.ts` | 单元测试 |

### 4.2 计算流程总览

```
┌─────────────────────────────────────────────────────────────────┐
│                         成本计算流程                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 步骤 1: 用户提供成本优先                                   │  │
│  │   - 检查 provided_cost_details 是否有值                   │  │
│  │   - 用户提供了 ANY 成本 → 跳过自动计算                     │  │
│  │   - 仅推导 total（如果只提供了 input + output）            │  │
│  └─────────────────────────────────────────────────────────┘  │
│                            ↓                                    │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 步骤 2: 自动计算模式                                      │  │
│  │   - 遍历 usageUnits (input/output/total)                 │  │
│  │   - 对每个键，找到匹配的单价                              │  │
│  │   - cost = token_count × price_per_token                │  │
│  └─────────────────────────────────────────────────────────┘  │
│                            ↓                                    │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 步骤 3: 推导 total_cost                                   │  │
│  │   - 已有 total → 直接使用                                 │  │
│  │   - 否则累加所有已计算的成本项                             │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 关键代码分析

`calculateUsageCosts` 静态方法（`IngestionService/index.ts:1280-1352`）：

```typescript
static calculateUsageCosts(
  modelPrices: Array<{ usageType: string; price: Decimal }> | null | undefined,
  observationRecord: { provided_cost_details },
  usageUnits: UsageCostType,
): { cost_details, total_cost } {
  const { provided_cost_details } = observationRecord;

  const providedCostKeys = Object.entries(provided_cost_details ?? {})
    .filter(([_, value]) => value != null)
    .map(([key]) => key);

  // ==========================================
  // 规则 1: 用户提供成本优先，不做任何自动计算
  // ==========================================
  if (providedCostKeys.length) {
    const cost_details = { ...provided_cost_details };

    // 仅当用户只提供了 input + output 时，推导 total
    const finalTotalCost =
      provided_cost_details?.["total"] ??
      (providedCostKeys.every(key => ["input", "output"].includes(key))
        ? ((provided_cost_details ?? {})["input"] ?? 0) +
          ((provided_cost_details ?? {})["output"] ?? 0)
        : undefined);

    if (!Object.prototype.hasOwnProperty.call(cost_details, "total") &&
        finalTotalCost != null) {
      cost_details.total = finalTotalCost;
    }

    return { cost_details, total_cost: finalTotalCost };
  }

  // ==========================================
  // 规则 2: 自动计算模式
  // ==========================================
  const finalCostEntries: [string, number][] = [];

  for (const [key, units] of Object.entries(usageUnits)) {
    const price = modelPrices?.find(p => p.usageType === key);

    // token 数量 × 单价（使用 Decimal 精确计算）
    if (units != null && price) {
      finalCostEntries.push([key, price.price.mul(units).toNumber()]);
    }
  }

  const finalCostDetails = Object.fromEntries(finalCostEntries);

  // ==========================================
  // 规则 3: 推导 total_cost
  // ==========================================
  let finalTotalCost;
  if (finalCostDetails.total != null) {
    finalTotalCost = finalCostDetails.total;
  } else if (finalCostEntries.length > 0) {
    finalTotalCost = finalCostEntries.reduce((acc, [_, cost]) => acc + cost, 0);
    finalCostDetails.total = finalTotalCost;
  }

  return { cost_details: finalCostDetails, total_cost: finalTotalCost };
}
```

### 4.4 用户提供成本优先规则详解

**设计意图**：用户最清楚实际成本，一旦用户提供了任何成本数据，系统完全信任用户输入，避免"部分计算、部分用户提供"导致的逻辑混乱。

| 场景 | 处理方式 |
|------|----------|
| 用户提供了 `input` + `output` 但无 `total` | 自动推导 `total = input + output` |
| 用户只提供了 `total` | 只使用 total，不计算分项 |
| 用户只提供了 `input` | total = input，output 保持 undefined |
| 用户提供了 `input` + 其他自定义项（如 `search`） | 不推导 total（因为不是标准的 input + output 组合） |

### 4.5 精度处理

- 使用 `decimal.js` 库进行精确的十进制乘法运算
- `price.price.mul(units).toNumber()` 确保无浮点数精度损失

---

## 第五部分：完整管线整合

### 5.1 调用栈（从 IngestionService 入口）

```
IngestionService.processObservationEventList
  ↓
createEventRecord / mergeObservationRecords
  ↓
calculateUsageAndCosts （整合三大步骤的入口）
  ├─ findModel()            → 模型匹配（含缓存）
  ├─ getUsageUnits()        → Token 估算
  │   └─ tokenCount()       → 调用具体 tokenizer
  └─ matchPricingTier()     → 定价层级匹配
  └─ calculateUsageCosts()  → 最终成本计算
```

### 5.2 `calculateUsageAndCosts` 方法完整流程

```typescript
private async calculateUsageAndCosts(
  observationRecord: ObservationRecordInsertType,
  internalModel: Model | null | undefined,
): Promise<{/* ... */}> {
  // 1. 获取 Token 数量（用户提供或自动估算）
  const usage_details = await this.getUsageUnits(observationRecord, internalModel);

  // 2. 匹配定价层级
  let usage_pricing_tier_id: string | undefined;
  let usage_pricing_tier_name: string | undefined;
  let modelPrices: Array<{ usageType: string; price: Decimal }> | undefined;

  if (internalModel) {
    const pricingTiers = await findPricingTiersForModel(internalModel.id);

    const matchedTier = matchPricingTier(pricingTiers, usage_details.usage_details ?? {});

    if (matchedTier) {
      usage_pricing_tier_id = matchedTier.pricingTierId;
      usage_pricing_tier_name = matchedTier.pricingTierName;
      // 转换格式供 calculateUsageCosts 使用
      modelPrices = Object.entries(matchedTier.prices).map(([usageType, price]) => ({
        usageType,
        price,
      }));
    }
  }

  // 3. 计算最终成本
  const final_cost_details = IngestionService.calculateUsageCosts(
    modelPrices,
    observationRecord,
    usage_details.usage_details ?? {},
  );

  return {
    ...usage_details,
    ...final_cost_details,
    internal_model_id: internalModel?.id,
    usage_pricing_tier_id,
    usage_pricing_tier_name,
  };
}
```

### 5.3 `getUsageUnits` 方法完整流程（关键！）

```typescript
private async getUsageUnits(
  observationRecord: { provided_usage_details, level, input, output, id },
  model: Model | null | undefined,
): Promise<{ usage_details, provided_usage_details }> {

  // ─────────────────────────────────────────────────────────
  // 阶段 A: 用户提供的 usage 优先
  // ─────────────────────────────────────────────────────────
  const providedUsageDetails: Record<string, number> = {};
  for (const [key, value] of Object.entries(observationRecord.provided_usage_details)) {
    if (value != null) {
      const numValue = Number(value);
      if (!isNaN(numValue) && numValue >= 0) {  // 只接受非负数字
        providedUsageDetails[key] = numValue;
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // 阶段 B: 自动 Token 估算的 3 个前置条件
  // ─────────────────────────────────────────────────────────
  // 条件 1: 模型存在
  // 条件 2: 用户没有提供任何 usage
  // 条件 3: 观察状态不是 ERROR
  if (
    model &&
    Object.keys(providedUsageDetails).length === 0 &&
    observationRecord.level !== ObservationLevel.ERROR
  ) {
    try {
      let newInputCount: number | undefined;
      let newOutputCount: number | undefined;

      // ──────────────────────────────────────────────
      // 阶段 C: 异步 Token 估算（带同步回退）
      // ──────────────────────────────────────────────
      await instrumentAsync({ name: "token-count" }, async (span) => {
        try {
          // 并行估算 input 和 output
          [newInputCount, newOutputCount] = await Promise.all([
            tokenCountAsync({ text: observationRecord.input, model }),
            tokenCountAsync({ text: observationRecord.output, model }),
          ]);
        } catch (error) {
          // 异步估算失败 → 回退到同步版本
          logger.warn("Async tokenization has failed. Falling back to synchronous tokenization");
          newInputCount = tokenCount({ text: observationRecord.input, model });
          newOutputCount = tokenCount({ text: observationRecord.output, model });
        }
        // ... tracing metrics
      });

      logger.debug(`Tokenized observation ${observationRecord.id}...`);

      // ──────────────────────────────────────────────
      // 阶段 D: 计算 total
      // ──────────────────────────────────────────────
      const newTotalCount =
        newInputCount || newOutputCount
          ? (newInputCount ?? 0) + (newOutputCount ?? 0)
          : undefined;  // 两个都 undefined → total 也 undefined

      const usage_details: Record<string, number> = {};
      if (newInputCount != null) usage_details.input = newInputCount;
      if (newOutputCount != null) usage_details.output = newOutputCount;
      if (newTotalCount != null) usage_details.total = newTotalCount;

      return { usage_details, provided_usage_details: providedUsageDetails };

    } catch (error) {
      // ──────────────────────────────────────────────
      // 阶段 E: 最外层异常捕获
      // ──────────────────────────────────────────────
      traceException(error);
      logger.error(`Tokenization failed for observation ${observationRecord.id}...`);
      // 关键：发生任何异常时，返回空对象，而不是抛出错误中断整个流程！
      return {
        usage_details: {},
        provided_usage_details: providedUsageDetails,
      };
    }
  }

  // ─────────────────────────────────────────────────────────
  // 阶段 F: 跳过自动估算，直接使用用户提供的值
  // ─────────────────────────────────────────────────────────
  const usageDetails = { ...providedUsageDetails };
  if (Object.keys(usageDetails).length > 0 && !("total" in usageDetails)) {
    // 用户提供了部分值但没提供 total → 自动累加
    usageDetails.total = Object.values(providedUsageDetails).reduce((acc, value) => acc + value, 0);
  }

  return {
    usage_details: usageDetails,
    provided_usage_details: providedUsageDetails,
  };
}
```

### 5.4 数据流向

```
┌─────────────────────────────────────────────────────────────────────┐
│                          数据流向图                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  API Input → provided_model_name                                     │
│      ↓  (正则匹配)                                                  │
│  Model ID + tokenizer_id + tokenizer_config                          │
│      ↓                                                              │
│  PricingTiers (conditions + prices)                                  │
│      ↓  (条件匹配)                                                  │
│  matched_prices (input_price, output_price, total_price)             │
│                                                                     │
│  API Input → provided_usage_details OR input/output texts           │
│      ↓  (tokenizer 估算)                                            │
│  usage_details (input_tokens, output_tokens, total_tokens)          │
│      ↓  (单价 × token 数)                                           │
│  cost_details (input_cost, output_cost, total_cost)                 │
│      ↓                                                              │
│  ClickHouse observations_table                                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 第六部分：关键设计决策

### 6.1 缓存层级设计

| 层级 | 存储 | 适用场景 | 优点 |
|------|------|----------|------|
| L1 | 本地内存 | 高频重复模型 | 极快（~1ms） |
| L2 | Redis | 所有模型 | 跨 worker 共享 |
| L3 | PostgreSQL | 首次查询 | 数据一致性 |

### 6.2 用户成本优先原则

**问题**：为什么只要用户提供了任何成本项，就停止所有自动计算？

- **根本原因**：成本计算不是"越多越好"，而是"越准越好"
- **实际场景**：用户可能通过 API 拿到了精确的成本分项，其中某些项（如 search、rag 等）Langfuse 不知道如何计算
- **避免错误**：如果部分用用户数据、部分自动计算，可能导致 `total != input + output` 等不一致问题

### 6.3 定价层级的条件 AND 逻辑

**为什么是 AND 而不是 OR？**

- 层级代表一个"定价档位"，所有条件必须同时满足才进入该档位
- 例如：`input > 200K AND output > 50K` 才触发某个特殊定价
- 如果需要 OR，可以拆成多个同优先级的层级

### 6.4 定价层级的优先级排序

**为什么优先级数字越小越先匹配？**

- 类似 CSS `z-index` 的直觉
- 更具体的条件应该给更高优先级（更小的数字）
- 默认层级始终是最后 fallback（优先级通常为 0）

---

## 第七部分：完整的失败/回退路径分析（新增！）

这是本报告的核心补充章节，详细分析所有异常分支的处理逻辑。

### 7.1 异常路径总览图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    成本估算完整失败/回退路径                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  START → 模型匹配 → 定价层级匹配 → Token估算 → 成本计算 → END            │
│           ↓ 失败         ↓ 失败         ↓ 失败        ↓ 部分字段        │
│        model=null     使用默认层级   usage={}     部分字段undefined      │
│                                                                         │
│  所有失败都是"优雅降级"，从不抛出异常中断管线！                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.2 路径 1：模型未匹配

**触发条件**：
- 用户提供的 `modelName` 无法通过正则匹配到任何 model
- 或 Redis/PG 查询异常

**代码位置**：`modelMatch.ts: findModel()`

**回退行为**：
```typescript
return {
  model: null,        // ← 关键！返回 null 而不是抛出
  pricingTiers: [],   // ← 空数组
  source: "none"
};
```

**下游影响**：
```typescript
// 在 calculateUsageAndCosts 中：
if (internalModel) {  // ← internalModel 是 null，这个块不会执行
  // 不会调用 findPricingTiersForModel
  // 不会调用 matchPricingTier
  // modelPrices 保持 undefined
}

// 最终 calculateUsageCosts 收到的 modelPrices = undefined
// → 不会有任何自动计算的成本项
```

**最终落库结果**：
```
internal_model_id: undefined
usage_pricing_tier_id: undefined
usage_pricing_tier_name: undefined
cost_details: {} （如果用户也没提供成本）
total_cost: undefined
```

### 7.3 路径 2：定价层级匹配失败

**触发条件**：
- 模型存在，但没有任何定价层级
- 或所有条件层级都不匹配，且没有默认层级

**代码位置**：`pricing-tiers/matcher.ts: matchPricingTier()`

**回退行为**：
```typescript
const defaultTier = tiers.find(tier => tier.isDefault);
return defaultTier ? { ... } : null;  // ← 无默认层级返回 null
```

**下游影响**：
```typescript
const matchedTier = matchPricingTier(...);
if (matchedTier) {  // ← matchedTier 是 null，这个块不会执行
  // modelPrices 保持 undefined
}
```

**注意**：实际上这种情况很少发生——Langfuse 确保每个内置模型都有默认层级。自定义模型可能因为数据迁移问题缺失默认层级。

### 7.4 路径 3：Token 估算失败（5 个子路径）

**子路径 3a：未识别的 Tokenizer ID**

```typescript
// tokenCount() 函数：
if (p.model.tokenizerId === "openai") { /* ... */ }
else if (p.model.tokenizerId === "claude") { /* ... */ }
else if (p.model.tokenizerId) {
  logger.error(`Unknown tokenizer ${p.model.tokenizerId}`);
}
return undefined;  // ← 关键：静默返回 undefined
```

**子路径 3b：Tokenizer 配置无效**

```typescript
const config = OpenAiTokenConfig.safeParse(p.model.tokenizerConfig);
if (!config.success) {
  logger.warn(`Invalid tokenizer config for model ${p.model.id}: ...`);
  return undefined;  // ← Zod 解析失败直接返回
}
```

**子路径 3c：观察状态是 ERROR**

```typescript
// getUsageUnits() 前置条件检查：
if (model &&
    Object.keys(providedUsageDetails).length === 0 &&
    observationRecord.level !== ObservationLevel.ERROR  // ← ERROR 状态跳过
) {
  // Token 估算逻辑不会执行
}
```

> **设计理由**：ERROR 状态的 Generation 通常没有有效的 output，进行 Token 估算没有意义。

**子路径 3d：Token Count 抛出异常**

```typescript
try {
  // 各种 Token 估算逻辑
} catch (error) {
  traceException(error);
  logger.error(`Tokenization failed for observation ${observationRecord.id}...`);
  return {  // ← 捕获异常后返回空对象
    usage_details: {},
    provided_usage_details: providedUsageDetails,
  };
}
```

**子路径 3e：部分字段估算成功，部分失败**

```typescript
// 例如 input 估算成功 100 tokens，output 估算失败返回 undefined
const usage_details = {
  input: 100,         // ← 成功
  // output: undefined ← 不存在这个键
  total: 100          // ← 只累加成功的字段
};
```

### 7.5 路径 4：用户提供部分成本字段

这是最复杂的回退逻辑，**7 种组合场景详解**。

**核心公式再确认**（`IngestionService/index.ts:1300-1306`）：
```typescript
const finalTotalCost =
  provided_cost_details?.["total"] ??
  // 关键：只要所有提供的键都在 {input, output} 中（即使只有一个），就进入推导
  (providedCostKeys.every((key) => ["input", "output"].includes(key))
    ? (provided_cost_details?.["input"] ?? 0) + (provided_cost_details?.["output"] ?? 0)
    : undefined);
```

> **修正后的理解**：`every()` 检查的是"用户提供的所有键是否都在白名单中"，而不是"用户必须提供所有白名单键"。

---

#### 场景 4.1：只提供 input，不提供 output/total

**输入**：
```typescript
provided_cost_details = { input: 0.01 }
```

**处理逻辑**：
```typescript
providedCostKeys = ["input"]

// 检查：用户提供的所有键是否都在 {input, output} 中？
providedCostKeys.every(key => ["input", "output"].includes(key))
// → ["input"].every(...) = true ✅

// 推导公式：input ?? 0 + output ?? 0
finalTotalCost = 0.01 + 0 = 0.01
```

**输出**：
```typescript
{
  cost_details: { input: 0.01, total: 0.01 },  // ← total 被自动写回！
  total_cost: 0.01
}
```

> **关键点**：只提供 input 时，系统会推导 total = input，并写回 cost_details.total。之前的"undefined"结论是错误的。

---

#### 场景 4.2：只提供 output，不提供 input/total

**输入**：
```typescript
provided_cost_details = { output: 0.02 }
```

**处理逻辑**：
```typescript
providedCostKeys = ["output"]

// 检查：output 在白名单中 → true
finalTotalCost = 0 + 0.02 = 0.02
```

**输出**：
```typescript
{
  cost_details: { output: 0.02, total: 0.02 },  // ← total 被自动写回！
  total_cost: 0.02
}
```

---

#### 场景 4.3：只提供 total，不提供 input/output

**输入**：
```typescript
provided_cost_details = { total: 0.03 }
```

**处理逻辑**：
```typescript
providedCostKeys = ["total"]

// 检查：total 不在 {input, output} 白名单中 → false
finalTotalCost = provided_cost_details["total"] ?? (false ? ... : undefined)
// → 0.03（直接使用用户提供的 total，不进入推导分支）
```

**输出**：
```typescript
{
  cost_details: { total: 0.03 },
  total_cost: 0.03
}
```

---

#### 场景 4.4：提供 input + output，不提供 total

**输入**：
```typescript
provided_cost_details = { input: 0.01, output: 0.02 }
```

**处理逻辑**：
```typescript
providedCostKeys = ["input", "output"]

// 检查：所有键都在白名单中 → true
finalTotalCost = 0.01 + 0.02 = 0.03
```

**输出**：
```typescript
{
  cost_details: { input: 0.01, output: 0.02, total: 0.03 },
  total_cost: 0.03
}
```

---

#### 场景 4.5：提供 input + total，不提供 output

**输入**：
```typescript
provided_cost_details = { input: 0.01, total: 0.03 }
```

**处理逻辑**：
```typescript
providedCostKeys = ["input", "total"]

// 检查：total 不在白名单中 → false
// 不会进入推导分支，直接使用用户提供的 total
finalTotalCost = 0.03
```

**输出**：
```typescript
{
  cost_details: { input: 0.01, total: 0.03 },  // ← output 不会被反推
  total_cost: 0.03
}
```

> **设计原则**：output 字段不会从 total - input 反推——系统不会做任何"智能"反向推导。

---

#### 场景 4.6：提供 output + total，不提供 input

类似场景 4.5，input 保持 undefined。

---

#### 场景 4.7：提供非标准字段（如 search、rag 等）

**输入**：
```typescript
provided_cost_details = { input: 0.01, search: 0.005 }
```

**处理逻辑**：
```typescript
providedCostKeys = ["input", "search"]

// 检查：search 不在 {input, output} 白名单中 → false
finalTotalCost = undefined  // ← 不会推导 total
```

**输出**：
```typescript
{
  cost_details: { input: 0.01, search: 0.005 },  // ← 非标准字段原样保留
  total_cost: undefined
}
```

> **设计优点**：系统支持任意自定义成本字段，不会因为字段不认识就拒绝或报错。

---

### 7.6 提供字段组合真值表（新增！）

以下是所有 12 种可能输入组合的完整真值表，逐条对齐源码分支：

| # | 提供的字段 | every() 检查结果 | finalTotalCost 计算 | cost_details 最终字段 | total_cost |
|---|-----------|-----------------|---------------------|---------------------|-----------|
| 1 | 无（空对象） | 不进入分支 | 走自动计算模式 | 取决于自动计算 | 取决于自动计算 |
| 2 | `{ input }` | **true** | input + 0 = input | `{ input, total }` | input |
| 3 | `{ output }` | **true** | 0 + output = output | `{ output, total }` | output |
| 4 | `{ total }` | false（total 不在白名单） | 直接取 total | `{ total }` | total |
| 5 | `{ input, output }` | **true** | input + output | `{ input, output, total }` | input+output |
| 6 | `{ input, total }` | false（total 不在白名单） | 直接取 total | `{ input, total }` | total |
| 7 | `{ output, total }` | false（total 不在白名单） | 直接取 total | `{ output, total }` | total |
| 8 | `{ input, output, total }` | **true** | 直接取用户提供的 total | `{ input, output, total }` | total |
| 9 | `{ search }` | false | undefined | `{ search }` | undefined |
| 10 | `{ input, search }` | false | undefined | `{ input, search }` | undefined |
| 11 | `{ output, search }` | false | undefined | `{ output, search }` | undefined |
| 12 | `{ total, search }` | false（但有 total） | 直接取 total | `{ total, search }` | total |

**核心规则提炼**：
1. **白名单原则**：只有当用户提供的**所有**字段都在 `{input, output}` 中时，才会进入 total 推导分支
2. **优先原则**：用户提供的 total 优先级永远最高，只要提供了就直接使用，不会被覆盖
3. **非侵入原则**：非标准字段（如 search、rag 等）原样保留，系统不会修改或删除

### 7.6 路径 5：部分 usage 字段匹配到价格，部分没匹配

**触发条件**：
- usage_details 有 input、output、total
- 但 modelPrices 中只有 input 的价格，没有 output 的价格

**处理逻辑**：
```typescript
for (const [key, units] of Object.entries(usageUnits)) {
  const price = modelPrices?.find(p => p.usageType === key);

  if (units != null && price) {  // ← 只有两个条件都满足才计算
    finalCostEntries.push([key, price.price.mul(units).toNumber()]);
  }
}
```

**示例**：
```typescript
usageUnits = { input: 100, output: 200 }
modelPrices = [ { usageType: "input", price: 0.0001 } ]  // ← 没有 output 的价格

// 计算结果：
finalCostEntries = [ ["input", 0.01] ]  // ← 只有 input 被计算
finalCostDetails = { input: 0.01 }

// 推导 total：
finalTotalCost = 0.01  // ← 只累加已计算的字段
finalCostDetails.total = 0.01
```

**最终输出**：
```typescript
{
  cost_details: { input: 0.01, total: 0.01 },  // ← output 不存在
  total_cost: 0.01
}
```

> **关键点**：total 只累加**成功计算**的字段，而不是 usage 中所有字段。

### 7.7 失败路径总结表（修正版，带前置条件和示例引用）

| 失败场景 | 回退行为 | 最终结果特征（分情况） |
|----------|----------|------------------------|
| **模型未匹配** | internalModel = null，跳过定价和自动成本计算 | **用户未提供 cost**：`internal_model_id = undefined`，成本字段 undefined<br>**用户提供了 cost**：原样保留用户的 cost，按真值表规则推导 total<br>**→ 完整端到端示例见 [第 8.10 节** |
| **定价层级无默认** | matchedTier = null，modelPrices = undefined | **用户未提供 cost**：`usage_pricing_tier_id = undefined`，成本字段 undefined<br>**用户提供了 cost**：原样保留用户的 cost，不受定价层级影响 |
| **Tokenizer ID 未知** | tokenCount() 返回 undefined | **用户未提供 usage**：`usage_details` 对应字段不存在<br>**用户提供了 usage**：原样保留用户的 usage |
| **Tokenizer 配置无效** | tokenCount() 返回 undefined | **用户未提供 usage**：`usage_details` 对应字段不存在<br>**用户提供了 usage**：原样保留用户的 usage |
| **观察状态是 ERROR** | 跳过 Token 估算 | **用户未提供 usage**：`usage_details` 全部 undefined<br>**用户提供了 usage**：原样保留用户的 usage |
| **Token 估算抛出异常** | 捕获异常，返回空 usage | **用户未提供 usage**：`usage_details = {}`<br>**用户提供了 usage**：原样保留用户的 usage |
| **用户提供部分成本字段** | 放弃所有自动计算，仅在白名单内推导 total | **every() 通过**：推导 total 并写回<br>**every() 不通过**：不推导 total，用户提供的字段原样保留<br>**→ 真值表见 [第 7.6 节]** |
| **部分 usage 无对应价格** | 只计算能找到价格的字段 | **成功匹配价格的字段**：计算成本<br>**未匹配价格的字段**：成本字段缺失<br>**total**：只累加成功计算的字段成本 |

> **核心原则**：用户提供的数据永远是"一等公民"，无论系统内部发生任何失败，用户数据都会被完整保留，不会被覆盖或清除。

---

## 第八部分：端到端完整示例（新增！）

以下是一个从 API 输入到 ClickHouse 落库的真实完整示例，包含各种边界情况。

### 8.1 场景设定

**用户 API 输入**：
```json
{
  "id": "gen-abc123",
  "traceId": "trace-xyz789",
  "type": "GENERATION",
  "name": "test-generation",
  "startTime": "2024-05-15T10:00:00.000Z",
  "model": "gpt-4-turbo",
  "input": [{
    "role": "system",
    "content": "You are a helpful assistant."
  }, {
    "role": "user",
    "content": "Hello, how are you?"
  }],
  "output": "I'm doing well! How can I help you today?",
  "usage": {
    "input": 100,
    // ← 用户故意不提供 output tokens
    "total": 150
  },
  "cost": {
    // ← 用户不提供任何成本字段，让 Langfuse 自动计算
  }
}
```

**数据库中模型配置**：
```typescript
// gpt-4-turbo 模型配置
{
  id: "model-gpt4-001",
  model_name: "gpt-4-turbo",
  match_pattern: "(?i)^gpt-4-turbo",
  tokenizer_id: "openai",
  tokenizer_config: {
    tokenizerModel: "gpt-4",
    tokensPerMessage: 3,
    tokensPerName: 1
  },
  pricing_tiers: [
    {
      id: "tier-standard",
      name: "Standard",
      isDefault: true,
      priority: 0,
      conditions: [],
      prices: [
        { usageType: "input", price: 0.01 },    // $0.01 per 1k tokens
        { usageType: "output", price: 0.03 },   // $0.03 per 1k tokens
      ]
    }
  ]
}
```

---

### 8.2 步骤 1：模型匹配

**执行**：`findModel({ projectId: "proj-123", model: "gpt-4-turbo" })`

**结果**：
- L1 缓存未命中 → L2 Redis 未命中 → PostgreSQL 查询
- 正则 `(?i)^gpt-4-turbo` 匹配成功
- 返回完整的 Model 对象 + pricingTiers

**中间状态**：
```typescript
internalModel = { id: "model-gpt4-001", tokenizer_id: "openai", ... }
```

---

### 8.3 步骤 2：获取 Usage Units

**执行**：`getUsageUnits(observationRecord, internalModel)`

**阶段 A：处理用户提供的 usage**
```typescript
providedUsageDetails = {
  input: 100,   // ← 来自 API input.usage
  total: 150,   // ← 来自 API input.usage
  // 注意：用户没提供 output！
}
```

**阶段 B：前置条件检查**
```typescript
Object.keys(providedUsageDetails).length === 0
// → 2 > 0 → 不进行自动 Token 估算！
```

> **关键**：即使用户只提供了部分 usage 字段，也会完全跳过自动估算，不会去估算缺失的 output 字段。

**阶段 F：推导 total（如果需要）**
```typescript
// 用户已经提供了 total，不需要推导
usageDetails = { input: 100, total: 150 }
```

**中间状态**：
```typescript
usage_details = { input: 100, total: 150 }
// 注意：output 不存在！
```

---

### 8.4 步骤 3：定价层级匹配

**执行**：`matchPricingTier(pricingTiers, usage_details)`

**结果**：
- 唯一的层级是默认层级，无条件匹配
- 返回 Standard 层级的价格

**中间状态**：
```typescript
modelPrices = [
  { usageType: "input", price: new Decimal(0.01) },
  { usageType: "output", price: new Decimal(0.03) }
]
```

---

### 8.5 步骤 4：成本计算

**执行**：`calculateUsageCosts(modelPrices, observationRecord, usage_details)`

**阶段 1：用户提供成本检查**
```typescript
providedCostKeys = Object.keys(provided_cost_details ?? {})
// → [] （空数组，用户没提供任何成本）
// → 不进入用户提供优先模式，继续自动计算
```

**阶段 2：自动计算**
```typescript
// 遍历 usage_details 的键
for (const [key, units] of Object.entries({ input: 100, total: 150 })) {

  // key = "input":
  const price_input = modelPrices.find(p => p.usageType === "input");
  // → 找到：price = 0.01
  finalCostEntries.push(["input", 0.01 * 100]);  // → 1.0

  // key = "total":
  const price_total = modelPrices.find(p => p.usageType === "total");
  // → 没找到！modelPrices 里没有 total 的价格
  // → 跳过
}
```

> **关键点**：total 的价格不存在！（大多数模型按 input/output 定价，不是按 total 定价）

**阶段 3：推导 total_cost**
```typescript
finalCostDetails = { input: 1.0 }

// 检查是否有 total 字段？→ 没有
// 检查是否有已计算的成本项？→ 有（input）
finalTotalCost = [["input", 1.0]].reduce((acc, [_, c]) => acc + c, 0)
// → 1.0

finalCostDetails.total = 1.0;  // ← 自动添加 total
```

**最终输出**：
```typescript
{
  cost_details: {
    input: 1.0,    // ← 计算成功
    // output 不存在！（因为 usage_details 里就没有 output）
    total: 1.0     // ← 只累加了 input 的成本
  },
  total_cost: 1.0
}
```

---

### 8.6 最终落库结果（ClickHouse observations_table）

```typescript
{
  // 基础字段
  id: "gen-abc123",
  trace_id: "trace-xyz789",
  type: "GENERATION",
  model: "gpt-4-turbo",

  // 模型匹配结果
  internal_model_id: "model-gpt4-001",
  usage_pricing_tier_id: "tier-standard",
  usage_pricing_tier_name: "Standard",

  // Usage 字段（用户提供 + 系统推导）
  provided_usage_details: {
    input: 100,
    total: 150
  },
  usage_details: {
    input: 100,
    total: 150
    // 注意：output 不存在！
  },

  // 成本字段
  provided_cost_details: {},
  cost_details: {
    input: 1.0,
    total: 1.0
    // 注意：output 不存在！
  },
  total_cost: 1.0,

  // 其他字段...
  input: [{ role: "system", content: "..." }, ...],
  output: "I'm doing well!...",
}
```

---

### 8.7 字段缺失说明

**Q：为什么 output 在最终结果中不存在？**

**A：因为经过了两次"过滤"：**
1. **Usage 层面**：用户没提供 output tokens，且因为用户提供了部分 usage，系统不会自动估算 output tokens
2. **成本层面**：usage_details 里没有 output 字段，循环时不会处理到它，自然也就不会有 output_cost

**Q：为什么 total_cost 是 1.0 而不是 1.5（100×0.01 + 50×0.03）？**

**A：因为 total 只累加**成功计算**的字段。output 字段在 usage_details 里不存在，自然不会被计算到成本里。

> **设计哲学**：不猜测、不推断、不做"智能补全"。缺失就是缺失，系统不会假设 output = total - input。

---

### 8.8 如果用户没提供任何 usage（完全自动模式）

作为对比，如果用户的 API 输入是：

```json
{
  "usage": {},  // ← 完全不提供 usage
  "cost": {}
}
```

那么流程会是：
1. **自动 Token 估算**：
   - input 文本 → 估算得 42 tokens
   - output 文本 → 估算得 18 tokens
   - total = 42 + 18 = 60 tokens
2. **成本计算**：
   - input_cost = 42 × 0.01 = 0.42
   - output_cost = 18 × 0.03 = 0.54
   - total_cost = 0.42 + 0.54 = 0.96
3. **最终落库**：
   ```typescript
   usage_details: { input: 42, output: 18, total: 60 }
   cost_details: { input: 0.42, output: 0.54, total: 0.96 }
   total_cost: 0.96
   ```

---

### 8.9 补充示例：仅填 input_cost（用户提供部分成本字段）

**用户 API 输入**：
```json
{
  "id": "gen-def456",
  "traceId": "trace-xyz789",
  "model": "gpt-4-turbo",
  "input": [{ "role": "user", "content": "Hello" }],
  "output": "Hi there!",
  "usage": {
    "input": 10,
    "output": 3,
    "total": 13
  },
  "cost": {
    "input": 0.0001  // ← 只提供 input_cost！
  }
}
```

**数据库模型配置**（与前面相同）：
- input: $0.01 per 1k tokens
- output: $0.03 per 1k tokens

---

#### 步骤 1：模型匹配

成功匹配 `gpt-4-turbo` 模型。

---

#### 步骤 2：获取 Usage Units

用户完整提供了所有 usage 字段，跳过自动估算。

```typescript
usage_details = { input: 10, output: 3, total: 13 }
```

---

#### 步骤 3：定价层级匹配

成功匹配 Standard 层级价格。

```typescript
modelPrices = [
  { usageType: "input", price: new Decimal(0.01) },
  { usageType: "output", price: new Decimal(0.03) }
]
```

---

#### 步骤 4：成本计算（关键！只提供了 input_cost）

**执行**：`calculateUsageCosts(modelPrices, observationRecord, usage_details)`

```typescript
// 阶段 1：用户提供成本检查
const providedCostKeys = Object.entries({ input: 0.0001 })
  .filter(([_, v]) => v != null)
  .map(([k]) => k);
// → ["input"] （长度 > 0，进入用户提供优先模式）

// 阶段 2：every() 白名单检查
providedCostKeys.every((key) => ["input", "output"].includes(key));
// → ["input"].every(...) = true ✅ （input 在白名单中）

// 阶段 3：推导 total
const finalTotalCost =
  provided_cost_details?.["total"] ??
  (true ? (provided_cost_details?.["input"] ?? 0) + (provided_cost_details?.["output"] ?? 0) : undefined);
// → undefined ?? (0.0001 + 0) = 0.0001

// 阶段 4：写回 total 到 cost_details
if (!cost_details.hasOwnProperty("total") && finalTotalCost != null) {
  cost_details.total = finalTotalCost;
}
// → cost_details = { input: 0.0001, total: 0.0001 }  ← total 被自动写回！
```

---

#### 最终落库结果（ClickHouse）

```typescript
{
  id: "gen-def456",
  trace_id: "trace-xyz789",
  model: "gpt-4-turbo",

  internal_model_id: "model-gpt4-001",
  usage_pricing_tier_name: "Standard",

  // Usage 字段（用户完整提供）
  provided_usage_details: { input: 10, output: 3, total: 13 },
  usage_details: { input: 10, output: 3, total: 13 },

  // 成本字段（关键！）
  provided_cost_details: { input: 0.0001 },
  cost_details: {
    input: 0.0001,
    total: 0.0001  // ← total 被系统自动推导并写回！
    // 注意：output 字段不存在！因为用户只提供了 input
  },
  total_cost: 0.0001,

  input: [{ "role": "user", "content": "Hello" }],
  output: "Hi there!",
}
```

> **关键点**：
> 1. 用户只提供了 `input` 成本，但 total 被自动推导并写回
> 2. `output` 成本字段保持缺失（不会用 tokens × 单价自动计算）
> 3. total_cost = input_cost，与真值表第 2 行完全一致

---

### 8.10 补充示例：模型未匹配但用户已提供 cost（新增！）

这是最容易被误解的场景：系统内部模型匹配失败，但用户数据仍然完整保留。

**用户 API 输入**：
```json
{
  "id": "gen-ghi789",
  "traceId": "trace-abc123",
  "model": "my-custom-model-v2",  // ← 这个模型 Langfuse 不认识！
  "input": [{ "role": "user", "content": "Translate to French" }],
  "output": "Traduire en français",
  "usage": {
    "input": 50,
    "output": 25,
    "total": 75
  },
  "cost": {
    "input": 0.0005,  // ← 用户自己提供了准确的成本
    "output": 0.00075
  }
}
```

---

#### 步骤 1：模型匹配（失败！）

**执行**：`findModel({ projectId, model: "my-custom-model-v2" })`

**结果**：
```typescript
// 数据库中没有匹配这个模型名的正则
internalModel = null;  // ← 模型未匹配！
```

> **关键观察**：模型匹配失败只是意味着"系统不知道如何自动计算成本"，但不会中断整个 ingestion 流程。

---

#### 步骤 2：获取 Usage Units（不受影响！）

用户完整提供了所有 usage 字段，跳过自动估算。

```typescript
usage_details = { input: 50, output: 25, total: 75 }
```

> **关键点**：模型未匹配不影响用户提供的 usage 数据——用户数据原封不动保留。

---

#### 步骤 3：定价层级匹配（直接跳过！）

```typescript
if (internalModel) {  // ← internalModel 是 null，这个块不会执行！
  // 不会调用 findPricingTiersForModel
  // 不会调用 matchPricingTier
}
modelPrices = undefined;
```

---

#### 步骤 4：成本计算（用户提供优先，不受模型未匹配影响！）

**执行**：`calculateUsageCosts(undefined, observationRecord, usage_details)`

```typescript
// 阶段 1：用户提供成本检查
const providedCostKeys = Object.entries({ input: 0.0005, output: 0.00075 })
  .filter(([_, v]) => v != null)
  .map(([k]) => k);
// → ["input", "output"] （长度 > 0，进入用户提供优先模式）

// 阶段 2：every() 白名单检查
providedCostKeys.every((key) => ["input", "output"].includes(key));
// → true ✅ （两个字段都在白名单中）

// 阶段 3：推导 total
const finalTotalCost =
  provided_cost_details?.["total"] ??
  (true ? 0.0005 + 0.00075 : undefined);
// → undefined ?? 0.00125 = 0.00125

// 阶段 4：写回 total 到 cost_details
cost_details = { input: 0.0005, output: 0.00075, total: 0.00125 }
```

> **震惊但正确**：即使模型未匹配，用户提供的成本字段仍然被完整保留，并且 total 仍然被正确推导！

---

#### 最终落库结果（ClickHouse）

```typescript
{
  id: "gen-ghi789",
  trace_id: "trace-abc123",
  model: "my-custom-model-v2",

  // 模型匹配相关字段（确实是 undefined）
  internal_model_id: undefined,        // ← 模型未匹配
  usage_pricing_tier_id: undefined,
  usage_pricing_tier_name: undefined,

  // Usage 字段（完整保留！）
  provided_usage_details: { input: 50, output: 25, total: 75 },
  usage_details: { input: 50, output: 25, total: 75 },  // ← 不受影响！

  // 成本字段（完整保留 + total 自动推导！）
  provided_cost_details: { input: 0.0005, output: 0.00075 },
  cost_details: {
    input: 0.0005,
    output: 0.00075,
    total: 0.00125  // ← 即使模型未匹配，total 仍然被推导并写回！
  },
  total_cost: 0.00125,  // ← 成本计算不受模型未匹配影响！

  input: [{ "role": "user", "content": "Translate to French" }],
  output: "Traduire en français",
}
```

---

#### 这个示例揭示的 3 个深层设计原则

1. **失败隔离原则**：模型匹配是一个可选功能，失败不会污染或删除用户已提供的数据
2. **用户数据主权原则**：用户提供的 usage 和 cost 是"源数据"，系统不会因为自身计算能力不足而丢弃
3. **优雅降级的本质**：不是"全部成功或全部失败"，而是"能算多少算多少，不能算的原样保留"

> **架构师视角**：这是一个非常优秀的容错设计。即使 Langfuse 缺少某个模型的定价配置，用户仍然可以通过 API 自己提供成本数据，系统不会因为"不认识这个模型"就拒绝 ingestion 或丢弃数据。

---

## 第九部分：调试与故障排查

### 9.1 常见问题排查路径

**问题 1：成本是 undefined**
1. 检查 `internal_model_id` 是否为 undefined → 模型匹配失败
2. 检查模型的 `match_pattern` 正则是否正确
3. 检查 Redis 缓存是否有该模型的"未找到"标记

**问题 2：成本计算值不正确**
1. 检查 `usage_details` 的 token 数量是否正确
2. 检查匹配到的 `usage_pricing_tier_name` 是否符合预期
3. 检查 `provided_cost_details` 是否被意外设置（优先级高于自动计算）

**问题 3：大上下文定价未生效**
1. 检查 `usage_details.input_tokens` 是否确实超过阈值
2. 检查定价层级的 `conditions.usageDetailPattern` 是否匹配键名（如 `input` vs `input_tokens`）
3. 检查层级 `priority` 排序是否正确

**问题 4：部分成本字段缺失**
1. 检查 `provided_cost_details` 是否有任何字段（有 → 自动计算被跳过）
2. 检查 `usage_details` 里对应的字段是否存在
3. 检查 `modelPrices` 里是否有对应的 `usageType` 价格

### 9.2 日志调试关键字

```typescript
// modelMatch.ts 调试日志
logger.debug(`Model match resolved`, {
  projectId, model, source, matchedModelId,
  matchedModelName, pricingTierCount
});

// Tokenizer 错误日志
logger.error(`Unknown tokenizer ${tokenizerId}`);
logger.warn(`Invalid tokenizer config for model ${modelId}: ...`);
logger.error(`Tokenization failed for observation ${observationId}...`);

// IngestionService 成本调试日志
logger.debug(`Calculated costs and usage`, {
  cost: final_cost_details.cost_details,
  usage: final_usage_details.usage_details,
  pricingTier: usage_pricing_tier_name,
});
```

### 9.3 缓存清理命令

```typescript
// 清理单个项目的模型缓存
await clearModelCacheForProject(projectId);

// 清理全部缓存（worker 启动时自动调用）
await clearFullModelCache();
```

---

## 附录：核心常量与配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LANGFUSE_LOCAL_CACHE_MODEL_MATCH_ENABLED` | true | L1 本地缓存开关 |
| `LANGFUSE_LOCAL_CACHE_MODEL_MATCH_TTL_MS` | 10000 | L1 TTL（毫秒） |
| `LANGFUSE_LOCAL_CACHE_MODEL_MATCH_MAX` | 20000 | L1 最大条目数 |
| `LANGFUSE_CACHE_MODEL_MATCH_ENABLED` | true | L2 Redis 缓存开关 |
| `LANGFUSE_CACHE_MODEL_MATCH_TTL_SECONDS` | - | L2 TTL（秒） |

### Tokenizer 配置示例

```json
{
  "gpt-4o": {
    "tokenizer_id": "openai",
    "tokenizer_config": {
      "tokenizerModel": "gpt-4o",
      "tokensPerMessage": 3,
      "tokensPerName": 1
    }
  },
  "claude-3-5-sonnet": {
    "tokenizer_id": "claude"
  }
}
```

---

## 总结

Langfuse 的成本估算管线是一个设计精良的三层架构，核心设计原则可以用三句话概括：

1. **优雅降级**：任何步骤失败都不会中断管线，只会返回空值或部分结果
2. **用户优先**：一旦用户提供了任何数据（usage 或 cost），立即停止所有自动计算
3. **不猜测不推断**：缺失就是缺失，系统不会做任何"智能"补全或反推

这种设计确保了管线的健壮性——即使在部分数据缺失或组件失败时，也能尽可能多地保存有效数据，而不是整体崩溃。但同时也意味着：**部分字段缺失是正常现象，不是 Bug**。理解这些回退路径，才能正确解释最终落库的数据。
