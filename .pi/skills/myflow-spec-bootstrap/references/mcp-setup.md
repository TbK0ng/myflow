# Analysis Backend Setup (codebase-memory, GitNexus, ABCoder)

Spec bootstrapping is much faster with a code graph or AST backend, but these
are **tool choices, not requirements**. Configure them through Pi's MCP
mechanism. If none is available, fall back to `read` / `grep` / `find` and
direct source inspection — the process in `repository-analysis.md` still works,
just more slowly.

## codebase-memory (Recommended, Already Configured Here)

`codebase-memory-mcp` builds a knowledge graph of a repository: symbols,
call/usage edges, file outlines, routes, hotspots, coverage gaps, and
architecture summaries. It is a superset of what GitNexus gives you for this
purpose, and this harness already uses it.

### How it is wired in this environment

1. MCP server entry in `~/.pi/agent/mcp.json`:

   ```json
   {
     "mcpServers": {
       "codebase-memory-mcp": {
         "type": "stdio",
         "command": "C:/Users/wocai/.local/bin/codebase-memory-mcp.exe",
         "enabled": true
       }
     }
   }
   ```

2. A generated Pi extension, `~/.pi/agent/extensions/cbmem.ts`, exposes the
   server's tools directly to the model (so they appear as normal tools, not
   only behind the MCP namespace). It is regenerated on install/update from the
   server's tool registry; do not hand-edit inside its generated block.

To move it to another machine: put the `codebase-memory-mcp` binary on `PATH`,
add the `mcpServers` entry above (project-level `.pi/mcp.json` works too), then
restart Pi or run `/reload`. Verify with `pi mcp` or the `/mcp` command.

### Index the repository

```text
index_repository({ repo_path: "/absolute/path/to/repo", mode: "moderate" })
list_projects()
index_status({ project: "repo-name" })
```

Modes: `fast` (bytes only), `moderate` (filtered + semantic), `full`
(everything + semantic). Re-run `index_repository` after large changes, or
persist the index with `persistence: true` (writes
`.codebase-memory/graph.db.zst`).

### Useful Tools

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

## GitNexus (Optional Alternative)

GitNexus builds a code knowledge graph and is useful for module boundaries,
execution flows, dependency relationships, blast radius, and graph queries.

### Install and Index

```bash
# Run from the repository root.
npx gitnexus analyze

# Check index status.
npx gitnexus status
```

The index is written to `.gitnexus/`. Keep embeddings only if the project
already uses them; otherwise a normal index is enough for spec bootstrapping.

### MCP Server Command

```bash
npx -y gitnexus mcp
```

### Useful Tools

| Tool | Purpose |
|------|---------|
| `gitnexus_query` | Find execution flows and functional areas by concept |
| `gitnexus_context` | Inspect callers, callees, references for a symbol |
| `gitnexus_impact` | Blast radius before changing a symbol |
| `gitnexus_detect_changes` | Changed symbols and affected flows |
| `gitnexus_cypher` | Direct graph queries |
| `gitnexus_list_repos` | List indexed repositories |

## ABCoder (Optional Alternative)

ABCoder parses code into UniAST and gives precise package, file, and
node-level structure. Use it when the spec needs exact code shapes:
signatures, type contracts, constructor patterns, and reference chains.

### Install and Parse

```bash
go install github.com/cloudwego/abcoder@latest
abcoder parse /absolute/path/to/package --lang typescript --name package-name --output ~/abcoder-asts
```

For monorepos, parse each package with a stable `--name` so notes can reference
the same repository names.

### MCP Server Command

```bash
abcoder mcp ~/abcoder-asts
```

### Useful Tools

| Tool | Layer | Purpose |
|------|-------|---------|
| `list_repos` | 1 | List parsed repositories |
| `get_repo_structure` | 2 | Inspect packages and files |
| `get_package_structure` | 3 | Inspect nodes within a package |
| `get_file_structure` | 3 | Functions, classes, types, signatures in a file |
| `get_ast_node` | 4 | Code, dependencies, references, implementations |

## No-Backend Fallback

Without any backend, use the standard tools and follow the same analysis order:

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
