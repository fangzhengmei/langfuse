# Langfuse 成本估算管线完整技术解析

## 概述

Langfuse 的成本估算管线是一个三段式处理流程：**模型匹配** → **定价层级匹配** → **Token 估算与成本计算**。该管线负责为每条 LLM 调用追踪记录匹配正确的模型定价，估算 Token 使用量，并最终累加计算出调用成本。

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
  const config = OpenAiTokenConfigSchema.parse(params.model.tokenizerConfig);
  
  // 对于 Chat 消息数组，使用特殊公式
  if (isChatMessageArray(parsedText) && isChatModel(config.tokenizerModel)) {
    return openAiChatTokenCount({ messages: parsedText, config });
  }
  
  // 对于普通文本，直接使用 tiktoken
  return getTokensByModel(config.tokenizerModel, parsedText);
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
  cachedTokenizerByModel[model] = 
    cachedTokenizerByModel[model] || encoding_for_model(model);
  
  // Unicode 安全转换（处理 Emoji 等多字节字符）
  const cleanedText = unicodeToBytesInString(text);
  
  return cachedTokenizerByModel[model].encode(cleanedText, "all").length;
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
        ? (provided_cost_details?.["input"] ?? 0) + 
          (provided_cost_details?.["output"] ?? 0)
        : undefined);

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

### 5.3 数据流向

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

## 第七部分：调试与故障排查

### 7.1 常见问题排查路径

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

### 7.2 日志调试关键字

```typescript
// modelMatch.ts 调试日志
logger.debug(`Model match resolved`, {
  projectId, model, source, matchedModelId,
  matchedModelName, pricingTierCount
});

// IngestionService 成本调试日志
logger.debug(`Calculated costs and usage`, {
  cost: final_cost_details.cost_details,
  usage: final_usage_details.usage_details,
  pricingTier: usage_pricing_tier_name,
});
```

### 7.3 缓存清理命令

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

Langfuse 的成本估算管线是一个设计精良的三层架构：

1. **模型匹配层**：通过正则 + 多级缓存实现高性能的模型识别
2. **定价层级层**：支持复杂的条件定价，适配不同 LLM 提供商的定价策略
3. **Token 估算层**：精确的 Token 计数逻辑，实现 provider 级别的估算器

三者通过 `calculateUsageAndCosts` 方法无缝整合，最终输出准确的成本数据，为用户提供 LLM 成本可观测性。
