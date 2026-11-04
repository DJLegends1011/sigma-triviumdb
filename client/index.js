// SPDX-License-Identifier: 0BSD
// TriviumDB for Project Σ — the client half:
// 1. Smart Recall: a view that finds any moment of the library's chats and lorebooks by meaning, a chat window
//    that turns on the recall of a chat's older moments into its prompt, and the settings.
// 2. The engine for other extensions: window.__SIGMA_TRIVIUM__.db and the triviumdb.* commands.
// 3. The developer workbench, folded away at the bottom of the view.

import { createTriviumClientApi, why } from './api.js';
import { mountDevTools } from './dev.js';

const VIEW = 'ext:triviumdb/recall';
const POLL_MS = 1500;
const PRIME_WAIT_MS = 4000;
const STOP = new Set('a an and are as at be but by for from had has have he her his i if in into is it its me my no not of on or our she so that the their them then there they this to was we were what when where which who will with you your'.split(' '));

/** @type {import('../../../../docs/extensions').ClientExtension} */
export default {
    init(ctx) {
        const { CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(String(s ?? ''));
        const call = ctx.server.call;
        const dbApi = createTriviumClientApi(call);

        // ---- the engine for other extensions ----
        if (typeof window !== 'undefined') {
            window.__SIGMA_TRIVIUM__ = Object.freeze({ db: dbApi, version: '0.9.0' });
        }
        ctx.commands.register('open', ({ namespace = 'playground', options = {} } = {}) => dbApi.open(namespace, options), {
            title: 'Open a TriviumDB namespace handle',
        });
        ctx.commands.register('list-namespaces', () => dbApi.listNamespaces(), { title: 'List open TriviumDB namespaces' });
        ctx.commands.register('status', () => dbApi.status(), { title: 'Get TriviumDB engine status' });
        ctx.commands.register('seed-demo', ({ namespace = 'playground', reset = true } = {}) => dbApi.seedDemo(namespace, reset), {
            title: 'Seed the TriviumDB playground knowledge graph',
        });
        ctx.commands.register('query', async ({ namespace = 'playground', query = 'MATCH (n) RETURN n', params = {}, dim } = {}) => {
            const db = await dbApi.open(namespace, dim ? { dim } : {});
            return db.query(query, params);
        }, { title: 'Execute a TQL query or mutation on a TriviumDB namespace' });
        ctx.commands.register('search', async ({ namespace = 'playground', vector = null, queryText = '', topK = 5, expandDepth = 1, advanced = false, dim } = {}) => {
            const db = await dbApi.open(namespace, dim ? { dim } : {});
            return advanced
                ? db.searchAdvanced(vector, { queryText, topK, expandDepth })
                : db.search(vector, { queryText, topK, expandDepth });
        }, { title: 'Search a TriviumDB namespace (vector + BM25 + graph diffusion)' });
        ctx.commands.register('recall-search', ({ q = '', scope = 'all', chatId, charId, limit = 20 } = {}) => call('/recall/search', 'POST', { q, scope, chatId, charId, limit }), {
            title: 'Search the Smart Recall index of chats and lorebooks',
        });

        // ---- shared bits ----
        const fmtNum = (n) => Number(n || 0).toLocaleString();
        const fmtDate = (at) => {
            if (!at) return '';
            const d = new Date(typeof at === 'number' || /^\d+$/.test(String(at)) ? Number(at) : String(at).replace(/(\d)(am|pm)$/i, '$1 $2'));
            return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        };
        const termsOf = (q) => [...new Set((String(q || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) || []).filter(w => w.length > 2 && !STOP.has(w)))].slice(0, 12);
        /** The part of a text around its first matching word, escaped, with the words marked. */
        function snippetHtml(text, q, max = 320) {
            const raw = String(text || '');
            const terms = termsOf(q);
            let start = 0;
            if (terms.length) {
                const lower = raw.toLowerCase();
                const at = Math.min(...terms.map(t => { const i = lower.indexOf(t); return i < 0 ? Infinity : i; }));
                if (Number.isFinite(at) && at > max * 0.4) start = Math.max(0, at - Math.floor(max * 0.3));
            }
            let cut = raw.slice(start, start + max);
            if (start > 0) cut = `…${cut.replace(/^\S*\s/, '')}`;
            if (start + max < raw.length) cut = `${cut.replace(/\s\S*$/, '')}…`;
            let html = esc(cut);
            if (terms.length) {
                const re = new RegExp(`(${terms.map(t => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
                html = html.replace(re, '<mark>$1</mark>');
            }
            return html;
        }
        const avatarOf = (charId) => {
            try { return charId ? (CoreAPI.getCharacterAvatarSmallThumbUrl?.(charId) || '') : ''; } catch { return ''; }
        };
        async function openHit(h) {
            try {
                if (h.src === 'lore') await ctx.commands.run('lorebook.open', { name: h.world, uid: h.uid });
                else await ctx.chats.open(h.chatId, { messageId: h.messageId, seq: h.seq });
            } catch (e) {
                CoreAPI.showToast(`Could not open it: ${why(e)}`, 'error');
            }
        }
        function hitHtml(h, q, ref, { compact = false } = {}) {
            const match = h.match === null || h.match === undefined
                ? (h.words ? '<span class="tdb-pill" title="Matched your words">words</span>' : '')
                : `<span class="tdb-pill is-match" title="How close in meaning">${esc(h.match)}%</span>`;
            const max = compact ? 180 : 320;
            if (h.src === 'lore') {
                return `<button type="button" class="tdb-hit${compact ? ' is-compact' : ''}" data-tdb-hit="${esc(ref)}">
                    <span class="tdb-hit-icon is-lore" aria-hidden="true"><i class="fa-solid fa-book-atlas"></i></span>
                    <span class="tdb-hit-main">
                        <span class="tdb-hit-top"><strong class="tdb-hit-name">${esc(h.title)}</strong>${match}</span>
                        <span class="tdb-hit-where">Lorebook · ${esc(h.world)}${h.off ? ' · off' : ''}</span>
                        <span class="tdb-hit-text">${snippetHtml(h.text, q, max)}</span>
                    </span>
                </button>`;
            }
            const img = avatarOf(h.charId);
            const pic = h.user
                ? '<span class="tdb-hit-icon" aria-hidden="true"><i class="fa-solid fa-user"></i></span>'
                : img ? `<img class="tdb-hit-avatar" src="${esc(img)}" alt="" loading="lazy">` : '<span class="tdb-hit-icon" aria-hidden="true"><i class="fa-solid fa-comment"></i></span>';
            const where = [h.chat ? `“${h.chat}”` : '', `#${h.seq}`, fmtDate(h.at)].filter(Boolean).join(' · ');
            return `<button type="button" class="tdb-hit${compact ? ' is-compact' : ''}" data-tdb-hit="${esc(ref)}">
                ${pic}
                <span class="tdb-hit-main">
                    <span class="tdb-hit-top"><strong class="tdb-hit-name">${esc(h.name)}</strong>${match}</span>
                    <span class="tdb-hit-where">${h.char && !h.user ? `${esc(h.char)} · ` : ''}${esc(where)}</span>
                    <span class="tdb-hit-text">${snippetHtml(h.text, q, max)}</span>
                </span>
            </button>`;
        }
        const engineHint = (st) => `TriviumDB's engine is not built for this device (${esc(st?.engine?.platform || '')}).`
            + ' On Termux, run <code>bash extensions/installed/triviumdb/scripts/build-termux.sh</code> and restart Project Σ.';

        // ---- the menu door and the view ----
        ctx.ui.contribute('app.action', {
            id: 'recall',
            label: 'Smart Recall',
            icon: 'fa-clock-rotate-left',
            when: ({ view }) => view !== VIEW,
            run: () => ctx.commands.run('view.switch', { view: VIEW }),
        });

        let page = null;
        ctx.ui.contribute('shell.view', {
            id: 'recall',
            label: 'Smart Recall',
            icon: 'fa-clock-rotate-left',
            render(el) { page = mountView(el); },
            enter: () => page?.enter(),
            leave: () => page?.leave(),
            refresh: () => page?.refresh(),
        });

        function mountView(el) {
            el.innerHTML = `
                <div class="tdb">
                    <header class="tdb-hero">
                        <h2 class="tdb-hero-title"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i> Smart Recall</h2>
                        <p class="tdb-hero-lead">Find any moment from your chats and lorebooks by what it meant, not the exact words. Turn it on in a chat and the AI remembers the moments that matter, too.</p>
                    </header>
                    <form class="tdb-searchbar" data-tdb-form>
                        <i class="fa-solid fa-magnifying-glass tdb-searchbar-icon" aria-hidden="true"></i>
                        <input type="search" class="glass-input tdb-searchbar-input" data-tdb-q autocomplete="off" enterkeyhint="search"
                            placeholder="e.g. the night she told me about her brother">
                        <button type="submit" class="cl-btn cl-btn-primary tdb-searchbar-go">Search</button>
                    </form>
                    <div class="tdb-chips" role="radiogroup" aria-label="Search in">
                        <button type="button" class="tdb-chip is-on" data-tdb-scope="all" role="radio" aria-checked="true">Everything</button>
                        <button type="button" class="tdb-chip" data-tdb-scope="chats" role="radio" aria-checked="false"><i class="fa-solid fa-comments" aria-hidden="true"></i> Chats</button>
                        <button type="button" class="tdb-chip" data-tdb-scope="lore" role="radio" aria-checked="false"><i class="fa-solid fa-book-atlas" aria-hidden="true"></i> Lorebooks</button>
                        <span class="tdb-by" data-tdb-by></span>
                    </div>
                    <div class="tdb-results" data-tdb-results aria-live="polite"></div>
                    <section class="tdb-card" data-tdb-status><p class="tdb-dim">Reading the index…</p></section>
                    <details class="tdb-dev" data-tdb-dev>
                        <summary><i class="fa-solid fa-code" aria-hidden="true"></i> Developer tools <span class="tdb-dim">the raw engine, for extension authors</span></summary>
                        <div data-tdb-dev-body></div>
                    </details>
                </div>`;
            const $ = (sel) => el.querySelector(sel);
            let shown = false;
            let st = null;
            let scope = 'all';
            let lastQ = '';
            let hits = [];
            let timer = null;
            let dev = null;

            function paintStatus() {
                const box = $('[data-tdb-status]');
                if (!st) return;
                if (!st.engine.ok) {
                    box.className = 'tdb-card is-warn';
                    box.innerHTML = `<p>${engineHint(st)}</p>`;
                    return;
                }
                const ix = st.index;
                const job = st.job;
                const busy = job && (job.status === 'queued' || job.status === 'running');
                const pct = busy && job.progress?.total ? Math.round((job.progress.done / job.progress.total) * 100) : null;
                const how = st.mode === 'meaning'
                    ? `<span class="tdb-pill is-match"><i class="fa-solid fa-brain" aria-hidden="true"></i> By meaning</span> <span class="tdb-dim">${esc(st.connection.name)} · ${esc(st.connection.model)}</span>`
                    : '<span class="tdb-pill"><i class="fa-solid fa-font" aria-hidden="true"></i> By words</span> <span class="tdb-dim">Pick a connection in the settings to search by meaning.</span>';
                const what = ix.built
                    ? `<strong>${fmtNum(ix.indexed.messages)}</strong> messages and <strong>${fmtNum(ix.indexed.lore)}</strong> lore entries indexed`
                    : 'Nothing indexed yet';
                const waitingN = (st.scope.chats ? ix.waiting.messages : 0) + (st.scope.lore ? ix.waiting.lore : 0);
                const waiting = ix.built && waitingN
                    ? `<span class="tdb-dim">· ${fmtNum(waitingN)} waiting${st.mode === 'meaning' ? ` (about ${fmtNum(ix.waiting.tokens)} tokens to embed)` : ''}</span>`
                    : ix.built ? '<span class="tdb-dim">· up to date</span>' : '';
                const verb = !ix.built ? 'Index my library' : ix.stale ? 'Re-index with the new settings' : 'Update index';
                box.className = `tdb-card${st.connectionError ? ' is-warn' : ''}`;
                box.innerHTML = `
                    <div class="tdb-status-row">
                        <div class="tdb-status-main">
                            <div class="tdb-status-line">${how}</div>
                            <div class="tdb-status-line">${what} ${waiting}</div>
                            ${ix.stale ? '<div class="tdb-status-line tdb-warn-text">The way text is understood changed in the settings; index again to search that way.</div>' : ''}
                            ${st.connectionError ? `<div class="tdb-status-line tdb-warn-text">${esc(st.connectionError)}</div>` : ''}
                            ${job?.status === 'failed' ? `<div class="tdb-status-line tdb-warn-text">The last indexing stopped: ${esc(job.error || 'unknown error')}</div>` : ''}
                        </div>
                        <div class="tdb-status-verbs">
                            <button type="button" class="cl-btn cl-btn-primary cl-btn-sm" data-tdb-act="index" ${busy || st.connectionError ? 'disabled' : ''}>
                                <i class="fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-arrows-rotate'}" aria-hidden="true"></i> ${busy ? (job.status === 'queued' ? 'Queued' : 'Indexing…') : esc(verb)}
                            </button>
                            <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-act="settings"><i class="fa-solid fa-gear" aria-hidden="true"></i> Settings</button>
                        </div>
                    </div>
                    ${busy ? `<div class="tdb-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${pct !== null ? `aria-valuenow="${pct}"` : ''}>
                        <span style="width:${pct ?? 5}%"></span></div>
                        <p class="tdb-dim tdb-progress-note">${esc(job.progress?.note || 'Starting…')}${pct !== null ? ` · ${pct}%` : ''}</p>` : ''}`;
            }

            function paintResults(message) {
                const box = $('[data-tdb-results]');
                if (message) { box.innerHTML = message; return; }
                if (!lastQ) {
                    box.innerHTML = st?.index?.built ? `
                        <div class="tdb-empty">
                            <p class="tdb-dim">Describe a moment instead of quoting it:</p>
                            <div class="tdb-tries">
                                ${['when we first met', 'a promise someone made', 'an argument about trust', 'the plan to escape'].map(t => `<button type="button" class="tdb-chip" data-tdb-try="${esc(t)}">${esc(t)}</button>`).join('')}
                            </div>
                        </div>` : `
                        <ol class="tdb-steps">
                            <li><strong>Choose how it reads.</strong> In the settings, pick a connection that makes embeddings (OpenAI-compatible, OpenRouter, Ollama, LM Studio or Google AI Studio) to search by meaning. Without one it matches words.</li>
                            <li><strong>Index your library.</strong> Press <em>Index my library</em> below. New messages join as you chat.</li>
                            <li><strong>Search here, or let the AI remember.</strong> In any chat, open the <em>Smart Recall</em> window and switch on <em>Remind the AI</em>.</li>
                        </ol>`;
                    return;
                }
                if (!hits.length) {
                    box.innerHTML = '<p class="tdb-empty tdb-dim">Nothing close enough. Try other words, or describe the moment.</p>';
                    return;
                }
                box.innerHTML = hits.map((h, i) => hitHtml(h, lastQ, i)).join('');
            }

            async function readStatus() {
                try {
                    st = await call('/recall/status');
                } catch (e) {
                    $('[data-tdb-status]').innerHTML = `<p class="tdb-warn-text">Could not read Smart Recall: ${esc(why(e))}</p>`;
                    return;
                }
                if (!shown) return;
                paintStatus();
                if (!lastQ) paintResults();
                const busy = st.job && (st.job.status === 'queued' || st.job.status === 'running');
                clearTimeout(timer);
                if (busy) timer = setTimeout(readStatus, POLL_MS);
            }

            async function search(q) {
                lastQ = String(q || '').trim();
                $('[data-tdb-by]').textContent = '';
                if (!lastQ) { hits = []; paintResults(); return; }
                paintResults('<p class="tdb-empty tdb-dim"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Searching…</p>');
                try {
                    const out = await call('/recall/search', 'POST', { q: lastQ, scope, limit: 30 });
                    hits = out.hits || [];
                    $('[data-tdb-by]').textContent = out.by === 'meaning' ? 'by meaning' : out.by === 'words' ? 'by words' : '';
                    paintResults();
                } catch (e) {
                    hits = [];
                    paintResults(`<p class="tdb-empty tdb-warn-text">${esc(why(e))}</p>`);
                }
            }

            $('[data-tdb-form]').addEventListener('submit', (e) => {
                e.preventDefault();
                void search($('[data-tdb-q]').value);
            });
            el.addEventListener('click', async (e) => {
                const t = /** @type {Element} */ (e.target);
                if (t.closest('[data-tdb-dev]')) return;
                const chip = t.closest('[data-tdb-scope]');
                if (chip) {
                    scope = chip.dataset.tdbScope;
                    for (const c of el.querySelectorAll('[data-tdb-scope]')) {
                        const on = c === chip;
                        c.classList.toggle('is-on', on);
                        c.setAttribute('aria-checked', String(on));
                    }
                    if (lastQ) void search(lastQ);
                    return;
                }
                const tryBtn = t.closest('[data-tdb-try]');
                if (tryBtn) {
                    $('[data-tdb-q]').value = tryBtn.dataset.tdbTry;
                    void search(tryBtn.dataset.tdbTry);
                    return;
                }
                const hitBtn = t.closest('[data-tdb-hit]');
                if (hitBtn) {
                    const h = hits[Number(hitBtn.dataset.tdbHit)];
                    if (h) void openHit(h);
                    return;
                }
                const act = t.closest('[data-tdb-act]')?.dataset.tdbAct;
                if (act === 'index') {
                    const rebuild = !!st?.index?.stale;
                    const ix = st?.index;
                    const n = ix ? ix.waiting.messages + ix.waiting.lore : 0;
                    if (st?.mode === 'meaning' && n > 2000) {
                        const ok = await CoreAPI.showConfirm({
                            title: 'Index your library?',
                            message: `About ${fmtNum(n)} messages and entries (roughly ${fmtNum(ix.waiting.tokens)} tokens) go to “${st.connection.name}” to be embedded. Embedding is cheap, but not free on paid APIs. It runs in the background while you keep using the app.`,
                            confirmLabel: 'Index',
                            icon: 'fa-solid fa-arrows-rotate',
                        });
                        if (ok !== true) return;
                    }
                    try {
                        await call('/recall/index', 'POST', { rebuild });
                    } catch (err) {
                        CoreAPI.showToast(`Could not start indexing: ${why(err)}`, 'error');
                    }
                    await readStatus();
                } else if (act === 'settings') {
                    try { await ctx.commands.run('settings.open', {}); } catch { /* the menu has it too */ }
                }
            });
            const devBox = $('[data-tdb-dev]');
            devBox.addEventListener('toggle', () => {
                if (devBox.open) {
                    if (!dev) dev = mountDevTools($('[data-tdb-dev-body]'), { dbApi, CoreAPI });
                    dev.enter();
                } else {
                    dev?.leave();
                }
            });

            return {
                enter() { shown = true; void readStatus(); if (devBox.open) dev?.enter(); },
                leave() { shown = false; clearTimeout(timer); dev?.leave(); },
                async refresh() { await readStatus(); if (lastQ) await search(lastQ); },
            };
        }

        // ---- the chat window: recall on or off for this chat, what it recalled, a search of this chat ----
        let win = null;
        ctx.ui.addChatWindow({
            id: 'recall',
            label: 'Smart Recall',
            icon: 'fa-clock-rotate-left',
            min: { w: 24, h: 30 },
            render(body) { win = mountWindow(body); },
            onOpen: ({ chatId }) => win?.show(chatId),
            onClose: () => win?.rest(),
        });
        ctx.events.on('conversation.changed', ({ chatId }) => {
            if (win?.isOpen() && chatId && chatId !== win.chatId()) win.show(chatId);
        });
        for (const name of ['message.created', 'message.updated']) {
            ctx.events.on(name, ({ chatId }) => { if (win?.isOpen() && chatId === win.chatId()) win.reloadSoon(); });
        }

        function mountWindow(body) {
            body.innerHTML = `
                <div class="tdb-win">
                    <label class="tdb-switch">
                        <input type="checkbox" class="cl-switch-input" data-tdbw-on><span class="cl-switch" aria-hidden="true"></span>
                        <span>Remind the AI of relevant past moments</span>
                    </label>
                    <div class="tdb-win-scope" data-tdbw-scope-row>
                        <span class="cl-cwin-dim">Look in</span>
                        <select class="cl-select-fluid" data-tdbw-scope>
                            <option value="chat">this chat</option>
                            <option value="character">every chat with this character</option>
                        </select>
                    </div>
                    <p class="cl-cwin-dim tdb-win-hint" data-tdbw-hint></p>
                    <div class="tdb-win-section">
                        <div class="tdb-win-head"><span>Last reply was reminded of</span><button type="button" class="cl-cwin-btn-text" data-tdbw-act="preview" title="What the next reply would be reminded of"><i class="fa-solid fa-eye" aria-hidden="true"></i> Preview next</button></div>
                        <div data-tdbw-last></div>
                    </div>
                    <div class="tdb-win-section">
                        <form class="tdb-win-search" data-tdbw-form>
                            <input type="search" class="cl-cwin-input" data-tdbw-q placeholder="Find a moment in this chat…" enterkeyhint="search">
                            <button type="submit" class="cl-cwin-btn-text is-primary" aria-label="Search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button>
                        </form>
                        <div data-tdbw-results></div>
                    </div>
                    <p class="cl-cwin-dim tdb-win-foot" data-tdbw-foot></p>
                </div>`;
            const $ = (sel) => body.querySelector(sel);
            const onBox = /** @type {HTMLInputElement} */ ($('[data-tdbw-on]'));
            const scopeSel = /** @type {HTMLSelectElement} */ ($('[data-tdbw-scope]'));
            CoreAPI.initCustomSelect?.(scopeSel);
            let chatId = null;
            let state = null;
            let lastHits = [];
            let found = [];
            let busy = false;

            const follow = ctx.chats.follow({
                read: (id) => call(`/recall/chats/${encodeURIComponent(id)}`),
                moved: (id) => {
                    chatId = id;
                    state = null;
                    found = [];
                    $('[data-tdbw-q]').value = '';
                    $('[data-tdbw-results]').innerHTML = '';
                    paint();
                },
                apply: (next) => { state = next; paint(); },
                fail: (e) => { state = { error: why(e) }; paint(); },
            });

            function paint() {
                if (!chatId || !state) {
                    $('[data-tdbw-hint]').textContent = chatId ? 'Reading…' : 'Open a chat to use Smart Recall here.';
                    return;
                }
                if (state.error) { $('[data-tdbw-hint]').textContent = `Could not read it: ${state.error}`; return; }
                if (!busy) onBox.checked = !!state.on;
                if (scopeSel.value !== state.scope) {
                    scopeSel.value = state.scope;
                    scopeSel.dispatchEvent(new Event('change', { bubbles: false }));
                }
                $('[data-tdbw-scope-row]').classList.toggle('cl-hidden', !state.on);
                $('[data-tdbw-hint]').textContent = !state.built
                    ? 'Nothing is indexed yet. Open Smart Recall from the menu and index your library first.'
                    : state.on
                        ? `Before each reply, the most relevant older messages (not the newest, which the AI already sees) join the prompt, found ${state.mode === 'meaning' ? 'by meaning' : 'by matching words'}.`
                        : `Off for this chat${state.byDefault ? ' (on by default elsewhere)' : ''}.`;
                lastHits = state.last?.hits || [];
                $('[data-tdbw-last]').innerHTML = lastHits.length
                    ? lastHits.map((h, i) => hitHtml(h, '', `l${i}`, { compact: true })).join('')
                    : `<p class="cl-cwin-dim">${state.on ? 'Nothing yet. It fills in with the next reply.' : 'Nothing: recall is off.'}</p>`;
                $('[data-tdbw-foot]').textContent = state.built ? `${fmtNum(state.indexed)} of ${fmtNum(state.total)} messages of this chat are indexed.` : '';
            }

            onBox.addEventListener('change', async () => {
                if (!chatId) return;
                busy = true;
                try { await call(`/recall/chats/${encodeURIComponent(chatId)}`, 'PUT', { on: onBox.checked }); } catch (e) { CoreAPI.showToast(`Could not change it: ${why(e)}`, 'error'); }
                busy = false;
                await follow.reload();
            });
            scopeSel.addEventListener('change', async () => {
                if (!chatId || !state || state.scope === scopeSel.value) return;
                try { await call(`/recall/chats/${encodeURIComponent(chatId)}`, 'PUT', { scope: scopeSel.value }); } catch (e) { CoreAPI.showToast(`Could not change it: ${why(e)}`, 'error'); }
                await follow.reload();
            });
            $('[data-tdbw-form]').addEventListener('submit', async (e) => {
                e.preventDefault();
                const q = $('[data-tdbw-q]').value.trim();
                const box = $('[data-tdbw-results]');
                if (!q || !chatId) { box.innerHTML = ''; return; }
                box.innerHTML = '<p class="cl-cwin-dim">Searching…</p>';
                try {
                    const out = await call('/recall/search', 'POST', { q, chatId, limit: 12 });
                    found = out.hits || [];
                    box.innerHTML = found.length ? found.map((h, i) => hitHtml(h, q, `f${i}`, { compact: true })).join('') : '<p class="cl-cwin-dim">Nothing close enough.</p>';
                } catch (err) {
                    box.innerHTML = `<p class="cl-cwin-dim tdb-warn-text">${esc(why(err))}</p>`;
                }
            });
            body.addEventListener('click', async (e) => {
                const t = /** @type {Element} */ (e.target);
                const hitBtn = t.closest('[data-tdb-hit]');
                if (hitBtn) {
                    const ref = hitBtn.dataset.tdbHit;
                    const h = ref.startsWith('l') ? lastHits[Number(ref.slice(1))] : found[Number(ref.slice(1))];
                    if (h) void openHit(h);
                    return;
                }
                if (t.closest('[data-tdbw-act="preview"]') && chatId) {
                    try {
                        const out = await call(`/recall/chats/${encodeURIComponent(chatId)}/preview`);
                        lastHits = out.hits || [];
                        $('[data-tdbw-last]').innerHTML = lastHits.length
                            ? `<p class="cl-cwin-dim">The next reply (preview, ${out.by === 'meaning' ? 'by meaning' : 'by words'}):</p>${lastHits.map((h, i) => hitHtml(h, '', `l${i}`, { compact: true })).join('')}`
                            : '<p class="cl-cwin-dim">Nothing would be recalled right now.</p>';
                    } catch (err) {
                        CoreAPI.showToast(`Could not preview: ${why(err)}`, 'error');
                    }
                }
            });

            return { show: follow.show, rest: follow.rest, reloadSoon: follow.reloadSoon, isOpen: follow.isOpen, chatId: () => chatId };
        }

        // the composer is about to send: the recall query is embedded with the new message in it, before the prompt
        ctx.hooks.add('composer.send', async (text, { chatId }) => {
            if (!chatId || !String(text || '').trim()) return undefined;
            try {
                await Promise.race([
                    call(`/recall/chats/${encodeURIComponent(chatId)}/prime`, 'POST', { text }),
                    new Promise(resolve => setTimeout(resolve, PRIME_WAIT_MS)),
                ]);
            } catch { /* the prompt falls back to the words */ }
            return undefined;
        });

        // ---- settings ----
        ctx.ui.addSettingsSection((el) => {
            const get = (k) => ctx.settings.get(k);
            const on = (k) => (get(k) ? ' checked' : '');
            const sw = (k, label) => `<label><input type="checkbox" class="cl-switch-input" data-tdbs="${k}"${on(k)}><span class="cl-switch" aria-hidden="true"></span><span>${label}</span></label>`;
            const placement = get('promptPlacement') || 'pre_history';
            el.innerHTML = `
                <div class="settings-row">
                    <label>Understand text with</label>
                    <select class="cl-select-fluid" data-tdbs-profile><option value="">Nothing: match words only</option></select>
                    <span class="settings-hint cl-hidden" data-tdbs-gone>The connection picked here was deleted, so Smart Recall matches words until you pick another.</span>
                    <span class="settings-hint">A connection that makes embeddings lets Smart Recall search by meaning: OpenAI and OpenAI-compatible servers (Ollama, LM Studio, vLLM…), OpenRouter, or Google AI Studio. Changing it means indexing again.</span>
                </div>
                <div class="settings-row">
                    <label>Embedding model</label>
                    <div class="settings-input-group u-row tdb-set-row">
                        <input type="search" class="glass-input" data-tdbs="embedModel" autocomplete="off" placeholder="automatic" value="${esc(get('embedModel') || '')}">
                        <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdbs-test><i class="fa-solid fa-plug-circle-check" aria-hidden="true"></i> Test</button>
                    </div>
                    <span class="settings-hint" data-tdbs-test-out>Empty picks text-embedding-3-small (gemini-embedding-001 on Google AI Studio). Local servers need their own model name, such as nomic-embed-text.</span>
                </div>
                <div class="settings-row">${sw('indexChats', 'Index chat messages')}</div>
                <div class="settings-row">${sw('indexLore', 'Index lorebook entries')}</div>
                <div class="settings-row">${sw('autoUpdate', 'Keep the index up to date as you chat')}</div>
                <div class="settings-row">
                    ${sw('recallByDefault', 'Remind the AI in every chat unless a chat turns it off')}
                    <span class="settings-hint">Each chat's Smart Recall window switches it on or off for that chat.</span>
                </div>
                <div class="settings-row">
                    <label>Moments to recall per reply</label>
                    <input type="number" class="glass-input tdb-num" data-tdbs="recallTopK" min="1" max="12" step="1" value="${esc(get('recallTopK'))}">
                </div>
                <div class="settings-row">
                    <label>Leave out the newest messages</label>
                    <input type="number" class="glass-input tdb-num" data-tdbs="recallSkipRecent" min="0" max="500" step="1" value="${esc(get('recallSkipRecent'))}">
                    <span class="settings-hint">The AI sees these already, so recalling them would only repeat them.</span>
                </div>
                <div class="settings-row">
                    <label>Closest match needed (0 to 1)</label>
                    <input type="number" class="glass-input tdb-num" data-tdbs="recallMinScore" min="0" max="1" step="0.05" value="${esc(get('recallMinScore'))}">
                    <span class="settings-hint">Higher recalls less but closer. Search results show each match's closeness, which helps pick this.</span>
                </div>
                <div class="settings-row">
                    <label>Where it goes in the prompt</label>
                    <select class="cl-select-fluid" data-tdbs="promptPlacement">
                        <option value="pre_history"${placement === 'pre_history' ? ' selected' : ''}>Before the conversation</option>
                        <option value="post_history"${placement === 'post_history' ? ' selected' : ''}>After the conversation</option>
                        <option value="at_depth"${placement === 'at_depth' ? ' selected' : ''}>Inside the conversation</option>
                    </select>
                </div>
                <div class="settings-row" data-tdbs-depth${placement === 'at_depth' ? '' : ' hidden'}>
                    <label>Messages back from the newest</label>
                    <input type="number" class="glass-input tdb-num" data-tdbs="promptDepth" min="0" max="50" step="1" value="${esc(get('promptDepth'))}">
                </div>
                <div class="settings-row">
                    <label>Heading the AI reads</label>
                    <textarea class="glass-input" rows="2" data-tdbs="recallHeading" placeholder="Earlier moments from this story that may matter now. They already happened; use them for continuity, not as new events.">${esc(get('recallHeading') || '')}</textarea>
                </div>
                <details class="tdb-set-dev">
                    <summary>Developer</summary>
                    <div class="settings-row">
                        <label>Default vector size for new namespaces</label>
                        <input type="number" class="glass-input tdb-num" data-tdbs="defaultDim" min="1" max="8192" value="${esc(get('defaultDim'))}">
                    </div>
                    <div class="settings-row">
                        <label>Default write-ahead log sync</label>
                        <select class="cl-select-fluid" data-tdbs="defaultSyncMode">
                            ${['normal', 'full', 'off'].map(v => `<option value="${v}"${get('defaultSyncMode') === v ? ' selected' : ''}>${v}</option>`).join('')}
                        </select>
                    </div>
                    <div class="settings-row">
                        <label>Namespace {{trivium_recall::query}} searches</label>
                        <input type="search" class="glass-input" data-tdbs="recallNamespace" maxlength="128" value="${esc(get('recallNamespace') || 'playground')}">
                        <span class="settings-hint"><code>{{trivium_recall}}</code> alone writes this chat's Smart Recall anywhere a prompt holds it.</span>
                    </div>
                </details>`;
            for (const input of el.querySelectorAll('[data-tdbs]')) {
                input.addEventListener('change', () => {
                    const key = input.dataset.tdbs;
                    if (input.type === 'checkbox') ctx.settings.set(key, input.checked);
                    else if (input.type === 'number') {
                        const v = Number(input.value);
                        const val = Number.isFinite(v) && input.value !== '' ? Math.min(Number(input.max), Math.max(Number(input.min), v)) : ctx.settings.defaults[key];
                        input.value = String(val);
                        ctx.settings.set(key, val);
                    } else ctx.settings.set(key, input.value.trim());
                    if (key === 'promptPlacement') el.querySelector('[data-tdbs-depth]').hidden = input.value !== 'at_depth';
                });
            }
            for (const sel of el.querySelectorAll('select[data-tdbs]')) CoreAPI.initCustomSelect?.(sel);
            void ctx.ui.connectionSelect(el.querySelector('[data-tdbs-profile]'), { key: 'embedProfile' })
                .then(({ gone }) => el.querySelector('[data-tdbs-gone]').classList.toggle('cl-hidden', !gone));
            el.querySelector('[data-tdbs-test]').addEventListener('click', async () => {
                const out = el.querySelector('[data-tdbs-test-out]');
                out.textContent = 'Testing…';
                // a pick is saved within about half a second; the test reads what the server holds
                await new Promise(r => setTimeout(r, 700));
                try {
                    const r = await call('/recall/test', 'POST', {});
                    out.textContent = r.mode === 'words'
                        ? 'No connection picked: Smart Recall matches words.'
                        : `Works: ${r.model} answers ${r.dim}-number vectors in ${r.ms} ms.`;
                } catch (e) {
                    out.textContent = `Failed: ${why(e)}`;
                }
            });
        });
    },

    dispose() {
        if (typeof window !== 'undefined') delete window.__SIGMA_TRIVIUM__;
    },
};
