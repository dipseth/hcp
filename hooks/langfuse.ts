// Langfuse as the decision pipeline's tracer and scores ports: every run is a
// trace (one span per node) sent over OTLP/HTTP in Langfuse's v4 shape, and
// every card answer is a score on the run's root observation. Best effort by contract: Langfuse being down never blocks
// a call, a card or a run; the local ledger keeps everything regardless.

import type { EngineInterface, PluginOptions } from 'claude-code'

import { sha256Hex } from './vendor/dp.js'
import type { ScoreRequest, SpanHandle, TracePort } from './vendor/dp.js'

type Engine = EngineInterface

export type LangfuseConfig = { baseUrl: string; auth: string }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 of a UTF-8 string: the hooks runtime has no btoa or Buffer. */
export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (b === undefined ? '=' : B64[(n >> 6) & 63]!) + (c === undefined ? '=' : B64[n & 63]!)
  }

  return out
}

type SecretName = 'HCP_TYPESAFE_API_KEY' | 'HCP_LANGFUSE_PUBLIC_KEY' | 'HCP_LANGFUSE_SECRET_KEY' | 'HCP_LANGFUSE_BASE_URL'

// The plugin's userConfig values, as register(on, options) received them.
// A synced install asks for them once per host; sensitive ones live in the keychain.
let pluginOptions: PluginOptions = {}

export function useOptions(options: PluginOptions): void {
  pluginOptions = options
}

/** The userConfig field for a secret: HCP_LANGFUSE_SECRET_KEY → langfuse_secret_key. */
export const optionKey = (name: SecretName) => name.replace(/^HCP_/, '').toLowerCase()

/**
 * One of hcp's secrets: the session's environment, else the plugin's userConfig,
 * else its line in ~/.claude/.env. Never logged.
 */
export async function secret($: Engine, name: SecretName): Promise<string | undefined> {
  // $.env.get takes a literal name, so the variables a mod reads can be listed.
  const fromEnv =
    name === 'HCP_TYPESAFE_API_KEY'
      ? await $.env.get('HCP_TYPESAFE_API_KEY')
      : name === 'HCP_LANGFUSE_PUBLIC_KEY'
        ? await $.env.get('HCP_LANGFUSE_PUBLIC_KEY')
        : name === 'HCP_LANGFUSE_SECRET_KEY'
          ? await $.env.get('HCP_LANGFUSE_SECRET_KEY')
          : await $.env.get('HCP_LANGFUSE_BASE_URL')
  if (fromEnv) return fromEnv
  const configured = pluginOptions[optionKey(name)]
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  const home = await $.env.get('HOME')
  if (!home) return undefined
  try {
    const line = (await $.fs.read(`${home}/.claude/.env`)).split('\n').find(one => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(one))

    return line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') || undefined
  } catch {
    return undefined
  }
}

/** The Langfuse project hcp reports to, when all three of its variables are set. */
export async function langfuseFrom($: Engine): Promise<LangfuseConfig | undefined> {
  const [publicKey, secretKey, baseUrl] = await Promise.all([
    secret($, 'HCP_LANGFUSE_PUBLIC_KEY'),
    secret($, 'HCP_LANGFUSE_SECRET_KEY'),
    secret($, 'HCP_LANGFUSE_BASE_URL'),
  ])
  if (!publicKey || !secretKey || !baseUrl) return undefined

  return { baseUrl: baseUrl.replace(/\/+$/, ''), auth: `Basic ${base64(`${publicKey}:${secretKey}`)}` }
}

const newId = () => sha256Hex(`${Date.now()}:${Math.random()}:${Math.random()}`).slice(0, 32)
/** The root span's id, derived from the trace id, so a score written later can target the root observation. */
export const rootSpanId = (traceId: string) => traceId.slice(0, 16)
const nanos = (ms: number) => `${Math.round(ms)}000000`

/** The OTLP endpoint and the header that selects Langfuse's v4 (observations-first) ingestion. */
export const OTEL_PATH = '/api/public/otel/v1/traces'
const V4_HEADER = { 'x-langfuse-ingestion-version': '4' }

async function post($: Engine, cfg: LangfuseConfig, path: string, body: unknown, headers: Record<string, string> = {}) {
  try {
    await $.http.fetch(`${cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: cfg.auth, ...headers },
      body: JSON.stringify(body),
    })
  } catch {
    // Best effort: the ledger has it.
  }
}

type AttrValue = { stringValue: string } | { arrayValue: { values: { stringValue: string }[] } }
type Attr = { key: string; value: AttrValue }

const asString = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value ?? null))
const attr = (key: string, value: unknown): Attr =>
  Array.isArray(value) && value.every(v => typeof v === 'string')
    ? { key, value: { arrayValue: { values: (value as string[]).map(v => ({ stringValue: v })) } } }
    : { key, value: { stringValue: asString(value) } }

/** An observation as it is built in memory: exported once, complete, when the run ends. */
type Built = {
  spanId: string
  parentSpanId?: string
  name: string
  type: string
  startMs: number
  endMs?: number
  input?: unknown
  output?: unknown
  metadata: Record<string, unknown>
  isError?: boolean
}

/** A node's observation type: model-backed nodes are generations (with their cost), the rest spans. */
const typeOfNode = (metadata: Record<string, unknown>) => (metadata.kind === 'decide' || metadata.kind === 'generate' ? 'generation' : 'span')

/** One complete OTLP/JSON span, with the trace-wide attributes copied onto it so every observation filters alike. */
function otlpSpan(traceId: string, b: Built, shared: Attr[]) {
  const attributes: Attr[] = [
    ...shared,
    attr('langfuse.observation.type', b.type),
    ...(b.input !== undefined ? [attr('langfuse.observation.input', b.input)] : []),
    ...(b.output !== undefined ? [attr('langfuse.observation.output', b.output)] : []),
    ...Object.entries(b.metadata)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => attr(`langfuse.observation.metadata.${k}`, v)),
    ...(b.type === 'generation' && typeof b.metadata.cost_usd === 'number' ? [attr('langfuse.observation.cost_details', { total: b.metadata.cost_usd })] : []),
  ]

  return {
    traceId,
    spanId: b.spanId,
    ...(b.parentSpanId ? { parentSpanId: b.parentSpanId } : {}),
    name: b.name,
    kind: 1,
    startTimeUnixNano: nanos(b.startMs),
    endTimeUnixNano: nanos(b.endMs ?? b.startMs),
    attributes,
    status: { code: b.isError ? 2 : 1 },
  }
}

/**
 * A tracer for one run, in Langfuse's v4 shape: the run is one OTEL trace
 * whose id is the run id, the root observation carries the run's input and
 * output, and each node is a child span. Trace name, session, tags and user
 * are copied onto every span. Nothing is sent until the run ends; then the
 * whole trace goes in one OTLP/HTTP request in the background, so a run never
 * waits on Langfuse and no span is ever exported twice.
 */
export function langfuseTracer($: Engine, cfg: LangfuseConfig, extraTags: readonly string[] = []): TracePort {
  const children: Built[] = []
  let traceId: string | null = null
  let root: Built | undefined
  const handle = (target: Built, tags?: string[]): SpanHandle => ({
    get traceId() {
      return traceId
    },
    setMetadata: metadata => void (target.metadata = { ...target.metadata, ...metadata }),
    setOutput: output => void (target.output = output),
    setTags: more => void (tags && tags.push(...more.filter(t => !tags.includes(t)))),
  })

  return {
    async root(opts, fn) {
      traceId = newId()
      const tags = [...new Set([...opts.tags, ...extraTags])]
      root = { spanId: rootSpanId(traceId), name: opts.name, type: 'chain', startMs: Date.now(), input: opts.input, metadata: { ...opts.metadata } }
      let failed = false
      try {
        return await fn(handle(root, tags))
      } catch (error) {
        failed = true
        throw error
      } finally {
        root.endMs = Date.now()
        root.isError = failed
        const shared = [
          attr('langfuse.trace.name', opts.name),
          attr('langfuse.session.id', opts.group),
          attr('langfuse.trace.tags', tags),
          ...(opts.userId ? [attr('langfuse.user.id', opts.userId)] : []),
        ]
        const id = traceId
        const spans = [root, ...children].map(b => otlpSpan(id, b, shared))
        void post(
          $,
          cfg,
          OTEL_PATH,
          { resourceSpans: [{ resource: { attributes: [attr('service.name', 'hcp')] }, scopeSpans: [{ scope: { name: 'hcp' }, spans }] }] },
          V4_HEADER,
        )
      }
    },
    async span(opts, fn) {
      const built: Built = {
        spanId: newId().slice(0, 16),
        ...(root ? { parentSpanId: root.spanId } : {}),
        name: opts.name,
        type: 'span',
        startMs: Date.now(),
        input: opts.input,
        metadata: { ...opts.metadata },
      }
      try {
        return await fn(handle(built))
      } catch (error) {
        built.isError = true
        throw error
      } finally {
        built.endMs = Date.now()
        built.type = typeOfNode(built.metadata)
        children.push(built)
      }
    },
  }
}

/** A card's answer as a Langfuse score on the run's trace. */
export function langfuseScore($: Engine, cfg: LangfuseConfig, score: ScoreRequest): Promise<void> {
  // POST /scores stays the supported write path in v4. The root observation is the run's v4 target.
  const comment = [score.label, score.comment].filter(Boolean).join(': ')

  return post($, cfg, '/api/public/scores', {
    traceId: score.runId,
    ...(/^[0-9a-f]{32}$/.test(score.runId) ? { observationId: rootSpanId(score.runId) } : {}),
    name: score.name,
    value: score.value,
    dataType: score.dataType,
    ...(comment ? { comment } : {}),
  })
}
