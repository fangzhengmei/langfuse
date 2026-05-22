# 媒体附件入库与短期签名访问链路复盘

## 一、整体架构概览

```
客户端 (SDK/前端)                       Langfuse 后端                     对象存储 (S3/Azure/GCS/OCI)
      |                                     |                                     |
      | 1. 请求上传签名 URL                 |                                     |
      |------------------------------------>|                                     |
      |                                     | 2. 校验权限 + 生成媒体记录          |
      |                                     |    (media 表)                       |
      |                                     | 3. 调用存储服务生成签名上传 URL      |
      |                                     |------------------------------------>|
      |                                     |<------------------------------------|
      | 4. 返回 uploadUrl + mediaId         |                                     |
      |<------------------------------------|                                     |
      |                                     |                                     |
      | 5. 直传文件到签名 URL                |                                     |
      |-------------------------------------------------------------------------->|
      |                                     |                                     | 6. 存储鉴权 (签名验证)
      |                                     |                                     |<---------->|
      | 7. 回调更新上传状态                  |                                     |
      |------------------------------------>|                                     |
      |                                     | 8. 更新 media 表 uploadHttpStatus   |
      |                                     |                                     |
      |-----------------------------------------------------------------------------
      |                                     |                                     |
      | 9. 请求访问媒体 (前端展示)           |                                     |
      |------------------------------------>|                                     |
      |                                     | 10. 校验权限 + 查询 media 表         |
      |                                     | 11. 生成短期签名下载 URL             |
      |                                     |------------------------------------>|
      |                                     |<------------------------------------|
      | 12. 返回 url + urlExpiry             |                                     |
      |<------------------------------------|                                     |
      |                                     |                                     |
      | 13. 访问签名 URL                     |                                     |
      |-------------------------------------------------------------------------->|
      |                                     |                                     | 14. 存储鉴权 (签名验证)
      |                                     |                                     |<---------->|
```

---

## 二、数据库表结构

### 2.1 `media` 表（核心媒体元数据表）

**文件**: `packages/shared/prisma/schema.prisma:1242-1263`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String | 媒体ID，由 SHA256 哈希前22位生成 |
| `sha256Hash` | String(44) | 文件 SHA256 哈希（base64编码），用于去重 |
| `projectId` | String | 项目ID，权限隔离边界 |
| `bucketPath` | String | 对象存储中的完整路径 |
| `bucketName` | String | 存储桶名称 |
| `contentType` | String | MIME类型（如 image/png, video/mp4） |
| `contentLength` | BigInt | 文件大小（字节） |
| `uploadHttpStatus` | Int? | 上传状态（200/201=成功） |
| `uploadHttpError` | String? | 上传错误信息 |
| `uploadedAt` | DateTime? | 上传完成时间 |

**唯一约束**:
- `(projectId, id)` - 按项目的媒体ID唯一
- `(projectId, sha256Hash)` - 按项目的文件哈希唯一，实现去重

### 2.2 `trace_media` 关联表

**文件**: `packages/shared/prisma/schema.prisma:1265-1279`

关联 trace 与 media，支持一个 trace 关联多个媒体。

### 2.3 `observation_media` 关联表

**文件**: `packages/shared/prisma/schema.prisma:1281-1296`

关联 observation 与 media，支持一个 observation 关联多个媒体。`field` 字段标识媒体属于 input/output/metadata。

---

## 三、媒体附件入库流程（上传链路）

### 3.1 步骤1：获取上传签名 URL

**接口**: `POST /api/public/media`

**文件**: `web/src/pages/api/public/media/index.ts`

**请求参数**:
```typescript
{
  traceId: string;           // 关联的trace ID
  observationId?: string;    // 关联的observation ID（可选）
  contentType: MediaContentType;  // MIME类型
  contentLength: number;     // 文件大小（字节）
  sha256Hash: string;        // 文件SHA256哈希（44字符base64）
  field: "input" | "output" | "metadata";  // 所属字段
}
```

**核心逻辑**:
1. **权限校验**: 通过 `createAuthedProjectAPIRoute` 验证 API key 权限
2. **去重检查**: 按 `(projectId, sha256Hash)` 查询是否已存在相同文件
   - 若已存在且上传成功，直接返回 mediaId，无需重复上传
3. **生成 mediaId**: 取 SHA256 哈希前22位（132 bits），转换为 URL-safe base64
   ```typescript
   // web/src/pages/api/public/media/index.ts:223-231
   function getMediaId(params: { sha256Hash: string }) {
     const urlSafeHash = sha256Hash.replaceAll("+", "-").replaceAll("/", "_");
     return urlSafeHash.slice(0, 22);
   }
   ```
4. **生成存储路径**: `{prefix}{projectId}/{mediaId}.{extension}`
5. **调用存储服务生成签名上传 URL**:
   ```typescript
   // web/src/pages/api/public/media/index.ts:120-126
   const uploadUrl = await s3Client.getSignedUploadUrl({
     path: bucketPath,
     ttlSeconds: 60 * 60,  // 上传URL有效期1小时
     sha256Hash,
     contentType,
     contentLength,
   });
   ```
6. **写入 media 表**: 使用原生 SQL 避免高并发下的死锁，支持重试3次
7. **写入关联表**: `trace_media` 或 `observation_media`

**返回**:
```typescript
{
  mediaId: string;
  uploadUrl: string | null;  // 去重命中时为null
}
```

### 3.2 步骤2：客户端直传对象存储

客户端使用返回的 `uploadUrl` 直接 PUT 文件到对象存储，无需经过 Langfuse 后端。

### 3.3 步骤3：回调更新上传状态

**接口**: `PATCH /api/public/media/[mediaId]`

**文件**: `web/src/pages/api/public/media/[mediaId].ts:71-132`

**请求参数**:
```typescript
{
  uploadedAt: Date;
  uploadHttpStatus: number;   // 200/201=成功，其他=失败
  uploadHttpError?: string;
  uploadTimeMs?: number;
}
```

**核心逻辑**:
1. 校验 media 存在且属于当前项目
2. 更新 media 表的上传状态字段
3. 记录指标（Prometheus）:
   - `langfuse.media.upload_http_status` - 计数
   - `langfuse.media.upload_time_ms` - 直方图

---

## 四、后端颁发签名下载链接

### 4.1 tRPC 路由

**文件**: `web/src/server/api/routers/media.ts`

提供两个查询接口:

#### 4.1.1 `media.getById` - 按媒体ID获取

```typescript
// web/src/server/api/routers/media.ts:17-64
input: { mediaId: string, projectId: string }
return: {
  mediaId: string;
  contentType: string;
  contentLength: number;
  url: string;           // 签名URL
  urlExpiry: string;     // 过期时间ISO字符串
}
```

#### 4.1.2 `media.getByTraceOrObservationId` - 按关联ID批量获取

```typescript
// web/src/server/api/routers/media.ts:65-171
input: { traceId: string, observationId?: string, projectId: string }
return: Array<{
  mediaId: string;
  contentType: string;
  contentLength: number;
  field: "input" | "output" | "metadata";
  url: string;
  urlExpiry: string;
}>
```

### 4.2 核心颁发逻辑

**文件**: `web/src/server/api/routers/media.ts:47-63`

```typescript
const mediaStorageClient = getMediaStorageServiceClient(media.bucketName);
const ttlSeconds = env.LANGFUSE_S3_MEDIA_DOWNLOAD_URL_EXPIRY_SECONDS;  // 默认3600秒
const urlExpiry = new Date(Date.now() + ttlSeconds * 1000).toISOString();

const url = await mediaStorageClient.getSignedUrl(
  media.bucketPath,
  ttlSeconds,
  false,  // asAttachment=false, 浏览器内联显示
);
```

### 4.3 存储服务客户端

**文件**: `web/src/features/media/server/getMediaStorageClient.ts`

单例模式，使用环境变量配置的存储凭据:
- `LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID`
- `LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY`
- `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET`
- `LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT`
- `LANGFUSE_S3_MEDIA_UPLOAD_REGION`

---

## 五、前端续签签名链接机制

### 5.1 前端 Hooks

#### 5.1.1 `useMedia` Hook - 批量获取 trace/observation 媒体

**文件**: `web/src/components/trace/api/useMedia.ts`

```typescript
// web/src/components/trace/api/useMedia.ts:16-33
export function useMedia({ projectId, traceId, observationId }: UseMediaParams) {
  return api.media.getByTraceOrObservationId.useQuery(
    { projectId, traceId, observationId },
    {
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      staleTime: 50 * 60 * 1000,  // 50分钟后视为过期
    },
  );
}
```

#### 5.1.2 `LangfuseMediaView` 组件 - 单个媒体渲染

**文件**: `web/src/components/ui/LangfuseMediaView.tsx:68-80`

```typescript
const { data } = api.media.getById.useQuery(
  { mediaId: mediaData.id, projectId: projectId as string },
  {
    enabled: Boolean(projectId),
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    staleTime: 55 * 60 * 1000,  // 55分钟，略短于URL有效期1小时
  },
);
```

### 5.2 续签机制原理与风险分析

#### 5.2.1 TanStack Query 自动重获取触发条件

根据 TanStack Query 官方文档，stale 数据的自动重获取**仅在以下触发条件发生时**执行:
1. **新的查询实例挂载** (`refetchOnMount`) - 当前配置: `false`
2. **窗口重新获得焦点** (`refetchOnWindowFocus`) - 当前配置: `false`
3. **网络重新连接** (`refetchOnReconnect`) - 当前配置: `false`
4. **配置了定时刷新** (`refetchInterval`) - 当前配置: 未设置

#### 5.2.2 关键问题发现

**⚠️ 风险：当前配置下签名URL过期后不会自动续签！**

| 配置项 | 值 | 影响 |
|--------|----|------|
| `staleTime` | 50-55分钟 | 仅标记数据是否"过时"，不主动触发重获取 |
| `refetchOnMount` | `false` | 组件重新挂载时不重获取 |
| `refetchOnWindowFocus` | `false` | 窗口重获焦点时不重获取 |
| `refetchOnReconnect` | `false` | 网络重连时不重获取 |
| `refetchInterval` | 未设置 | 无定时刷新 |

**场景复现**:
- 用户打开页面，加载媒体（URL有效期60分钟）
- 用户保持页面打开，不切换标签、不刷新、不离开
- 55分钟后，数据标记为 stale，但无触发条件
- 60分钟后，URL实际过期
- 用户点击媒体 → 访问签名URL → 403 Forbidden 错误

#### 5.2.3 修复建议

**方案一：设置 refetchInterval（推荐）**

```typescript
// 每50分钟自动刷新一次，确保URL永远不会过期
staleTime: 50 * 60 * 1000,
refetchInterval: 50 * 60 * 1000,  // 新增：每50分钟自动重获取
refetchIntervalInBackground: true, // 后台静默刷新
```

**方案二：手动检测过期并调用 refetch()**

```typescript
const { data, refetch } = api.media.getById.useQuery(...);

// 在访问URL前检查是否即将过期
const isUrlExpiringSoon = data?.urlExpiry 
  ? new Date(data.urlExpiry).getTime() - Date.now() < 5 * 60 * 1000
  : false;

if (isUrlExpiringSoon) {
  refetch(); // 手动触发重新获取
}
```

**方案三：启用 refetchOnMount（最简单）**

```typescript
refetchOnMount: true,  // 组件挂载时检查并刷新过期数据
```

### 5.3 媒体引用字符串格式

**文件**: `packages/shared/src/utils/IORepresentation/chatML/types.ts:46-90`

媒体在 trace/observation 的 input/output 中以特殊字符串格式引用:

```
@@@langfuseMedia:type=image/jpeg|id=abc123xyz|source=storage@@@
```

解析逻辑使用 `MediaReferenceStringSchema` 进行验证和解析。

---

## 六、对象存储后端鉴权机制

**文件**: `packages/shared/src/server/services/StorageService.ts`

系统支持四种对象存储后端，每种后端有不同的签名鉴权机制。

### 6.1 统一接口

```typescript
// packages/shared/src/server/services/StorageService.ts:88-121
export interface StorageService {
  getSignedUrl(
    fileName: string,
    ttlSeconds: number,
    asAttachment?: boolean,
  ): Promise<string>;

  getSignedUploadUrl(params: {
    path: string;
    ttlSeconds: number;
    sha256Hash: string;
    contentType: string;
    contentLength: number;
  ): Promise<string>;
}
```

### 6.2 AWS S3 签名机制

**文件**: `packages/shared/src/server/services/StorageService.ts:701-792`

使用 **AWS Signature Version 4 (SigV4)**:

```typescript
// S3 下载签名URL
return getSignedUrl(
  this.signedUrlClient,
  new GetObjectCommand({
    Bucket: this.bucketName,
    Key: fileName,
    ResponseContentDisposition: asAttachment 
      ? `attachment; filename="${fileName}"` 
      : undefined,
  }),
  { expiresIn: ttlSeconds },  // 签名有效期
);

// S3 上传签名URL
return getSignedUrl(
  this.signedUrlClient,
  new PutObjectCommand({
    Bucket: this.bucketName,
    Key: path,
    ContentType: contentType,
    ChecksumSHA256: sha256Hash,    // 校验文件完整性
    ContentLength: contentLength,  // 校验文件大小
  }),
  {
    expiresIn: ttlSeconds,
    signableHeaders: new Set(["content-type", "content-length"]),
    unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
  },
);
```

**签名验证**: S3 服务端收到请求后，使用相同的密钥和算法重新计算签名，与URL中的签名对比。

### 6.3 Azure Blob 签名机制

**文件**: `packages/shared/src/server/services/StorageService.ts:409-475`

使用 **Shared Access Signature (SAS)**:

```typescript
const blockBlobClient = this.client.getBlockBlobClient(fileName);
let url = await blockBlobClient.generateSasUrl({
  permissions: BlobSASPermissions.parse("r"),  // 只读权限
  expiresOn: new Date(Date.now() + ttlSeconds * 1000),
  contentDisposition: asAttachment
    ? `attachment; filename="${fileName}"`
    : undefined,
});
```

**SAS Token 包含**:
- `sv` - 签名版本
- `st` - 开始时间
- `se` - 过期时间
- `sr` - 资源类型
- `sp` - 权限
- `sig` - 签名

### 6.4 Google Cloud Storage 签名机制

**文件**: `packages/shared/src/server/services/StorageService.ts:952-1015`

使用 **Signed URL (v4)**:

```typescript
const file = this.bucket.file(fileName);
const options: GetSignedUrlConfig = {
  version: "v4",
  action: "read",
  expires: Date.now() + ttlSeconds * 1000,
};
const [url] = await file.getSignedUrl(options);
```

### 6.5 OCI Object Storage 签名机制

**文件**: `packages/shared/src/server/services/StorageService.ts:1410-1518`

使用 **Pre-Authenticated Request (PAR)**:

```typescript
const req: objectstorage.requests.CreatePreauthenticatedRequestRequest = {
  namespaceName,
  bucketName: this.bucketName,
  createPreauthenticatedRequestDetails: {
    name: `read-${fileName}-${Date.now()}`,
    accessType: "ObjectRead",
    objectName: fileName,
    timeExpires: expiresOn,
  },
};
const resp = await client.createPreauthenticatedRequest(req);
const accessUri = resp.preauthenticatedRequest.accessUri;
```

### 6.6 外部端点支持

**文件**: `packages/shared/src/server/services/StorageService.ts:523-540`

支持内部/外部双端点配置:
- 内部端点: 用于服务端实际操作（上传、下载、删除）
- 外部端点: 用于生成签名URL（客户端可访问）
- 通过 `externalEndpoint` 参数配置

---

## 七、关键配置参数

**文件**: `web/src/env.mjs:316-336`

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET` | - | 媒体存储桶名称 |
| `LANGFUSE_S3_MEDIA_UPLOAD_PREFIX` | "" | 存储路径前缀 |
| `LANGFUSE_S3_MEDIA_MAX_CONTENT_LENGTH` | - | 最大文件大小（字节） |
| `LANGFUSE_S3_MEDIA_DOWNLOAD_URL_EXPIRY_SECONDS` | 3600 | 下载URL有效期（秒） |
| `LANGFUSE_S3_MEDIA_UPLOAD_SSE` | - | 服务端加密（AES256/aws:kms） |
| `LANGFUSE_S3_MEDIA_UPLOAD_SSE_KMS_KEY_ID` | - | KMS密钥ID |

---

## 八、第四轮深度核对结果（四项精准核实）

### 8.1 问题一：200/201 行为结论与 E2E 用例逐条对齐，区分代码事实 vs 假设

**结论：✅ E2E测试全覆盖200场景，201为假设场景；代码事实与测试断言一致**

#### E2E 测试用例全景分析

**测试文件**: `web/src/__tests__/server/media.servertest.ts`

| 测试用例 | 期望 uploadHttpStatus | 代码位置 | 性质 |
|---------|----------------------|---------|------|
| PNG上传成功 | 200 | 第264行 | ✅ 代码事实 |
| PDF上传成功 | 200 | 第318行 | ✅ 代码事实 |
| 错误contentLength重试 | 第一次403，第二次200 | 第369、399行 | ✅ 代码事实 |
| 错误content重试 | 第一次403，第二次200 | 第452、482行 | ✅ 代码事实 |
| 错误contentType重试 | 第一次403，第二次200 | 第535、565行 | ✅ 代码事实 |
| 不同contentType重传 | 第一次200，第二次200 | 第618、665行 | ✅ 代码事实 |
| 去重短路验证 | 200 | 第717行 | ✅ 代码事实 |
| SHA256不匹配 | 400 | 第842行 | ✅ 代码事实 |

#### 代码事实 vs 假设边界

| 判断 | 代码事实 | 假设 | 证据 |
|------|---------|------|------|
| 去重短路只判断200 | ✅ 是 | ❌ | `index.ts:74` + E2E第717行断言 |
| 状态回写只判断200 | ✅ 是 | ❌ | `[mediaId].ts:98` + E2E第619行断言 |
| 读取放行接受200和201 | ✅ 是 | ❌ | `media.ts:41` + `[mediaId].ts:43` |
| S3 PUT成功返回201 | ❌ | ✅ 是 | 测试环境S3mock返回200（第256行），生产环境S3返回201是AWS行为常识 |
| 201导致去重失效 | ❌ | ✅ 是 | E2E测试未覆盖201场景，属于推断 |

#### E2E 测试中的关键断言

**去重短路测试**（第696-756行）:
```typescript
// 第一次上传成功，uploadHttpStatus=200
expect(firstResult.mediaRecord).toMatchObject({
  uploadHttpStatus: 200,  // 第717行
});

// 第二次相同文件上传，预期uploadUrl为null（去重命中）
expect(secondResult.getUploadUrlResponse?.body.uploadUrl).toBeNull();  // 第754行
```

**不同contentType重传测试**（第596-694行）:
```typescript
// 第一次上传PNG但声明contentType为image/jpeg，成功
expect(firstResult.mediaRecord).toMatchObject({
  sha256Hash: validPNG.sha256Hash,
  contentType: "image/jpeg",  // 第614行
  uploadHttpStatus: 200,      // 第618行
});

// 第二次上传相同PNG，声明正确的image/png，也成功（未去重）
expect(secondResult.getUploadUrlResponse?.body.uploadUrl).not.toBeNull();  // 隐含：去重未命中
```

#### 语义边界澄清

1. **"上传成功"的三重语义**:
   - 去重/回写口径：`uploadHttpStatus === 200`（严格）
   - 读取放行口径：`uploadHttpStatus === 200 || === 201`（宽松）
   - E2E测试口径：始终断言 `=== 200`（测试环境）

2. **201的真实来源**:
   - 不是代码中的硬编码值
   - 是AWS S3生产环境对PUT请求的标准响应
   - 当前测试环境（S3mock）返回200，因此E2E无法覆盖

---

### 8.2 问题二：允许不同 content type 重传的设计反证，重写去重与状态口径边界

**结论：✅ 允许不同contentType重传是明确的设计选择，而非缺陷；去重逻辑是"相同内容+相同类型"才短路**

#### 设计反证：E2E 用例明确验证

**测试用例**（`media.servertest.ts:596-694`）:
```
测试名称: "should allow reuploading with different content type"

步骤:
1. 上传PNG文件（真实内容），但声明 contentType = "image/jpeg"
   → 成功，uploadHttpStatus = 200
   → contentType 存储为 "image/jpeg"

2. 上传完全相同的PNG文件（相同SHA256），声明 contentType = "image/png"
   → 去重未命中（返回新的uploadUrl，非null）
   → 成功，uploadHttpStatus = 200
   → contentType 更新为 "image/png"

3. 断言：两次都成功，第二次未触发去重
```

#### 去重逻辑的完整边界

**代码**（`web/src/pages/api/public/media/index.ts:72-76`）:
```typescript
if (
  existingMedia &&
  existingMedia.uploadHttpStatus === 200 &&  // 条件1：状态成功
  existingMedia.contentType === contentType  // 条件2：类型相同
) {
  // 去重命中，返回 { mediaId, uploadUrl: null }
}
```

**去重短路的三个必要条件（缺一不可）**:
| 条件 | 说明 | 不满足时的行为 |
|------|------|---------------|
| `existingMedia` 存在 | 相同projectId+sha256Hash的记录存在 | 走完整上传流程 |
| `uploadHttpStatus === 200` | 之前上传成功 | 重新生成上传URL，允许重试 |
| `contentType === contentType` | 请求的contentType与已有记录相同 | 重新生成上传URL，允许用不同类型重传 |

#### UPSERT 更新语义边界

**代码**（`web/src/pages/api/public/media/index.ts:157-162`）:
```sql
ON CONFLICT ("project_id", "sha_256_hash")
DO UPDATE SET
  "bucket_name" = ${env.LANGFUSE_S3_MEDIA_UPLOAD_BUCKET},
  "bucket_path" = ${bucketPath},           -- 随contentType变化（扩展名不同）
  "content_type" = ${contentType},         -- 覆盖为新的contentType
  "content_length" = ${contentLength}      -- 覆盖为新的contentLength
```

**关键设计意图**:
- 唯一键是 `(projectId, sha256Hash)` —— 基于内容去重
- 但允许同一内容以不同 contentType 重新上传
- 重新上传时会更新 `contentType`、`bucketPath`、`contentLength`
- `bucketPath` 变化是因为扩展名由 contentType 决定（`.png` vs `.jpg`）

#### 状态口径的完整边界表

| 操作 | 状态判断口径 | 代码位置 |
|------|-------------|---------|
| **去重短路** | `uploadHttpStatus === 200` **且** `contentType === contentType` | `index.ts:72-76` |
| **状态回写清空错误** | `uploadHttpStatus === 200` | `[mediaId].ts:98` |
| **seed-media 去重** | `uploadHttpStatus === 200` | `seed-media.ts:179` |
| **读取放行（getById）** | `uploadHttpStatus === 200 \|\| === 201` | `media.ts:41` |
| **读取放行（GET API）** | `uploadHttpStatus === 200 \|\| === 201` | `[mediaId].ts:43` |
| **批量读取（当前）** | 无任何判断 | `media.ts:85-170` |

---

### 8.3 问题三：seed-media 脚本中的 uploadHttpStatus 判定并入同一语义口径

**结论：✅ seed-media 与公开 API 口径完全一致，统一语义为 `=== 200`**

#### 三处判定的代码对齐

| 判定位置 | 代码 | 口径 | 一致性 |
|---------|------|------|--------|
| 公开API去重 | `index.ts:74` | `existingMedia.uploadHttpStatus === 200` | ✅ 一致 |
| 公开API回写 | `[mediaId].ts:98` | `uploadHttpStatus === 200 ? null` | ✅ 一致 |
| seed-media去重 | `seed-media.ts:179` | `existingMedia.uploadHttpStatus === 200` | ✅ 一致 |
| seed-media写入 | `seed-media.ts:240, 249` | 硬编码 `200` | ✅ 一致 |

#### seed-media 脚本详细证据

**去重检查**（`seed-media.ts:179-181`）:
```typescript
if (existingMedia && existingMedia.uploadHttpStatus === 200) {
  logger.debug(
    `[seed-media] Media already exists for ${mediaFile.name}, creating TraceMedia link only`,
  );
  // 只创建关联，不重复上传
}
```

**写入数据库**（`seed-media.ts:218-250`）:
```sql
INSERT INTO "media" (
  ...
  "uploaded_at",
  "upload_http_status"
)
VALUES (
  ...
  ${new Date()},
  ${200}  -- 硬编码200
)
ON CONFLICT ("project_id", "sha_256_hash")
DO UPDATE SET
  ...
  "uploaded_at" = ${new Date()},
  "upload_http_status" = ${200}  -- 硬编码200
```

#### 统一语义口径

**"上传成功"的写入口径（全链路一致）**:
- 公开 API PATCH 回调：客户端传入 `uploadHttpStatus`（可以是200或201等）
- 公开 API POST 去重：`=== 200`
- 公开 API PATCH 清空错误：`=== 200`
- seed-media 脚本去重：`=== 200`
- seed-media 脚本写入：硬编码 `200`

**不一致之处（读取口径）**:
- 单条读取放行：`=== 200 || === 201`（比写入口径宽松）
- 批量读取：无判断

#### 语义澄清：为什么 seed-media 硬编码 200？

1. **内部脚本 vs 外部API**:
   - seed-media 是内部数据填充脚本，直接调用 `storageClient.uploadFile()`
   - 不经过公开API的"获取上传URL → 直传 → 回调"流程
   - 脚本内上传成功即意味成功，直接写入200

2. **无回调机制**:
   - 内部上传没有HTTP响应状态码的概念
   - 成功就是200，失败就跳过不写入

---

### 8.4 问题四：批量读取修复建议同时覆盖 trace 与 observation 两条查询分支

**结论：❌ 两条分支都未过滤，需同时修复**

#### 两条分支的代码证据

**Trace 分支**（`web/src/server/api/routers/media.ts:97-112`）:
```sql
SELECT
  tm.field,
  m.id,
  m.bucket_name,
  m.bucket_path,
  m.content_type,
  m.content_length
FROM
  trace_media tm
  LEFT JOIN media m 
    ON tm.media_id = m.id 
    AND tm.project_id = m.project_id
WHERE
  tm.project_id = ${projectId}
  AND tm.trace_id = ${traceId}
/* ⚠️ 缺少：AND m.upload_http_status IN (200, 201) */
```

**Observation 分支**（`web/src/server/api/routers/media.ts:124-140`）:
```sql
SELECT
  om.field,
  m.id,
  m.bucket_name,
  m.bucket_path,
  m.content_type,
  m.content_length
FROM
  observation_media om
  LEFT JOIN media m 
    ON om.media_id = m.id 
    AND om.project_id = m.project_id
WHERE
  om.project_id = ${projectId}
  AND om.trace_id = ${traceId}
  AND om.observation_id = ${input.observationId}
/* ⚠️ 缺少：AND m.upload_http_status IN (200, 201) */
```

#### 两条分支的共同问题

| 问题 | Trace分支 | Observation分支 |
|------|-----------|----------------|
| 使用 LEFT JOIN | ✅ 是 | ✅ 是 |
| 无 uploadHttpStatus 过滤 | ✅ 是 | ✅ 是 |
| SELECT 不含 uploadHttpStatus | ✅ 是 | ✅ 是 |
| 直接为所有结果生成签名URL | ✅ 是 | ✅ 是 |

#### 完整修复方案（同时覆盖两条分支）

**方案一：SQL层过滤（推荐，性能最优）**

```typescript
// Trace 分支
media = await ctx.prisma.$queryRaw<...>`
  SELECT
    tm.field,
    m.id,
    m.bucket_name,
    m.bucket_path,
    m.content_type,
    m.content_length
  FROM
    trace_media tm
    INNER JOIN media m  -- 改为INNER JOIN，排除关联不存在的情况
      ON tm.media_id = m.id 
      AND tm.project_id = m.project_id
  WHERE
    tm.project_id = ${projectId}
    AND tm.trace_id = ${traceId}
    AND m.upload_http_status IN (200, 201)  -- 新增：只返回上传成功的媒体
`;

// Observation 分支
media = await ctx.prisma.$queryRaw<...>`
  SELECT
    om.field,
    m.id,
    m.bucket_name,
    m.bucket_path,
    m.content_type,
    m.content_length
  FROM
    observation_media om
    INNER JOIN media m  -- 改为INNER JOIN
      ON om.media_id = m.id 
      AND om.project_id = m.project_id
  WHERE
    om.project_id = ${projectId}
    AND om.trace_id = ${traceId}
    AND om.observation_id = ${input.observationId}
    AND m.upload_http_status IN (200, 201)  -- 新增：只返回上传成功的媒体
`;
```

**方案二：应用层过滤（需要先查询uploadHttpStatus）**

```typescript
// 1. 修改SQL，增加upload_http_status字段
SELECT
  ...
  m.upload_http_status  -- 新增
FROM
  ...

// 2. 在Promise.all前过滤
const validMedia = media.filter(m => 
  m.upload_http_status === 200 || m.upload_http_status === 201
);

// 3. 只为有效媒体生成签名URL
return await Promise.all(
  validMedia.map<Promise<MediaReturnType>>(async (m) => {
    // ...
  }),
);
```

**方案三：混合方案（最健壮）**

```typescript
// SQL层过滤 + SELECT字段包含状态（用于应用层双重校验）
SELECT
  ...
  m.upload_http_status
FROM
  ...
WHERE
  ...
  AND m.upload_http_status IN (200, 201)

// 应用层二次校验（防御性编程）
const validMedia = media.filter(m => 
  m.upload_http_status === 200 || m.upload_http_status === 201
);

if (validMedia.length !== media.length) {
  logger.warn("Some media records were filtered out due to invalid upload status");
}
```

#### 修复验证清单

- [ ] Trace 分支 SQL 增加 `upload_http_status IN (200, 201)` 过滤
- [ ] Trace 分支 JOIN 改为 INNER JOIN
- [ ] Observation 分支 SQL 增加 `upload_http_status IN (200, 201)` 过滤
- [ ] Observation 分支 JOIN 改为 INNER JOIN
- [ ] 新增 E2E 测试用例验证未成功上传的媒体不被返回
- [ ] 新增 E2E 测试用例验证 observation 分支过滤逻辑


---

### 8.5 问题五：PATCH 异常分支的错误信息拼接是否正确

**结论：❌ 存在运算符优先级bug，错误信息会丢失上下文前缀**

#### 问题代码

```typescript
// web/src/pages/api/public/media/[mediaId].ts:124-129
throw new InternalServerError(
  `Error updating uploadedAt on media ID ${mediaId}` +
    (e instanceof Error ? e.message : "")
    ? (e as Error).message
    : "",
);
```

#### 运算符优先级分析

JavaScript 中 `+` 运算符优先级 **高于** `?:` 三元运算符。

**实际执行顺序**:
```typescript
// 先执行 + 连接，再执行三元判断
(
  `Error updating uploadedAt on media ID ${mediaId}` +
  (e instanceof Error ? e.message : "")
) ? (e as Error).message : ""
```

#### 两种场景的错误输出

| 场景 | 预期输出 | 实际输出 | 问题 |
|------|---------|---------|------|
| `e` 是 Error 对象 | `"Error updating uploadedAt on media ID m_123: Original error message"` | `"Original error message"` | ❌ 丢失上下文前缀 |
| `e` 不是 Error 对象 | `"Error updating uploadedAt on media ID m_123"` | `undefined` 或运行时错误 | ❌ 尝试访问 `(e as Error).message` |

#### 修复方案

**正确写法（加括号控制优先级）**:
```typescript
throw new InternalServerError(
  `Error updating uploadedAt on media ID ${mediaId}` +
    ((e instanceof Error ? e.message : "")
      ? `: ${(e as Error).message}`
      : "")
);
```

**更清晰的写法**:
```typescript
const errorMessage = e instanceof Error ? e.message : "";
throw new InternalServerError(
  `Error updating uploadedAt on media ID ${mediaId}${errorMessage ? `: ${errorMessage}` : ""}`
);
```

---

### 8.6 保留：多 bucket 相关结论（第三轮核对）

**结论：⚠️ 是当前明确的设计前提，而非意外缺陷；但存在未来扩展风险**

（详细分析见第三轮核对，此处保留作为历史参考）

---

### 8.7 保留：各存储后端上传签名的完整性约束差异（第三轮核对）

**结论：❌ 各后端实现差异显著，但需纠正过度推断，明确实际风险边界**

（详细分析见第三轮核对，此处保留作为历史参考）

---

## 九、安全设计要点

### 9.1 现有安全措施

1. **权限隔离**: 所有操作通过 `projectId` 边界校验，防止跨项目访问
2. **签名过期**: URL 有效期严格限制（默认3600秒），降低泄露风险
3. **完整性校验（S3）**: 上传时强制校验 SHA256 哈希和 Content-Length（存储层）
4. **去重机制**: 基于 SHA256 哈希 + contentType 实现"相同内容+相同类型"去重
5. **状态机（单条查询）**: `getById` 和 GET API 中 `uploadHttpStatus` 确保只有上传成功的媒体才能被访问
6. **幂等性**: 高并发场景下使用原生 SQL + 重试机制保证数据一致性
7. **审计日志**: 所有上传操作记录指标，支持监控和审计
8. **应用层大小限制**: 获取上传URL时校验 `contentLength < MAX_CONTENT_LENGTH`
9. **允许重传**: 支持不同 contentType、不同 contentLength、不同 content 的重试上传

### 9.2 已核实的安全缺陷（按优先级）

| 优先级 | 问题 | 影响 | 所在章节 |
|--------|------|------|---------|
| 🔴 高 | 批量查询（trace/observation）未过滤未成功上传的媒体 | 未上传/上传失败的媒体也能获得签名URL，存在缓存污染风险 | 8.4 |
| 🔴 高 | 非S3后端存储层完整性校验缺失 | 客户端可上传与声明的SHA256/Size不符的文件，存在缓存污染攻击 | 8.7（第三轮） |
| 🟡 中 | 200/201状态处理不一致 | S3 PUT成功返回201时去重失效，重复上传浪费资源 | 8.1 |
| 🟡 中 | 前端URL过期无自动续签 | 用户长时间停留页面时URL过期，导致403错误 | 5.2 |
| 🟡 中 | PATCH异常分支错误信息拼接bug | 错误信息丢失上下文前缀，调试困难 | 8.5 |
| 🟢 低 | 多bucket参数名误导 | 当前单bucket设计下无影响，未来扩展需注意 | 8.6 |
| 🟢 低 | seed-media硬编码200 | 内部脚本，无实际影响 | 8.3 |

### 9.3 设计边界澄清

1. **单 bucket 部署**: 当前系统明确设计为单 bucket 部署，所有媒体共享一个存储桶。多 bucket 支持不在当前设计范围内。
2. **S3 为一等公民**: 完整性校验在 S3 后端得到完整实现，其他后端为兼容实现，安全级别不同。
3. **状态机部分生效**: 状态机校验仅在单条查询（`getById`、GET API）中生效，批量查询（`getByTraceOrObservationId`）未实现。
4. **客户端信任模型**: SHA256 哈希由客户端计算并提供，非 S3 后端无法在存储层验证其真实性。
5. **去重边界**: 去重是"相同内容（SHA256）+ 相同类型（contentType）+ 状态200"才短路，允许同一内容以不同类型重传。
6. **写入口径统一**: 公开API和seed-media脚本的写入/去重口径统一为 `uploadHttpStatus === 200`，读取口径更宽松（接受200和201）。
