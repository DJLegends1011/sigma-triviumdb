// SPDX-License-Identifier: 0BSD
// TriviumDB for Project Σ — Smart Recall, the server half:
// an index of the account's chat messages and lorebook entries in a TriviumDB namespace, searched by
// meaning (embeddings from one of the account's connections) or by words (BM25) when none is picked,
// and the recall of a chat's older moments into its prompt.

const TABLE = 'x_triviumdb_recall';
const META = 'x_triviumdb_meta';

// append-only: an entry that ran is never edited, a change is a new entry
export const migrations = [
    `CREATE TABLE x_triviumdb_recall (
        key TEXT PRIMARY KEY,
        space TEXT NOT NULL,
        node INTEGER NOT NULL,
        digest TEXT NOT NULL,
        src TEXT NOT NULL,
        chat_id TEXT,
        message_id INTEGER,
        seq INTEGER,
        world TEXT,
        uid INTEGER,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX x_triviumdb_recall_chat ON x_triviumdb_recall(chat_id);
    CREATE INDEX x_triviumdb_recall_world ON x_triviumdb_recall(world);
    CREATE INDEX x_triviumdb_recall_space ON x_triviumdb_recall(space, src);
    CREATE TABLE x_triviumdb_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );`,
];

const KEYWORD_SPACE = 'recall-kw';
const KEYWORD_DIM = 64;
const EMBED_BATCH = 64;
const EMBED_CHARS = 6000;
const SNIPPET_CHARS = 1200;
const INDEX_TEXT_CHARS = 8000;
const QUERY_CHARS = 1500;
const PRIME_TTL_MS = 30 * 60 * 1000;
const STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// a text-search hit scores above this; a node the words did not touch scores below 1
const TEXT_HIT = 2;
// connection kinds that have no embeddings endpoint of their own
const NO_EMBEDDINGS = new Set(['anthropic', 'vertex', 'claude-subscription', 'codex-subscription', 'antigravity-subscription']);

const STOP = new Set(('a about after again all also am an and any are as at be been before being but by can could did do does '
    + 'doing down for from had has have having he her here hers him his how i if in into is it its just me more most my no nor '
    + 'not now of off on once only or other our ours out over own same she should so some such than that the their theirs them '
    + 'then there these they this those through to too under until up very was we were what when where which while who whom why '
    + 'will with would you your yours yourself time told said say says tell').split(' '));

/** The words a keyword search runs on: no stopwords, no repeats, at most 24. */
export function keywordQuery(text) {
    const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) || [];
    const out = [];
    for (const w of words) {
        if (w.length < 2 || STOP.has(w) || out.includes(w)) continue;
        out.push(w);
        if (out.length >= 24) break;
    }
    return out.join(' ');
}

const clip = (text, max) => {
    const s = String(text || '').trim();
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

function unit(vec) {
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
}

function fnv(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
});

/**
 * @param {import('express').Router} router
 * @param {any} ctx  the server context
 * @param {any} engine  the namespace manager from index.js
 */
export function registerRecall(router, ctx, engine) {
    const { openNamespace, getOpenInstance, dropNamespace, loadNativeAddon, textToDemoVector, sanitizeBigInt } = engine;

    // ---- small stores ----
    const meta = {
        get(db, key) { return db.prepare(`SELECT value FROM ${META} WHERE key = ?`).get(key)?.value ?? null; },
        set(db, key, value) {
            if (value === null || value === undefined) db.prepare(`DELETE FROM ${META} WHERE key = ?`).run(key);
            else db.prepare(`INSERT INTO ${META} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
        },
    };
    const num = (db, key, lo, hi) => {
        const v = Number(ctx.setting(db, key));
        const d = Number(ctx.manifest.settings?.[key]);
        return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : d));
    };
    const flag = (db, key) => !!ctx.setting(db, key);

    // ---- what understands the text: one of the account's connections, or none (words only) ----
    function embedTarget(db) {
        const id = ctx.setting(db, 'embedProfile');
        if (!id) return null;
        const row = ctx.stores.llmProfiles.profileRow(db, id);
        if (!row || row.id !== id) return { error: 'The connection picked for Smart Recall was deleted. Pick another in Settings > Extensions > TriviumDB.' };
        const kind = String(row.kind || 'openai');
        const model = String(ctx.setting(db, 'embedModel') || '').trim();
        const base = String(row.base_url || '').replace(/\/+$/, '');
        if (kind === 'gemini') {
            return { via: 'gemini', kind, name: row.name, base: base || STUDIO_BASE, key: row.api_key || '', model: model || 'gemini-embedding-001' };
        }
        if (/-subscription$/.test(kind) || /^cli:/i.test(base)) {
            return { error: `“${row.name}” signs in with a subscription, and subscriptions (ChatGPT, Claude, Antigravity) give no embeddings. Pick an API-key connection: Google AI Studio (a key from a project without billing is free), OpenRouter, OpenAI, or a local Ollama / LM Studio.` };
        }
        if (NO_EMBEDDINGS.has(kind)) {
            return { error: `“${row.name}” (${kind}) has no embeddings endpoint. Pick Google AI Studio, OpenRouter, OpenAI, or an OpenAI-compatible server such as Ollama or LM Studio.` };
        }
        const fallbackBase = kind === 'openrouter' ? 'https://openrouter.ai/api/v1' : '';
        if (!base && !fallbackBase) return { error: `“${row.name}” has no endpoint address.` };
        return {
            via: 'openai',
            kind,
            name: row.name,
            base: base || fallbackBase,
            key: row.api_key || '',
            model: model || (kind === 'openrouter' ? 'openai/text-embedding-3-small' : 'text-embedding-3-small'),
        };
    }
    const signatureOf = (target) => (target && !target.error ? `${target.via}|${target.base}|${target.model}` : 'keyword');

    /** How long a 429 asks to wait, in ms: Retry-After, Google's RetryInfo, or "retry in 54.4s"; null when it does not say. */
    function retryDelayOf(resp, json, text) {
        const ra = Number(resp.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) return ra * 1000;
        const info = (json?.error?.details || []).find(d => String(d['@type'] || '').endsWith('RetryInfo'));
        const m = /^(\d+(?:\.\d+)?)s$/.exec(String(info?.retryDelay || '')) || /retry in (\d+(?:\.\d+)?)\s*s/i.exec(text);
        return m ? Math.ceil(Number(m[1]) * 1000) : null;
    }

    /**
     * patient: a background job, which waits out rate limits (as long as the service asks, up to ~2 min each,
     * a dozen times) and says so through onWait; a search or a prompt gives up after two short tries.
     */
    async function postJson(url, headers, body, signal, { patient = false, onWait } = {}) {
        let lastError = null;
        const tries = patient ? 12 : 3;
        for (let attempt = 0; attempt < tries; attempt++) {
            const timeout = AbortSignal.timeout(90_000);
            const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
            let resp;
            try {
                resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: sig });
            } catch (e) {
                if (signal?.aborted) throw e;
                lastError = new Error(`could not reach ${new URL(url).host}: ${e?.cause?.code || e?.message || e}`);
                await sleep(800 * (attempt + 1), signal);
                continue;
            }
            const text = await resp.text();
            let json = null;
            try { json = JSON.parse(text); } catch { /* not JSON */ }
            if (resp.ok && json) return json;
            const said = json?.error?.message || json?.error || json?.message || text.slice(0, 300) || resp.statusText;
            lastError = new Error(`${resp.status} ${typeof said === 'string' ? said : JSON.stringify(said)}`);
            if (resp.status !== 429 && resp.status < 500) break;
            // a quota that is spent for the day (not per minute) never comes back by waiting
            if (resp.status === 429 && /per ?day|PerDay|daily/i.test(text)) break;
            let wait = 1500 * (attempt + 1);
            if (resp.status === 429) {
                const asked = retryDelayOf(resp, json, text);
                if (!patient) { if (asked && asked > 5000) break; }
                else wait = Math.min(125_000, (asked ?? 20_000) + 1500);
            }
            if (patient) onWait?.(wait);
            await sleep(wait, signal);
        }
        throw lastError || new Error('the embeddings request failed');
    }

    /** One unit vector per text, in order. */
    async function embedTexts(target, texts, signal, opts = {}) {
        const out = [];
        for (let i = 0; i < texts.length; i += EMBED_BATCH) {
            const batch = texts.slice(i, i + EMBED_BATCH).map(t => clip(t, EMBED_CHARS) || ' ');
            let vectors;
            if (target.via === 'gemini') {
                const json = await postJson(
                    `${target.base}/models/${encodeURIComponent(target.model)}:batchEmbedContents`,
                    target.key ? { 'x-goog-api-key': target.key } : {},
                    { requests: batch.map(text => ({ model: `models/${target.model}`, content: { parts: [{ text }] } })) },
                    signal,
                    opts,
                );
                vectors = (json.embeddings || []).map(e => e.values);
            } else {
                const headers = target.key ? { authorization: 'Bearer ' + target.key } : {};
                const json = await postJson(`${target.base}/embeddings`, headers, { model: target.model, input: batch }, signal, opts);
                vectors = [...(json.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(d => d.embedding);
            }
            if (vectors.length !== batch.length || vectors.some(v => !Array.isArray(v) || !v.length)) {
                throw new Error(`the embeddings answer held ${vectors.length} vectors for ${batch.length} texts`);
            }
            for (const v of vectors) out.push(unit(v.map(Number)));
        }
        return out;
    }

    // ---- the namespace the index lives in: one per way of understanding text ----
    function currentSpace(db) {
        const space = meta.get(db, 'space');
        const dim = Number(meta.get(db, 'dim'));
        return space && dim ? { space, dim, sig: meta.get(db, 'sig') } : null;
    }
    function openSpace(db, user, sp) {
        openNamespace(user, db, sp.space, { dim: sp.dim });
        return getOpenInstance(user, sp.space);
    }
    function forgetSpace(db, user) {
        const sp = currentSpace(db);
        if (sp) {
            try { dropNamespace(user, sp.space); } catch { /* already gone */ }
        }
        db.transaction(() => {
            db.prepare(`DELETE FROM ${TABLE}`).run();
            for (const k of ['space', 'dim', 'sig', 'indexedAt']) meta.set(db, k, null);
        })();
    }
    /** The space the settings ask for, made (and the old one dropped) when they changed. */
    async function ensureSpace(db, user, target, signal) {
        const sig = signatureOf(target);
        const have = currentSpace(db);
        if (have && have.sig === sig) return have;
        let dim = KEYWORD_DIM;
        let space = KEYWORD_SPACE;
        if (target) {
            dim = (await embedTexts(target, ['dimension probe'], signal, { patient: true }))[0].length;
            space = `recall-${fnv(sig)}-${dim}`;
        }
        forgetSpace(db, user);
        db.transaction(() => {
            meta.set(db, 'space', space);
            meta.set(db, 'dim', dim);
            meta.set(db, 'sig', sig);
        })();
        // a namespace left on disk by an earlier run of the same space starts empty, as the table does
        try { dropNamespace(user, space); } catch { /* none */ }
        return { space, dim, sig };
    }

    // ---- what the index holds of the library ----
    const MESSAGE_COLS = `id, seq, is_user, is_system, mes, json_extract(data, '$.name') AS name,
        json_extract(data, '$.extra.hidden') AS hidden, json_extract(data, '$.send_date') AS at`;
    const chatInfo = (db, chatId) => db.prepare('SELECT id, char_id, name, character_name, user_name FROM chats WHERE id = ?').get(chatId) || null;

    function messageItems(db, chat) {
        const rows = db.prepare(`SELECT ${MESSAGE_COLS} FROM chat_messages WHERE chat_id = ? ORDER BY seq`).all(chat.id);
        const items = [];
        for (const r of rows) {
            const text = typeof r.mes === 'string' ? r.mes.trim() : '';
            if (r.is_system || r.hidden || !text) continue;
            const name = r.name || (r.is_user ? (chat.user_name || 'You') : (chat.character_name || 'Character'));
            items.push({
                key: `m:${r.id}`,
                digest: ctx.messages.digest(`${name}\n${text}`),
                embedText: `${name}: ${text}`,
                indexText: text,
                row: { src: 'msg', chat_id: chat.id, message_id: r.id, seq: r.seq, world: null, uid: null },
                payload: {
                    src: 'msg', chatId: chat.id, charId: chat.char_id, seq: r.seq, messageId: r.id,
                    user: !!r.is_user, name, chat: chat.name, char: chat.character_name || '', at: r.at || null,
                    text: clip(text, SNIPPET_CHARS),
                },
            });
        }
        return items;
    }

    function loreItems(db, world) {
        const rows = db.prepare('SELECT uid, data FROM world_entries WHERE world_name = ? ORDER BY uid').all(world);
        const items = [];
        for (const r of rows) {
            let d;
            try { d = JSON.parse(r.data); } catch { continue; }
            const content = typeof d.content === 'string' ? d.content.trim() : '';
            if (!content) continue;
            const keys = (Array.isArray(d.key) ? d.key : []).map(String).filter(Boolean);
            const title = String(d.comment || '').trim() || keys.slice(0, 3).join(', ') || `Entry ${r.uid}`;
            items.push({
                key: `l:${world}:${r.uid}`,
                digest: ctx.messages.digest(`${title}\n${keys.join(',')}\n${content}`),
                embedText: `${title}${keys.length ? ` (${keys.join(', ')})` : ''}: ${content}`,
                indexText: `${title} ${keys.join(' ')} ${content}`,
                row: { src: 'lore', chat_id: null, message_id: null, seq: null, world, uid: r.uid },
                payload: { src: 'lore', world, uid: r.uid, title, keys: keys.slice(0, 12), off: !!d.disable, text: clip(content, SNIPPET_CHARS) },
            });
        }
        return items;
    }

    /**
     * Bring the index in step with the library: new and changed items embedded, removed ones dropped.
     * scope.chats names the chats to look at, scope.lore every lorebook; neither: everything the settings index.
     */
    async function syncIndex({ db, user, signal, progress }, scope = {}) {
        const target = embedTarget(db);
        if (target?.error) throw new Error(target.error);
        if (!loadNativeAddon().TriviumDB) throw new Error('the TriviumDB engine is not built for this device');
        const sp = await ensureSpace(db, user, target, signal);
        const entry = openSpace(db, user, sp);
        const tdb = entry.db;
        const wantChats = flag(db, 'indexChats');
        const wantLore = flag(db, 'indexLore');
        const full = !scope.chats && !scope.lore;

        // what to visit
        const chatIds = !wantChats ? [] : scope.chats ? [...scope.chats] : full ? db.prepare('SELECT id FROM chats ORDER BY last_mes_at DESC').all().map(r => r.id) : [];
        const worlds = !wantLore || !(full || scope.lore) ? [] : db.prepare('SELECT name FROM worlds ORDER BY name').all().map(r => r.name);

        const total = (chatIds.length ? db.prepare(`SELECT COUNT(*) n FROM chat_messages WHERE chat_id IN (SELECT value FROM json_each(?))`).get(JSON.stringify(chatIds)).n : 0)
            + (worlds.length ? db.prepare(`SELECT COUNT(*) n FROM world_entries WHERE world_name IN (SELECT value FROM json_each(?))`).get(JSON.stringify(worlds)).n : 0);
        let seen = 0;
        let embedded = 0;
        let removed = 0;
        const say = (note) => progress?.({ done: Math.min(seen, total), total, note });

        const dropRows = (rows) => {
            for (const r of rows) {
                try { tdb.delete(r.node); } catch { /* already gone */ }
            }
            if (rows.length) {
                db.transaction(() => {
                    const del = db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`);
                    for (const r of rows) del.run(r.key);
                })();
                removed += rows.length;
            }
        };

        // embedding waits in one queue across chats, so small chats share calls
        let queue = [];
        const flushQueue = async () => {
            if (!queue.length) return;
            const batch = queue;
            queue = [];
            const onWait = (ms) => progress?.({ done: Math.min(seen, total), total, note: `Waiting ${Math.round(ms / 1000)}s for ${target.name}'s rate limit` });
            const vectors = target ? await embedTexts(target, batch.map(i => i.embedText), signal, { patient: true, onWait }) : batch.map(i => textToDemoVector(i.embedText, sp.dim));
            const now = Date.now();
            const upsert = db.prepare(`INSERT INTO ${TABLE} (key, space, node, digest, src, chat_id, message_id, seq, world, uid, updated_at)
                VALUES (@key, @space, @node, @digest, @src, @chat_id, @message_id, @seq, @world, @uid, @updated_at)
                ON CONFLICT(key) DO UPDATE SET space = excluded.space, node = excluded.node, digest = excluded.digest, chat_id = excluded.chat_id,
                    message_id = excluded.message_id, seq = excluded.seq, world = excluded.world, uid = excluded.uid, updated_at = excluded.updated_at`);
            const rows = [];
            batch.forEach((item, i) => {
                let node = item.node;
                if (node) {
                    tdb.updateVector(node, vectors[i]);
                    tdb.updatePayload(node, item.payload);
                } else {
                    node = tdb.insert(vectors[i], item.payload);
                }
                tdb.indexText(node, clip(item.indexText, INDEX_TEXT_CHARS));
                rows.push({ key: item.key, space: sp.space, node, digest: item.digest, ...item.row, updated_at: now });
            });
            db.transaction(() => { for (const r of rows) upsert.run(r); })();
            embedded += batch.length;
            if (embedded % (EMBED_BATCH * 8) < batch.length) tdb.buildTextIndex();
        };

        const visit = async (items, existingRows, label) => {
            const existing = new Map(existingRows.map(r => [r.key, r]));
            const moved = [];
            for (const item of items) {
                const had = existing.get(item.key);
                existing.delete(item.key);
                if (had && had.digest === item.digest) {
                    if (item.row.seq !== null && had.seq !== item.row.seq) moved.push({ had, item });
                    continue;
                }
                queue.push({ ...item, node: had?.node || null });
                if (queue.length >= EMBED_BATCH) {
                    say(label);
                    await flushQueue();
                    if (signal?.aborted) return;
                }
            }
            // a message whose place moved keeps its vector; its payload learns the new place
            if (moved.length) {
                for (const { had, item } of moved) {
                    try { tdb.updatePayload(had.node, item.payload); } catch { /* gone */ }
                }
                db.transaction(() => {
                    const up = db.prepare(`UPDATE ${TABLE} SET seq = ? WHERE key = ?`);
                    for (const { had, item } of moved) up.run(item.row.seq, had.key);
                })();
            }
            dropRows([...existing.values()]);
        };

        const rowsOfChat = db.prepare(`SELECT key, node, digest, seq FROM ${TABLE} WHERE space = ? AND src = 'msg' AND chat_id = ?`);
        for (const chatId of chatIds) {
            if (signal?.aborted) break;
            const chat = chatInfo(db, chatId);
            const items = chat ? messageItems(db, chat) : [];
            await visit(items, rowsOfChat.all(sp.space, chatId), chat ? `Reading “${chat.name}”` : 'Reading chats');
            seen += chat ? db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE chat_id = ?').get(chatId).n : 0;
            say(chat ? `Read “${chat.name}”` : 'Reading chats');
        }
        const rowsOfWorld = db.prepare(`SELECT key, node, digest, seq FROM ${TABLE} WHERE space = ? AND src = 'lore' AND world = ?`);
        for (const world of worlds) {
            if (signal?.aborted) break;
            const exists = !!db.prepare('SELECT 1 FROM worlds WHERE name = ?').get(world);
            const items = exists ? loreItems(db, world) : [];
            await visit(items, rowsOfWorld.all(sp.space, world), `Reading lorebook “${world}”`);
            seen += db.prepare('SELECT COUNT(*) n FROM world_entries WHERE world_name = ?').get(world).n;
            say(`Read lorebook “${world}”`);
        }
        if (!signal?.aborted) {
            say('Embedding the last batch');
            await flushQueue();
        }

        // what the library no longer holds, or the settings no longer index
        if (!signal?.aborted && full) {
            dropRows(db.prepare(`SELECT key, node FROM ${TABLE} WHERE space = ? AND src = 'msg' AND (? = 0 OR chat_id NOT IN (SELECT id FROM chats))`).all(sp.space, wantChats ? 1 : 0));
        }
        if (!signal?.aborted && (full || scope.lore)) {
            dropRows(db.prepare(`SELECT key, node FROM ${TABLE} WHERE space = ? AND src = 'lore' AND (? = 0 OR world NOT IN (SELECT name FROM worlds))`).all(sp.space, wantLore ? 1 : 0));
        }
        if (!wantChats && scope.chats?.size) {
            dropRows(db.prepare(`SELECT key, node FROM ${TABLE} WHERE space = ? AND src = 'msg' AND chat_id IN (SELECT value FROM json_each(?))`).all(sp.space, JSON.stringify([...scope.chats])));
        }
        tdb.buildTextIndex();
        tdb.flush();
        meta.set(db, 'indexedAt', Date.now());
        progress?.({ done: total, total, note: `${embedded} added or changed, ${removed} removed` });
        return { embedded, removed, total };
    }

    // ---- jobs: the full index on request, and catching up as the library changes ----
    const JOB_KEYS = ['index', 'sync'];
    const pending = new Map(); // user -> { chats: Set, lore: boolean }
    const latestJob = (db) => ctx.jobs.list(db).filter(j => JOB_KEYS.includes(j.key)).sort((a, b) => (b.queuedAt || 0) - (a.queuedAt || 0))[0] || null;

    function enqueueIndex(db) {
        return ctx.jobs.run(db, {
            key: 'index',
            label: 'Smart Recall: indexing your library',
            run: (job) => syncIndex(job, {}),
        });
    }
    function enqueueSync(db, user) {
        return ctx.jobs.run(db, {
            key: 'sync',
            label: 'Smart Recall: catching up',
            run: async (job) => {
                await sleep(2500, job.signal);
                const p = pending.get(job.user) || { chats: new Set(), lore: false };
                pending.delete(job.user);
                if (!p.chats.size && !p.lore) return;
                await syncIndex(job, { chats: p.chats.size ? p.chats : null, lore: p.lore });
            },
        });
    }

    ctx.events.on((records, { db, user }) => {
        if (!currentSpace(db) || !flag(db, 'autoUpdate')) return;
        const p = pending.get(user) || { chats: new Set(), lore: false };
        let touched = false;
        for (const r of records) {
            if (r.extension === ctx.manifest.id) continue;
            if (r.entity === 'message' && r.chatId) { p.chats.add(r.chatId); touched = true; }
            else if (r.entity === 'chat' && r.op === 'deleted') { for (const id of r.ids || []) p.chats.add(String(id)); touched = true; }
            else if (r.entity === 'chat' && r.op === 'created') { for (const id of r.ids || []) p.chats.add(String(id)); touched = true; }
            else if (r.entity === 'world' || r.entity === 'worldEntry') { p.lore = true; touched = true; }
        }
        if (!touched) return;
        if (!flag(db, 'indexChats')) p.chats.clear();
        if (!flag(db, 'indexLore')) p.lore = false;
        if (!p.chats.size && !p.lore) return;
        pending.set(user, p);
        const busy = ctx.jobs.list(db).some(j => j.key === 'sync' && j.status === 'queued');
        if (!busy) enqueueSync(db, user);
    });

    // ---- search ----
    /**
     * Hits for a query in the index: by meaning when there is a vector, plus the items whose words match.
     * filter is TriviumDB's payload filter; keywords:false leaves the words out (the prompt's long queries).
     */
    function searchIndex(entry, { vec, text, k, filter, minScore = 0, keywords = true }) {
        const found = new Map();
        if (vec) {
            for (const h of entry.db.search(vec, k, 0, minScore, filter)) {
                found.set(h.id, { id: h.id, payload: h.payload, sem: h.score, kw: false });
            }
        }
        const words = keywords ? keywordQuery(text) : '';
        if (words) {
            const zero = new Array(entry.dim).fill(0);
            let rank = 0;
            for (const h of entry.db.searchHybrid(zero, words, k, 0, 0, 0, filter)) {
                if (h.score < TEXT_HIT) continue;
                const had = found.get(h.id);
                if (had) had.kw = true;
                else found.set(h.id, { id: h.id, payload: h.payload, sem: null, kw: true, kwRank: rank });
                rank++;
            }
        }
        const scoreOf = (h) => (h.sem ?? 0) + (h.kw ? 0.15 : 0) - (h.sem === null ? (h.kwRank || 0) * 0.001 : 0);
        return [...found.values()].sort((a, b) => scoreOf(b) - scoreOf(a)).map(h => sanitizeBigInt(h));
    }

    const view = (h) => {
        const p = h.payload || {};
        const base = { id: h.id, src: p.src, match: h.sem === null ? null : Math.round(Math.max(0, Math.min(1, h.sem)) * 100), words: !!h.kw, text: p.text || '' };
        if (p.src === 'lore') return { ...base, world: p.world, uid: p.uid, title: p.title, keys: p.keys || [], off: !!p.off };
        return { ...base, chatId: p.chatId, charId: p.charId, seq: p.seq, messageId: p.messageId, user: !!p.user, name: p.name, chat: p.chat, char: p.char, at: p.at };
    };

    // ---- recall in the prompt ----
    const primed = new Map(); // `${user}:${chatId}` -> { text, vec, at, sig }
    const recalled = new Map(); // `${user}:${chatId}` -> { at, hits }
    const keyOf = (user, chatId) => `${user || 'default'}:${chatId}`;

    function chatRecall(db, chatId) {
        const slot = ctx.chatSlot.get(db, chatId) || {};
        const on = typeof slot.recall === 'boolean' ? slot.recall : flag(db, 'recallByDefault');
        const scope = slot.scope === 'character' ? 'character' : 'chat';
        return { on, scope, set: typeof slot.recall === 'boolean' };
    }

    /** The newest visible messages' text, the query the prompt's recall runs on. */
    function recentText(db, chatId, extra = '') {
        const rows = db.prepare(`SELECT ${MESSAGE_COLS} FROM chat_messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 8`).all(chatId);
        const parts = [];
        for (const r of rows) {
            if (r.is_system || r.hidden || !String(r.mes || '').trim()) continue;
            parts.unshift(String(r.mes).trim());
            if (parts.length >= 2) break;
        }
        if (extra && String(extra).trim()) parts.push(String(extra).trim());
        const text = parts.join('\n');
        return text.length > QUERY_CHARS ? text.slice(-QUERY_CHARS) : text;
    }

    async function prime(db, user, chatId, extra, signal) {
        const sp = currentSpace(db);
        if (!sp || sp.space === KEYWORD_SPACE) return false;
        const target = embedTarget(db);
        if (!target || target.error || signatureOf(target) !== sp.sig) return false;
        const text = recentText(db, chatId, extra);
        if (!text) return false;
        const [vec] = await embedTexts(target, [text], signal);
        primed.set(keyOf(user, chatId), { text, vec, at: Date.now(), sig: sp.sig });
        return true;
    }

    // a new message in a chat that recalls: the next prompt's query is embedded ahead of it
    ctx.events.on((records, { db, user }) => {
        const chats = new Set(records.filter(r => r.entity === 'message' && r.op === 'created' && r.chatId).map(r => r.chatId));
        for (const chatId of chats) {
            try {
                if (!chatRecall(db, chatId).on) continue;
            } catch { continue; }
            void prime(db, user, chatId, '').catch(() => { /* the prompt falls back to the last vector */ });
        }
    });

    /** What the prompt recalls for a chat now: the hits and the block's text; null when nothing. */
    function recallFor(db, user, chatId, { force = false } = {}) {
        const { on, scope } = chatRecall(db, chatId);
        if (!on && !force) return null;
        const sp = currentSpace(db);
        if (!sp || !loadNativeAddon().TriviumDB) return null;
        const chat = chatInfo(db, chatId);
        if (!chat) return null;
        const entry = openSpace(db, user, sp);
        if (entry.db.nodeCount() === 0) return null;

        const topK = num(db, 'recallTopK', 1, 12);
        const skip = num(db, 'recallSkipRecent', 0, 500);
        const minScore = num(db, 'recallMinScore', 0, 1);
        const maxSeq = db.prepare('SELECT MAX(seq) m FROM chat_messages WHERE chat_id = ?').get(chatId)?.m ?? -1;
        const cutoff = maxSeq - skip;
        const text = recentText(db, chatId);
        if (!text) return null;

        const cache = primed.get(keyOf(user, chatId));
        const fresh = cache && cache.sig === sp.sig && Date.now() - cache.at < PRIME_TTL_MS;
        const vec = sp.space === KEYWORD_SPACE ? null : fresh ? cache.vec : null;
        // without a vector the words of the newest message stand in
        const words = vec ? '' : recentText(db, chatId).split('\n').at(-1) || '';
        const filter = scope === 'character' ? { src: 'msg', charId: chat.char_id } : { src: 'msg', chatId };
        const hits = searchIndex(entry, { vec, text: words, k: topK * 6 + skip, filter, minScore, keywords: !vec })
            .map(view)
            .filter(h => h.src === 'msg' && (h.chatId !== chatId || h.seq <= cutoff))
            .slice(0, topK);
        if (!hits.length) return { hits, text: '', by: vec ? 'meaning' : 'words' };

        const lines = hits.map(h => {
            const where = h.chatId === chatId ? `message #${h.seq}` : `an earlier chat, “${h.chat}”`;
            return `- ${h.name} (${where}): ${clip(h.text, 500)}`;
        });
        const head = String(ctx.setting(db, 'recallHeading') || '').trim()
            || 'Earlier moments from this story that may matter now. They already happened; use them for continuity, not as new events.';
        return { hits, text: `[${head}\n${lines.join('\n')}]`, by: vec ? 'meaning' : 'words' };
    }

    ctx.prompt.addBlock({
        id: 'recall',
        position: 'pre_history',
        role: 'system',
        text: ({ db, user, chatId, dryRun }) => {
            try {
                const out = recallFor(db, user, chatId);
                if (!out) return '';
                if (!dryRun) recalled.set(keyOf(user, chatId), { at: Date.now(), hits: out.hits, by: out.by });
                if (!out.text) return '';
                const placement = ['pre_history', 'post_history', 'at_depth'].includes(ctx.setting(db, 'promptPlacement')) ? ctx.setting(db, 'promptPlacement') : 'pre_history';
                return placement === 'at_depth'
                    ? { text: out.text, position: 'at_depth', depth: num(db, 'promptDepth', 0, 50), role: 'system' }
                    : { text: out.text, position: placement, role: 'system' };
            } catch {
                return '';
            }
        },
    });

    // ---- routes ----
    const fail = (res, e, status = 400) => res.status(e?.statusCode || status).json({ error: e instanceof Error ? e.message : String(e) });

    function counts(db, sp) {
        const lib = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(LENGTH(mes)), 0) c FROM chat_messages WHERE is_system = 0 AND mes IS NOT NULL AND mes <> ''`).get();
        const lore = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(LENGTH(json_extract(data, '$.content'))), 0) c FROM world_entries`).get();
        const out = { library: { messages: lib.n, lore: lore.n }, indexed: { messages: 0, lore: 0 }, waiting: { messages: lib.n, lore: lore.n, tokens: Math.round((lib.c + lore.c) / 4) } };
        if (!sp) return out;
        const got = db.prepare(`SELECT src, COUNT(*) n FROM ${TABLE} WHERE space = ? GROUP BY src`).all(sp.space);
        for (const g of got) out.indexed[g.src === 'lore' ? 'lore' : 'messages'] = g.n;
        const waitMsg = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(LENGTH(m.mes)), 0) c FROM chat_messages m WHERE m.is_system = 0 AND m.mes IS NOT NULL AND m.mes <> ''
            AND NOT EXISTS (SELECT 1 FROM ${TABLE} r WHERE r.key = 'm:' || m.id AND r.space = ?)`).get(sp.space);
        const waitLore = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(LENGTH(json_extract(e.data, '$.content'))), 0) c FROM world_entries e
            WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} r WHERE r.key = 'l:' || e.world_name || ':' || e.uid AND r.space = ?)`).get(sp.space);
        out.waiting = { messages: waitMsg.n, lore: waitLore.n, tokens: Math.round((waitMsg.c + waitLore.c) / 4) };
        return out;
    }

    router.get('/recall/status', (req, res) => {
        try {
            const db = req.db;
            const native = loadNativeAddon();
            const target = embedTarget(db);
            const sp = currentSpace(db);
            const c = counts(db, sp);
            const job = latestJob(db);
            res.json({
                engine: { ok: !!native.TriviumDB, binary: native.binary, error: native.error, platform: `${process.platform}-${process.arch}` },
                mode: target && !target.error ? 'meaning' : 'words',
                connection: target && !target.error ? { name: target.name, model: target.model, kind: target.kind } : null,
                connectionError: target?.error || null,
                index: {
                    built: !!sp,
                    stale: !!sp && sp.sig !== signatureOf(target),
                    mode: sp ? (sp.space === KEYWORD_SPACE ? 'words' : 'meaning') : null,
                    indexedAt: Number(meta.get(db, 'indexedAt')) || null,
                    ...c,
                },
                scope: { chats: flag(db, 'indexChats'), lore: flag(db, 'indexLore'), auto: flag(db, 'autoUpdate') },
                job: job ? { id: job.id, key: job.key, status: job.status, progress: job.progress, error: job.error, endedAt: job.endedAt } : null,
            });
        } catch (e) { fail(res, e, 500); }
    });

    router.post('/recall/index', (req, res) => {
        try {
            if (!loadNativeAddon().TriviumDB) return res.status(503).json({ error: 'the TriviumDB engine is not built for this device' });
            const target = embedTarget(req.db);
            if (target?.error) return res.status(400).json({ error: target.error });
            if (req.body?.rebuild === true) forgetSpace(req.db, req.userHandle);
            res.json({ queued: true, id: enqueueIndex(req.db).id });
        } catch (e) { fail(res, e); }
    });

    router.delete('/recall/index', (req, res) => {
        try {
            forgetSpace(req.db, req.userHandle);
            primed.clear();
            res.json({ ok: true });
        } catch (e) { fail(res, e); }
    });

    router.post('/recall/test', async (req, res) => {
        try {
            const target = embedTarget(req.db);
            if (!target) return res.json({ ok: true, mode: 'words' });
            if (target.error) return res.status(400).json({ error: target.error });
            const t0 = Date.now();
            const [vec] = await embedTexts(target, ['Smart Recall connection test'], AbortSignal.timeout(60_000));
            res.json({ ok: true, mode: 'meaning', model: target.model, dim: vec.length, ms: Date.now() - t0 });
        } catch (e) { fail(res, e, 502); }
    });

    router.post('/recall/search', async (req, res) => {
        try {
            const db = req.db;
            const q = String(req.body?.q || '').trim().slice(0, 2000);
            if (!q) return res.json({ hits: [], by: null });
            const sp = currentSpace(db);
            if (!sp) return res.status(409).json({ error: 'Nothing is indexed yet. Press “Index my library” first.' });
            const entry = openSpace(db, req.userHandle, sp);
            const limit = Math.max(1, Math.min(50, Number(req.body?.limit) || 20));
            const scope = ['chats', 'lore'].includes(req.body?.scope) ? req.body.scope : 'all';
            const filter = {};
            if (scope === 'chats') filter.src = 'msg';
            if (scope === 'lore') filter.src = 'lore';
            if (typeof req.body?.chatId === 'string' && req.body.chatId) { filter.src = 'msg'; filter.chatId = req.body.chatId; }
            if (typeof req.body?.charId === 'string' && req.body.charId) { filter.src = 'msg'; filter.charId = req.body.charId; }
            let vec = null;
            if (sp.space !== KEYWORD_SPACE) {
                const target = embedTarget(db);
                if (target && !target.error && signatureOf(target) === sp.sig) {
                    [vec] = await embedTexts(target, [q], AbortSignal.timeout(60_000));
                }
            }
            const minScore = vec ? Math.max(0, num(db, 'recallMinScore', 0, 1) - 0.1) : 0;
            const hits = searchIndex(entry, { vec, text: q, k: limit, filter: Object.keys(filter).length ? filter : undefined, minScore }).slice(0, limit).map(view);
            res.json({ hits, by: vec ? 'meaning' : 'words' });
        } catch (e) { fail(res, e); }
    });

    router.get('/recall/chats/:chatId', ctx.requireChat, (req, res) => {
        try {
            const db = req.db;
            const { chatId } = req.params;
            const r = chatRecall(db, chatId);
            const sp = currentSpace(db);
            const indexed = sp ? db.prepare(`SELECT COUNT(*) n FROM ${TABLE} WHERE space = ? AND chat_id = ?`).get(sp.space, chatId).n : 0;
            const total = db.prepare(`SELECT COUNT(*) n FROM chat_messages WHERE chat_id = ? AND is_system = 0 AND mes IS NOT NULL AND mes <> ''`).get(chatId).n;
            const last = recalled.get(keyOf(req.userHandle, chatId)) || null;
            res.json({
                chatId, on: r.on, scope: r.scope, set: r.set, byDefault: flag(db, 'recallByDefault'),
                built: !!sp, mode: sp ? (sp.space === KEYWORD_SPACE ? 'words' : 'meaning') : null,
                indexed, total, last,
            });
        } catch (e) { fail(res, e, 500); }
    });

    router.put('/recall/chats/:chatId', ctx.requireChat, (req, res) => {
        try {
            const { chatId } = req.params;
            const body = req.body || {};
            const slot = { ...(ctx.chatSlot.get(req.db, chatId) || {}) };
            if (body.on !== undefined) {
                if (typeof body.on !== 'boolean') return res.status(400).json({ error: 'on is true or false' });
                slot.recall = body.on;
            }
            if (body.scope !== undefined) {
                if (!['chat', 'character'].includes(body.scope)) return res.status(400).json({ error: 'scope is chat or character' });
                slot.scope = body.scope;
            }
            ctx.chatSlot.set(req.db, chatId, slot);
            if (slot.recall) void prime(req.db, req.userHandle, chatId, '').catch(() => {});
            res.json({ ok: true, ...chatRecall(req.db, chatId) });
        } catch (e) { fail(res, e); }
    });

    // the composer is about to send: embed the query with the new message in it, before the prompt is built
    router.post('/recall/chats/:chatId/prime', ctx.requireChat, async (req, res) => {
        try {
            const { chatId } = req.params;
            if (!chatRecall(req.db, chatId).on) return res.json({ primed: false });
            const done = await prime(req.db, req.userHandle, chatId, String(req.body?.text || '').slice(0, QUERY_CHARS), AbortSignal.timeout(15_000));
            res.json({ primed: done });
        } catch (e) { res.json({ primed: false, error: e instanceof Error ? e.message : String(e) }); }
    });

    // what the prompt would recall right now (the window's preview)
    router.get('/recall/chats/:chatId/preview', ctx.requireChat, (req, res) => {
        try {
            const out = recallFor(req.db, req.userHandle, req.params.chatId, { force: true });
            res.json(out || { hits: [], text: '', by: null });
        } catch (e) { fail(res, e); }
    });

    return { recallFor };
}
