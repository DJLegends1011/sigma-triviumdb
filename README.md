# TriviumDB for Project Σ (`sigma-triviumdb`)

Embedded **vector + knowledge graph + BM25 full-text + TQL** engine ([TriviumDB 0.9.0](https://github.com/YoKONCy/TriviumDB)) for other Project Σ extensions, plus its debug tools. [Smart Recall](https://github.com/DJLegends1011/sigma-smart-recall) is the example extension built on it.

## For extensions

**In the page**
- `window.__SIGMA_TRIVIUM__.db.open(namespace, { dim })`: a TauriTavern-compatible handle (insert, link, search, searchAdvanced, TQL `query`, subgraph, Leiden clustering, indexes…).
- Commands: `triviumdb.open`, `triviumdb.search`, `triviumdb.query`, `triviumdb.rank`, `triviumdb.list-namespaces`, `triviumdb.status`, `triviumdb.seed-demo`.

**In a server half**: `globalThis.__SIGMA_TRIVIUM_SERVER__` (`apiVersion` 1), looked up at use time since halves load in any order:
- `status()`, `open(user, db, namespace, options)` → `{ namespace, dim, db }` (`db` the native handle), `drop(user, namespace)`, `execute(user, namespace, operation)`.
- `embeddings.targetOf(db, profileId, model)`, `embeddings.embed(target, texts, { role: 'doc' | 'query', signal, patient, onWait })`, `embeddings.signatureOf(target)`: embeddings through the account's connections (OpenAI-compatible, OpenRouter, Google AI Studio with retrieval task types, nomic prefixes), waiting out rate limits when `patient`.
- `keywordQuery(text)`, `textVector(text, dim)`, `sanitize(value)`.

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
