// Pictures on cards and from the person: thumbnails made with sips, video
// frames sampled with ffmpeg, and the bytes a drawing needs. Files live under
// <TMPDIR>/hcp-media/<session>/; $.state keeps only their paths.

import type { EngineInterface } from 'claude-code'

import type { HcpMedia } from '../types'
import { MAX_MEDIA, VIDEO_FILE, isMediaFile } from './model'

type Engine = EngineInterface

/** An Svg's whole source is held to 131072 characters; the jpeg's base64 stays under this. */
const SVG_BUDGET = 128_000
const FFMPEG = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
const FFPROBE = ['ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']

// Thumbnail base64 by file: read once, refilled after a reload, never put in $.state.
const bytes = new Map<string, string>()
let mediaDir: string | undefined
let made = 0

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

async function dir($: Engine) {
  if (mediaDir === undefined) {
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
    const at = `${tmp}/hcp-media/${await $.session.id()}`
    await $.process.run(['mkdir', '-p', at], { timeoutMs: 5000 })
    mediaDir = at
  }

  return mediaDir
}

/** The first of `bins` that starts; undefined where none is installed. */
async function runAny($: Engine, bins: readonly string[], args: readonly string[], timeoutMs: number) {
  for (const bin of bins) {
    try {
      return await $.process.run([bin, ...args], { timeoutMs })
    } catch {
      // Not on this PATH: try the next spelling.
    }
  }

  return undefined
}

async function size($: Engine, path: string) {
  const ran = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeoutMs: 10_000 })
  const width = Number(/pixelWidth: (\d+)/.exec(ran.stdout)?.[1])
  const height = Number(/pixelHeight: (\d+)/.exec(ran.stdout)?.[1])

  return width > 0 && height > 0 ? { width, height } : undefined
}

async function resample($: Engine, from: string, to: string, edge: number, format: 'jpeg' | 'png') {
  const quality = format === 'jpeg' ? ['-s', 'formatOptions', '70'] : []
  const ran = await $.process.run(['sips', '-Z', String(edge), '-s', 'format', format, ...quality, from, '--out', to], {
    timeoutMs: 30_000,
  })

  return ran.exitCode === 0
}

/**
 * The picture at `path` with its thumbnails made: a jpeg an Svg can carry, a
 * smaller one for grids, and a png the terminal reads. Where sips can't read
 * it the picture still stands, drawn as its caption with an Open button.
 */
export async function prepare($: Engine, path: string, caption?: string, video?: string): Promise<HcpMedia> {
  const media: HcpMedia = { path, ...(caption ? { caption } : {}), ...(video ? { video } : {}) }
  try {
    const stem = `${await dir($)}/${String(++made).padStart(3, '0')}-${baseName(path)
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 40)}`
    const source = await size($, path)
    // sips -Z scales up as well as down: a small picture keeps its own size.
    const edge = (wanted: number) => (source ? Math.min(wanted, Math.max(source.width, source.height)) : wanted)
    for (const wanted of [640, 480, 360]) {
      if (!(await resample($, path, `${stem}.jpg`, edge(wanted), 'jpeg'))) break
      const { base64 } = await $.fs.read(`${stem}.jpg`, { as: 'bytes' })
      if (base64.length <= SVG_BUDGET) {
        bytes.set(`${stem}.jpg`, base64)
        media.thumbPath = `${stem}.jpg`
        Object.assign(media, await size($, media.thumbPath))
        break
      }
    }
    if (await resample($, path, `${stem}-mini.jpg`, edge(200), 'jpeg')) media.miniPath = `${stem}-mini.jpg`
    if (await resample($, path, `${stem}.png`, edge(1600), 'png')) media.pngPath = `${stem}.png`
  } catch {
    // No sips, or not a picture it reads: the card shows the caption and path.
  }

  return media
}

/** `count` frames spread over the video, each prepared, captioned with its time. */
export async function sampleVideo($: Engine, path: string, count = 8): Promise<HcpMedia[]> {
  const probe = await runAny($, FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], 30_000)
  const duration = Number(probe?.stdout.trim())
  if (probe?.exitCode !== 0 || !(duration > 0)) return []
  const out = `${await dir($)}/${String(++made).padStart(3, '0')}-${baseName(path).replace(/[^\w.-]+/g, '_')}-frames`
  await $.process.run(['mkdir', '-p', out], { timeoutMs: 5000 })
  const ran = await runAny(
    $,
    FFMPEG,
    ['-v', 'error', '-y', '-i', path, '-vf', `fps=${count}/${duration},scale='min(1280,iw)':-2`, '-frames:v', String(count), `${out}/frame-%02d.png`],
    120_000,
  )
  if (ran?.exitCode !== 0) return []
  const frames = (await $.fs.list(out))
    .map(entry => entry.name)
    .filter(name => name.startsWith('frame-'))
    .sort()

  return Promise.all(
    frames.map((name, at) => prepare($, `${out}/${name}`, `${baseName(path)} at ${((at * duration) / count).toFixed(1)}s`, path)),
  )
}

/** A picture, or a video's frames. */
export async function expand($: Engine, path: string, caption?: string): Promise<HcpMedia[]> {
  return VIDEO_FILE.test(path) ? sampleVideo($, path) : [await prepare($, path, caption)]
}

/** Several pictures or videos, in order, held to MAX_MEDIA in all. */
export async function expandAll($: Engine, items: readonly { path: string; caption?: string }[]): Promise<HcpMedia[]> {
  const each = await Promise.all(items.map(item => expand($, item.path, item.caption)))

  return each.flat().slice(0, MAX_MEDIA)
}

/** The typed paths that name an image or video file that is there, `~` expanded. */
export async function existing($: Engine, paths: readonly string[]): Promise<string[]> {
  const home = await $.env.get('HOME')
  const found = await Promise.all(
    paths.map(async raw => {
      const path = raw.startsWith('~/') && home !== undefined ? `${home}${raw.slice(1)}` : raw
      if (!isMediaFile(path)) return undefined
      const stat = await $.fs.stat(path).catch(() => undefined)

      return stat?.kind === 'file' ? path : undefined
    }),
  )

  return found.filter((path): path is string => path !== undefined)
}

/** Thumbnail bytes for the pictures about to be drawn, by thumbnail path. */
export async function thumbnails($: Engine, media: readonly HcpMedia[]): Promise<ReadonlyMap<string, string>> {
  const wanted = media.flatMap(m => [m.thumbPath, m.miniPath]).filter((p): p is string => p !== undefined)
  await Promise.all(
    wanted
      .filter(path => !bytes.has(path))
      .map(async path => {
        try {
          const { base64 } = await $.fs.read(path, { as: 'bytes' })
          if (base64.length <= SVG_BUDGET) bytes.set(path, base64)
        } catch {
          // Cleaned out of the temp folder: the picture draws as its caption.
        }
      }),
  )

  return bytes
}

/** Writes base64 to a new file under the media folder, through base64 -D since $.fs writes text. */
export async function saveBytes($: Engine, base64: string, name: string): Promise<string | undefined> {
  const path = `${await dir($)}/${String(++made).padStart(3, '0')}-${name.replace(/[^\w.-]+/g, '_')}`
  const ran = await $.process.run(['sh', '-c', 'base64 -D > "$1"', 'sh', path], { stdin: base64, timeoutMs: 10_000 })

  return ran.exitCode === 0 ? path : undefined
}

/**
 * The newest `count` images the engine saved for prompt-box pastes in this
 * session, newest first: where it keeps them (/tmp/claude-<uid>/<project>/<session>/images).
 */
export async function pastedImages($: Engine, count: number): Promise<string[]> {
  const ran = await $.process.run(
    ['sh', '-c', 'ls -t /tmp/claude-"$(id -u)"/*/"$1"/images/* 2>/dev/null | head -n "$2"', 'sh', await $.session.id(), String(count)],
    { timeoutMs: 5000 },
  )

  return ran.stdout.split('\n').filter(line => line.trim())
}
