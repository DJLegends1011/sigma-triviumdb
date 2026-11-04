# TriviumDB Smart Recall for Project Σ (`sigma-triviumdb`)

**Find any moment from your chats and lorebooks by what it meant, not the exact words, and let the AI remember the moments that matter in long chats.**

Runs on [TriviumDB 0.9.0](https://github.com/YoKONCy/TriviumDB), an embedded vector + BM25 + knowledge-graph engine, which other extensions can use directly too.

## What you get

- **Smart Recall view** (menu → *Smart Recall*): one search box over every chat message and lorebook entry. Type *"the night she told me about her brother"* and find the message even if it never used those words. Tap a result to jump to that message in its chat, or open the lorebook entry.
- **Remind the AI** (in any chat: the *Smart Recall* window): before each reply, the few older messages most relevant to what is happening now are added to the prompt, so a 2,000-message chat still remembers the promise from message 40. Look in *this chat* or *every chat with this character*. The window shows what the last reply was reminded of, and previews the next.
- **Keeps itself up to date**: new, edited and deleted messages and lorebook changes are indexed in the background as you chat.

## Setup

1. **Settings → Extensions → TriviumDB Smart Recall → Understand text with**: pick a connection that can make embeddings:
   OpenAI or any OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp…), OpenRouter, or Google AI Studio.
   Leave the model empty for `text-embedding-3-small` (`gemini-embedding-001` on Google); local servers need their model name, e.g. `nomic-embed-text`. Press **Test**.
   *No connection?* Smart Recall still works, matching words instead of meaning.
2. Open **Smart Recall** and press **Index my library**. It runs in the background and shows progress; the status card estimates the tokens first.
3. Search, or switch on **Remind the AI** in a chat.

Settings also cover how many moments to recall, how many of the newest messages to leave out (the AI already sees them), the closest match needed, where the block goes in the prompt, and the heading the AI reads. `{{trivium_recall}}` writes the chat's recall anywhere a prompt holds it.

## For extension authors: the engine

- `window.__SIGMA_TRIVIUM__.db.open(namespace, { dim })`: a TauriTavern-compatible database handle (insert, link, search, searchAdvanced, TQL `query`, subgraph, Leiden clustering…).
- Commands: `triviumdb.open`, `triviumdb.search`, `triviumdb.query`, `triviumdb.list-namespaces`, `triviumdb.status`, `triviumdb.seed-demo`, `triviumdb.recall-search`.
- `{{trivium_recall::namespace::query}}` searches a namespace of your own from any prompt.
- **Developer tools**, folded at the bottom of the Smart Recall view: the raw workbench (stats, hybrid search with stage timings, TQL console, graph traversal, CRUD) and the full API catalog.

## Platforms

Prebuilt N-API binaries in `native/`: Windows x64, Linux x64 / ARM64 (glibc, also `proot-distro`), macOS Apple Silicon.

### Native Termux (`android-arm64`)

TriviumDB is pure Rust, so it builds on the phone in about three minutes:

```bash
bash extensions/installed/triviumdb/scripts/build-termux.sh
```

It installs only missing build tools (never upgrades Node.js, which would break Project Σ's `better-sqlite3`), builds `native/triviumdb.android-arm64.node`, and checks it loads. Restart Project Σ afterwards.

## Tests

```bash
node --test test/triviumdb.test.mjs   # engine API, page boot, view/window/settings render
node --test test/recall.test.mjs      # Smart Recall end to end against a mock embeddings server
```
