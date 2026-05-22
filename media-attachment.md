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

## 八、第三轮深度核对结果（四项精准核实）

### 8.1 问题一：getByTraceOrObservationId 批量返回前是否过滤未成功上传的媒体

**结论：❌ 未过滤，存在安全隐患**

#### 代码证据

**批量查询逻辑**（`web/src/server/api/routers/media.ts:85-141`）:
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
```

**关键发现**:
- SQL 查询仅做 `LEFT JOIN`，**没有任何 WHERE 条件过滤 `uploadHttpStatus`**
- 查询结果 SELECT 列表中甚至**不包含 `uploadHttpStatus` 字段**
- 后续 `Promise.all` 循环直接为所有查询结果生成签名URL

#### 与单条查询的对比

| 查询方式 | 代码位置 | 状态检查 |
|---------|---------|---------|
| `getById` | `media.ts:36-45` | ✅ 检查 `!uploadHttpStatus` → 抛出"未上传"<br>✅ 检查 `!== 200 && !== 201` → 抛出"上传失败" |
| `GET /api/public/media/[mediaId]` | `[mediaId].ts:41-46` | ✅ 同上 |
| `getByTraceOrObservationId` | `media.ts:85-170` | ❌ 无任何检查 |

#### 影响分析

1. **未上传的媒体**（`uploadHttpStatus IS NULL`）：会返回签名URL，但存储中不存在文件，访问时404
2. **上传失败的媒体**（`uploadHttpStatus` 非200/201）：会返回签名URL，但可能存储的是错误数据
3. **安全隐患**：攻击者可以通过创建 trace/observation_media 关联，获取未成功上传媒体的签名URL
4. **体验问题**：前端渲染时会出现图片加载失败的占位符

#### 修复建议

**方案一：在SQL中过滤（推荐，性能最优）**

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
  JOIN media m  -- 改为INNER JOIN，排除关联不存在的情况
    ON tm.media_id = m.id 
    AND tm.project_id = m.project_id
WHERE
  tm.project_id = ${projectId}
  AND tm.trace_id = ${traceId}
  AND m.upload_http_status IN (200, 201)  -- 新增：只返回上传成功的媒体
```

**方案二：在应用层过滤**

```typescript
// 在Promise.all前增加过滤
const validMedia = media.filter(m => 
  m.uploadHttpStatus === 200 || m.uploadHttpStatus === 201
);
```

---

### 8.2 问题二：去重短路与状态回写对 200/201 的处理是否统一

**结论：✅ 去重短路与状态回写内部一致，但与读取放行不一致**

#### 三项逻辑的精准核对

| 场景 | 代码位置 | 检查逻辑 | 200 | 201 |
|------|---------|---------|-----|-----|
| **去重短路** | `media/index.ts:74` | `existingMedia.uploadHttpStatus === 200` | ✅ | ❌ |
| **状态回写清空错误** | `[mediaId].ts:98` | `uploadHttpStatus === 200 ? null` | ✅ | ❌ |
| **读取放行（getById）** | `media.ts:41` | `=== 200 \|\| === 201` | ✅ | ✅ |
| **读取放行（GET API）** | `[mediaId].ts:43` | `=== 200 \|\| === 201` | ✅ | ✅ |

#### 代码事实确认

**去重短路**（`web/src/pages/api/public/media/index.ts:72-75`）:
```typescript
if (
  existingMedia &&
  existingMedia.uploadHttpStatus === 200 &&  // 只判断200
  existingMedia.contentType === contentType
) {
  // 去重命中，直接返回
}
```

**状态回写**（`web/src/pages/api/public/media/[mediaId].ts:95-99`）:
```typescript
data: {
  uploadedAt,
  uploadHttpStatus,
  uploadHttpError: uploadHttpStatus === 200 ? null : uploadHttpError,  // 只判断200
}
```

**读取放行**（`web/src/server/api/routers/media.ts:41`）:
```typescript
if (!(media.uploadHttpStatus === 200 || media.uploadHttpStatus === 201))
  throw new TRPCError({
    code: "NOT_FOUND",
    message: `Media upload failed`,
  });
```

#### 边界分析

- **去重与状态回写一致**：两处都只判断200，说明是有意的设计选择，而非遗漏
- **但与读取放行不一致**：读取放行同时接受200和201
- **实际影响**：S3 PUT成功返回201，这意味着：
  1. 首次上传成功（201）→ 状态回写时 `uploadHttpError` 不会被清空
  2. 下次相同文件上传 → 去重短路不通过（因为status=201）→ 重新走上传流程
  3. 但读取放行会正常通过（因为接受201）

#### 修复建议

统一三处逻辑，同时接受200和201：

```typescript
// 去重短路
existingMedia &&
(existingMedia.uploadHttpStatus === 200 || existingMedia.uploadHttpStatus === 201) &&
existingMedia.contentType === contentType

// 状态回写
uploadHttpError: (uploadHttpStatus === 200 || uploadHttpStatus === 201) ? null : uploadHttpError
```

---

### 8.3 问题三：多 bucket 相关结论是现状缺陷还是设计前提

**结论：⚠️ 是当前明确的设计前提，而非意外缺陷；但存在未来扩展风险**

#### 代码事实边界

**事实1：单 bucket 写入**（`web/src/pages/api/public/media/index.ts:110-112, 144, 159`）:
```typescript
// 获取上传URL时，bucketName 来自环境变量
const s3Client = getMediaStorageServiceClient(
  env.LANGFUSE_S3_MEDIA_UPLOAD_BUCKET,
);

// 写入数据库时，bucket_name 来自环境变量
INSERT INTO "media" (..., "bucket_name", ...)
VALUES (..., ${env.LANGFUSE_S3_MEDIA_UPLOAD_BUCKET}, ...)
ON CONFLICT ("project_id", "sha_256_hash")
DO UPDATE SET
  "bucket_name" = ${env.LANGFUSE_S3_MEDIA_UPLOAD_BUCKET},
  ...
```

**事实2：环境变量仅支持单 bucket 配置**（`web/src/env.mjs:322, 714`）:
```typescript
LANGFUSE_S3_MEDIA_UPLOAD_BUCKET: z.string().optional(),
```

**事实3：数据库表支持多 bucket**（`schema.prisma` media 表含 `bucketName` 字段）

**事实4：存储客户端单例模式**（`web/src/features/media/server/getMediaStorageClient.ts:7-24`）:
```typescript
let s3StorageServiceClient: StorageService;  // 模块级单例

export const getMediaStorageServiceClient = (
  bucketName: string,  // 参数存在但仅第一次有效
): StorageService => {
  if (!s3StorageServiceClient) {
    s3StorageServiceClient = StorageServiceFactory.getInstance({
      bucketName,  // 仅第一次调用使用
      // ... 其他配置都来自环境变量，与 bucketName 无关
    });
  }
  return s3StorageServiceClient;
};
```

**事实5：批量签名取第一个媒体的 bucket**（`web/src/server/api/routers/media.ts:147-149`）:
```typescript
const mediaStorageClient = getMediaStorageServiceClient(
  media[0].bucket_name,  // 只用第一个媒体的bucketName
);
```

#### 设计前提 vs 缺陷的边界判定

| 维度 | 设计前提（当前现状） | 潜在缺陷（未来风险） |
|------|---------------------|---------------------|
| **部署模型** | 单 bucket 部署，所有媒体共享一个存储桶 | 未来支持按项目/区域/租户配置不同 bucket |
| **凭据配置** | 所有 bucket 使用相同的访问密钥（来自环境变量） | 不同 bucket 需要不同的访问密钥 |
| **数据一致性** | media 表中所有记录的 `bucketName` 字段值相同 | 数据迁移、多 bucket 并存场景下值不一致 |
| **单例合理性** | 单例是合理的性能优化，避免重复创建客户端 | 多 bucket 场景下单例模式失效 |
| **批量签名逻辑** | 所有媒体 bucket 相同，取第一个无问题 | 媒体来自不同 bucket 时生成错误URL |

#### 澄清后的结论

1. **不是代码缺陷**：当前代码在单 bucket 部署模型下完全正确，单例模式是合理的性能优化
2. **是明确的设计前提**：系统设计为单 bucket 部署，所有相关配置都围绕这一前提
3. **存在扩展风险**：如果未来需要支持多 bucket，需要修改多处代码
4. **参数名误导**：`getMediaStorageServiceClient(bucketName)` 的参数名具有误导性，因为它实际上并不使用该参数（除第一次调用外）

#### 改进建议（非修复，而是增强健壮性）

**方案一：增加参数校验，明确设计边界**

```typescript
export const getMediaStorageServiceClient = (
  bucketName: string,
): StorageService => {
  if (!s3StorageServiceClient) {
    s3StorageServiceClient = StorageServiceFactory.getInstance({
      bucketName,
      // ...
    });
  }
  
  // 新增：校验传入的 bucketName 与客户端配置一致
  if (s3StorageServiceClient.getBucketName() !== bucketName) {
    throw new Error(
      `Bucket mismatch: requested ${bucketName}, but client configured for ${s3StorageServiceClient.getBucketName()}. ` +
      `Multi-bucket deployment is not currently supported.`
    );
  }
  
  return s3StorageServiceClient;
};
```

**方案二：批量签名时校验所有媒体 bucket 一致**

```typescript
// 校验所有媒体的bucketName相同
const bucketName = media[0].bucket_name;
const allSameBucket = media.every(m => m.bucket_name === bucketName);
if (!allSameBucket) {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Multi-bucket media retrieval is not supported",
  });
}
```

---

### 8.4 问题四：各存储后端上传签名的完整性约束差异

**结论：❌ 各后端实现差异显著，但需纠正过度推断，明确实际风险边界**

#### 逐项证据对比表

| 存储后端 | SHA256 校验 | Content-Length 校验 | Content-Type 校验 | 代码证据行 |
|---------|------------|--------------------|-------------------|-----------|
| **AWS S3** | ✅ 强制签名校验<br>`ChecksumSHA256` + `unhoistableHeaders` | ✅ 强制签名校验<br>`ContentLength` + `signableHeaders` | ✅ 强制签名校验<br>`ContentType` | `StorageService.ts:766-792` |
| **Azure Blob** | ❌ 参数解构但未使用 | ❌ 参数解构但未使用 | ✅ 包含在 SAS 签名<br>`contentType: contentType` | `StorageService.ts:441-475` |
| **Google Cloud Storage** | ❌ 未解构该参数 | ✅ 扩展头签名校验<br>`extensionHeaders["Content-Length"]` | ✅ 包含在签名<br>`contentType` | `StorageService.ts:981-1015` |
| **OCI Object Storage** | ❌ 参数解构但未使用 | ❌ 参数解构但未使用 | ❌ 未解构该参数 | `StorageService.ts:1474-1518` |

#### 各后端实现的精准证据

**S3 实现**（最完整）:
```typescript
// 第773行：完整解构所有参数
const { path, ttlSeconds, contentType, contentLength, sha256Hash } = params;

// 第782-783行：全部包含在PutObjectCommand中
ChecksumSHA256: sha256Hash,
ContentLength: contentLength,

// 第788-789行：强制签名头，防止篡改
signableHeaders: new Set(["content-type", "content-length"]),
unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
```

**Azure Blob 实现**:
```typescript
// 第448行：只解构了3个参数，sha256Hash和contentLength被解构但未使用
const { path, ttlSeconds, contentType } = params;

// 第456行：仅contentType包含在SAS签名中
contentType: contentType,
// sha256Hash 和 contentLength 未被使用
```

**GCS 实现**:
```typescript
// 第988行：只解构了3个参数，sha256Hash未被解构
const { path, ttlSeconds, contentType } = params;

// 第999行：contentLength通过extensionHeaders包含在签名中
extensionHeaders: {
  "Content-Length": params.contentLength.toString(),
},
// sha256Hash 未被使用
```

**OCI 实现**:
```typescript
// 第1481行：只解构了2个参数，sha256Hash、contentLength、contentType都未使用
const { path, ttlSeconds } = params;

// PAR（Pre-Authenticated Request）仅控制访问权限和过期时间，不校验任何内容属性
```

#### 纠正过度推断

| 之前的推断 | 纠正后的准确描述 | 边界条件 |
|-----------|-----------------|---------|
| "攻击者获取签名URL后可以上传任意内容" | "非S3后端无法在存储层强制校验文件内容与签名时声明的一致" | 攻击者必须先通过API认证获取签名URL，这本身有访问控制 |
| "SHA256去重机制失效" | "非S3后端无法保证客户端声明的SHA256与实际文件内容一致" | mediaId基于客户端提供的SHA256生成，如果客户端诚实，去重仍然有效 |
| "可以上传更大的文件" | "Azure和OCI后端无法在存储层强制校验Content-Length" | 应用层在获取上传URL时已经校验了`contentLength < MAX_CONTENT_LENGTH` |

#### 真实风险边界

1. **已有的防护（所有后端）**:
   - URL有过期时间（默认1小时）
   - 获取签名URL需要API认证
   - 应用层在签发URL前校验 `contentLength < MAX_CONTENT_LENGTH`
   - mediaId基于客户端提供的SHA256生成（防止同一个文件被分配不同ID）

2. **缺失的防护（非S3后端）**:
   - 无法在存储层校验客户端上传的文件大小是否等于声明的 `contentLength`
   - 无法在存储层校验客户端上传的文件内容哈希是否等于声明的 `sha256Hash`

3. **实际可行的攻击场景**:
   - 客户端A请求上传URL，声明SHA256=X，Size=1MB
   - 获得签名URL后，客户端A实际上传不同内容的文件（Size可能不同）
   - 文件成功写入存储（非S3后端不校验）
   - media表记录SHA256=X，Size=1MB，但实际文件不同
   - 下次客户端B上传相同内容（真实SHA256=X）时，去重命中，但访问的是客户端A上传的恶意文件
   - ⚠️ **这是真实的缓存污染风险**

#### 修复建议优先级

**高优先级：应用层完整性校验（通用方案）**

在PATCH回调时，对非S3后端增加校验：
```typescript
// PATCH回调时增加校验逻辑（仅对非S3后端）
if (storageType !== "s3") {
  const s3Client = getMediaStorageServiceClient(media.bucketName);
  const fileStat = await s3Client.stat(media.bucketPath); // 获取文件元数据
  
  // 校验文件大小
  if (fileStat.size !== Number(media.contentLength)) {
    await s3Client.deleteFiles([media.bucketPath]);
    throw new Error("Content-Length mismatch");
  }
  
  // 对于关键场景，可下载文件校验SHA256（但影响性能）
  // const fileContent = await s3Client.download(media.bucketPath);
  // const actualHash = crypto.createHash('sha256').update(fileContent).digest('base64');
}
```

**低优先级：各存储后端原生支持研究**
- Azure Blob: 可研究 `x-ms-blob-content-md5` 头的签名支持
- GCS: 可研究 `x-goog-hash` 头的签名支持
- OCI: PAR机制本身不支持内容校验，无解

---

### 8.5 问题五：PATCH异常分支的错误信息拼接是否正确

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

## 九、安全设计要点

### 9.1 现有安全措施

1. **权限隔离**: 所有操作通过 `projectId` 边界校验，防止跨项目访问
2. **签名过期**: URL 有效期严格限制（默认3600秒），降低泄露风险
3. **完整性校验（S3）**: 上传时强制校验 SHA256 哈希和 Content-Length（存储层）
4. **去重机制**: 基于 SHA256 哈希实现文件去重，节省存储空间
5. **状态机（单条查询）**: `getById` 和 GET API 中 `uploadHttpStatus` 确保只有上传成功的媒体才能被访问
6. **幂等性**: 高并发场景下使用原生 SQL + 重试机制保证数据一致性
7. **审计日志**: 所有上传操作记录指标，支持监控和审计
8. **应用层大小限制**: 获取上传URL时校验 `contentLength < MAX_CONTENT_LENGTH`

### 9.2 已核实的安全缺陷（按优先级）

| 优先级 | 问题 | 影响 | 所在章节 |
|--------|------|------|---------|
| 🔴 高 | 批量查询未过滤未成功上传的媒体 | 未上传/上传失败的媒体也能获得签名URL，存在缓存污染风险 | 8.1 |
| 🔴 高 | 非S3后端存储层完整性校验缺失 | 客户端可上传与声明的SHA256/Size不符的文件，存在缓存污染攻击 | 8.4 |
| 🟡 中 | 200/201状态处理不一致 | S3 PUT成功返回201时去重失效，重复上传浪费资源 | 8.2 |
| 🟡 中 | 前端URL过期无自动续签 | 用户长时间停留页面时URL过期，导致403错误 | 5.2 |
| 🟡 中 | PATCH异常分支错误信息拼接bug | 错误信息丢失上下文前缀，调试困难 | 8.5 |
| 🟢 低 | 多bucket参数名误导 | 当前单bucket设计下无影响，未来扩展需注意 | 8.3 |

### 9.3 设计边界澄清

1. **单 bucket 部署**: 当前系统明确设计为单 bucket 部署，所有媒体共享一个存储桶。多 bucket 支持不在当前设计范围内。
2. **S3 为一等公民**: 完整性校验在 S3 后端得到完整实现，其他后端为兼容实现，安全级别不同。
3. **状态机部分生效**: 状态机校验仅在单条查询（`getById`、GET API）中生效，批量查询（`getByTraceOrObservationId`）未实现。
4. **客户端信任模型**: SHA256 哈希由客户端计算并提供，非 S3 后端无法在存储层验证其真实性。
