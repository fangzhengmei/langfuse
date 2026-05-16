# Langfuse OTEL ForbiddenError 重试行为最终报告

**日期**: 2026-05-16  
**范围**: OTEL 管线所有异常分支的完整重试行为

---

## 一、层级 1: OtelIngestionProcessor 内部异常去向

**代码位置**: `packages/shared/src/server/otel/OtelIngestionProcessor.ts:578-588`

```typescript
} catch (error) {
  // 分支 A: ForbiddenError
  if (error instanceof ForbiddenError) {
    traceException(error, span);
    throw error;        // ➡️ 重新抛到 Worker 外层
  }

  // 分支 B: Processor 内部的其他异常
  logger.error("Error processing OTEL spans:", error);
  traceException(error, span);
  return [];           // ➡️ 静默继续，返回空数组
}
```

**本层级行为**:

| 异常来源 | 分支条件 | 去向 | 是否触达外层 catch |
|---------|---------|------|-------------------|
| ForbiddenError | `error instanceof ForbiddenError` | throw 重新抛出 | ✅ 是 |
| Processor 内部其他异常 | 否则 | return [] 继续 | ❌ 否 |

---

## 二、层级 2: Worker 外层捕获的异常处理

**代码位置**: `worker/src/queues/otelIngestionQueue.ts:527-544`

```typescript
} catch (e) {
  // 分支 1: 捕获到的是 ForbiddenError
  if (e instanceof ForbiddenError) {
    traceException(e);
    logger.warn(`Failed to parse otel observation: ${e.message}`, { error: e, fileKey });
    return;    // ➡️ 正常结束，不重试
  }

  // 分支 2: 捕获到的是非 Forbidden 异常
  logger.error(`Failed job otel ingestion processing for ${projectId}`, { error: e, fileKey });
  traceException(e);
  throw e;     // ➡️ 触发 BullMQ 重试
}
```

**外层 catch 能捕获的异常来源**（不限于 Processor）：
- S3 下载失败
- Masking 遮蔽处理失败（但它会提前 return，不会走到这里）
- IngestionService 写入失败
- ClickHouse 连接异常
- Redis 操作失败
- 以及整个处理流程中任何未被内部 catch 拦截的异常

**本层级行为**:

| 捕获到的异常类型 | 分支条件 | 最终行为 | BullMQ 重试 |
|----------------|---------|---------|------------|
| ForbiddenError | `e instanceof ForbiddenError` | return 正常结束 | ❌ **不重试** |
| 非 Forbidden 异常 | 否则 | throw e 抛出 | ✅ **重试（最多 6 次）** |

---

## 三、最终结论总表

| 异常类型 | 来源层级 | Processor 内部处理 | Worker 外层处理 | 最终结果 | 是否重试 |
|---------|---------|-------------------|----------------|---------|---------|
| **ForbiddenError** | Processor 内部或其他地方 | throw 重新抛出 | return 正常结束 | ✅ 静默终止 | ❌ **不重试** |
| **Processor 内部其他异常** | 仅 Processor 内部 | return [] 继续 | N/A（不会走到外层） | ✅ 静默继续 | ❌ **不重试** |
| **非 Forbidden 异常（S3/ClickHouse/Redis 等）** | 整个流程其他位置 | N/A | throw e 抛出 | 🔄 异常穿透 | ✅ **重试（6 次指数退避）** |

---

## 四、完整控制流路径图

```
                    OTEL 队列任务开始
                          |
                          ▼
              ┌──────────────────────────┐
              │   整个处理流程 try 块    │
              │  (S3 下载 → Masking →   │
              │   Processor → 写入等)    │
              └───────────┬──────────────┘
                          |
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
  抛出异常                            正常完成
        |                                   |
        ▼                                   ▼
  Worker 外层 catch                    BullMQ 标记完成
        |
  ┌─────┴──────────────────────────┐
  ▼                                ▼
ForbiddenError               非 Forbidden 异常
  |                                |
  ▼                                ▼
return 正常结束                   throw e 抛出
  |                                |
  ▼                                ▼
✅ 静默终止，不重试              ✅ BullMQ 重试 (最多 6 次)
  |
  ┌──────────────────────────────┐
  │ Processor 内部的非 Forbidden  │──────┐
  │     异常被内部 catch 拦截     │      │
  └──────────────────────────────┘      ▼
                                  ✅ return [] 继续，无重试
```

---

## 五、代码索引

| 功能 | 文件路径 | 行号 |
|-----|---------|-----|
| Processor 内部异常分支 | `packages/shared/src/server/otel/OtelIngestionProcessor.ts` | L578-588 |
| Worker 外层异常分支 | `worker/src/queues/otelIngestionQueue.ts` | L527-544 |
| BullMQ 重试参数配置 | `packages/shared/src/server/redis/otelIngestionQueue.ts` | L78-86 |

---

*基于 Langfuse v2.x 代码库，截止 2026-05-16*
