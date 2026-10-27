import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { callKey, classifyCall, gateOf, parseTags, redact } from '../hooks/reach'
import { SURFACE_SPEC, betaLower, evidenceOf, similarPrecedents, withFloor } from '../hooks/surface'
import {
  detectService,
  markdownToHtml,
  markdownToPlain,
  needsAuthServers,
  nextWorkMorning,
  parseWhen,
  smartLater,
  splitPaths,
} from '../hooks/model'

// The test runner has a real timer; the hooks environment's types don't name it.
declare const setTimeout: (fn: () => void, ms: number) => unknown
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 50))

/** Stands in for the engine beneath the plugin, and records what it was asked to send. */
function engine(on: On, env: Record<string, string> = { HOME: '/nonexistent' }) {
  const submitted: string[] = []
  const registered: Record<string, string> = {}
  const toasts: string[] = []
  on('tool.register', (_, e) => {
    registered[e.name] = e.description

    return { value: { tool: `mcp__hcp__${e.name}` } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: false as const, reason: 'no-surface' as const } }))
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 16, 0) })
  mock.env(on, env)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })

  return Object.assign(submitted, { registered, toasts, clock })
}

const PANE = {
  plugin: 'hcp',
  component: 'Pane',
  requestId: 'hcp',
  props: {
    title: 'HCP',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/**
 * Stands in for the host's files, sips and ffmpeg: every path exists unless it
 * says "missing", a thumbnail is 640x400, and a video holds three frames.
 */
function pictures(on: On) {
  const ran: string[][] = []
  const done = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.id', () => ({ value: 'session-1' }))
  on('fs.stat', (_, e) =>
    e.path.includes('missing') ? { deny: `ENOENT: ${e.path}` } : { value: { kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false } },
  )
  on('fs.read', (_, e) => (e.as === 'bytes' ? { value: { base64: 'AAAA' } } : { deny: `ENOENT: ${e.path}` }))
  on('fs.list', () => ({
    value: ['frame-01.png', 'frame-02.png', 'frame-03.png'].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'sips' && e.argv[1] === '-g') return done('pixelWidth: 640\npixelHeight: 400')
    if (e.argv[0] === 'ffprobe') return done('9.0\n')

    return done()
  })

  return ran
}

const shots = (count: number) => Array.from({ length: count }, (_, at) => ({ path: `/shots/shot-${at + 1}.png`, caption: `shot ${at + 1}` }))

/** The card id from what the tool told Claude. */
const idOf = (posted: { text?: string; result?: unknown }) =>
  /card (\w+)/.exec(posted.text ?? String(posted.result))?.[1] ?? '?'

test('an ask card draws in the pane and sends the pick, on every surface', async ($, on) => {
  const submitted = engine(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const posted = await $.tool.call({
      tool: 'mcp__hcp__ask',
      title: 'Which environment?',
      options: [
        { value: 'nprod', label: 'nprod' },
        { value: 'prod', label: 'prod', hint: 'Reads production' },
      ],
      recommended: ['nprod'],
    })
    const card = { id: idOf(posted) }
    expect(card.id).toMatch(/^c\d+$/)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /Which environment\?/ })).toBeDefined()
    await ui.press({ key: `${card.id}-opt-prod` })
    await ui.press({ key: `${card.id}-send` })

    expect(submitted[submitted.length - 1]).toBe(`[HCP ${card.id}] Which environment? → prod.`)
    expect(await ui.find({ type: 'Text', text: /\(sent\)/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a press mid-turn shows the card as queued at once and ignores repeat presses', async ($, on) => {
  const submitted: string[] = []
  let release = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__hcp__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: false as const, reason: 'no-surface' as const } }))
  mock.clock(on, { now: Date.UTC(2026, 9, 22, 16, 0) })
  mock.env(on, { HOME: '/nonexistent' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // A prompt submitted while Claude works resolves only once the running turn ends.
  on('prompt.submit', async (_, e) => {
    submitted.push(e.text)
    await held

    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const posted = await $.tool.call({ tool: 'mcp__hcp__handoff', title: 'Sign in to the VPN' })
  const card = { id: idOf(posted) }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  void ui.press({ key: `${card.id}-done` })
  void ui.press({ key: `${card.id}-done` })
  void ui.press({ key: `${card.id}-done` })
  await settle()

  expect(submitted.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /Queued/ })).toBeDefined()
  expect(await ui.find({ key: `${card.id}-done` })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Nothing waiting on you/ })).toBeDefined()

  release()
  await settle()
  expect(submitted.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /\(sent\)/ })).toBeDefined()
  await ui.unmount()
})

test('Noted sends no prompt and appends a note Claude reads', async ($, on) => {
  const submitted = engine(on)
  const session = mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const posted = await $.tool.call({
    tool: 'mcp__hcp__ask',
    title: 'Ship it?',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    recommended: ['yes'],
  })
  const card = { id: idOf(posted) }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `${card.id}-nntr` })

  expect(submitted).toEqual([])
  const texts = session.appended().map(row => JSON.stringify(row.message.content))
  expect(texts.some(t => t.includes(`[HCP ${card.id} · NNTR] Ship it? → Yes.`))).toBe(true)
  await ui.unmount()
})

test('a share card draws its text with copy buttons and sends a requested change', async ($, on) => {
  const submitted = engine(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  const posted = await $.tool.call({
    tool: 'mcp__hcp__share',
    title: 'Release note',
    text: '**Shipped** the new dock',
    audience: 'Slack channel',
  })
  const card = { id: idOf(posted) }
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect(await ui.find({ type: 'Text', text: /Release note/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /For: Slack channel/ })).toBeDefined()
  expect(await ui.find({ key: `${card.id}-copy-rich` })).toBeDefined()
  await ui.input({ key: `${card.id}-note`, text: 'Mention the rollback plan' })

  expect(submitted[0]).toBe(`[HCP ${card.id}] Change "Release note": Mention the rollback plan`)
  await ui.unmount()
})

test('an expired gcloud login raises one handoff and tells Claude to stop retrying', async ($, on) => {
  engine(on)
  const session = mock.session(on)
  on('tool.call', () => ({
    isError: true as const,
    result: 'Reauthentication failed. cannot prompt during non-interactive execution.',
    text: 'Reauthentication failed. cannot prompt during non-interactive execution.',
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: "bq query --use_legacy_sql=false 'SELECT 1'" })
  await $.tool.call({ tool: 'Bash', command: "bq query --use_legacy_sql=false 'SELECT 2'" })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Re-authenticate gcloud/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /gcloud auth login --update-adc/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Waiting on you \(1\)/ })).toBeDefined()
  await ui.unmount()
  const notes = session.appended().map(row => JSON.stringify(row.message.content))
  expect(notes.filter(t => t.includes("Don't retry the command")).length).toBe(1)
})

test('a grep that prints the login hint is not an auth failure', () => {
  expect(detectService('grep -rn "gcloud auth login" skills', '')).toBe(undefined)
  expect(detectService("bq query 'SELECT 1'", 'ERROR: Reauthentication failed. cannot prompt during non-interactive execution.')).toBe('gcloud')
  expect(detectService('ls', 'Error: not logged in')).toBe(undefined)
  // A failed sed that printed hcp's own login table is not a login failure either.
  expect(detectService('cd ~/x; sed -n 1,9p hooks/model.ts', "fix: 'gcloud auth login --update-adc'")).toBe(undefined)
})

test('later is five minutes in working hours and the next workday morning outside them', () => {
  const cdt = -300
  const thuAfternoon = Date.UTC(2026, 9, 22, 19, 0) // 14:00 CDT, Thursday
  expect(smartLater(thuAfternoon, cdt).label).toBe('in 5 min')

  const friEvening = Date.UTC(2026, 9, 23, 23, 30) // 18:30 CDT, Friday
  const monday = nextWorkMorning(friEvening, cdt)
  expect(monday).toBe(Date.UTC(2026, 9, 26, 14, 0)) // Monday 09:00 CDT
  expect(smartLater(friEvening, cdt).label).toBe('Mon 09:00')

  expect(parseWhen('30m', thuAfternoon, cdt)?.dueAt).toBe(thuAfternoon + 30 * 60_000)
  expect(parseWhen('9am', thuAfternoon, cdt)?.label).toBe('Fri 09:00')
  expect(parseWhen('15:30', thuAfternoon, cdt)?.label).toBe('15:30')
  expect(parseWhen('check', thuAfternoon, cdt)).toBe(undefined)
})

test("an hcp tool's raw result row is hidden, and other rows are left to the engine", async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine row</Text>
  })
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  const row = (tool: string) =>
    ({
      plugin: 'hcp',
      component: 'ToolResult',
      requestId: 't1',
      props: { tool_use_id: 't1', tool, output: 'Posted as card c1.', isErrored: false },
    }) as const

  for (const surface of ['terminal', 'vscode'] as const) {
    const hidden = await $.ui.mount({ ...row('mcp__hcp__ask'), surface })
    expect(await hidden.find({ type: 'Text', text: /engine row|Posted/ })).toBe(undefined)
    await hidden.unmount()

    const left = await $.ui.mount({ ...row('Bash'), surface })
    expect(await left.find({ type: 'Text', text: /engine row/ })).toBeDefined()
    await left.unmount()
  }
})

test('pictures on a card draw as Image on the terminal and Svg elsewhere', async ($, on) => {
  const submitted = engine(on)
  pictures(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const posted = await $.tool.call({
      tool: 'mcp__hcp__ask',
      title: 'Which layout?',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      media: [...shots(2), { path: '/shots/missing.png' }],
    })
    const card = { id: idOf(posted) }
    expect(String(posted.result)).toMatch(/no such image or video file: \/shots\/missing\.png/)
    const ui = await $.ui.mount({ ...PANE, surface })

    const drawn = await ui.findAll({ type: surface === 'terminal' ? 'Image' : 'Svg' })
    expect(drawn.length).toBe(2)
    if (surface !== 'terminal') expect(String(drawn[0]?.props.source)).toContain('data:image/jpeg;base64,AAAA')
    expect(await ui.find({ type: 'Text', text: /shot 2/ })).toBeDefined()
    await ui.press({ key: `${card.id}-opt-b` })
    await ui.press({ key: `${card.id}-send` })
    expect(submitted[submitted.length - 1]).toBe(`[HCP ${card.id}] Which layout? → B.`)
    await ui.unmount()
  }
})

test('slides flip, keep a note per slide, and only the active card carries hotkeys', async ($, on) => {
  const submitted = engine(on)
  pictures(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const first = { id: idOf(await $.tool.call({ tool: 'mcp__hcp__share', title: 'Release note', text: 'Shipped', media: shots(6) })) }
  const second = {
    id: idOf(
      await $.tool.call({
        tool: 'mcp__hcp__ask',
        title: 'Ship it?',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
      }),
    ),
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ key: `${first.id}-next` }))?.props.hotkey).toBe('l')
  expect((await ui.find({ key: `${second.id}-opt-yes` }))?.props.hotkey).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /Keys once the pane has focus/ })).toBeDefined()

  // j moves the hotkeys to the next card, k back.
  await ui.press({ key: 'nav-next' })
  await settle()
  expect((await ui.find({ key: `${second.id}-opt-yes` }))?.props.hotkey).toBe('1')
  expect((await ui.find({ key: `${first.id}-next` }))?.props.hotkey).toBe(undefined)
  await ui.press({ key: 'nav-prev' })
  await settle()

  await ui.press({ key: `${first.id}-next` })
  expect(await ui.find({ type: 'Text', text: /^2\/6$/ })).toBeDefined()
  await ui.input({ key: `${first.id}-slide-note-1`, text: 'crop the header' })
  expect(await ui.find({ type: 'Text', text: /crop the header/ })).toBeDefined()
  await ui.input({ key: `${first.id}-note`, text: 'Add the date' })
  expect(submitted[0]).toBe(`[HCP ${first.id}] Change "Release note": Add the date On image 2 ("shot 2"): "crop the header"`)
  await ui.unmount()
})

test('a picture dropped into the message field is attached, then sent with the next message', async ($, on) => {
  const submitted = engine(on)
  pictures(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await ui.input({ key: 'quick-0', text: "'/Users/me/shot one.png'" })
  await settle()
  expect(submitted).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Sent with your next message \(1\)/ })).toBeDefined()

  await ui.input({ key: 'quick-1', text: 'what is off here?' })
  await settle()
  expect(submitted[0]).toBe('what is off here?\nAttached, view each with Read before acting:\n- /Users/me/shot one.png')
  expect(await ui.find({ type: 'Text', text: /Sent with your next message/ })).toBe(undefined)
  await ui.unmount()
})

test('a video on a card is sampled into captioned frames that play the video', async ($, on) => {
  engine(on)
  const ran = pictures(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const posted = await $.tool.call({ tool: 'mcp__hcp__handoff', title: 'Check the recording', media: [{ path: '/rec/demo.mov' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(ran.some(argv => argv[0] === 'ffmpeg' && argv.includes('/rec/demo.mov'))).toBe(true)
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(3)
  expect(await ui.find({ type: 'Text', text: /demo\.mov at 1\.1s/ })).toBeDefined()
  expect((await ui.find({ key: `${idOf(posted)}-open-0` }))?.props.label).toBe('▶ Play')
  await ui.unmount()
})

test('typed text yields the image and video paths in it, quoted, escaped or as file URLs', () => {
  expect(splitPaths("look '/a b/c.png' and /x/y\\ z.MOV, ok")).toEqual({ paths: ['/a b/c.png', '/x/y z.MOV'], rest: 'look and ok' })
  expect(splitPaths('file:///tmp/s%20s.jpg')).toEqual({ paths: ['/tmp/s s.jpg'], rest: '' })
  expect(splitPaths('see /etc/hosts and ~/d/p.webp.')).toEqual({ paths: ['~/d/p.webp'], rest: 'see /etc/hosts and' })
})

test('a share copies as paste-ready HTML and plain text, and MCP auth parses', () => {
  expect(markdownToHtml('**Deployed** to `preview`\n- one\n- [PR](https://example.com/1)')).toBe(
    '<p><b>Deployed</b> to <code>preview</code></p><ul><li>one</li><li><a href="https://example.com/1">PR</a></li></ul>',
  )
  expect(markdownToPlain('**Deployed**: [PR](https://example.com/1)')).toBe('Deployed: PR (https://example.com/1)')
  const now = Date.UTC(2026, 9, 22)
  expect(needsAuthServers(`{"gitlab":{"timestamp":${now - 1000}},"old":{"timestamp":0}}`, now)).toEqual(['gitlab'])
  expect(needsAuthServers('not json', now)).toEqual([])
})

test('an extension file adds a watched login, protocol rules and wording', async ($, on) => {
  const { registered, toasts } = engine(on, { HOME: '/home/me', HCP_EXTENSIONS: '~/team.json' })
  on('fs.read', (_, e) =>
    e.path === '/home/me/team.json'
      ? {
          value: JSON.stringify({
            protocol: ['- Shared text names no customers.'],
            services: {
              twg: { label: 'twg', fix: 'twg login', verify: ['twg', 'whoami'], command: '\\btwg\\b', pattern: 'not logged in' },
              broken: { label: 'broken' },
            },
            tools: { share: { append: 'Usually for Teams.', properties: { audience: 'Teams channel or email.' } } },
            labels: { copyRich: 'Copy for Teams' },
          }),
        }
      : { deny: `ENOENT: ${e.path}` },
  )
  on('prompt.compose', () => ({ sections: [] }))
  on('tool.call', () => ({ isError: true as const, result: 'Error: not logged in', text: 'Error: not logged in' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(registered.handoff).toContain('gcloud / bq and twg auth failures')
  expect(registered.share).toContain('Usually for Teams.')
  expect(toasts.some(t => t.includes('service broken needs'))).toBe(true)
  const protocol = (
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] })
  ).sections.find(s => s.id === 'hcp:protocol')?.text ?? ''
  expect(protocol).toContain('- Shared text names no customers.')
  expect(protocol).toContain('Auth failures from gcloud / bq and twg in Bash')

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'twg jira workitem view IS-1' })
  await $.tool.call({ tool: 'mcp__hcp__share', title: 'Note', text: 'hi' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Re-authenticate twg/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Waiting on you \(2\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Copy for Teams/ })).toBeDefined()
  await ui.unmount()
})

// --- the reach contract -------------------------------------------------------

const COMMENT = "gh issue comment 12 -R dipseth/hcp --body 'Fixed in e53aa48, thanks @alice'"

/** The engine's own tools beneath hcp: every call that gets through answers "ran", and is counted. */
function tools(on: On) {
  const ran: string[] = []
  on('tool.call', (_, e) => {
    ran.push(e.tool === 'Bash' ? String((e as unknown as { command: string }).command) : e.tool)

    return { result: 'ran', text: 'ran' }
  })

  return ran
}

/** Jev over the host's fetch: answers each question asked from `p`, and records the bodies sent. */
function jev(on: On, p: Record<string, number>, status = 200) {
  const sent: { headers: Record<string, string>; body: string }[] = []
  on('http.fetch', (_, e) => {
    sent.push({ headers: { ...(e.init?.headers ?? {}) }, body: e.init?.body ?? '' })
    const asked = Object.keys((JSON.parse(e.init?.body ?? '{}') as { questions?: Record<string, unknown> }).questions ?? {})
    const answers = Object.fromEntries(asked.map(k => [k, { type: 'noul', noul: p[k] ?? 0 }]))

    return { value: { status, ok: status < 400, headers: {}, text: status < 400 ? JSON.stringify({ answers, usage: { input_tokens: 400 } }) : 'boom' } }
  })

  return sent
}

/** The ledger's writes, by file. */
function ledger(on: On) {
  const files = new Map<string, string>()
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })

  return files
}

const KEYED = { HOME: '/home/me', HCP_TYPESAFE_API_KEY: 'apikey_SECRET123' }

test('the rules sort calls by who they reach, and quoted text is not a command', () => {
  const at = (tool: string, input: Record<string, unknown>) => classifyCall(tool, input)
  expect(at('Read', { file_path: '/a' }).level).toBe('local')
  expect(at('Bash', { command: 'git status && ls' }).level).toBe('local')
  expect(at('Bash', { command: 'grep -rn "gh issue comment" .' }).level).toBe('local')
  const comment = at('Bash', { command: COMMENT })
  expect(comment.level).toBe('notifies')
  expect(comment.channel).toBe('gh issue comment')
  expect(comment.audience).toEqual(['dipseth/hcp#12'])
  expect(at('Bash', { command: 'git push origin main' })).toMatchObject({ level: 'shared', audience: ['origin main'] })
  expect(at('Bash', { command: 'curl -X POST https://api.example.com/v1 -d @x.json' })).toMatchObject({ source: 'none', audience: ['api.example.com'] })
  expect(at('mcp__claude_ai_weReci__send_recipe_email', { to: 'sam@example.com', body: 'Try this' })).toMatchObject({
    level: 'notifies',
    audience: ['sam@example.com'],
  })
  expect(at('mcp__claude_ai_weReci__search_recipes', { query: 'soup' }).level).toBe('local')
  expect(at('mcp__claude_ai_google-workspace__execute', { code: 'x' }).source).toBe('none')
  expect(at('mcp__linear__create_issue', { title: 'Fix login', assignee: 'ana' })).toMatchObject({ level: 'notifies', why: 'sets assignee, which notifies them' })
  expect(at('mcp__linear__create_issue', { title: 'Fix login' }).source).toBe('none')
  expect(at('mcp__hcp__share', { title: 't', text: 'x' }).level).toBe('local')
  expect(at('Artifact', { file_path: '/p.html' }).level).toBe('own')
  expect(redact('token ghp_abcdef123 and Bearer xyz.abc')).toBe('token [redacted] and [redacted]')
  expect(callKey('Bash', { command: 'a', tool_use_id: 't1' })).toBe(callKey('Bash', { tool_use_id: 't2', command: 'a' }))
  const { tags, problems } = parseTags({ 'mcp__claude_ai_GroceryTrack__*': 'local', 'bash:^make deploy': 'shared', x: 'loud' })
  expect(problems.length).toBe(1)
  expect(classifyCall('Bash', { command: 'make deploy' }, tags).level).toBe('shared')
})

test('the gate holds a call that notifies people unless it fits a grant on every count', () => {
  const t = { same_kind: 0.7, same_audience: 0.8, sensitive: 0.4 }
  expect(gateOf('local', {}, false, t).branch).toBe('pass')
  expect(gateOf('shared', {}, false, t).branch).toBe('badge')
  expect(gateOf(undefined, {}, false, t).branch).toBe('badge')
  expect(gateOf('notifies', {}, false, t).branch).toBe('hold')
  const fits = { same_kind: [0.95], same_audience: [0.9], sensitive: [0.05] }
  expect(gateOf('notifies', fits, true, t).branch).toBe('grant')
  expect(gateOf('notifies', { ...fits, sensitive: [0.6] }, true, t).reason).toContain('new sensitive material')
  expect(gateOf('notifies', { ...fits, same_kind: [0.4] }, true, t).branch).toBe('hold')
  expect(gateOf('notifies', { ...fits, same_audience: [0.75] }, true, t).reason).toContain('a new audience')
})

test('a comment is held with its exact content on a card, and Send lets the same call through once', async ($, on) => {
  const submitted = engine(on, KEYED)
  const ran = tools(on)
  const sent = jev(on, {})
  ledger(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

  const held = await $.tool.call({ tool: 'Bash', command: COMMENT })
  expect(held.deny).toMatch(/^\[hcp\] Held: this gh issue comment call notifies people \(dipseth\/hcp#12\)\. Card r1 is up\./)
  expect(ran).toEqual([])
  expect(sent.length).toBe(0) // a rule knew: no judge asked

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /Send this gh issue comment\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /Fixed in e53aa48, thanks @alice/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /held · card r1/ })).toBeDefined()
  await ui.press({ key: 'r1-send' })
  // It notifies people: the first press says who and that it can't be unsent; nothing goes yet.
  expect(await ui.find({ type: 'Text', text: /notifies dipseth\/hcp#12 and can't be unsent\. Press again/ })).toBeDefined()
  expect(submitted.some(t => t.startsWith('[HCP r1]'))).toBe(false)
  await ui.press({ key: 'r1-send' })
  expect(submitted[submitted.length - 1]).toBe('[HCP r1] Send it: make the held gh issue comment call again, unchanged.')

  expect((await $.tool.call({ tool: 'Bash', command: COMMENT })).deny).toBe(undefined)
  expect(ran).toEqual([COMMENT])
  // The approval was for one call: a third is held again.
  expect((await $.tool.call({ tool: 'Bash', command: COMMENT })).deny).toMatch(/Card r2 is up/)
  expect(await ui.find({ type: 'Text', text: /sent from card r1/ })).toBeDefined()
  await ui.unmount()
})

test('a change request goes back to Claude, and Not now is a note with no reply', async ($, on) => {
  const submitted = engine(on, KEYED)
  tools(on)
  jev(on, {})
  const session = mock.session(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: COMMENT })
  // Typed only where that server was connected when the types were laid.
  await $.tool.call({ tool: 'mcp__claude_ai_weReci__send_recipe_email', to: 'sam@example.com', body: 'Try this soup' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.input({ key: 'r1-note', text: 'drop the thanks' })
  expect(submitted[submitted.length - 1]).toMatch(/^\[HCP r1\] Don't send the gh issue comment call as it is\. Change it: Note: "drop the thanks"/)
  await ui.press({ key: 'r2-not-now' })
  const notes = session.appended().map(row => JSON.stringify(row.message.content))
  expect(notes.some(t => t.includes("[HCP r2 · NNTR] Not now: don't make the weReci send_recipe_email call"))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Nothing waiting on you/ })).toBeDefined()
  await ui.unmount()
})

test('an untagged write is judged by Jev, then haiku when Jev fails, and badged when nobody answers', async ($, on) => {
  engine(on, KEYED)
  const ran = tools(on)
  const files = ledger(on)
  let jevUp = true
  const bodies: string[] = []
  on('http.fetch', (_, e) => {
    bodies.push(e.init?.body ?? '')
    const answers = { notifies: { type: 'noul', noul: 0.9 }, visible: { type: 'noul', noul: 0.9 }, remote: { type: 'noul', noul: 1 } }

    return { value: jevUp ? { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } : { status: 500, ok: false, headers: {}, text: 'down' } }
  })
  let haikuUp = true
  on('model.complete', () => ({
    value: haikuUp
      ? { isAnswered: true as const, text: '{"notifies": 0.1, "visible": 0.2, "remote": 0.9}', usage: { input_tokens: 300, output_tokens: 20 } as never }
      : { isAnswered: false as const, reason: 'empty-reply' as const, usage: {} as never },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const call = { tool: 'mcp__claude_ai_google-workspace__execute', code: 'gmail.send({to: "team@x.com"})' }
  const run = (input: Record<string, unknown>) => $.tool.call(input as never)

  expect((await run(call)).deny).toMatch(/Card r1 is up/)
  expect(bodies[0]).toContain('jev-1.14.0')
  expect(JSON.parse(bodies[0]!).state).toEqual({ call: { channel: 'google-workspace execute', audience: [], content: expect.stringContaining('gmail.send') } })

  jevUp = false
  expect((await run({ ...call, code: 'drive.list()' })).deny).toBe(undefined) // haiku: remote, nobody told
  haikuUp = false
  expect((await run({ ...call, code: 'drive.copy()' })).deny).toBe(undefined) // nobody: badge only
  expect(ran.length).toBe(2)
  const rows = [...files.values()].join('').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  expect(rows.map(r => r.judgedBy)).toEqual(['jev', 'haiku', 'none'])
  expect(rows.map(r => r.branch)).toEqual(['hold', 'pass', 'badge'])
  expect(String(rows[2]!.problems)).toContain('jev: Jev HTTP 500')
})

test('Send and allow similar opens a grant that lets a like call through and holds a new audience', async ($, on) => {
  const submitted = engine(on, KEYED)
  const ran = tools(on)
  const sent = jev(on, { same_kind: 0.94, same_audience: 0.92, sensitive: 0.04 })
  ledger(on)
  on('model.complete', () => ({
    value: { isAnswered: true as const, text: 'a short status note on a GitHub issue', usage: { input_tokens: 10, output_tokens: 10 } as never },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: COMMENT })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'r1-similar-1h' })
  await ui.press({ key: 'r1-similar-1h' })
  expect(submitted[submitted.length - 1]).toContain('Similar gh issue comment calls to the same audience may go through for the next hour')
  await settle()
  expect(await ui.find({ type: 'Text', text: /a short status note on a GitHub issue/ })).toBeDefined()

  await $.tool.call({ tool: 'Bash', command: COMMENT }) // the approved one
  const like = "gh issue comment 12 -R dipseth/hcp --body 'Also shipped the docs'"
  expect((await $.tool.call({ tool: 'Bash', command: like })).deny).toBe(undefined)
  expect(ran).toEqual([COMMENT, like])
  expect(JSON.parse(sent[0]!.body).state.grant.intent).toBe('a short status note on a GitHub issue')
  expect(await ui.find({ type: 'Text', text: /allowed by grant g1/ })).toBeDefined()

  // Another issue is another audience: no grant covers it.
  expect((await $.tool.call({ tool: 'Bash', command: "gh issue comment 13 -R dipseth/hcp --body 'hi'" })).deny).toMatch(/Card r2/)
  // An hour on, the grant is gone.
  await submitted.clock.advance(61 * 60_000)
  expect((await $.tool.call({ tool: 'Bash', command: like.replace('docs', 'site') })).deny).toMatch(/Card r3/)
  await ui.unmount()
})

test('a tag in hcp.json holds a tool, and the key never reaches a card, a prompt or the ledger', async ($, on) => {
  const submitted = engine(on, { HOME: '/home/me', HCP_EXTENSIONS: '~/team.json' })
  tools(on)
  const files = ledger(on)
  files.set('/home/me/team.json', JSON.stringify({ reach: { 'mcp__claude_ai_GroceryTrack__*': 'notifies' } }))
  files.set('/home/me/.claude/.env', 'OTHER=1\nHCP_TYPESAFE_API_KEY="apikey_SECRET123"\n')
  const sent = jev(on, {})
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.tool.call({ tool: 'mcp__claude_ai_GroceryTrack__list_receipts' } as never)).deny).toMatch(/Card r1/)
  const mystery = await $.tool.call({ tool: 'Bash', command: 'curl -X POST https://hooks.example.com -H "Authorization: Bearer apikey_SECRET123" -d x' })
  expect(sent[0]?.headers.authorization).toBe('Bearer apikey_SECRET123') // read from ~/.claude/.env
  expect(sent[0]?.body).not.toContain('SECRET123')
  expect(mystery.deny).toBe(undefined)
  const protocol = (
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  ).sections.find(s => s.id === 'hcp:protocol')?.text ?? ''
  expect(protocol).toContain('held by hcp until the person approves')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /SECRET123/ })).toBe(undefined)
  expect(await ui.find({ type: 'Markdown', text: /SECRET123/ })).toBe(undefined)
  await ui.unmount()
  const written = [...files.entries()].filter(([path]) => path.includes('/ledger/')).map(([, text]) => text).join('')
  expect(written.length).toBeGreaterThan(0)
  expect(written).not.toContain('SECRET123')
  expect(submitted.join('')).not.toContain('SECRET123')
})

// --- decisions as evidence ------------------------------------------------------

/** Jev answering every question it is asked from `answer(key)`. */
function jevBy(on: On, answer: (key: string) => number) {
  const bodies: Record<string, unknown>[] = []
  on('http.fetch', (_, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as { questions?: Record<string, unknown> }
    bodies.push(body)
    const answers = Object.fromEntries(Object.keys(body.questions ?? {}).map(k => [k, { type: 'noul', noul: answer(k) }]))

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers, usage: { input_tokens: 300 } }) } }
  })

  return bodies
}

/** The ledger's rows across its files. */
const rowsOf = (files: Map<string, string>) =>
  [...files.entries()]
    .filter(([path]) => path.includes('/ledger/'))
    .flatMap(([, text]) => text.trim().split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)

const ENV_ASK = {
  tool: 'mcp__hcp__ask' as const,
  title: 'Which environment for the smoke run?',
  kind: 'env-choice',
  options: [
    { value: 'nprod', label: 'nprod' },
    { value: 'prod', label: 'prod' },
  ],
  recommended: ['nprod'],
}

test('past answers on like decisions turn the shadow verdict to tell, and an override scores it wrong', async ($, on) => {
  engine(on, KEYED)
  const files = ledger(on)
  on('fs.list', (_, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path!.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  const before = (id: string) => ({
    type: 'decision',
    decision: { id, source: 'ask', kind: 'env-choice', title: 'Which environment?', choice: 'nprod', alternatives: ['nprod', 'prod'], session: 'old', at: 1, outcome: 'took' },
  })
  // Ten kept calls: enough that even the record's cautious bound clears tell.
  const ids = Array.from({ length: 10 }, (_, at) => `c${at + 1}`)
  files.set('/home/me/.claude/hcp/ledger/2026-10-20.jsonl', ids.map(id => JSON.stringify(before(id))).join('\n') + '\n')
  const bodies = jevBy(on, key => (key.startsWith('same_kind') ? 0.92 : key === 'reversible' ? 0.9 : 0.1))
  await $.session.start({ cwd: '/work/hcp', surface: 'desktop', isInteractive: true })

  const card = { id: idOf(await $.tool.call(ENV_ASK)) }
  await settle()
  const asked = bodies.find(b => (b.questions as Record<string, unknown>).same_kind_0) as { state: { precedents: unknown[] } }
  expect(asked.state.precedents.length).toBe(10)
  expect(JSON.stringify(asked.state)).not.toContain('took') // Jev never sees how the person answered

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `${card.id}-opt-prod` })
  await ui.press({ key: `${card.id}-send` })
  await settle()
  await ui.unmount()

  const rows = rowsOf(files)
  const shadowRow = rows.find(r => r.type === 'shadow' && r.decisionId === card.id)!
  expect(shadowRow).toMatchObject({ pipeline: 'hcp-surface', verdict: 'tell', judgedBy: 'jev' })
  const decided = rows.find(r => r.type === 'decision' && (r.decision as { id: string; session: string }).session !== 'old')!.decision
  expect(decided).toMatchObject({ outcome: 'overrode', picked: 'prod', kind: 'env-choice', repo: 'hcp' })
  expect(rows.find(r => r.type === 'score' && r.decisionId === card.id)).toMatchObject({ name: 'surfaced_right', value: 0, label: 'overrode' })

  const report = (await $.command.run({ command: 'hcp', args: 'shadow', origin: { kind: 'composer' } } as never)).text ?? ''
  expect(report).toContain('champion hcp-surface: would ask 0, tell 1, log 0. Right on 0/1')
  expect(report).toContain('1 times it would have skipped asking when the person wanted a say')
})

test('a decision Claude records shows in the pane, and Disagree sends Claude back to check', async ($, on) => {
  const submitted = engine(on, KEYED)
  const files = ledger(on)
  jevBy(on, () => 0.5)
  await $.session.start({ cwd: '/work/hcp', surface: 'vscode', isInteractive: true })

  const recorded = await $.tool.call({
    tool: 'mcp__hcp__decided',
    title: 'Which date library?',
    choice: 'date-fns',
    alternatives: ['dayjs', 'luxon'],
    kind: 'library',
    why: 'already a dependency',
  } as never)
  expect(String(recorded.result)).toMatch(/^Recorded d1\./)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /Which date library\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /shadow would ask/ })).toBeDefined()

  await ui.input({ key: 'd1-why', text: 'we are moving to Temporal' })
  await settle()
  expect(submitted[submitted.length - 1]).toBe(
    '[HCP d1] I disagree with "Which date library?" (you chose date-fns). we are moving to Temporal Undo what you did on the strength of it where you can, tell me what you reverted, and check with me before choosing again.',
  )
  expect(await ui.find({ type: 'Text', text: /you disagreed/ })).toBeDefined()
  await ui.unmount()
  const row = rowsOf(files).find(r => r.type === 'score')
  expect(row).toMatchObject({ value: 1, label: 'disagreed' }) // the shadow said ask, and the person wanted a say
})

test('Claude writes a pipeline: problems come back to fix, a good one is saved, drawn, run, and a challenger is shadowed', async ($, on) => {
  engine(on, KEYED)
  const files = ledger(on)
  jevBy(on, key => (key === 'breaking' ? 0.85 : 0.2))
  await $.session.start({ cwd: '/work/hcp', surface: 'desktop', isInteractive: true })
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__hcp__pipeline', ...input } as never)

  expect(String((await call({ action: 'describe' })).result)).toContain('hcp.precedents@1')
  const bad = String((await call({ action: 'define', scope: 'external', spec: { id: 'x', nodes: {} } })).result)
  expect(bad).toMatch(/^Not saved; fix every problem/)

  const spec = {
    id: 'release-risk',
    fact: 'risk',
    input: 'json',
    output: 'json',
    trigger: ['on-demand'],
    group: 'release-{version}',
    result: ['careful', 'ship'],
    nodes: {
      judge: { kind: 'decide', questions: 'release-risk', version: '1' },
      gate: {
        kind: 'code',
        role: 'gate',
        inputs: { b: 'judge.breaking' },
        branches: ['careful', 'ship'],
        thresholds: { breaking: 0.6 },
        rules: [{ when: 'b[0] >= $t.breaking', branch: 'careful', reason: "'likely breaking'" }, { branch: 'ship', reason: "'looks safe'" }],
        version: '1',
      },
      careful: { kind: 'code', role: 'derive', expr: '{ "advice": "stage it first" }', version: '1' },
      ship: { kind: 'code', role: 'derive', expr: '{ "advice": "ship it" }', version: '1' },
    },
    edges: [
      { from: 'judge', to: 'gate' },
      { from: 'gate', to: 'careful', when: { gate: 'gate', branch: 'careful' } },
      { from: 'gate', to: 'ship', when: { gate: 'gate', branch: 'ship' } },
    ],
    feedback: [
      { id: 'outcome', from: 'surface:release', to: 'gate', source: 'explicit', scope: 'user', form: 'score', latency: 'deferred', score: { name: 'risk_right', dataType: 'BOOLEAN' } },
    ],
    eval: { dataset: 'release-eval', gateMetric: 'score_positive' },
  }
  const questions = { 'release-risk': { breaking: { type: 'noul', instructions: 'Does `input.changes` remove or rename anything users call?' } } }
  const saved = String((await call({ action: 'define', scope: 'external', spec, questions })).result)
  expect(saved).toContain('Saved release-risk')
  expect(files.get('/home/me/.claude/hcp/pipelines/external/release-risk.svg')).toContain('<svg')
  const ran = String((await call({ action: 'run', name: 'release-risk', input: { version: '0.3', changes: 'renamed ask to choose' } })).result)
  expect(ran).toMatch(/^release-risk → careful, judged by jev/)
  expect(ran).toContain('likely breaking')

  // An internal challenger: the champion's spec with a stricter tell threshold, run in shadow on the next decision.
  const strict = JSON.parse(JSON.stringify(SURFACE_SPEC)) as { id: string; nodes: { gate: { thresholds: Record<string, number> } } }
  strict.id = 'hcp-surface-strict'
  strict.nodes.gate.thresholds.tell = 0.95
  expect(String((await call({ action: 'define', scope: 'internal', spec: strict })).result)).toContain('runs in shadow beside hcp-surface')
  await $.tool.call(ENV_ASK)
  await settle()
  const shadows = rowsOf(files).filter(r => r.type === 'shadow').map(r => r.pipeline)
  expect(shadows).toEqual(['hcp-surface', 'hcp-surface-strict'])
})

test('with Langfuse set, a run is a trace with a span per node, and the card answer is a score on that trace', async ($, on) => {
  engine(on, {
    ...KEYED,
    HCP_LANGFUSE_PUBLIC_KEY: 'pk-lf-1',
    HCP_LANGFUSE_SECRET_KEY: 'sk-lf-1',
    HCP_LANGFUSE_BASE_URL: 'https://lf.example.com/',
  })
  tools(on)
  ledger(on)
  const posts: { url: string; auth: string; body: Record<string, unknown> }[] = []
  on('http.fetch', (_, e) => {
    posts.push({ url: e.url, auth: e.init?.headers?.authorization ?? '', body: JSON.parse(e.init?.body ?? '{}') as Record<string, unknown> })

    return { value: { status: 207, ok: true, headers: {}, text: '{}' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: COMMENT })
  await settle()

  const batch = posts.find(p => p.url === 'https://lf.example.com/api/public/ingestion')!
  expect(batch.auth).toBe('Basic cGstbGYtMTpzay1sZi0x') // base64("pk-lf-1:sk-lf-1")
  const events = batch.body.batch as { type: string; body: { id: string; traceId?: string; name: string; tags?: string[] } }[]
  expect(events[0]).toMatchObject({ type: 'trace-create', body: { name: 'pipeline:hcp-reach', tags: expect.arrayContaining(['hcp', 'reach']) } })
  const traceId = events[0]!.body.id
  expect(events.filter(ev => ev.type === 'span-create').every(ev => ev.body.traceId === traceId)).toBe(true)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'r1-not-now' })
  await settle()
  await ui.unmount()
  const score = posts.find(p => p.url === 'https://lf.example.com/api/public/scores')!
  expect(score.body).toMatchObject({ traceId, name: 'hold_needed', value: 1, dataType: 'BOOLEAN' })
})

test('with no environment, the Jev key comes from the plugin settings', { options: { typesafe_api_key: 'apikey_FROMCONFIG' } }, async ($, on) => {
  engine(on, { HOME: '/home/me' })
  tools(on)
  ledger(on)
  const sent = jev(on, {})
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'curl -X POST https://hooks.example.com -d x' })
  expect(sent[0]?.headers.authorization).toBe('Bearer apikey_FROMCONFIG')
})

test(
  'Langfuse keys from the plugin settings turn tracing on, and the environment wins over them',
  { options: { langfuse_public_key: 'pk-cfg', langfuse_secret_key: 'sk-cfg', langfuse_base_url: 'https://lf.example.com' } },
  async ($, on) => {
    engine(on, { ...KEYED, HCP_LANGFUSE_SECRET_KEY: 'sk-env' })
    tools(on)
    ledger(on)
    const posts: { url: string; auth: string }[] = []
    on('http.fetch', (_, e) => {
      posts.push({ url: e.url, auth: e.init?.headers?.authorization ?? '' })

      return { value: { status: 207, ok: true, headers: {}, text: '{}' } }
    })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: COMMENT })
    await settle()

    const batch = posts.find(p => p.url === 'https://lf.example.com/api/public/ingestion')
    expect(batch?.auth).toBe('Basic cGstY2ZnOnNrLWVudg==') // base64("pk-cfg:sk-env")
  },
)

const past = (id: string, outcome: string, at = 1, session = 'old') =>
  ({ id, source: 'ask', kind: 'env-choice', title: 'Which environment?', choice: 'nprod', alternatives: [], session, at, outcome }) as never

test('the record promotes only on enough evidence, a Disagree outweighs a Fine, and silence is not agreement', () => {
  const decision = past('c99', 'pending', 99, 'now') as { id: string; session: string }
  const matchAll = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, at) => [`same_kind_${at}`, [0.95]]))
  const t = { match: 0.7, explore: 0 }
  const evidence = (items: never[]) => evidenceOf(decision as never, items, matchAll(items.length), t)

  // Three kept calls look like 80% kept, but the cautious bound stays low.
  const three = evidence([past('a', 'took'), past('b', 'took'), past('c', 'took')])
  expect(three.rate).toBe(0.8)
  expect(three.lower).toBeLessThan(0.6)
  const ten = evidence(Array.from({ length: 10 }, (_, at) => past(`k${at}`, 'took', at)))
  expect(ten.lower).toBeGreaterThan(0.7)

  // One Disagree among ten Fines pulls the record down as much as three Fines push it up.
  const withNo = evidence([...Array.from({ length: 9 }, (_, at) => past(`k${at}`, 'agreed', at)), past('no', 'disagreed', 0)])
  expect(withNo.rate).toBe(Math.round((10 / 14) * 1000) / 1000)
  expect(withNo.lastNo).toBe(false)
  // The newest going against Claude asks again at once.
  expect(evidence([past('k1', 'took', 1), past('no', 'overrode', 5)]).lastNo).toBe(true)

  // Unanswered and dismissed cards never become precedents.
  const pool = [past('p', 'pending'), past('d', 'dismissed'), past('t', 'took')]
  expect((similarPrecedents(decision as never, pool) as { id: string }[]).map(d => d.id)).toEqual(['t'])
  expect(betaLower(1, 1)).toBeLessThan(0.1)
})

test('the floor turns any verdict back to ask for choices that reach people or are hard to undo', () => {
  const tell = { verdict: 'tell', reason: 'your record: at least 80% kept' }
  expect(withFloor({ reach: 'notifies' } as never, tell)).toEqual({ verdict: 'ask', reason: 'floor: it notifies people', wanted: 'tell' })
  expect(withFloor({ reach: 'shared' } as never, { verdict: 'log', reason: 'x' })).toMatchObject({ verdict: 'ask', wanted: 'log' })
  expect(withFloor({ reversible: false } as never, tell)).toMatchObject({ verdict: 'ask', reason: 'floor: hard to undo' })
  expect(withFloor({ reach: 'own', reversible: true } as never, tell)).toEqual(tell)
})

test('a hard-to-undo ask hides the recommendation until the person picks, and the answer time is kept', async ($, on) => {
  const submitted = engine(on, KEYED)
  const files = ledger(on)
  jevBy(on, () => 0.5)
  await $.session.start({ cwd: '/work/hcp', surface: 'desktop', isInteractive: true })
  const card = { id: idOf(await $.tool.call({ ...ENV_ASK, reversible: false } as never)) }
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /pick first; Claude's recommendation shows after you choose/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Claude recommended/ })).toBe(undefined)
  await ui.press({ key: `${card.id}-opt-nprod` })
  expect(await ui.find({ type: 'Text', text: /Claude recommended: nprod/ })).toBeDefined()
  await submitted.clock.advance(12_000)
  await ui.press({ key: `${card.id}-send` })
  await settle()
  await ui.unmount()

  const rows = rowsOf(files)
  const decided = rows.filter(r => r.type === 'decision').pop()!.decision as Record<string, unknown>
  expect(decided).toMatchObject({ outcome: 'took', blind: 'stakes', reversible: false, answeredMs: 12_000 })
  // Hard to undo: the floor keeps the shadow at ask.
  expect(rows.find(r => r.type === 'shadow')).toMatchObject({ verdict: 'ask' })
})

test('a Fine can turn into a Disagree, Change replaces the choice, and the report counts what escaped', async ($, on) => {
  const submitted = engine(on, KEYED)
  ledger(on)
  jevBy(on, () => 0.5)
  await $.session.start({ cwd: '/work/hcp', surface: 'vscode', isInteractive: true })
  const decide = (title: string, choice: string) =>
    $.tool.call({ tool: 'mcp__hcp__decided', title, choice, kind: 'library' } as never)
  await decide('Which date library?', 'date-fns')
  await decide('Which test runner?', 'vitest')
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await submitted.clock.advance(1000)
  await ui.press({ key: 'd1-agree' })
  await settle()
  await ui.press({ key: 'd1-disagree' })
  await settle()
  expect(submitted[submitted.length - 1]).toMatch(/^\[HCP d1\] I disagree with "Which date library\?"/)

  await ui.input({ key: 'd2-change', text: 'use bun test, it is already set up.' })
  await settle()
  expect(submitted[submitted.length - 1]).toBe(
    '[HCP d2] Change "Which test runner?": instead of vitest, use bun test, it is already set up. Rework what you built on vitest to match, and say what changed.',
  )
  expect(await ui.find({ type: 'Text', text: /you changed it: use bun test/ })).toBeDefined()
  await ui.unmount()

  const report = (await $.command.run({ command: 'hcp', args: 'shadow', origin: { kind: 'composer' } } as never)).text ?? ''
  expect(report).toContain('Attention (are answers judgments or rubber stamps?):')
  expect(report).toContain('- library: 2 answered')
  expect(report).toContain('Escaped: 1 of 1 Fines were later reversed.')
})

test('the person can edit a held message: the edited call goes through, the original does not', async ($, on) => {
  const submitted = engine(on, KEYED)
  const ran = tools(on)
  jev(on, {})
  ledger(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: COMMENT })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const edited = "gh issue comment 12 -R dipseth/hcp --body 'Fixed in e53aa48.'"

  await ui.input({ key: 'r1-edit', text: edited })
  await ui.input({ key: 'r1-edit', text: edited })
  expect(submitted[submitted.length - 1]).toContain("[HCP r1] Send it with the person's edits")
  expect(submitted[submitted.length - 1]).toContain(edited)

  expect((await $.tool.call({ tool: 'Bash', command: COMMENT })).deny).toMatch(/Card r2/)
  expect((await $.tool.call({ tool: 'Bash', command: edited })).deny).toBe(undefined)
  expect(ran).toEqual([edited])
  await ui.unmount()
})
