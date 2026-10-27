# hcp: Human Context Protocol

Clickable seams between you and Claude, so a decision is a click instead of a paragraph. One shared surface, of many: a pluribus.

**Claude posts cards** (tools `mcp__hcp__ask`, `mcp__hcp__handoff`, `mcp__hcp__share`). They draw inline at the tool row and in the HCP pane:

- **ask**: options as buttons (single or multi), the recommendation preselected, an optional draft to approve, and a note field. A choice Claude marks `reversible: false` or `reach: shared|notifies` hides the recommendation until you pick, and so does a random 5% of low-stakes cards (see Decisions as evidence).
- **handoff**: a step only you can do. An expired gcloud/bq login in any Bash call raises one automatically, and Claude is told to stop retrying. **Run it** opens the browser login and then verifies with a bq dry run. **Put in prompt** fills `! <command>`. An MCP server that needs authorizing raises one too, the first time Claude searches for its tools; the pane also shows a 🔑 line while the engine lists any server as needing auth.
- **share**: text for somewhere else. **Copy formatted** puts HTML and plain text on the clipboard together, so bold, lists and links survive the paste into Slack, mail or a doc; **Copy plain** is text alone. A note asks Claude for a change.

**Every answer has three deliveries:**

- **Send** starts a turn.
- **Noted** (NNTR) is a note Claude reads, mid-run if it's working, without replying.
- **Later** sends in 5 minutes during working hours (weekdays 08:00–18:00), otherwise at 09:00 on the next workday.

**From you to Claude:**

- **Mode**, which tells Claude how much to involve you until you change it:
  - **Pairing** (default): ask freely, with a card whenever a decision comes up.
  - **Heads-down**: batch questions into one card, keep updates to a line, decide reversible things without asking.
  - **Away**: don't wait on you. Take safe, reversible defaults, leave questions as cards, and make no outward-facing writes (issues, PRs, Slack, deploys) until you're back.
- **Concise** toggle.
- **Steers** sent mid-run: Don't code yet, Check with me first, Narrow scope, Wrap up.
- **Quick replies:** Yes, No, Yes · NNTR, No · NNTR, 👀 Seen.
- **Message field** with Send / NNTR / Later.

**Pictures:**

- Claude passes `media` (image paths with captions, or a video) on any card. Up to 4 draw as a grid, more as **slides** with ‹ › and a note per slide that goes back with the answer. A video is sampled into 8 frames (ffmpeg), and **▶ Play** opens the original. Thumbnails are made with `sips` under `$TMPDIR/hcp-media/<session>/`.
- The terminal draws them with its native image support (kitty, Ghostty, iTerm2 3.5+; elsewhere the caption shows, with **⤢ Open**). Desktop, VS Code and mobile draw them as an SVG thumbnail.
- **To send Claude a picture**, drop an image or video file into the message field (or type its path) and press Enter. It's attached with a thumbnail, then sent with your next message as paths Claude reads. A path in a card's note is attached the same way. Pictures you paste into the normal prompt box also show under **You sent**.

**Keys** (terminal; focus the pane with ctrl+x tab or `/hcp`, and Tab off a text field first): `j`/`k` next/previous card · `1`–`8` pick an option · `s` send/copy/done · `x` dismiss · `h`/`l` previous/next slide · `o` open · `y`/`n` quick Yes/No. New cards never take the focus.

**Commands:**

- `/hcp [pairing|heads-down|away|clear]`: open the pane. Where no pane is placed, the inbox draws inline.
- `/nntr <note>`: tell Claude something without a reply.
- `/later [30m|2h|9am|14:30|tomorrow] <message>`: schedule a message.

Scheduled messages live as long as the session: closing it drops them.

## Reach: calls that contact people

Every tool call is sorted by who it reaches: **local** (this machine), **own** (your accounts, nobody told), **shared** (others can see it), **notifies** (a person gets a message).

- **notifies** calls are held. The call fails for Claude with "[hcp] Held … card r<n>", and a reach card shows the exact content and who it goes to. You can answer:
  - **Send**: Claude makes the same call again. That exact call runs once, and Claude Code doesn't ask permission a second time. A message can't be unsent, so the first press says who gets it and the second press sends.
  - **Send · allow similar 1h** or **… for today**: also opens a grant.
  - **Save as draft**.
  - **Not now**.
  - **Edit** the content in place and press Enter (twice, as with Send): Claude makes the call with your text, and it runs without another card if the content matches.
  - Or tell Claude what to change.
- **shared** calls run with a badge on the tool row, for example `↗ git push · origin main · others can see`. **local** and **own** calls run untouched.
- **A grant** lets later calls through without a card, until it expires. A call qualifies only when it uses the same channel (`gh issue comment`), reaches nobody outside the grant's audience, and the judge finds it the same kind of message with no new sensitive material. Anything less gets a card. The pane lists grants with a countdown and **Revoke**, and lists everything outward this session.
- **Claude reads the contract first.** The protocol and the descriptions of tools that notify people say so, so Claude makes the call and lets hcp ask, instead of asking twice.

How a call is sorted is a [decision pipeline](https://github.com/dipseth/decision-pipeline) (`hooks/reach.ts`): models estimate, code decides, your answers correct it later.

1. **Rules and your tags settle most calls with no network.** Examples: Read and Edit are local; `gh issue|pr comment`, mail and chat webhooks notify; `git push` is shared; an MCP tool named `send_*`, or one that sets an assignee, notifies.
2. **Jev judges what the rules can't place**: an untagged MCP write, `curl -X POST`, `gh api -X`. It's one request of four yes/no questions, taking about 200 ms and costing about $0.00002. If Jev fails, the session's haiku answers the same questions. If nobody answers, the call is badged "reach unknown", not held.
3. **A code gate turns the probabilities into pass, badge, grant or hold.** The thresholds are data, recorded on every run.
4. **Each card answer is feedback on the gate.** Run records and answers go to `~/.claude/hcp/ledger/<date>.jsonl`, so the thresholds can be re-tuned from the records alone.

The Jev key is `HCP_TYPESAFE_API_KEY`. hcp looks for it in the session's environment first, then the plugin's settings (`typesafe_api_key`), then its line in `~/.claude/.env`. It never appears on a card, in a prompt or in the ledger. Token-like strings are redacted before anything goes to Jev, and Jev sees only the channel, the audience and the content.

Calibration on `tests/fixtures/reach-calls.json` (jev-1.14.0, 2026-10-26):
- **Reach:** 10/10 notifying calls held, with 1 false hold in 18 (creating a pull request).
- **Grants:** none passed that shouldn't have; 1–2 of the 4 that should pass were held at the edges.

The sample is small, so treat the thresholds as a start and re-run `node build/calibrate.ts` as the fixtures grow.

## Decisions as evidence

Which choices should reach you at all? Today Claude decides that from prose. hcp is turning it into evidence, starting in shadow:

- **Every decision gets a record.** An ask card, given a `kind` (`env-choice`, `library`), is one. So is a choice Claude makes itself and records with `mcp__hcp__decided`; the pane lists those under **Claude decided** with **👍 Fine**, **✋ Disagree** and a **Change** field. Disagree tells Claude to undo what it did on the strength of the choice and check with you. Change gives Claude your replacement and has it rework what was built on the old choice. A Fine can still become **Disagree after all**, which the record counts as an error the first review missed.
- **The surface pipeline** (`hooks/surface.ts`, a JSON spec) runs on each record. It reads the most similar past decisions, from this session and from the ledger's last 30 days. Jev answers which of them really are the same kind of choice, plus three facts about this one: reversible? affects others? are the options close? Code counts your record on the matching ones, at most 10, giving this session double weight. A Disagree counts as much as three Fines, and an override as much as two, because trust falls faster than it rises. Unanswered and dismissed cards are missing data, not agreement, and never count. The gate reads the record's cautious lower bound (the 5% bound of its Beta posterior), not its average, so a kind earns tell or log only with enough evidence: about 10 kept calls in a row for tell. A gate then picks one of:
  - **ask**: a card before Claude acts;
  - **tell**: Claude acts, and you get a card to override;
  - **log**: recorded only.
- **New ideas get a way in.** With fewer than 5 precedents, the verdict is ask, and so it is when you went another way on the newest one like it. A fixed 10% of decisions are asked anyway, chosen deterministically, so the record keeps learning.
- **A floor no pipeline can lower.** A decision Claude marks `reversible: false` or `reach: shared|notifies` is asked whatever the champion or any challenger says. The floor is code outside the specs (`floorOf` in `hooks/surface.ts`), and the shadow record keeps what the pipeline wanted beside it.
- **Watching for rubber stamps.** Every answer records how long it took. `/hcp shadow` lists per kind: answers, median time, the share under 3 seconds, how often you kept Claude's call, and how many Fines were later reversed. It flags a kind where almost every answer is fast and agrees. The random 5% of ask cards with the recommendation hidden measure how much preselection sways you: the report compares how often you match Claude with and without it.
- **It changes nothing yet.** The verdict is recorded beside what you actually did, and your answer scores it: was asking needed? `/hcp shadow` shows how often it would have been right, how many cards it would have saved, and how often it would have skipped asking when you wanted a say. It earns control only through a pre-registered trial.

## Pipelines Claude writes

`mcp__hcp__pipeline` lets Claude write decision pipelines as JSON specs against hcp's registry, using the same Jev, haiku, ledger and Langfuse ports:

- `describe` returns the contract, the registry and the champion as an example.
- `define` compiles a spec and saves it with an SVG diagram under `~/.claude/hcp/pipelines/<scope>/`. A spec with problems isn't saved; every problem comes back at once, for Claude to fix.
- `run` runs a saved pipeline; `list` lists them.

There are two scopes:
- **external**: a decision in your task, such as "is this release risky?".
- **internal**: a challenger to how hcp chooses what to ask. It runs in shadow beside the champion on every decision, and `/hcp shadow` compares the two.

## Observability

With `HCP_LANGFUSE_PUBLIC_KEY`, `HCP_LANGFUSE_SECRET_KEY` and `HCP_LANGFUSE_BASE_URL` set (in the environment, the plugin's settings or `~/.claude/.env`), every run, whether reach, surface or one Claude wrote, is a Langfuse trace with a span per node. Every card answer is a score on that trace (`hold_needed`, `surfaced_right`). Langfuse is best effort: the local ledger keeps everything regardless.

### Keys on every host

The keys can't ship in this public repo, so `plugin.json` declares them as `userConfig`: `typesafe_api_key`, `langfuse_public_key`, `langfuse_secret_key` and `langfuse_base_url`, all optional. Claude Code asks for them once on each host where the plugin is enabled, or you can set them in `/config`. The two secret keys go in the system keychain, and the other two in `settings.json` under `pluginConfigs.hcp.options`. For a cloud session on claude.ai/code, set the `HCP_*` variables in that environment's settings instead. An environment variable wins over the plugin's settings for the same key.

## Extending it for your environment

The base knows one watched login (gcloud/bq) and generic wording. An environment adds its own in a JSON extension file, without forking the code. hcp reads `~/.claude/hcp.json` at session start, or the files named in `HCP_EXTENSIONS` (paths joined by `:`, layered in order, a later one winning). Each key is optional:

```json
{
  "protocol": ["- Share text usually goes to Teams; name no customers."],
  "services": {
    "glab": {
      "label": "glab (GitLab)",
      "fix": "glab auth login",
      "verify": ["glab", "auth", "status"],
      "command": "\\bglab\\b",
      "pattern": "glab auth login|not logged in|\\b401\\b"
    }
  },
  "tools": {
    "share": { "append": "Usually for Teams.", "properties": { "audience": "Teams channel or email." } }
  },
  "labels": { "copyRich": "Copy for Teams" },
  "reach": { "mcp__claude_ai_GroceryTrack__*": "local", "mcp__teams__post_message": "notifies", "bash:^make release": "shared" },
  "judge": "jev"
}
```

- **protocol**: lines added to the rules Claude is told, after the base ones.
- **services**: CLIs whose expired login raises a handoff. `pattern` is matched, case-insensitively, against the failed Bash output; `command`, if given, must match the Bash command too; `fix` is what the person runs; `verify` is a read-only command that exits 0 once credentials work; `"runnable": true` lets the card's **Run it** start `fix` itself (only for logins that need no terminal). The same name as a base service replaces it. Claude's protocol and the handoff tool's description list every watched login.
- **tools**: per tool (`ask`, `handoff`, `share`), text appended to its description and replacement descriptions for its properties.
- **labels**: `copyRich`, the share card's formatted-copy button.
- **reach**: a tool name (`*` matches anything) or `bash:<regex>` against a Bash command, and the level hcp gives it: `local`, `own`, `shared` or `notifies`. A tag beats the built-in rules and the judge; a later file's tags win.
- **judge**: who estimates what rules and tags can't place: `jev` (the default, falling back to haiku), `haiku`, or `off` (rules and tags alone; unknown calls are badged).

A malformed file, or a named one that can't be read, is reported in a toast and skipped.

## Install

At the prompt of a Claude Code terminal session (2.1.308 or later), then `y` to add the marketplace and a scope:

```text
/plugin install hcp --marketplace dipseth/hcp
```

From a shell:

```bash
claude plugin install hcp --marketplace dipseth/hcp
```

To have it on every machine signed in to your claude.ai account, add `dipseth/hcp` as a marketplace under **Customize > Plugins > Add > Add marketplace** on claude.ai, turn on **Sync automatically**, and add the `hcp` plugin. It then arrives in Claude Code as `hcp@synced`. The cards draw in the terminal, the desktop app's Code tab and the VS Code extension; claude.ai chat and Cowork ignore mods.

## Developing

Clone it and name the folder in `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, or start a session with `claude --plugin-dir <folder>`. Run `claude plugin test` and `claude plugin validate` on the folder.

`hooks/vendor/dp.js` is the decision-pipeline core and zod, bundled with `build/bundle.sh <decision-pipeline checkout>` (after `npm install` there). A hooks module can only import its own files and has no Node, so `node:crypto` is swapped for a pure-JS shim. `hooks/vendor/dp.d.ts` types the parts hcp uses. `node build/calibrate.ts` runs the fixtures through Jev and prints what the thresholds would do.
