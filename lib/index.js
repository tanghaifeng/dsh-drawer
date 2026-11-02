/**
 * dsh-drawer —— host 半入口。
 *
 * 职责只有一件：给浏览器半提供「每个全局面板来自哪个插件、插件是自己的还是下载的」，
 * 用于抽屉里「常驻内置 / 下载的第三方插件 / 我的插件」的分组。
 *
 * 只读 profile 目录（package.json / node_modules / cordis.patch.yml），不写任何文件。
 * 浏览器半通过同源 POST `/api/dsh-drawer/context` 取值，取不到时前端按内置兜底分组。
 *
 * @module dsh-drawer
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 插件名（bundle id）。 */
export const name = 'drawer'

/** 静态注入：HTTP 路由注册需要 webServer。 */
export const inject = ['webServer']

/** 统一 API 前缀。 */
export const API_PREFIX = '/api/dsh-drawer'

/** JSON body 上限（64KB，本插件请求体很小）。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 解析 profile 目录：优先插件配置，其次环境变量，最后 ~/.dsh/profiles/<profile>。
 *
 * @param {object} config 插件配置。
 * @returns {string} profile 绝对路径。
 */
function resolveProfileDir(config) {
  if (config && typeof config.profileDir === 'string' && config.profileDir.trim()) {
    return path.resolve(config.profileDir.trim())
  }
  if (process.env.DSH_PROFILE_DIR) return path.resolve(process.env.DSH_PROFILE_DIR)
  const profile = process.env.DSH_PROFILE || 'desktop'
  return path.join(os.homedir(), '.dsh', 'profiles', profile)
}

/**
 * 读 JSON 文件，失败返回 null。
 *
 * @param {string} file 绝对路径。
 * @returns {any} 解析结果。
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 列出 profile/node_modules 里的包名（展开 @scope）。
 *
 * @param {string} profileDir profile 目录。
 * @returns {string[]} 包名列表。
 */
function listInstalledPackages(profileDir) {
  const nm = path.join(profileDir, 'node_modules')
  let entries = []
  try {
    entries = fs.readdirSync(nm)
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      let scoped = []
      try {
        scoped = fs.readdirSync(path.join(nm, entry))
      } catch {
        continue
      }
      for (const sub of scoped) names.push(`${entry}/${sub}`)
    } else {
      names.push(entry)
    }
  }
  return names
}

/**
 * 判断包来源：
 * - `builtin`：随 DSH 发行的 @deepseek-ai/* 包；
 * - `own`：软链到 profile 之外的本地开发目录（例如 workspace/.dsh/plugins）；
 * - `third`：从 npm 装进 profile/node_modules 的包。
 *
 * @param {string} origin 包名。
 * @param {string} full 包在 profile/node_modules 下的绝对路径。
 * @param {string} nm profile/node_modules 绝对路径。
 * @returns {{origin: 'builtin'|'own'|'third', link: boolean, realPath: string|null}} 分类结果。
 */
function classifyPackage(origin, full, nm) {
  const builtin = origin.startsWith('@deepseek-ai/')
  let link = false
  let realPath = full
  try {
    const stat = fs.lstatSync(full)
    link = stat.isSymbolicLink()
    if (link) realPath = fs.realpathSync(full)
  } catch {
    return { origin: builtin ? 'builtin' : 'third', link: false, realPath: null }
  }
  if (builtin) return { origin: 'builtin', link, realPath: link ? realPath : null }
  const inside = realPath === full || realPath.startsWith(nm + path.sep)
  return { origin: inside ? 'third' : 'own', link, realPath: link ? realPath : null }
}

/**
 * 读取某个已安装包的 package.json 元数据（读不到返回空对象）。
 *
 * @param {string} profileDir profile 目录。
 * @param {string} name 包名。
 * @returns {{description: string, version: string, hasClient: boolean}} 元数据。
 */
function readPackageMeta(profileDir, name) {
  const pkg = readJson(path.join(profileDir, 'node_modules', name, 'package.json')) || {}
  return {
    description: typeof pkg.description === 'string' ? pkg.description : '',
    version: typeof pkg.version === 'string' ? pkg.version : '',
    hasClient: !!(pkg.dsh && pkg.dsh.client),
  }
}

/**
 * 从 cordis.patch.yml 里提取 `id → name` 行（忽略 disabled 等其它字段）。
 *
 * @param {string} profileDir profile 目录。
 * @returns {{id: string, name: string}[]} 行列表。
 */
function readPatchRows(profileDir) {
  let text = ''
  try {
    text = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  } catch {
    return []
  }
  const rows = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const idMatch = line.match(/^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/)
    if (idMatch) {
      current = { id: idMatch[1] }
      continue
    }
    const nameMatch = line.match(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/)
    if (nameMatch && current) {
      current.name = nameMatch[1]
      rows.push(current)
      current = null
    }
  }
  return rows
}

/**
 * 采集 profile 信息（只读）。
 *
 * @param {string} profileDir profile 目录。
 * @returns {object} 上下文。
 */
export function collectContext(profileDir) {
  const pkg = readJson(path.join(profileDir, 'package.json')) || {}
  const nm = path.join(profileDir, 'node_modules')
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.filter((v) => typeof v === 'string') : []
  const dependencies = Object.keys(pkg?.dependencies || {})
  const packages = []
  for (const name of listInstalledPackages(profileDir)) {
    const info = classifyPackage(name, path.join(nm, name), nm)
    packages.push({ name, ...info })
  }
  const rows = readPatchRows(profileDir)
  const names = new Set([...bundles, ...dependencies])
  for (const row of rows) if (row.name) names.add(row.name)
  const installed = []
  for (const name of names) {
    const info = packages.find((item) => item.name === name)
    const meta = readPackageMeta(profileDir, name)
    const origin = name.startsWith('@deepseek-ai/') ? 'builtin' : (info ? info.origin : 'third')
    installed.push({
      name,
      origin,
      description: meta.description,
      version: meta.version,
      hasClient: meta.hasClient,
      local: !!(info && info.link),
    })
  }
  installed.sort((a, b) => a.name.localeCompare(b.name))
  return { profileDir, dependencies, bundles, packages, rows, installed }
}

/**
 * loopback + same-origin 围栏（与 dsh-deploy 保持一致）。
 *
 * @param {object} request IncomingMessage。
 * @returns {boolean} 是否放行。
 */
function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request?.headers?.host
  if (typeof host !== 'string' || !host) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * 写 JSON 响应。
 *
 * @param {object} res ServerResponse。
 * @param {number} status 状态码。
 * @param {object} body 响应体。
 * @returns {void}
 */
function writeJson(res, status, body) {
  let payload
  try {
    payload = JSON.stringify(body)
  } catch {
    payload = JSON.stringify({ ok: false, error: '响应序列化失败' })
    status = 400
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * 读 JSON body（上限 64KB）。
 *
 * @param {object} req IncomingMessage。
 * @returns {Promise<object|undefined>} 解析结果。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return undefined
      chunks.push(chunk)
    }
  } catch {
    return undefined
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 构造路由。
 *
 * @param {object} config 插件配置。
 * @returns {{kind: 'exact', path: string, handler: Function}[]} 路由列表。
 */
export function buildRoutes(config) {
  const profileDir = resolveProfileDir(config)
  return [
    {
      kind: 'exact',
      path: `${API_PREFIX}/context`,
      handler: async (req, res) => {
        try {
          if (!isLoopbackRequest(req)) {
            writeJson(res, 403, { ok: false, error: 'loopback only' })
            return
          }
          if (String(req.method ?? '').toUpperCase() !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'POST required' })
            return
          }
          const body = await readJsonBody(req)
          if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
            writeJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
            return
          }
          writeJson(res, 200, { ok: true, ...collectContext(profileDir), config })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
  ]
}

/**
 * Cordis 插件入口。
 *
 * @param {object} ctx host 插件上下文。
 * @param {object} [config] 插件配置。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const pluginConfig = config && typeof config === 'object' ? config : {}
  if (!ctx?.webServer || typeof ctx.webServer.register !== 'function') {
    console.warn('[drawer] ctx.webServer 不可用，来源识别接口未注册（前端按内置规则兜底）')
    return
  }
  const register = () => {
    const disposers = []
    for (const route of buildRoutes(pluginConfig)) {
      try {
        disposers.push(ctx.webServer.register(route))
      } catch (error) {
        console.warn(`[drawer] 注册路由 ${route.path} 失败: ${String(error?.message ?? error)}`)
      }
    }
    console.log(`[drawer] 已注册 ${disposers.length} 个 HTTP 路由（${API_PREFIX}）`)
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* 忽略释放失败 */
        }
      }
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(register, 'drawer: routes')
  else register()
}
