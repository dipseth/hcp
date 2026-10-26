# hcp: Human Context Protocol

Clickable seams between you and Claude, so a decision is a click instead of a paragraph. One shared surface, of many: a pluribus.

**Claude posts cards** (tools `mcp__hcp__ask`, `mcp__hcp__handoff`, `mcp__hcp__share`). They draw inline at the tool row and in the HCP pane:

- **ask**: options as buttons (single or multi), the recommendation preselected, an optional draft to approve, and a note field.
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
  "labels": { "copyRich": "Copy for Teams" }
}
```

- **protocol**: lines added to the rules Claude is told, after the base ones.
- **services**: CLIs whose expired login raises a handoff. `pattern` is matched, case-insensitively, against the failed Bash output; `command`, if given, must match the Bash command too; `fix` is what the person runs; `verify` is a read-only command that exits 0 once credentials work; `"runnable": true` lets the card's **Run it** start `fix` itself (only for logins that need no terminal). The same name as a base service replaces it. Claude's protocol and the handoff tool's description list every watched login.
- **tools**: per tool (`ask`, `handoff`, `share`), text appended to its description and replacement descriptions for its properties.
- **labels**: `copyRich`, the share card's formatted-copy button.

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
