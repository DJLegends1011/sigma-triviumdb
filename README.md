# TriviumDB for Project Σ (`sigma-triviumdb`)

Embedded **vector + knowledge graph + BM25 full-text + TQL** engine ([TriviumDB 0.9.0](https://github.com/YoKONCy/TriviumDB)) for other Project Σ extensions, plus its debug tools.

## For extensions

Everything goes through Project Σ commands, run from your page half with `ctx.commands.run`:
- `triviumdb.open` `{ namespace, options: { dim } }` → a handle (insert, link, search, searchAdvanced, TQL `query`, subgraph, Leiden clustering, indexes…).
- `triviumdb.search`, `triviumdb.query`, `triviumdb.list-namespaces`, `triviumdb.status`, `triviumdb.seed-demo`.
- `triviumdb.embed` `{ texts, role: 'doc' | 'query', profileId?, model? }` → `{ model, signature, dim, vectors }`: embeddings through the account's connections (OpenAI-compatible, OpenRouter, Google AI Studio with retrieval task types, nomic prefixes). Store `signature` with your vectors and re-embed when it changes.
- `triviumdb.rank` `{ query, texts, profileId?, model? }`: texts ranked by meaning against a query.

**Feeding a prompt from your server half**: a prompt block's text is built synchronously, so search ahead of time. Wrap `chat.send` in your page half, run `triviumdb.search`, keep the hits in your own chat slot, and have your server half's `ctx.prompt.addBlock` read that slot.

**TauriTavern extensions**: the handle is also at TauriTavern's `api.db` (see `exposeAsTauriTavern` in `client/api.js`, the one place that name lives), unless a real TauriTavern host already holds it.

**In a prompt**: `{{trivium_recall::query}}` or `{{trivium_recall::namespace::query}}`.

## The TriviumDB view (menu → TriviumDB)

- **Meaning test**: pick a connection, type a query and some texts, and see how its embeddings rank them, with the score and whether each shares the query's words. The sample: *"dragon fire"* should put *"The great wyrm set the forest ablaze with its flames"* near the top though they share no word.
- **Workbench**: engine stats, seed a demo knowledge graph, hybrid search with stage timings, TQL console, subgraph / shortest path / Leiden clusters, CRUD and property indexes, and the full API catalog.

## Platforms

Prebuilt N-API binaries in `native/`: Windows x64, Linux x64 / ARM64 (glibc, also `proot-distro`), macOS Apple Silicon.

### Native Termux (`android-arm64`)

```bash
bash extensions/installed/triviumdb/scripts/build-termux.sh
```

Builds `native/triviumdb.android-arm64.node` in about three minutes, installing only missing build tools (never upgrading Node.js, which would break Project Σ's `better-sqlite3`). Restart Project Σ afterwards.

## Tests

```bash
node --test test/triviumdb.test.mjs   # engine API, page boot, view and settings render
node --test test/meaning.test.mjs     # meaning test ("dragon fire" vs the wyrm), server API, Gemini request shape
```
