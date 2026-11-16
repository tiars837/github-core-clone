# github-core-clone

[![make.fun](https://make.fun/badge/tiars837/github-core-clone)](https://make.fun/bounty/github-core-clone-01)
[![make.fun entry](https://make.fun/badge/tiars837/github-core-clone/entry)](https://make.fun/bounty/github-core-clone-01)
[![make.fun bounty](https://make.fun/badge/tiars837/github-core-clone/bounty)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in one process, standard library only — built for the
[make.fun bounty “Build a GitHub-compatible git forge”](https://make.fun/bounty/github-core-clone-01)
($500).

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (with
  `fetch`, `ls-refs`, shallow/deepen) and v0, receive-pack v0 with fast-forward
  enforcement and per-ref `ok`/`ng` reports. Packs are SHA-1, byte-exact, and
  the server understands plain objects and ofs/ref deltas on the way in.
- **REST v3** under `/api/v3` — repos, branches, commits, contents, issues,
  labels, pull requests (with squash merge and conflict detection), git refs.
  Every reply carries `X-GitHub-Request-Id` and `application/json`.
- **GraphQL v4** at `/api/graphql` — viewer, repository, issues and pull
  requests (connections with cursor pagination), mutations
  (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`), `node(id:)` global ids, introspection (`__type`), and
  operation batching.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, protocol `2026-07-28`
  (`server/discover`, legacy `initialize`, `tools/list`, `tools/call`) with
  six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL`, and
polls `/done` until the trial ends. There is nothing to install: the program
imports `node:http`, `node:crypto`, `node:zlib` and its own `app.ts` only.

## Design

- **In-memory store, deterministic.** No network at run, no `Date.now()`,
  no `Math.random()`: identities and timestamps come from a fixed base plus
  counters, so two runs of the same scenario behave the same way.
- **One shared store** behind all four surfaces: a push over git, an issue
  created over REST, a PR merged over GraphQL, and a repo listed over MCP all
  read and write the same objects, refs, issues and pull requests.
- **Auth:** every request except `GET /healthz` and `GET /api/v3/` must carry
  `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (any non-empty bearer token when
  the variable is unset, for local runs).

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts` — the whole forge: packfile read/write, git protocol, REST,
  GraphQL and MCP handlers.
- `package.json`, `tsconfig.json` — Node 22+, erasable TypeScript, no deps.

## License

MIT — see [LICENSE](LICENSE).
