export interface ApiDiagnostics {
  message?: string
  method: string
  path: string
  status: number | null
  contentType: string | null
  source: 'cloudflare' | 'nginx' | 'html-proxy' | 'json-api' | 'unknown' | 'network'
  hint: string
  viaCloudflare: boolean
  rayId: string | null
  requestId: string | null
  errorType: string | null
  errorOrigin: string | null
  responseDate: string | null
  receivedAt: string
  bodyTruncated: boolean
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public diagnostics?: ApiDiagnostics,
  ) {
    super(message)
  }
}

const ERROR_BODY_LIMIT = 16 * 1024
const JSON_BODY_LIMIT = 8 * 1024 * 1024
const safeHeader = (value: string | null, max = 160) =>
  value?.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) || null
const identifier = (value: unknown) => {
  const clean = typeof value === 'string' ? value.trim() : ''
  return clean && /^[\w.:-]{1,160}$/.test(clean) ? clean : null
}

async function readBounded(response: Response, limit: number) {
  const reader = response.body?.getReader()
  if (!reader) return { text: '', truncated: false }
  const decoder = new TextDecoder()
  let remaining = limit
  let text = ''
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const taken = Math.min(value.byteLength, remaining)
      text += decoder.decode(value.subarray(0, taken), { stream: true })
      remaining -= taken
      if (!remaining) {
        truncated = true
        await reader.cancel().catch(() => {})
        break
      }
    }
    text += decoder.decode()
    return { text, truncated }
  } finally {
    reader.releaseLock()
  }
}

function diagnose(
  response: Response,
  body: string,
  base: ApiDiagnostics,
  problem?: any,
): ApiDiagnostics {
  const contentType = safeHeader(response.headers.get('content-type'))
  const server = safeHeader(response.headers.get('server')) || ''
  const html =
    /\btext\/html\b/i.test(contentType || '') || /^\s*(?:<!doctype\s+html|<html\b)/i.test(body)
  const rayId =
    identifier(response.headers.get('cf-ray')) ||
    identifier(problem?.ray_id) ||
    (problem?.cloudflare_error === true ? identifier(problem?.instance) : null) ||
    (html
      ? body.match(
          /Cloudflare\s+Ray\s+ID:\s*(?:<[^>]{0,200}>\s*){0,4}([a-f0-9]{12,32}(?:-[a-z]{3})?)/i,
        )?.[1] || null
      : null)
  const errorType =
    identifier(response.headers.get('cf-error-type')) ||
    identifier(problem?.error_name) ||
    identifier(problem?.cf?.error_type)
  const errorOrigin =
    identifier(response.headers.get('cf-error-origin')) ||
    identifier(problem?.error_category) ||
    identifier(problem?.cf?.error_origin)
  const cloudflarePage =
    html && /cf-error-details|cf-error-overview|cloudflare-error|cloudflare\s+ray\s+id/i.test(body)
  const cloudflareProblem =
    problem?.cloudflare_error === true ||
    Boolean(response.headers.get('cf-error-type') || response.headers.get('cf-error-origin'))
  const viaCloudflare = Boolean(rayId || /cloudflare/i.test(server))
  const nginx =
    html && (/nginx/i.test(server) || /<center>\s*nginx(?:\/[\w.-]+)?\s*<\/center>/i.test(body))
  let source: ApiDiagnostics['source'] = html
    ? 'html-proxy'
    : /json/i.test(contentType || '')
      ? 'json-api'
      : 'unknown'
  let hint = '管理入口返回非 JSON 响应，请检查 CDN、反向代理和面板服务。'
  if (cloudflarePage || cloudflareProblem) {
    source = 'cloudflare'
    hint =
      response.status >= 500
        ? 'Cloudflare 错误响应，请检查 Cloudflare → 源站链路、Nginx 和面板日志；此响应无法确认 CNB 请求结果。'
        : 'Cloudflare 错误响应，请检查边缘访问规则、Cloudflare 事件和源站日志。'
  } else if (nginx) {
    source = 'nginx'
    hint = 'Nginx 返回 HTML 错误页，请检查反向代理到面板服务的连接；此页无法确认 CNB 请求结果。'
  } else if (source === 'json-api') {
    hint = '管理接口返回 JSON 错误，请结合面板日志确认具体原因。'
  } else if (viaCloudflare) {
    hint = '管理入口经过 Cloudflare，但无法仅凭代理头确认错误产生层；请检查反向代理和源站日志。'
  }
  return {
    ...base,
    status: response.status,
    contentType,
    source,
    hint,
    viaCloudflare,
    rayId,
    errorType,
    errorOrigin,
    requestId:
      identifier(response.headers.get('x-request-id')) ||
      identifier(response.headers.get('request-id')),
    responseDate:
      safeHeader(response.headers.get('date')) ||
      (typeof problem?.timestamp === 'string' && Number.isFinite(Date.parse(problem.timestamp))
        ? safeHeader(problem.timestamp)
        : null) ||
      (html ? body.match(/\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+UTC\b/)?.[0] || null : null),
  }
}

export function formatApiDiagnostics(value: ApiDiagnostics) {
  return [
    ...(value.message ? [`错误说明: ${value.message}`] : []),
    `请求: ${value.method} ${value.path}`,
    `HTTP 状态: ${value.status ?? '未收到响应'}`,
    `响应类型: ${value.contentType || '未提供'}`,
    `响应来源: ${value.source}`,
    `诊断: ${value.hint}`,
    ...(value.rayId ? [`Cloudflare Ray ID: ${value.rayId}`] : []),
    ...(value.requestId ? [`请求 ID: ${value.requestId}`] : []),
    ...(value.errorType ? [`Cloudflare 错误类型: ${value.errorType}`] : []),
    ...(value.errorOrigin ? [`Cloudflare 错误来源: ${value.errorOrigin}`] : []),
    ...(value.responseDate ? [`响应时间: ${value.responseDate}`] : []),
    `收到时间: ${value.receivedAt}`,
    ...(value.bodyTruncated ? ['响应已达到读取上限，仅提取有限诊断字段。'] : []),
  ].join('\n')
}

export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), method === 'GET' ? 12000 : 150000)
  const requestPath = `/api${path}`.split(/[?#]/)[0]!
  let diagnostics: ApiDiagnostics = {
    method: method.toUpperCase(),
    path: requestPath,
    status: null,
    contentType: null,
    source: 'network',
    hint: '浏览器尚未收到管理接口响应，请检查网络与管理服务。',
    viaCloudflare: false,
    rayId: null,
    requestId: null,
    errorType: null,
    errorOrigin: null,
    responseDate: null,
    receivedAt: new Date().toISOString(),
    bodyTruncated: false,
  }
  const requestLabel = `${diagnostics.method} ${requestPath}`
  try {
    const response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json, application/problem+json',
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: controller.signal,
      cache: 'no-store',
    })
    diagnostics = diagnose(response, '', { ...diagnostics, receivedAt: new Date().toISOString() })
    if (response.status === 401 && path !== '/session')
      window.dispatchEvent(new Event('session-expired'))
    const jsonResponse = /\b(?:application|text)\/(?:[\w.-]+\+)?json\b/i.test(
      response.headers.get('content-type') || '',
    )
    const body = await readBounded(
      response,
      response.ok && jsonResponse ? JSON_BODY_LIMIT : ERROR_BODY_LIMIT,
    )
    let result
    try {
      result = JSON.parse(body.text)
    } catch {
      /* Never retain or render raw HTML error pages. */
    }
    diagnostics = diagnose(
      response,
      body.text,
      { ...diagnostics, bodyTruncated: body.truncated },
      result,
    )
    if (!response.ok) {
      const rawMessage = result?.error?.message ?? result?.detail ?? result?.title
      const original = typeof rawMessage === 'string' ? rawMessage.slice(0, 1000) : null
      const source =
        diagnostics.source === 'cloudflare'
          ? `Cloudflare 返回错误页${response.status >= 500 ? '（源站链路需检查）' : ''}`
          : diagnostics.source === 'nginx'
            ? 'Nginx 返回 HTML 错误页'
            : diagnostics.source === 'html-proxy'
              ? '反向代理返回 HTML 错误页'
              : '管理接口请求失败'
      const message = original
        ? `${original}${diagnostics.source === 'cloudflare' ? ' · Cloudflare 错误响应' : ''}`
        : source
      diagnostics.message = message
      throw new ApiError(
        `${message}（${requestLabel} · HTTP ${response.status}）${diagnostics.rayId ? ` · Ray ID ${diagnostics.rayId}` : ''}`,
        response.status,
        diagnostics,
      )
    }
    if (body.truncated || result === undefined || result === null) {
      diagnostics.message = body.truncated
        ? '管理接口响应超出读取上限'
        : '管理服务返回了无效的 JSON 数据'
      throw new ApiError(
        `${diagnostics.message}（${requestLabel} · HTTP ${response.status}）`,
        502,
        diagnostics,
      )
    }
    return result as T
  } catch (error) {
    if (controller.signal.aborted) {
      diagnostics.message = '请求超时，请检查网络连接后重试'
      diagnostics.hint =
        '读取管理接口超时，请检查网络、反向代理和面板日志；超时不能确认操作是否已经执行。'
      throw new ApiError(`${diagnostics.message}（${requestLabel}）`, 408, diagnostics)
    }
    if (error instanceof ApiError) throw error
    diagnostics.message = '无法连接管理服务，请检查网络连接'
    throw new ApiError(`${diagnostics.message}（${requestLabel}）`, 0, diagnostics)
  } finally {
    window.clearTimeout(timeout)
  }
}
