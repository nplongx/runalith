# Chat On Steroids automatic-send preflight gate

This adapter implements the `Check automatic sends` local HTTP protocol found in the installed Chat On Steroids 2.1.48 application. It is separate from Runalith runtime authorization and does not grant workflow, task, approval, dispatch, or release authority.

## Verified CoS protocol

The installed CoS main process stores the setting as `ui.sendCheckUrl`. Before an app-originated automatic send, it POSTs JSON to that URL:

```json
{
  "version": 1,
  "kind": "continue",
  "id": "opaque-send-id",
  "chat": { "session": null, "project": null, "worker": null },
  "text": "automatic message text",
  "attempt": 1
}
```

The current observed `kind` values are `continue`, `fresh-turn`, `scheduled`, `goal-step`, `loop-step`, `worker-start`, and `worker-message`. CoS accepts only HTTP 200 with a JSON object containing `allow: true`. `allow: false` holds the send; non-200, timeout, invalid JSON or missing `allow: true` also holds it. CoS times out after approximately 3 seconds and retries a held send after approximately 30 seconds where its flow supports retry.

The URL must be HTTP on the local computer (`127.0.0.1`, `localhost`, or `[::1]`), include an explicit port, and contain no username/password. The adapter therefore binds only to loopback.

## Run locally

From the repository root (foreground):

```bash
node scripts/cos-automatic-send-check.mjs --root "$PWD" --target . --host 127.0.0.1 --port 18746
```

On this Linux workstation, the checked-in user service is `ops/systemd/runalith-cos-automatic-send-check.service`. Install/enable it with:

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/runalith-cos-automatic-send-check.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now runalith-cos-automatic-send-check.service
```

Inspect it with `systemctl --user status runalith-cos-automatic-send-check.service` and `journalctl --user -u runalith-cos-automatic-send-check.service -f`.

Health check:

```bash
curl --fail http://127.0.0.1:18746/health
```

In Chat On Steroids, open **Settings → General → For developers → Check automatic sends** and set the local address to:

```text
http://127.0.0.1:18746/check
```

An empty setting disables the feature. The adapter does not edit the CoS settings file or restart the app; save the address through the CoS UI so the application updates its in-memory configuration safely. Confirm the UI reports the value saved, then run the allow/hold smoke tests below.

## Repository selection

CoS supplies chat identifiers (`chat.session`, `chat.project`, `chat.worker`), not filesystem paths. By default, the adapter uses the Runalith repository root passed by `--root` and target passed by `--target`. This is suitable when the automatic sends being checked belong to this Runalith workspace.

For a machine that uses several repositories, provide a local policy file with exact CoS IDs:

```json
{
  "version": 1,
  "default": { "root": "/home/user/work/runalith", "target": "." },
  "sessions": {
    "<cos-session-id>": { "root": "/home/user/work/runalith", "target": "src/runtime" }
  },
  "projects": {
    "<cos-project-id>": { "root": "/home/user/work/another-repo", "target": "." }
  },
  "workers": {}
}
```

Run with `--policy /absolute/path/to/policy.json`. Session mapping has priority over project mapping, then worker mapping, then `default`. Set `"default": null` to explicitly disable the command-line fallback; without a matching mapping or default, the adapter holds the send. Mapping roots must be absolute Git roots; targets must remain inside them.

## Decision semantics

- Allow only after `agent-instructions-preflight.mjs` successfully loads a non-empty effective instruction bundle, checks root-to-target precedence and computes SHA-256 values.
- Hold unsupported protocol versions/kinds, malformed requests, missing mappings, invalid roots, missing instructions, path/symlink escapes, or instruction bundles over 32 KiB.
- The adapter never returns the instruction text to CoS and never logs the automatic message text. CoS's send-check protocol is an allow/hold gate, not a context-injection API.
- This proves the repository instructions were available and valid at send-check time. It does **not** prove the model previously read or obeyed them. The agent's startup preflight remains required; the send gate is a second fail-closed barrier.

## Tests

```bash
node --test tests/test-cos-automatic-send-check.mjs tests/test-agent-instructions-preflight.mjs
```
