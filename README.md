# TriviumDB for Project Σ (`sigma-triviumdb`)

Embedded **Vector + Knowledge Graph + BM25 Full-Text + TQL** database engine ([TriviumDB 0.9.0](https://github.com/YoKONCy/TriviumDB)) for Project Σ extensions, modeled after TauriTavern's `window.__TAURITAVERN__.api.db` contract and Project Σ's `hello-world` tour.

## Features

- **Multi-Namespace Isolation**: Each namespace (`open(namespace, options)`) opens an isolated `.tdb` mmap instance under the account's extension data directory.
- **Three Ways to Hook In**:
  1. **Global WebView Handle**: `window.__SIGMA_TRIVIUM__.db` (also aliases `window.__TAURITAVERN__.api.db` for drop-in TauriTavern extension compatibility).
  2. **Project Σ Extension Commands**: `ctx.commands.run('triviumdb.open', ...)`, `triviumdb.search`, `triviumdb.query`, `triviumdb.seedDemo`, `triviumdb.status`.
  3. **Prompt Macro & Auto-Recall Block**: Use `{{trivium_recall::query}}` or `{{trivium_recall::namespace::query}}` in any prompt, or toggle **Auto-inject knowledge recall block** in Settings > Extensions.
- **Interactive Workbench & Conversation Window**:
  - Open **TriviumDB Workbench** from the app menu (`shell.view`) to seed a sample knowledge graph, run Hybrid / Cognitive Pipeline searches with stage timings, execute TQL (`MATCH`, `FIND`, `SEARCH VECTOR`, `CREATE`), and run subgraph / shortest-path / Leiden community clustering.
  - Open the **TriviumDB** window inside any chat (`chat.window`) to inspect and search namespaces alongside your conversation.

## Platform Support & Native Termux Build

Bundled prebuilt N-API binaries in `native/`:
- `triviumdb.win32-x64-msvc.node` (Windows x64)
- `triviumdb.linux-arm64-gnu.node` (Linux ARM64 / `proot-distro` on Android)
- `triviumdb.linux-x64-gnu.node` (Linux x64)
- `triviumdb.darwin-arm64.node` (macOS Apple Silicon)

### Building for Native Termux (`android-arm64` Bionic)
Because TriviumDB is 100% pure Rust with zero C/C++ dependencies, you can compile `triviumdb.android-arm64.node` directly inside native Termux with a single command:

```bash
bash extensions/installed/triviumdb/scripts/build-termux.sh
```
This installs `rust` and `nodejs` if needed, compiles `libtriviumdb.so` (`--release --features nodejs`), places `triviumdb.android-arm64.node` into `native/`, and verifies the N-API binding.
