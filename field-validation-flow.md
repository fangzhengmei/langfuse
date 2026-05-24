# 字段验证流程与 Passkey 认证优化一致性分析

## 一、现有错误处理模式梳理

### 1.1 认证相关页面的错误处理模式

#### Sign-in 页面
`web/src/pages/auth/sign-in.tsx:570-646`

```typescript
// 错误状态存储
const [credentialsFormError, setCredentialsFormError] = useState<string | null>(errorMessage);

// 登录失败时设置错误
async function onCredentialsSubmit(values) {
  setCredentialsFormError(null);
  try {
    const result = await signIn("credentials", {
      email: values.email,
      password: values.password,
      callbackUrl: targetPath ?? "/",
      redirect: false,
    });
    if (!result.ok) {
      setCredentialsFormError(
        result?.error ?? "An unexpected error occurred.",
      );
    }
  } catch (error) {
    setCredentialsFormError("An unexpected error occurred.");
  }
}

// 错误展示 - 简单 div，不使用 Alert 组件
{credentialsFormError ? (
  <div className="text-destructive text-center text-sm font-medium">
    {credentialsFormError}
    <br />
    Contact support if this error is unexpected.{" "}
    {isLangfuseCloud &&
      "Make sure you are using the correct cloud data region."}
  </div>
) : null}
```

#### Reset Password 页面
`web/src/features/auth-credentials/components/ResetPasswordPage.tsx:50-107`

```typescript
// 错误状态存储
const [formError, setFormError] = useState<string | null>(null);
const [showResetPasswordEmailButton, setShowResetPasswordEmailButton] = useState(false);

// 后端抛出 UNAUTHORIZED
// credentialsRouter.ts:33-40
if (!emailVerificationStatus.verified) {
  throw new TRPCError({
    code: "UNAUTHORIZED",
    message:
      emailVerificationStatus.reason === "not_verified"
        ? "Email not verified."
        : "Email verification expired.",
  });
}

// 前端捕获并处理
await mutResetPassword
  .mutateAsync({ password: values.password })
  .then(() => { /* 成功处理 */ })
  .catch((error) => {
    if (error instanceof TRPCClientError) {
      if (error.data?.code === "UNAUTHORIZED") {
        setShowResetPasswordEmailButton(true);  // 特定逻辑分支
      }
      setFormError(error.message);  // 仅设置错误消息字符串
    } else {
      setFormError("An unknown error occurred");
    }
  });

// 错误展示 - 简单 div，不使用 Alert 组件
{formError ? (
  <div className="text-destructive text-center text-sm font-medium">
    {formError}
  </div>
) : null}
```

### 1.2 Alert 组件的使用模式

#### Alert 组件定义
`web/src/components/ui/alert.tsx:6-57`

```typescript
const alertVariants = cva(
  "relative w-full rounded-lg border p-3 [&>svg~*]:pl-6 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-3 [&>svg]:top-3 [&>svg]:text-foreground",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground",
        destructive:
          "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
      },
    },
  }
);

// 导出三个组件
export { Alert, AlertTitle, AlertDescription };
```

#### Alert 组件的实际使用场景
`web/src/pages/project/[projectId]/settings/integrations/blobstorage.tsx:146-150`

```typescript
{state.data.lastError && (
  <Alert variant="destructive" className="mb-4">
    <AlertTitle>Last export failed</AlertTitle>
    <AlertDescription>
      {state.data.lastError}
    </AlertDescription>
  </Alert>
)}
```

`web/src/features/widgets/components/WidgetForm.tsx:1989-1992`

```typescript
{!queryValidation.valid ? (
  <Alert variant="destructive" className="max-w-sm">
    <AlertCircle className="h-4 w-4" />
    <AlertTitle>Invalid query</AlertTitle>
    <AlertDescription>{queryValidation.reason}</AlertDescription>
  </Alert>
)}
```

### 1.3 React Hook Form 字段级错误处理模式

`web/src/features/public-api/components/CreateLLMApiKeyForm.tsx:1277-1279`

```typescript
// 使用 form.setError 设置 root 级别的错误
form.setError("root", { message: "Failed to create API key" });

// 使用 FormMessage 组件展示
{form.formState.errors.root && (
  <FormMessage>{form.formState.errors.root.message}</FormMessage>
)}
```

---

## 二、UNAUTHORIZED 错误处理的一致性问题

### 2.1 问题清单

| 问题 | 描述 | 代码位置 |
|------|------|---------|
| **1. 错误类型不一致** | 认证错误使用 `UNAUTHORIZED` 码，但前端仅提取 `error.message` 字符串，丢失了错误码的结构化信息 | `ResetPasswordPage.tsx:99-102` |
| **2. 未使用表单级错误 API** | `setFormError` 使用独立的 useState，而非 `form.setError("root", {...})`，导致无法与 React Hook Form 的验证机制集成 | `ResetPasswordPage.tsx:102` |
| **3. 展示组件不一致** | 认证相关页面使用简单 `<div>` 展示错误，而其他功能页面使用 `<Alert variant="destructive">` 组件，视觉风格不统一 | `sign-in.tsx:847-855`, `ResetPasswordPage.tsx:254-258` |
| **4. 错误码与展示逻辑耦合** | `UNAUTHORIZED` 码的处理逻辑（显示邮件按钮）与错误消息设置在同一分支，无法复用于其他错误码 | `ResetPasswordPage.tsx:99-102` |
| **5. 无错误码映射机制** | 没有统一的错误码到用户友好消息和操作建议的映射表 | 无 |

### 2.2 Alert 展示机制与当前实现的对比

| 维度 | 当前认证页面实现 | Alert 组件实现 | 推荐统一方式 |
|------|----------------|---------------|-------------|
| **容器** | `<div className="text-destructive">` | `<Alert variant="destructive">` | 使用 Alert 组件 |
| **标题** | 无 | `<AlertTitle>` | 添加错误类型标题 |
| **描述** | 简单文本 | `<AlertDescription>` | 使用 AlertDescription |
| **图标** | 无 | 可选图标（如 AlertCircle） | 添加图标增强辨识度 |
| **操作按钮** | 条件渲染在错误消息外 | 可集成在 Alert 内部 | 与 Alert 集成 |
| **与表单集成** | 独立 useState | 可选 | 使用 `form.formState.errors.root` |

---

## 三、Passkey 认证优化建议：UNAUTHORIZED 错误处理的统一方案

### 3.1 统一的错误处理架构

#### 步骤1：定义错误码到表单错误字段的映射

```typescript
// 建议新增：web/src/features/auth-credentials/lib/errorMapping.ts

import { TRPCClientError } from "@trpc/client";

export type AuthErrorCode = 
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BAD_REQUEST"
  | "INTERNAL_SERVER_ERROR";

export interface AuthErrorAction {
  showResetEmailButton?: boolean;
  showResendVerificationButton?: boolean;
  redirectTo?: string;
}

export interface AuthErrorMapping {
  formErrorCode: "email" | "password" | "confirmPassword" | "root";
  userMessage: string;
  action?: AuthErrorAction;
}

// 错误码映射表
export const AUTH_ERROR_MAPPINGS: Record<AuthErrorCode, AuthErrorMapping> = {
  UNAUTHORIZED: {
    formErrorCode: "root",  // 关键：UNAUTHORIZED 应设置为 root 级别错误
    userMessage: "Authentication failed. Please verify your credentials.",
    action: {
      showResetEmailButton: true,
    },
  },
  FORBIDDEN: {
    formErrorCode: "root",
    userMessage: "You do not have permission to perform this action.",
  },
  NOT_FOUND: {
    formErrorCode: "email",  // 邮箱不存在时设置到 email 字段
    userMessage: "No account found with this email address.",
  },
  CONFLICT: {
    formErrorCode: "email",  // 邮箱已注册时设置到 email 字段
    userMessage: "An account with this email already exists.",
  },
  BAD_REQUEST: {
    formErrorCode: "root",
    userMessage: "Invalid request. Please check your input.",
  },
  INTERNAL_SERVER_ERROR: {
    formErrorCode: "root",
    userMessage: "An unexpected error occurred. Please try again.",
  },
};

// 辅助函数：将 TRPC 错误转换为表单错误
export function mapTrpcErrorToFormError(error: unknown): {
  formErrorCode: string;
  message: string;
  action?: AuthErrorAction;
} {
  if (error instanceof TRPCClientError) {
    const code = error.data?.code as AuthErrorCode;
    const mapping = AUTH_ERROR_MAPPINGS[code];
    
    if (mapping) {
      return {
        formErrorCode: mapping.formErrorCode,
        message: error.message || mapping.userMessage,
        action: mapping.action,
      };
    }
  }
  
  // 默认 fallback
  return {
    formErrorCode: "root",
    message: "An unexpected error occurred.",
  };
}
```

#### 步骤2：统一使用 `form.setError` 而非独立 useState

**修正前（不一致）**：
```typescript
// ResetPasswordPage.tsx:96-107
.catch((error) => {
  if (error instanceof TRPCClientError) {
    if (error.data?.code === "UNAUTHORIZED") {
      setShowResetPasswordEmailButton(true);
    }
    setFormError(error.message);  // ❌ 独立 useState，与表单解耦
  }
});

// 展示
{formError ? (
  <div className="text-destructive text-center text-sm font-medium">
    {formError}
  </div>
) : null}
```

**修正后（一致）**：
```typescript
// 使用统一的错误映射
.catch((error) => {
  const { formErrorCode, message, action } = mapTrpcErrorToFormError(error);
  
  // ✅ 使用 React Hook Form 的 setError API
  form.setError(formErrorCode, { message });
  
  // ✅ 处理错误码特定的 action
  if (action?.showResetEmailButton) {
    setShowResetPasswordEmailButton(true);
  }
});

// ✅ 使用 Alert 组件统一展示
{form.formState.errors.root && (
  <Alert variant="destructive">
    <AlertCircle className="h-4 w-4" />
    <AlertTitle>Error</AlertTitle>
    <AlertDescription>
      {form.formState.errors.root.message}
    </AlertDescription>
  </Alert>
)}
```

#### 步骤3：统一的 Alert 展示组件

```typescript
// 建议新增：web/src/features/auth-credentials/components/AuthFormErrorAlert.tsx

import { AlertCircle } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/src/components/ui/alert";
import type { FieldValues, FormState } from "react-hook-form";

interface AuthFormErrorAlertProps<T extends FieldValues> {
  formState: FormState<T>;
  field?: "root" | "email" | "password";
}

export function AuthFormErrorAlert<T extends FieldValues>({
  formState,
  field = "root",
}: AuthFormErrorAlertProps<T>) {
  const error = formState.errors[field];
  
  if (!error) return null;
  
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Authentication Error</AlertTitle>
      <AlertDescription>
        {error.message as string}
      </AlertDescription>
    </Alert>
  );
}
```

---

## 四、同一错误路径下的行为一致性验证

### 4.1 UNAUTHORIZED 错误路径的完整流程

**后端抛出**：
```typescript
// credentialsRouter.ts:33-40
throw new TRPCError({
  code: "UNAUTHORIZED",
  message: "Email not verified.",
});
```

**前端捕获**（统一处理后）：
```typescript
.catch((error) => {
  const { formErrorCode, message, action } = mapTrpcErrorToFormError(error);
  // formErrorCode = "root", message = "Email not verified."
  // action = { showResetEmailButton: true }
  
  form.setError(formErrorCode, { message });
  // form.formState.errors.root = { message: "Email not verified.", type: "custom" }
  
  if (action?.showResetEmailButton) {
    setShowResetPasswordEmailButton(true);
  }
});
```

**Alert 展示**（统一组件）：
```
<AuthFormErrorAlert formState={form.formState} field="root" />

→ 渲染：
<Alert variant="destructive">
  <AlertCircle className="h-4 w-4" />
  <AlertTitle>Authentication Error</AlertTitle>
  <AlertDescription>Email not verified.</AlertDescription>
</Alert>
```

### 4.2 其他错误路径的一致性验证

#### NOT_FOUND 错误路径
```typescript
// 假设后端抛出
throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });

// 映射结果
formErrorCode = "email", message = "Account not found"

// 设置到 email 字段
form.setError("email", { message: "Account not found" });

// 由 FormMessage 组件在字段下方展示
<FormMessage />
```

#### CONFLICT 错误路径
```typescript
// 假设后端抛出
throw new TRPCError({ code: "CONFLICT", message: "Email already registered" });

// 映射结果
formErrorCode = "email", message = "Email already registered"

// 设置到 email 字段
form.setError("email", { message: "Email already registered" });
```

---

## 五、修正前后的矛盾示例对比

### 5.1 矛盾示例1：错误设置位置不一致

**修正前（矛盾）**：
```typescript
// ResetPasswordPage.tsx - 两处错误设置使用不同机制

// Zod 验证错误（正确）：通过 react-hook-form 设置
const form = useForm({
  resolver: zodResolver(resetPasswordSchema),  // ✅ 字段级错误由 form 管理
});

// 后端返回的 UNAUTHORIZED（不一致）：使用独立 useState
.catch((error) => {
  if (error.data?.code === "UNAUTHORIZED") {
    setShowResetPasswordEmailButton(true);
  }
  setFormError(error.message);  // ❌ 绕过 react-hook-form
});

// 展示逻辑分散
<FormMessage />  {/* 字段级验证错误 */}
{formError ? <div>...</div> : null}  {/* 后端业务错误，独立展示 */}
```

**修正后（一致）**：
```typescript
// 所有错误都通过 react-hook-form 统一管理
.catch((error) => {
  const { formErrorCode, message, action } = mapTrpcErrorToFormError(error);
  form.setError(formErrorCode, { message });  // ✅ 统一使用 form.setError
  
  if (action?.showResetEmailButton) {
    setShowResetPasswordEmailButton(true);
  }
});

// 展示逻辑统一
<FormMessage />  {/* 字段级错误 */}
<AuthFormErrorAlert formState={form.formState} field="root" />  {/* root 级错误 */}
```

### 5.2 矛盾示例2：展示组件不一致

**修正前（矛盾）**：
```typescript
// Sign-in 页面（不一致）
{credentialsFormError ? (
  <div className="text-destructive text-center text-sm font-medium">
    {credentialsFormError}  {/* ❌ 简单 div */}
  </div>
) : null}

// WidgetForm 页面（正确）
{!queryValidation.valid ? (
  <Alert variant="destructive" className="max-w-sm">
    <AlertCircle className="h-4 w-4" />
    <AlertTitle>Invalid query</AlertTitle>
    <AlertDescription>{queryValidation.reason}</AlertDescription>
  </Alert>
)}
```

**修正后（一致）**：
```typescript
// Sign-in 页面（统一使用 Alert）
<AuthFormErrorAlert formState={form.formState} field="root" />

// WidgetForm 页面（保持不变）
<Alert variant="destructive">...</Alert>
```

### 5.3 矛盾示例3：错误码硬编码导致扩展性差

**修正前（矛盾）**：
```typescript
.catch((error) => {
  if (error instanceof TRPCClientError) {
    // ❌ 硬编码检查，每新增一个错误码都要修改此处
    if (error.data?.code === "UNAUTHORIZED") {
      setShowResetPasswordEmailButton(true);
    }
    if (error.data?.code === "RATE_LIMITED") {  // 新增错误码需要多处修改
      setShowRateLimitWarning(true);
    }
    setFormError(error.message);
  }
});
```

**修正后（一致）**：
```typescript
// 错误映射表集中管理
const AUTH_ERROR_MAPPINGS = {
  UNAUTHORIZED: {
    formErrorCode: "root",
    userMessage: "Authentication failed.",
    action: { showResetEmailButton: true },  // ✅ 声明式配置
  },
  RATE_LIMITED: {
    formErrorCode: "root",
    userMessage: "Too many attempts. Please try again later.",
    action: { showRateLimitWarning: true },  // ✅ 新增只需修改映射表
  },
};

// 捕获逻辑通用，无需修改
.catch((error) => {
  const { formErrorCode, message, action } = mapTrpcErrorToFormError(error);
  form.setError(formErrorCode, { message });
  
  // ✅ 通用 action 处理
  if (action?.showResetEmailButton) setShowResetPasswordEmailButton(true);
  if (action?.showRateLimitWarning) setShowRateLimitWarning(true);
});
```

---

## 六、最终一致性结论

### 6.1 UNAUTHORIZED 是否应设置 formErrorCode？

**结论：是，但应设置为 `root` 级别的 formErrorCode，而非特定字段。**

**理由**：
1. **与 Alert 展示机制一致**：`root` 级别错误适合用 `<Alert variant="destructive">` 组件展示，与其他功能页面的 Alert 使用模式一致
2. **错误语义匹配**：`UNAUTHORIZED` 是全局认证失败，不属于特定字段（email/password）的验证错误
3. **现有模式支持**：React Hook Form 支持 `root` 级别的自定义错误，通过 `form.setError("root", { message })` 设置
4. **扩展性好**：`root` 级别错误可以携带额外的 action 信息（如显示邮件按钮），不污染字段级错误

### 6.2 统一错误处理的检查清单

| 检查项 | 状态 | 代码位置 |
|--------|------|---------|
| 所有错误通过 `form.setError` 设置 | ✅ 需统一 | |
| `UNAUTHORIZED` → `formErrorCode: "root"` | ✅ 一致 | |
| `NOT_FOUND`/`CONFLICT` → `formErrorCode: "email"` | ✅ 一致 | |
| 使用 `<Alert variant="destructive">` 展示 root 错误 | ✅ 需统一 | |
| 使用 `<FormMessage />` 展示字段级错误 | ✅ 保持现状 | |
| 错误码映射集中在 `AUTH_ERROR_MAPPINGS` | ✅ 需新增 | |
| 错误 action 声明式配置 | ✅ 需新增 | |

---

## 七、关键文件索引

| 文件路径 | 说明 |
|---------|------|
| `web/src/pages/auth/sign-in.tsx:570-646` | 登录页面错误处理 |
| `web/src/features/auth-credentials/components/ResetPasswordPage.tsx:50-107` | 重置密码页面错误处理 |
| `web/src/features/auth-credentials/server/credentialsRouter.ts:33-40` | 后端 UNAUTHORIZED 抛出 |
| `web/src/components/ui/alert.tsx:6-57` | Alert 组件定义 |
| `web/src/pages/project/[projectId]/settings/integrations/blobstorage.tsx:146-150` | Alert 组件使用示例 |
| `web/src/features/public-api/components/CreateLLMApiKeyForm.tsx:1277-1279` | React Hook Form setError 使用示例 |
| `web/src/features/widgets/components/WidgetForm.tsx:1989-1992` | Alert 组件使用示例 |
