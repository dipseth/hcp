// Langfuse as the decision pipeline's tracer and scores ports: every run is a
// trace (one span per node), and every card answer is a score on the trace of
// the run it judges. Best effort by contract: Langfuse being down never blocks
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
const iso = (ms: number) => new Date(ms).toISOString()

async function post($: Engine, cfg: LangfuseConfig, path: string, body: unknown) {
  try {
    await $.http.fetch(`${cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: cfg.auth },
      body: JSON.stringify(body),
    })
  } catch {
    // Best effort: the ledger has it.
  }
}

/**
 * A tracer for one run: the root opens a trace whose id is the run id, each
 * node a span under it. The whole trace goes in one batch when the run ends,
 * in the background, so a run never waits on Langfuse.
 */
export function langfuseTracer($: Engine, cfg: LangfuseConfig, extraTags: readonly string[] = []): TracePort {
  const events: Record<string, unknown>[] = []
  let traceId: string | null = null
  const handle = (target: Record<string, unknown>): SpanHandle => ({
    get traceId() {
      return traceId
    },
    setMetadata: metadata => void (target.metadata = { ...(target.metadata as object), ...metadata }),
    setOutput: output => void (target.output = output),
    setTags: tags => void (target.tags = [...new Set([...((target.tags as string[]) ?? []), ...tags])]),
  })

  return {
    async root(opts, fn) {
      traceId = newId()
      const started = Date.now()
      const body: Record<string, unknown> = {
        id: traceId,
        name: opts.name,
        input: opts.input,
        sessionId: opts.group,
        tags: [...opts.tags, ...extraTags],
        metadata: opts.metadata,
        ...(opts.userId ? { userId: opts.userId } : {}),
        timestamp: iso(started),
      }
      try {
        return await fn(handle(body))
      } finally {
        events.unshift({ id: newId(), type: 'trace-create', timestamp: iso(started), body })
        void post($, cfg, '/api/public/ingestion', { batch: events })
      }
    },
    async span(opts, fn) {
      const started = Date.now()
      const body: Record<string, unknown> = { id: newId(), traceId, name: opts.name, input: opts.input, metadata: opts.metadata, startTime: iso(started) }
      try {
        return await fn(handle(body))
      } finally {
        body.endTime = iso(Date.now())
        events.push({ id: newId(), type: 'span-create', timestamp: iso(started), body })
      }
    },
  }
}

/** A card's answer as a Langfuse score on the run's trace. */
export function langfuseScore($: Engine, cfg: LangfuseConfig, score: ScoreRequest): Promise<void> {
  return post($, cfg, '/api/public/scores', {
    traceId: score.runId,
    name: score.name,
    value: score.value,
    dataType: score.dataType,
    ...(score.comment ? { comment: score.comment } : {}),
    ...(score.label ? { comment: [score.label, score.comment].filter(Boolean).join(': ') } : {}),
  })
}
