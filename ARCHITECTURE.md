# Architecture

KiroLink translates between client-facing LLM APIs (Anthropic Messages, OpenAI
Chat Completions) and Kiro's `GenerateAssistantResponse` runtime. This document
describes how the pieces fit and, where it matters, why.

## Layers

Dependencies point downward. Nothing in a lower layer imports from a higher one.

```
        cli.ts          index.ts            ← entry points
             \             /
              \           /
               →   app.ts   ←               ← composition root
                     |
        ┌────────────┼────────────┐
        ↓            ↓            ↓
      http/       protocol/      kiro/       ← feature layers
        └────────────┼────────────┘
                     ↓
           domain/  config/  logging/        ← foundation
                     ↓
                 errors.ts
```

| Layer | Owns | Depends on |
| --- | --- | --- |
| `domain/` | Kiro wire types, size limits, model registry | nothing |
| `config/` | The `KiroLinkConfig` type, env resolution, config file | `domain` |
| `logging/` | The `Logger` port | nothing |
| `errors.ts` | Error hierarchy, HTTP status mapping | nothing |
| `kiro/` | Auth, HTTP transport, stream parsing, throttle, usage | `domain`, `config`, `logging` |
| `protocol/` | Request validation, translation, response writers | `domain`, `config`, `errors` |
| `http/` | Router, server, body reading, client auth, SSE | `config`, `domain`, `errors`, `kiro`, `protocol` |
| `app.ts` | Wiring concrete implementations together | everything |

`domain/types.ts` is deliberately dependency-free. It is the shared vocabulary,
so a module that touches a Kiro type does not thereby depend on the HTTP client.

## Request flow

```
client request
   → http/router          match method + path
   → http/auth            client API-key check (constant-time)
   → http/body            read with byte cap, parse JSON
   → protocol adapter     parseRequest → validated typed request
   → protocol adapter     toKiroRequest → KiroRequest
   → kiro/throttle        queue behind the concurrency limit
   → kiro/client          send upstream, emit KiroStreamEvent
   → protocol writer      render events into the client's protocol
```

The pump in `http/server.ts` (`handleChat`) is protocol-agnostic: it is written
once and works for every adapter.

## Key contracts

### `KiroClient`

```ts
type KiroClient = {
  send(request: KiroRequest, onEvent: (e: KiroStreamEvent) => void, signal?: AbortSignal): Promise<void>
}
```

The seam between the server and the upstream. `HttpKiroClient` is the real
implementation; tests inject a fake. Without this seam, the streaming, error
mapping, and abort paths are unreachable from a test.

### `ProtocolAdapter<TRequest>`

Everything protocol-specific lives behind one interface: which routes it serves,
how to validate a body, how to translate it, and how to write the response.
Adding a protocol means adding an adapter and registering it — the router and
event pump do not change.

### `ResponseWriter`

`begin` → `handle`* → (`complete` | `fail`) → `finish`. Each protocol has a
streaming and a buffered implementation. This is what keeps the two modes from
duplicating the event-handling logic.

### `Logger`

Injected, never global. `lazyDebug` takes a builder so expensive payload
summarization is skipped entirely when debug logging is off.

## Configuration

`config/env.ts` is the **only** module that reads `process.env`. Everything else
receives a fully-resolved, immutable `KiroLinkConfig`.

Precedence: CLI flag > environment variable > saved config file > default.

`KIROLINK_*` is canonical; the legacy `KIRO_PROXY_*` names are still read for
backwards compatibility.

Configuration is never written back into `process.env`. Doing so would leak
credentials into any child process (`kiro-cli` is spawned for token refresh) and
would make two independent instances in one process impossible.

## State

All mutable state is instance-scoped, created by a factory:

| State | Owner |
| --- | --- |
| OAuth token cache, refresh mutex | `createAuthProvider` |
| Usage/quota cache | `createUsageService` |
| Concurrency queue | `createThrottle` |
| Conversation id cache (LRU) | `createConversationIdAssigner` |

No module-level mutable state. Two `createKiroLink` calls are fully independent.

## Behaviors worth knowing

**History is never trimmed.** Field-level truncation caps an individual oversized
value, but conversation turns are never dropped. When a conversation genuinely
exceeds the context window, Kiro says so and KiroLink forwards that signal in the
exact shape the client's own compaction recognizes (see `isContextWindowOverflow`).
Silently deleting turns would hide that decision from the client.

**Truncation happens exactly once**, in the protocol layer, against the constants
in `domain/limits.ts`. Two truncation passes with different limits would corrupt
the marker written by the first.

**Tool pairing is repaired, not rejected.** An interrupted client sends a tool use
with no result; Kiro rejects that shape. A synthetic error result is inserted so
the model learns the call did not complete.

**Conversation ids are random but stable.** kiro-cli assigns a random id per
session and reuses it every turn, which earns prefix-cache reuse upstream.
KiroLink is stateless per request, so it caches a random id keyed by an immutable
conversation anchor (model + system + first user message) to reproduce that
behavior without deriving an id from user content.

**Images travel through a synthetic tool call.** Kiro accepts images attached to a
tool result, not on the chat path directly, so a prior `fs_read` call is
synthesized — the same shape kiro-cli produces for an attachment.

**The upstream host is allowlisted.** A bearer token is sent upstream, so
`resolveKiroApiUrl` rejects non-https URLs, embedded credentials, unexpected
paths, custom ports, and non-Kiro hosts.

## Testing

- `test/support/harness.ts` — fakes for client, auth, usage; env-isolated config
- `test/support/server.ts` — starts a real server on an ephemeral port with fakes

Tests never read the ambient environment: `testConfig()` builds from an explicit
env map, so tests are order-independent and safe to parallelize.

## Adding things

**A new client protocol**: create `protocol/<name>/{types,translate,writer}.ts`,
implement `ProtocolAdapter`, register it in `protocol/registry.ts`, add its routes
in `http/server.ts`. Reuse `protocol/conversation.ts` for turn flattening and
tool-result pairing.

**A new config knob**: add the field to the relevant `KiroLinkConfig` section,
read it once in `config/env.ts`, thread it through. Do not read `process.env`
elsewhere.

**A different upstream**: implement `KiroClient` and pass it to `createKiroLink`.
