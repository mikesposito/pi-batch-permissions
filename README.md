# pi-seatbelt

[![npm version](https://img.shields.io/npm/v/pi-seatbelt)](https://www.npmjs.com/package/pi-seatbelt)
[![license](https://img.shields.io/npm/l/pi-seatbelt)](LICENSE)

A permissions system for pi that you configure and that learns from your
decisions.

Every gated tool call gets a danger label from a small classifier model:
`safe`, `caution`, or `DANGEROUS`, with a one-line purpose and, when
dangerous, the reason. A whole chain of calls is approved in one dialog
instead of one at a time. In `auto` mode the labeller also sees what you
approved or rejected earlier in the session, rejection reasons included, so
its judgment tracks yours.

![The batch approval dialog: every call with its danger label, what it does, and why it's dangerous](assets/multiple.png)

Three choices per batch: `Approve all`, `Reject all`, or `Reject with
message`. The message goes back to the agent as the rejection reason, so it
can adjust instead of blindly retrying.

You pick which tools are gated (default: `bash`), which mode each session
runs in, and what the labeller calls dangerous.

## Install

From npm:

```sh
pi install npm:pi-seatbelt
```

Or from GitHub:

```sh
pi install git:github.com/mikesposito/pi-seatbelt
```

Try it once without installing:

```sh
pi -e npm:pi-seatbelt
```

For local development, symlink the checkout into your extensions directory,
or load it per run:

```sh
ln -s /path/to/pi-seatbelt ~/.pi/agent/extensions/seatbelt
pi -e /path/to/pi-seatbelt
```

No runtime dependencies. The host-provided pi packages are declared as peers.

## Modes

Press the mode key to cycle: `alt+b` by default, or any key you set (see
`shortcut` under [Configure](#configure)). Or use `/seatbelt:mode`: no
argument cycles, `/seatbelt:mode auto` sets a mode directly. The status bar
always shows where you are: `seatbelt:fastened 🔒` (green),
`seatbelt:auto 🤖` (yellow), `seatbelt:unfastened 💀` (red).

The mode is per session: switching affects only the current session, and
each session remembers its mode across restarts. New sessions start in the
default mode from config; set it with `/seatbelt:default auto` (no argument
shows the current default).

- `fastened`: every chain asks once. The default.
- `auto`: no dialog unless something is `DANGEROUS`. The labeller sees your
  earlier decisions in the session, so pair it with a good policy file.
- `unfastened`: no gating, no classifier calls, no cost.

Headless modes (print, JSON) have no dialogs: only `safe` calls auto-run,
everything else is blocked with a reason.

Calls made through nested execution (codemode scripts) never appear in an
assistant message, so they are approved one at a time as a fallback.

## What counts as dangerous is your call

The labels come from the classifier model. You steer it with a plain
markdown file: `~/.pi/agent/seatbelt/policy.md`.

- Write plain sentences. No syntax to learn.
- Everything you write is appended to the labeller's instructions as *your*
  policy, overriding the built-in defaults.
- Re-read before every batch. Edits apply immediately, no reload.
- Ships as a header-only template that is ignored until you add rules.

Example:

```markdown
# My policy

- Treat every docker command as dangerous: my machine has stateful containers.
- Treat `npm test`, `yarn build`, and `git status` in ~/dev/my-project as safe.
- Treat `git push` to origin main as dangerous; feature branches are caution.
- Treat any command that writes outside /tmp as dangerous.
```

Policy shapes the model's labels. With no model configured the policy file
is not consulted; gated calls always require approval.

## Configure

`~/.pi/agent/seatbelt/config.json` (not in this repo):

```json
{
  "model": "litellm/DeepSeek-V4-Flash",
  "timeoutMs": 20000,
  "mode": "fastened",
  "shortcut": "alt+b",
  "tools": ["bash", "write", "edit", "mcp__slack__*"]
}
```

- `tools`: what gets gated. Exact names (`read`, `write`, `edit`,
  `mcp__github__create_issue`) or prefix patterns (`mcp__slack__*` for a
  whole server, `*` for everything). Non-bash calls are shown to the
  labeller as tool name plus arguments, truncated to 500 characters.
- `shortcut`: the key that cycles the modes, as a pi key id (`"alt+b"`,
  `"ctrl+shift+p"`, `"f9"`, `"super+b"` for ⌘ on macOS). Read at startup,
  so a change needs a new session. Anything malformed falls back to
  `alt+b`. Some combos need the terminal to report modifiers distinctly:
  through tmux without `set -s extended-keys on`, `ctrl+shift+b` arrives
  as plain `ctrl+b` (cursor-left), while `alt`- and `F`1–`F`12` keys work
  everywhere. `super` (⌘) needs a terminal with Kitty keyboard protocol
  support (Ghostty, kitty, WezTerm) and is usually intercepted by the
  terminal or OS before it reaches pi. If a key combo does not work,
  `/seatbelt:mode` always does.
- `mode`: the default mode for new sessions. Per-session switching never
  touches it; use `/seatbelt:default` to change it.
- `model`: the labeller. Pick one with `/seatbelt`, or pass it directly:
  `/seatbelt litellm/gpt-4o-mini`. Fast and cheap works well; the prompt
  is tiny. Without a model, or if the call fails or times out, the
  approval dialog is shown unlabeled (always shown, even in auto mode),
  with a warning naming the cause; without a UI the call is blocked. A
  missing model also raises a recurring toast pointing at `/seatbelt`.
- `timeoutMs`: give up on the labeller after this long; past it the batch
  is treated as failed (unlabeled approval).

Both config files are seeded as templates on first load. Fresh installs get
a one-time notice to run `/seatbelt`.
