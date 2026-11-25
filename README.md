# TriviumDB for Project Σ

**Short version: TriviumDB is a search box for other extensions.** It stores text and finds it again, by matching words or by matching meaning. On its own it does nothing to your chats or characters. It's a building block that memory and lore extensions can use.

> **Right now no released extension uses it.** Install it if you build extensions or want to try meaning search in its test view. Otherwise you can skip it for now.

The database engine is [TriviumDB 0.9.0](https://github.com/YoKONCy/TriviumDB) by YoKONCy (its own docs are in Chinese). This repo is the Σ side.

## What problem it solves (a Seraphina example)

You've been chatting with **Seraphina** for 400 messages. Back at message 30 she gave you a silver locket that belonged to her sister. The model only sees the last few thousand words, so it has forgotten.

Now you type: *"Seraphina, what was that necklace you gave me?"*

- **Word search** looks for "necklace", finds nothing, because the old message says "locket".
- **Meaning search** knows a necklace and a locket are close, and finds message 30.

A memory extension built on TriviumDB would save your old messages into it, search it each time you send, and put the best match back into the prompt. TriviumDB is only the save-and-search part. Saving messages and feeding them back is the job of the extension that uses it.

You can try the difference in its test view (below). The built-in sample searches for *"dragon fire"* and finds *"The great wyrm set the forest ablaze with its flames"*, though they share no word.

## What you get when you install it

- **The TriviumDB view** (menu → TriviumDB):
  - **Meaning test:** pick one of your AI connections, type a question and a few sentences, and see which sentences it ranks closest in meaning, and which ones share words with the question. Handy for checking whether a connection can do meaning search at all.
  - **Workbench:** tools for extension makers. Load a small demo set (made-up cyberpunk characters such as "Alice Vance"), search it, run queries, and see the links between entries.
- **A prompt macro:** `{{trivium_recall::your question}}` (or `{{trivium_recall::store name::your question}}`) puts the best matches from a store into the prompt. It matches **words**, not meaning, and only finds what something already saved there, so on a fresh install it adds nothing.

## What it touches, and what it sends

- **It has a server half, and that half runs compiled code.** The engine is a native add-on in `native/`, prebuilt for Windows x64, Linux x64/ARM64 (glibc, also `proot-distro`) and macOS Apple Silicon from the TriviumDB 0.9.0 source linked above. On Termux you build it yourself with `scripts/build-termux.sh`, which downloads that same source from GitHub.
- **Writes:** its stores, as files in Σ's data folder under `users/<your account>/databases/`. Deleting a store, or reloading the demo, deletes that store's folder. Your library (characters, chats, lorebooks) is never changed.
- **Reads:** its own settings and, only for meaning search, the AI connection you picked (its address, model and API key), so it can call that service.
- **Sends, and where:** only when you or an extension asks for meaning search, the text being compared goes to the AI connection you picked (Google AI Studio, OpenRouter, OpenAI, or a local Ollama / LM Studio) to be turned into numbers it can compare. Nothing goes anywhere else. Word search never leaves your machine.

## For extension makers

Everything goes through Σ commands from your page half (`ctx.commands.run`). Each one answers `{ ok: true, value }` or `{ ok: false, error }` and never throws (Σ swallows a throwing extension command, so you'd only get `undefined`). An `undefined` answer means TriviumDB isn't installed or is switched off. The handle from `triviumdb.open` is a plain object whose methods reject normally.

| Command | What it does |
|---|---|
| `triviumdb.open` `{ namespace, options: { dim } }` | Opens or creates a store, and gives you a handle: insert, link, search, searchAdvanced, `query`, subgraph, Leiden clustering, indexes… |
| `triviumdb.search` | Searches a store by words, by meaning, or both. |
| `triviumdb.query` | Runs a TQL query (TriviumDB's own query language). |
| `triviumdb.embed` `{ texts, role: 'doc' \| 'query', profileId?, model? }` | Turns texts into meaning vectors with one of the user's connections and answers `{ model, signature, dim, vectors }`. Keep `signature` next to your vectors and redo them when it changes (it changes when the user switches model). |
| `triviumdb.rank` `{ query, texts, profileId?, model? }` | Ranks texts by how close in meaning they are to `query`. |
| `triviumdb.list-namespaces`, `triviumdb.status`, `triviumdb.seed-demo` | Lists stores, reports the engine's status, loads the demo set. |

**Getting results into a prompt from your server half:** prompt blocks are built synchronously, so search before the send. Wrap `chat.send` in your page half, run `triviumdb.search`, keep the hits in your own chat slot, and have your server half's `ctx.prompt.addBlock` read that slot.

**Extensions ported from TauriTavern:** the same handle is also TauriTavern's `api.db` (see `exposeAsTauriTavern` in `client/api.js`), unless a real TauriTavern host already provides one.

## Termux (`android-arm64`)

```bash
bash extensions/installed/triviumdb/scripts/build-termux.sh
```

Builds `native/triviumdb.android-arm64.node` in about three minutes. It installs only missing build tools and never upgrades Node.js (an upgrade would break Σ's `better-sqlite3`). Restart Σ afterwards.

## Tests

```bash
node --test test/triviumdb.test.mjs   # engine, page start-up, view and settings
node --test test/meaning.test.mjs     # the "dragon fire" meaning test, server routes, Gemini request shape
```

## Licence

GPL-3.0 (see `LICENSE`).
