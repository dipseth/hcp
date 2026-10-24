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
} from '../hooks/model'

// The test runner has a real timer; the hooks environment's types don't name it.
declare const setTimeout: (fn: () => void, ms: number) => unknown
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 50))

/** Stands in for the engine beneath the plugin, and records what it was asked to send. */
function engine(on: On) {
  const submitted: string[] = []
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
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })

  return submitted
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

test('a share copies as paste-ready HTML and plain text, and MCP auth parses', () => {
  expect(markdownToHtml('**Deployed** to `preview`\n- one\n- [PR](https://example.com/1)')).toBe(
    '<p><b>Deployed</b> to <code>preview</code></p><ul><li>one</li><li><a href="https://example.com/1">PR</a></li></ul>',
  )
  expect(markdownToPlain('**Deployed**: [PR](https://example.com/1)')).toBe('Deployed: PR (https://example.com/1)')
  const now = Date.UTC(2026, 9, 22)
  expect(needsAuthServers(`{"gitlab":{"timestamp":${now - 1000}},"old":{"timestamp":0}}`, now)).toEqual(['gitlab'])
  expect(needsAuthServers('not json', now)).toEqual([])
})
