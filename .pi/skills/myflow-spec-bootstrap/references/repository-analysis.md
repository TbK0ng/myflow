# Repository Analysis

The goal is to discover the project's real architecture before writing rules.
Do not start from generic spec templates and fill blanks. Start from the code,
then let the spec structure follow.

## Analysis Order

1. Read the existing `.myflow/spec/` tree and note which files are templates,
   outdated, or already project-specific.
2. Inspect package manifests, build scripts, workspace config, and top-level
   documentation to identify packages and runtime layers.
3. Use **codebase-memory** for module boundaries, execution flows, dependency
   hubs, and impact-sensitive areas (preferred backend; see
   `references/mcp-setup.md`).
4. Use codebase-memory's file outline and snippet tools, or language-native
   tooling, for exact signatures, types, class boundaries, and examples.
5. Read representative source and test files directly before turning any
   finding into a spec rule. Graph output is a map, not the final authority.

## What To Capture

| Area | Questions |
|------|-----------|
| Package boundaries | What does each package own? What imports cross boundaries? |
| Runtime layers | Which code is CLI, backend, frontend, worker, shared library, test-only, or tooling? |
| Core abstractions | Which types, services, stores, commands, routes, or adapters define the system shape? |
| Data flow | Where does user input enter, how is it validated, and where does state persist? |
| Error handling | How are failures represented, logged, surfaced, and tested? |
| Configuration | Where do defaults, environment config, generated files, and templates live? |
| Tests | Which test styles are trusted examples for new work? |

## codebase-memory Usage (Preferred)

Start broad, then inspect specific symbols. Tool names are the ones exposed by
the codebase-memory extension / MCP server.

```text
index_repository({ repo_path: "/abs/path/to/repo", mode: "moderate" })   # only if not indexed yet
list_projects()                                                          # confirm the project name
index_status({ project: "my-repo" })                                     # readiness + coverage gaps

get_architecture({ project: "my-repo", aspects: ["overview", "structure", "dependencies", "hotspots"] })
search_graph({ project: "my-repo", name_pattern: ".*Handler.*" })
trace_path({ project: "my-repo", function_name: "SomeFunction", direction: "both" })
get_code_snippet({ project: "my-repo", qualified_name: "pkg/module.Symbol" })
get_file_outline({ project: "my-repo", file_path: "src/example.ts" })
query_graph({ project: "my-repo", query: "MATCH (n)-[r]->(m) RETURN n.name, type(r), m.name LIMIT 30" })
search_code({ project: "my-repo", pattern: "placeholder", mode: "compact" })
```

Evidence discipline:

- Graph hits are leads. Before writing a rule, open the real file and confirm
  the pattern (use `get_code_snippet` or `read`).
- Before making a negative or exhaustive claim ("nothing else does this"),
  call `check_index_coverage` once with every path you relied on and read any
  ranges it reports as missed.
- A clean coverage result means no recorded gap, not proof of completeness.
- `detect_changes` is useful for a refresh pass to see which spec areas the
  latest diff touched.

## Other Backends

GitNexus and ABCoder are optional alternatives when codebase-memory is not
available; their setup and tool lists are in `references/mcp-setup.md`. With
ABCoder, use it for exact AST shapes (constructor patterns, function
signatures, type contracts, reference chains).

## Analysis Notes

Keep short notes while analyzing. The notes should include:

- Package or layer name.
- Files that define the local pattern.
- Rules the spec should teach.
- Anti-patterns found in old code, comments, tests, or migration paths.
- Spec files that should be created, deleted, renamed, or merged.
- Which tool produced each finding, and whether it was verified in source.
