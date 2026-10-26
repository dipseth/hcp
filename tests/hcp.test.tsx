import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: false as const, reason: 'no-surface' as const } }))
  mock.clock(on, { now: Date.UTC(2026, 9, 22, 16, 0) })
  mock.env(on, env)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })

  return Object.assign(submitted, { registered, toasts })
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
