## graphify

This project can have a knowledge graph at `graphify-out/` with god nodes, community
structure, and cross-file relationships.

`graphify-out/` is **local, regenerable output — it is ignored by Git and is not part
of the repository**. A fresh clone will not have it. Regenerate it with
`graphify update .` (AST-only, no API cost) before relying on the rules below; if it
is absent, fall back to reading the source directly.

Rules (they apply when `graphify-out/` exists locally):
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
