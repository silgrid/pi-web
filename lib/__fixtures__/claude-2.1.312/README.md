# claude 2.1.312 recordings

Verbatim stdout of the real `claude` CLI, `2.1.312 (Claude Code)`, recorded on
2026-11-01 with model alias `haiku`, each run in a throwaway directory with a
throwaway `CLAUDE_CONFIG_DIR` (its `settings.json` named below), one user
message written to stdin as stream-json and stdin then closed. Not
hand-authored. `lib/claude-adapter.test.mjs` and `lib/claude-session.test.mjs`
read them.

Common argv: `-p --input-format stream-json --output-format stream-json
--verbose --include-partial-messages --model haiku --session-id <uuid>`, plus
the preset flags of `lib/claude-argv.ts`.

| file | preset flags | config dir settings.json | what it shows |
|---|---|---|---|
| `stream.jsonl` | read-only (`--bare --strict-mcp-config --disable-slash-commands --permission-mode dontAsk --permission-prompts none --tools Read,Glob,Grep --allowedTools Read,Glob,Grep`) | `{}` | init, token deltas (thinking, text, `input_json_delta`), one `Read` tool_use and its tool_result, the `result` aggregate |
| `transcript.jsonl` | same run as `stream.jsonl` | — | the on-disk transcript claude wrote at `<config dir>/projects/<encoded cwd>/<session id>.jsonl` |
| `read-only-deny.jsonl` | read-only, as above | `{}` | asked to create `out.txt`: no write tool exists, the file was absent afterwards (`ls -A` of the run directory printed nothing), and the reply says it cannot write; `permission_denials` is `[]` because nothing was attempted |
| `writable-bash-deny.jsonl` | writable (`--permission-mode acceptEdits --permission-prompts none --tools Read,Glob,Grep,Edit,Write,Bash --allowedTools Read,Glob,Grep,Edit,Write`) | `{"permissions":{"allow":["Bash(echo:*)"]}}` | `echo allowed-ok` (allow-listed) ran; a `python3 -c …` write was denied automatically: an `is_error` tool_result naming the denial, a `system`/`permission_denied` event, and the entry in the result's `permission_denials`; `made.txt` was absent afterwards |

Observed while recording, kept as facts rather than worked around:

- Under `--bare`, claude 2.1.312 offers only `Read` of `Read,Glob,Grep`
  (init `tools: ["Read"]`); without `--bare` the same `--tools` list offers
  all six writable tools. The read-only argv is unchanged (it is the spec's).
- Under the read-only preset a write cannot even be attempted, so a real
  read-only run produces no `permission_denials`; the denial path is
  recorded from the writable preset's Bash allow list instead.
- `acceptEdits` also auto-accepts plain file commands such as `touch` in the
  cwd (`reason_type: subcommandResults`); the allow list confines the rest.
- The `assistant` event of a content block arrives before that block's
  `content_block_stop`; one API message yields one `assistant` event per
  content block, all with the same message id.
- The streamed per-message `usage.output_tokens` (2 on the final message of
  `stream.jsonl`) under-counts the `result` aggregate (283).

Scrubbing: the run directory `/tmp/claude-rec-<random>` was rewritten to
`/tmp/claude-rec` (also inside claude's encoded project directory names and one
split `input_json_delta` chunk); the transcript's `api-request`,
`api-request-shape` and `api-request-blob` entries were dropped (they echo the
full system prompt and request parameters, which pi-web never reads). No
credential, token or base URL appears in any file (checked by searching for the
recording environment's values, which are not reproduced here). Thinking
`signature` fields are the model's opaque signatures and stay as recorded.
