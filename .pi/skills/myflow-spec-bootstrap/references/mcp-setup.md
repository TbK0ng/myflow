# Analysis Backend Setup (codebase-memory)

Spec bootstrapping is much faster with a code graph backend, but the backend is
a **tool choice, not a requirement**. This harness uses **codebase-memory**;
if it is unavailable, fall back to `read` / `grep` / `find` and direct source
inspection — the process in `repository-analysis.md` still works, just more
slowly.

## What codebase-memory Provides

`codebase-memory-mcp` builds a knowledge graph of a repository: symbols,
call/usage edges, file outlines, routes, hotspots, coverage gaps, and
architecture summaries. That covers what spec bootstrap needs: module
boundaries, execution flows, dependency hubs, and impact-sensitive areas.

## How It Is Wired Here

1. MCP server entry in `~/.pi/agent/mcp.json` (the `command` is the absolute
   path to the binary on **your** machine — it is deliberately not a path from
   the machine that authored this file):

   ```json
   {
     "mcpServers": {
       "codebase-memory-mcp": {
         "type": "stdio",
         "command": "/path/to/codebase-memory-mcp",
         "enabled": true
       }
     }
   }
   ```

2. A generated Pi extension, `~/.pi/agent/extensions/cbmem.ts`, can expose the
   server's tools directly to the model, so they appear as normal tools rather
   than only behind the MCP namespace. Whether that file exists depends on how
   this machine was set up. If it is absent, the tools appear as
   `mcp__<server>__<tool>` and any agent allowlist has to name them that way.
   Do not assume either shape: inspect the tool names your Pi actually exposes.

## Moving It To Another Machine

1. Put the `codebase-memory-mcp` binary on `PATH`.
2. Add the `mcpServers` entry above to `~/.pi/agent/mcp.json`, or use a
   project-level `.pi/mcp.json`.
3. Restart Pi or run `/reload`.
4. Verify with `pi mcp list` or the `/mcp` command.

## Index The Repository

```text
index_repository({ repo_path: "/absolute/path/to/repo", mode: "moderate" })
list_projects()
index_status({ project: "repo-name" })
```

Modes: `fast` (file bytes only), `moderate` (filtered + semantic), `full`
(everything + semantic). Re-run `index_repository` after large changes, or keep
the index with `persistence: true` (writes `.codebase-memory/graph.db.zst`).

## Useful Tools

The names below are the ones codebase-memory exposes today, and they reach the
model through the generated interface above rather than from the MCP namespace.
Inspect the names your backend actually exposes (`/mcp`, or the tool list)
before calling one; do not hardcode a name from this table into a skill or a
script.

| Tool | Purpose |
|------|---------|
| `get_architecture` | Overview: packages, entry points, hotspots, layers, cycles |
| `search_graph` | Find functions/classes/routes by name pattern, regex, or semantics |
| `trace_path` | Callers/callees of a symbol (impact + data flow) |
| `get_code_snippet` | Read a symbol's source |
| `get_file_outline` | Declarations in one file, in source order |
| `get_graph_schema` | Node labels and edge types available to `query_graph` |
| `query_graph` | Cypher for multi-hop/aggregate questions |
| `search_code` | Graph-ranked text search (literals, config, messages) |
| `index_status` / `check_index_coverage` | Readiness and coverage gaps |
| `detect_changes` | Map a diff to impacted symbols/files |

## No-Backend Fallback

Without a backend, use the standard tools and follow the same analysis order:

```bash
find . -name "*.ts" -not -path "*/node_modules/*" | head -50
grep -rn "export function\|export class" src/ | head -50
```

Then read the manifests, entry points, and representative tests. Record in the
spec notes that no graph backend was used, so a later refresh can be more
thorough.

## Verification

After configuration, confirm the tools are visible from Pi (`/mcp`, or the tool
list), then run one cheap query before the spec-writing pass:

```text
list_projects()
get_architecture({ project: "repo-name", aspects: ["overview"] })
```
