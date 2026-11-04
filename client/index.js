// SPDX-License-Identifier: 0BSD
// TriviumDB for Project Σ — the client half: the engine for other extensions and its debug view.
// 1. window.__SIGMA_TRIVIUM__.db (a TauriTavern-compatible database handle) and the triviumdb.* commands.
// 2. The TriviumDB view: a meaning test (how a connection's embeddings rank texts against a query), then the
//    developer workbench (stats, hybrid search, TQL, graph traversal, CRUD) and the API catalog.
// Smart Recall (the smart-recall extension) is the example of a feature built on it.

import { createTriviumClientApi, why } from './api.js';
import { mountDevTools } from './dev.js';

const VIEW = 'ext:triviumdb/workbench';
const SAMPLE_QUERY = 'dragon fire';
const SAMPLE_TEXTS = [
    'The great wyrm set the forest ablaze with its flames, and the village burned until dawn.',
    'Drakes are lesser dragons that breathe fire and hoard gold in mountain caves.',
    'We drank tea at the inn by the river and talked until late.',
    'My brother Kai left for the capital years ago and never wrote back.',
    'The blacksmith quenched the glowing blade in a bucket of water.',
    'Morning came with fog over the plains.',
];

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
        ctx.commands.register('rank', ({ query, texts, profileId, model } = {}) => call('/embeddings/rank', 'POST', {
            query, texts, profileId: profileId ?? ctx.settings.get('meaningProfile'), model: model ?? ctx.settings.get('meaningModel'),
        }), { title: 'Rank texts against a query by meaning, through a connection\'s embeddings' });

        // ---- the menu door and the view ----
        ctx.ui.contribute('app.action', {
            id: 'workbench',
            label: 'TriviumDB',
            icon: 'fa-diagram-project',
            when: ({ view }) => view !== VIEW,
            run: () => ctx.commands.run('view.switch', { view: VIEW }),
        });

        let page = null;
        ctx.ui.contribute('shell.view', {
            id: 'workbench',
            label: 'TriviumDB',
            icon: 'fa-diagram-project',
            render(el) { page = mountView(el); },
            enter: () => page?.enter(),
            leave: () => page?.leave(),
            refresh: () => page?.refresh(),
        });

        function mountView(el) {
            el.innerHTML = `
                <div class="tdb">
                    <header class="tdb-hero">
                        <h2 class="tdb-hero-title"><i class="fa-solid fa-diagram-project" aria-hidden="true"></i> TriviumDB</h2>
                        <p class="tdb-hero-lead">The vector, graph and full-text engine other extensions build on, and its debug tools. Smart Recall is the example built on it.</p>
                    </header>
                    <section class="tdb-card">
                        <h3 class="tdb-heading">Meaning test</h3>
                        <p class="tdb-dim">How a connection's embeddings rank texts against a query. A good model puts the texts that mean the query first, even when they share none of its words.</p>
                        <div class="tdb-mt-row">
                            <select class="cl-select-fluid" data-mt-profile><option value="">Pick a connection…</option></select>
                            <input type="search" class="glass-input" data-mt-model autocomplete="off" placeholder="model: automatic" value="${esc(ctx.settings.get('meaningModel') || '')}">
                        </div>
                        <form class="tdb-mt-row" data-mt-form>
                            <input type="search" class="glass-input" data-mt-q autocomplete="off" value="${esc(SAMPLE_QUERY)}" placeholder="Query">
                            <button type="submit" class="cl-btn cl-btn-primary cl-btn-sm"><i class="fa-solid fa-play" aria-hidden="true"></i> Rank</button>
                        </form>
                        <textarea class="glass-input tdb-mt-texts" rows="6" data-mt-texts placeholder="One text per line">${esc(SAMPLE_TEXTS.join('\n'))}</textarea>
                        <div data-mt-out></div>
                    </section>
                    <div data-tdb-dev-body></div>
                </div>`;
            const $ = (sel) => el.querySelector(sel);
            const dev = mountDevTools($('[data-tdb-dev-body]'), { dbApi, CoreAPI });
            const profileSel = $('[data-mt-profile]');
            void ctx.ui.connectionSelect(profileSel, { key: 'meaningProfile' });
            $('[data-mt-model]').addEventListener('change', (e) => ctx.settings.set('meaningModel', e.target.value.trim()));

            $('[data-mt-form]').addEventListener('submit', async (e) => {
                e.preventDefault();
                const out = $('[data-mt-out]');
                const query = $('[data-mt-q]').value.trim();
                const texts = $('[data-mt-texts]').value.split('\n').map(s => s.trim()).filter(Boolean);
                out.innerHTML = '<p class="tdb-dim"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Embedding…</p>';
                try {
                    const r = await call('/embeddings/rank', 'POST', { query, texts, profileId: profileSel.value, model: $('[data-mt-model]').value.trim() });
                    out.innerHTML = `
                        <p class="tdb-dim">${esc(r.model)} · ${esc(r.dim)} dimensions · embedded in ${esc(r.embedMs)} ms, searched in ${esc(r.searchMs)} ms</p>
                        <ol class="tdb-mt-list">${r.ranked.map(h => `
                            <li class="tdb-mt-item">
                                <span class="tdb-mt-bar"><span style="width:${Math.max(2, h.match)}%"></span></span>
                                <span class="tdb-mt-head"><span class="tdb-pill is-match">${esc(h.match)}%</span>${h.words ? '<span class="tdb-pill" title="Shares words with the query">words</span>' : ''}<code class="tdb-dim">${esc(h.score)}</code></span>
                                <span class="tdb-mt-text">${esc(h.text)}</span>
                            </li>`).join('')}</ol>`;
                } catch (err) {
                    out.innerHTML = `<p class="tdb-warn-text">${esc(why(err))}</p>`;
                }
            });

            return {
                enter() { dev.enter(); },
                leave() { dev.leave(); },
                refresh: () => dev.refresh(),
            };
        }

        // ---- settings: the engine's defaults ----
        ctx.ui.addSettingsSection((el) => {
            const get = (k) => ctx.settings.get(k);
            el.innerHTML = `
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
                </div>
                <p class="settings-hint">The TriviumDB view (menu) has a meaning test for embedding connections and the developer workbench.</p>`;
            for (const input of el.querySelectorAll('[data-tdbs]')) {
                input.addEventListener('change', () => {
                    const key = input.dataset.tdbs;
                    if (input.type === 'number') {
                        const v = Number(input.value);
                        const val = Number.isFinite(v) && input.value !== '' ? Math.min(Number(input.max), Math.max(Number(input.min), v)) : ctx.settings.defaults[key];
                        input.value = String(val);
                        ctx.settings.set(key, val);
                    } else ctx.settings.set(key, input.value.trim());
                });
            }
            for (const sel of el.querySelectorAll('select[data-tdbs]')) CoreAPI.initCustomSelect?.(sel);
        });
    },

    dispose() {
        if (typeof window !== 'undefined') delete window.__SIGMA_TRIVIUM__;
    },
};
