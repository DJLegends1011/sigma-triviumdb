// SPDX-License-Identifier: 0BSD
// TriviumDB for Project Σ — Client Half:
// 1. Exposes `window.__SIGMA_TRIVIUM__.db` (and `window.__TAURITAVERN__.api.db` compatibility shim)
// 2. Registers `triviumdb.*` commands on `ctx.commands` so other Project Σ extensions can invoke TriviumDB
// 3. Contributes the TriviumDB Workbench & Tour (`shell.view` + `app.action`) and Conversation Window (`chat.window`)

const ID = 'triviumdb';
const VIEW = 'ext:triviumdb/workbench';

/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Build the TauriTavern-compatible `db` API object backed by Project Σ's `/api/ext/triviumdb/handle` route.
 * @param {(path: string, method?: string, body?: any) => Promise<any>} call
 */
function createTriviumClientApi(call) {
    const invokeHandle = async (request) => {
        const res = await call('/handle', 'POST', { request });
        return request.type === 'execute' ? res.result : res;
    };

    return Object.freeze({
        async open(namespace, options = {}) {
            const opened = await invokeHandle({ type: 'open', namespace, options });
            const exec = (operation) => invokeHandle({ type: 'execute', namespace, operation });

            const handle = {
                namespace: opened.namespace,
                dim: opened.dim,
                options: Object.freeze({ ...(opened.options || {}) }),
                insert: (vector, payload = null) => exec({ type: 'insert', vector, payload }),
                batchInsert: (vectors, payloads) => exec({ type: 'batchInsert', vectors, payloads }),
                upsert: (id, vector, payload = null) => exec({ type: 'upsert', id, vector, payload }),
                get: (id) => exec({ type: 'get', id }),
                updatePayload: (id, payload) => exec({ type: 'updatePayload', id, payload }),
                patchPayload: (id, patch) => exec({ type: 'patchPayload', id, patch }),
                updateVector: (id, vector) => exec({ type: 'updateVector', id, vector }),
                delete: (id) => exec({ type: 'delete', id }),
                link: (src, dst, label = 'related', weight = 1) => exec({ type: 'link', src, dst, label, weight }),
                unlink: (src, dst, label) => exec({ type: 'unlink', src, dst, label }),
                shortestPath: (source, target, opts = {}) => exec({ type: 'shortestPath', source, target, ...opts }),
                subgraph: (id, opts = {}) => exec({ type: 'subgraph', id, ...opts }),
                indexText: (id, text) => exec({ type: 'indexText', id, text }),
                indexKeyword: (id, keyword) => exec({ type: 'indexKeyword', id, keyword }),
                buildTextIndex: () => exec({ type: 'buildTextIndex' }),
                search: (vector = null, opts = {}) => {
                    const { queryText, filter, ...config } = opts || {};
                    return exec({
                        type: 'search',
                        vector,
                        queryText,
                        config: {
                            ...config,
                            payloadFilter: config.payloadFilter ?? filter,
                        },
                    });
                },
                searchBatch: (vectors, opts = {}) => {
                    const { parallelism, ...config } = opts || {};
                    return exec({ type: 'searchBatch', vectors, parallelism, config });
                },
                searchAdvanced: (vector = null, opts = {}) => {
                    const { queryText, ...config } = opts || {};
                    return exec({ type: 'searchAdvanced', vector, queryText, config });
                },
                query: (query, params = {}) => exec({ type: 'query', query, params }),
                leidenCluster: (config = {}) => exec({ type: 'leidenCluster', config }),
                buildQuiverIndex: () => exec({ type: 'buildQuiverIndex' }),
                compact: () => exec({ type: 'compact' }),
                flush: () => exec({ type: 'flush' }),
                close: () => invokeHandle({ type: 'close', namespace }),
                stats: () => exec({ type: 'stats' }),
            };
            return Object.freeze(handle);
        },
        listNamespaces: () => invokeHandle({ type: 'listNamespaces' }),
        flushAll: () => invokeHandle({ type: 'flushAll' }),
        status: () => call('/status', 'GET'),
        seedDemo: (namespace = 'playground', reset = true) => call('/seed-demo', 'POST', { namespace, reset }),
    });
}

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** @type {import('../../../../docs/extensions').ClientExtension} */
export default {
    init(ctx) {
        const CoreAPI = ctx.CoreAPI;
        const esc = (s) => CoreAPI.escapeHtml(s);
        const call = ctx.server.call;
        const dbApi = createTriviumClientApi(call);

        // Install global handle for Project Σ extensions in the WebView
        if (typeof window !== 'undefined') {
            window.__SIGMA_TRIVIUM__ = Object.freeze({ db: dbApi, version: '0.9.0' });
        }

        // ---- Register cross-extension Project Σ commands ----
        ctx.commands.register('open', ({ namespace = 'playground', options = {} } = {}) => dbApi.open(namespace, options), {
            title: 'Open a TriviumDB namespace handle',
        });
        ctx.commands.register('list-namespaces', () => dbApi.listNamespaces(), {
            title: 'List open TriviumDB namespaces',
        });
        ctx.commands.register('status', () => dbApi.status(), {
            title: 'Get TriviumDB engine status',
        });
        ctx.commands.register('seed-demo', ({ namespace = 'playground', reset = true } = {}) => dbApi.seedDemo(namespace, reset), {
            title: 'Seed the TriviumDB playground knowledge graph',
        });
        ctx.commands.register('query', async ({ namespace = 'playground', query = 'MATCH (n) RETURN n', params = {}, dim } = {}) => {
            const db = await dbApi.open(namespace, dim ? { dim } : {});
            return db.query(query, params);
        }, {
            title: 'Execute a TQL query or mutation on a TriviumDB namespace',
        });
        ctx.commands.register('search', async ({ namespace = 'playground', vector = null, queryText = '', topK = 5, expandDepth = 1, advanced = false, dim } = {}) => {
            const db = await dbApi.open(namespace, dim ? { dim } : {});
            return advanced
                ? db.searchAdvanced(vector, { queryText, topK, expandDepth })
                : db.search(vector, { queryText, topK, expandDepth });
        }, {
            title: 'Search a TriviumDB namespace (vector + BM25 + graph diffusion)',
        });

        // ---- App Action Menu item to switch to the Workbench ----
        ctx.ui.contribute('app.action', {
            id: 'workbench',
            label: 'TriviumDB Workbench',
            icon: 'fa-diagram-project',
            when: ({ view }) => view !== VIEW,
            run: async () => {
                await ctx.commands.run('view.switch', { view: VIEW });
            },
        });

        // ---- Extension Settings Section ----
        ctx.ui.addSettingsSection(async (el) => {
            let statusInfo = null;
            try {
                statusInfo = await dbApi.status();
            } catch { /* handled below */ }

            const on = (key) => (ctx.settings.get(key) ? ' checked' : '');
            const syncMode = ctx.settings.get('defaultSyncMode') || 'normal';
            const placement = ctx.settings.get('promptPlacement') || 'pre_history';

            el.innerHTML = `
                <div class="settings-row">
                    <label>Default Vector Dimension</label>
                    <input type="number" class="glass-input" data-tdb-set="defaultDim" min="1" max="8192" value="${esc(ctx.settings.get('defaultDim') ?? 1536)}">
                    <span class="settings-hint">Used when opening a brand-new namespace without an explicit dim option.</span>
                </div>
                <div class="settings-row">
                    <label>Default WAL Sync Mode</label>
                    <select class="cl-select-fluid" data-tdb-set="defaultSyncMode">
                        <option value="normal"${syncMode === 'normal' ? ' selected' : ''}>normal (Balanced WAL)</option>
                        <option value="full"${syncMode === 'full' ? ' selected' : ''}>full (Fsync every write)</option>
                        <option value="off"${syncMode === 'off' ? ' selected' : ''}>off (In-memory speed)</option>
                    </select>
                </div>
                <div class="settings-row">
                    <label>Default Recall Namespace</label>
                    <input type="search" autocomplete="one-time-code" class="glass-input" data-tdb-set="recallNamespace" maxlength="128" value="${esc(ctx.settings.get('recallNamespace') || 'playground')}">
                    <span class="settings-hint">Used by the <code>{{trivium_recall}}</code> macro and automatic prompt recall.</span>
                </div>
                <div class="settings-row">
                    <label>Recall Top-K</label>
                    <input type="number" class="glass-input" data-tdb-set="recallTopK" min="1" max="20" value="${esc(ctx.settings.get('recallTopK') ?? 5)}">
                </div>
                <div class="settings-row">
                    <label><input type="checkbox" class="cl-switch-input" data-tdb-set="injectPromptRecall"${on('injectPromptRecall')}><span class="cl-switch" aria-hidden="true"></span> Auto-inject knowledge recall block into chat prompts</label>
                    <span class="settings-hint">Queries the default namespace using the latest chat messages and injects top hits.</span>
                </div>
                <div class="settings-row">
                    <label>Prompt Block Placement</label>
                    <select class="cl-select-fluid" data-tdb-set="promptPlacement">
                        <option value="pre_history"${placement === 'pre_history' ? ' selected' : ''}>Before the conversation (pre_history)</option>
                        <option value="post_history"${placement === 'post_history' ? ' selected' : ''}>After the conversation (post_history)</option>
                        <option value="at_depth"${placement === 'at_depth' ? ' selected' : ''}>Inside the conversation (at_depth)</option>
                    </select>
                </div>
                <div class="settings-row" data-tdb-depth-row${placement === 'at_depth' ? '' : ' hidden'}>
                    <label>Messages back from the newest</label>
                    <input type="number" class="glass-input" data-tdb-set="promptDepth" min="0" max="50" value="${esc(ctx.settings.get('promptDepth') ?? 2)}">
                </div>
                <p class="settings-hint">
                    ${statusInfo?.ok
                        ? `Native Engine: <strong>TriviumDB v${esc(statusInfo.version)}</strong> active (<code>${esc(statusInfo.binary)}</code> on ${esc(statusInfo.platform)}-${esc(statusInfo.arch)}).`
                        : `Native Engine not built for this platform yet: ${esc(statusInfo?.nativeError || 'unavailable')}. On Termux run <code>bash extensions/installed/triviumdb/scripts/build-termux.sh</code>.`}
                </p>`;

            const depthRow = el.querySelector('[data-tdb-depth-row]');
            const fields = el.querySelectorAll('[data-tdb-set]');
            for (const input of fields) {
                input.addEventListener('change', () => {
                    const key = input.dataset.tdbSet || '';
                    if (input.type === 'checkbox') {
                        ctx.settings.set(key, input.checked);
                    } else if (input.type === 'number') {
                        ctx.settings.set(key, Number(input.value) || ctx.settings.defaults[key]);
                    } else {
                        ctx.settings.set(key, input.value.trim() || ctx.settings.defaults[key]);
                    }
                    if (key === 'promptPlacement' && depthRow) {
                        depthRow.hidden = input.value !== 'at_depth';
                    }
                });
            }
            for (const sel of el.querySelectorAll('select.cl-select-fluid')) {
                CoreAPI.initCustomSelect?.(sel);
            }
        });

        // ---- Conversation Window (`chat.window`) ----
        let winState = null;
        const paintChatWindow = async () => {
            if (!winState) return;
            const { el } = winState;
            const ns = ctx.settings.get('recallNamespace') || 'playground';
            let statusInfo = null;
            try {
                statusInfo = await dbApi.status();
            } catch (e) {
                el.innerHTML = `<div class="tdb-win"><p class="tdb-line is-error">Engine error: ${esc(why(e))}</p></div>`;
                return;
            }

            el.innerHTML = `
                <div class="tdb-win">
                    <div class="tdb-row tdb-between">
                        <span class="tdb-badge ${statusInfo?.ok ? 'is-ok' : 'is-warn'}">
                            <i class="fa-solid fa-database" aria-hidden="true"></i>
                            ${statusInfo?.ok ? `TriviumDB v${esc(statusInfo.version)}` : 'Addon Missing'}
                        </span>
                        <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-win="open-workbench">
                            <i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i> Workbench
                        </button>
                    </div>
                    <div class="tdb-row">
                        <input type="search" class="glass-input tdb-flex" data-tdb-win-ns value="${esc(ns)}" placeholder="Namespace (e.g. playground)">
                        <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-win="seed" title="Seed demo graph">
                            <i class="fa-solid fa-seedling" aria-hidden="true"></i> Seed
                        </button>
                    </div>
                    <div class="tdb-row">
                        <input type="search" class="glass-input tdb-flex" data-tdb-win-q placeholder="Hybrid search or keyword (e.g. Obsidian Cipher)...">
                        <button type="button" class="cl-btn cl-btn-primary cl-btn-sm" data-tdb-win="search">
                            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                        </button>
                    </div>
                    <div class="tdb-win-results" data-tdb-win-results>
                        <p class="tdb-note">Tip: Use <code>{{trivium_recall::Obsidian Cipher}}</code> in any prompt or message, or click Seed to load the sample cyberpunk knowledge graph.</p>
                    </div>
                </div>`;

            const nsInput = /** @type {HTMLInputElement} */ (el.querySelector('[data-tdb-win-ns]'));
            const qInput = /** @type {HTMLInputElement} */ (el.querySelector('[data-tdb-win-q]'));
            const outBox = /** @type {HTMLElement} */ (el.querySelector('[data-tdb-win-results]'));

            const runWinSearch = async () => {
                const targetNs = nsInput.value.trim() || 'playground';
                const q = qInput.value.trim();
                outBox.innerHTML = '<p class="tdb-note">Searching...</p>';
                try {
                    const db = await dbApi.open(targetNs);
                    const res = await db.searchAdvanced(null, { queryText: q || 'Alice', topK: 5, expandDepth: 1 });
                    if (!res.hits?.length) {
                        outBox.innerHTML = '<p class="tdb-note">No hits found in this namespace. Try clicking Seed first.</p>';
                        return;
                    }
                    outBox.innerHTML = res.hits.map(h => {
                        const p = h.payload || {};
                        return `<div class="tdb-hit-card">
                            <div class="tdb-hit-head">
                                <strong>#${esc(h.id)} ${esc(p.name || p.title || 'Node')}</strong>
                                <span class="tdb-score">score ${Number(h.score).toFixed(2)}</span>
                            </div>
                            <p class="tdb-hit-body">${esc(p.text || JSON.stringify(p))}</p>
                        </div>`;
                    }).join('');
                } catch (err) {
                    outBox.innerHTML = `<p class="tdb-line is-error">${esc(why(err))}</p>`;
                }
            };

            el.addEventListener('click', async (ev) => {
                const act = /** @type {HTMLElement | null} */ (/** @type {Element} */ (ev.target).closest('[data-tdb-win]'))?.dataset.tdbWin;
                if (act === 'open-workbench') {
                    await ctx.commands.run('view.switch', { view: VIEW });
                } else if (act === 'seed') {
                    const targetNs = nsInput.value.trim() || 'playground';
                    outBox.innerHTML = '<p class="tdb-note">Seeding demo knowledge graph...</p>';
                    try {
                        const seeded = await dbApi.seedDemo(targetNs, true);
                        CoreAPI.showToast(`Seeded ${seeded.stats?.nodeCount ?? 5} nodes & ${seeded.stats?.graph?.edgeCount ?? 7} edges into "${targetNs}"`, 'success');
                        await runWinSearch();
                    } catch (err) {
                        outBox.innerHTML = `<p class="tdb-line is-error">${esc(why(err))}</p>`;
                    }
                } else if (act === 'search') {
                    await runWinSearch();
                }
            });

            qInput.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') void runWinSearch();
            });
        };

        ctx.ui.addChatWindow({
            id: 'inspector',
            label: 'TriviumDB',
            icon: 'fa-diagram-project',
            min: { w: 24, h: 26 },
            render(el, { chatId, character }) {
                winState = { el, chatId, character };
                void paintChatWindow();
            },
            onOpen({ chatId, character }) {
                if (!winState) return;
                winState.chatId = chatId;
                winState.character = character;
                void paintChatWindow();
            },
            onClose() {
                winState = null;
            },
        });

        // ---- Shell View (`shell.view`): Interactive TriviumDB Workbench & API Tour ----
        let workbench = null;
        ctx.ui.contribute('shell.view', {
            id: 'workbench',
            label: 'TriviumDB',
            icon: 'fa-diagram-project',
            render(el) {
                workbench = mountWorkbench(el);
            },
            enter: () => workbench?.enter(),
            leave: () => workbench?.leave(),
            refresh: () => workbench?.refresh(),
        });

        function mountWorkbench(el) {
            let activeNs = 'playground';
            let shown = false;

            el.innerHTML = `
                <div class="tdb-tour">
                    <div class="tdb-header">
                        <div>
                            <h2 class="tdb-title">TriviumDB Workbench & Extension API Tour</h2>
                            <p class="tdb-line" data-tdb-lead>Loading native engine telemetry...</p>
                        </div>
                        <div class="tdb-verbs">
                            <button type="button" class="cl-btn cl-btn-primary cl-btn-sm" data-tdb-act="seed">
                                <i class="fa-solid fa-seedling" aria-hidden="true"></i> Seed Demo Graph
                            </button>
                            <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-act="flush">
                                <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Flush WAL
                            </button>
                            <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-act="refresh">
                                <i class="fa-solid fa-rotate" aria-hidden="true"></i> Refresh Stats
                            </button>
                        </div>
                    </div>

                    <div class="tdb-tiles" data-tdb-tiles></div>

                    <div class="tdb-pair">
                        <section class="tdb-panel">
                            <h3 class="tdb-heading">1. Hybrid Search & Cognitive Pipeline (Vector + BM25 + Graph Walk)</h3>
                            <div class="tdb-row">
                                <input type="search" class="glass-input tdb-flex" data-tdb-search-q value="Obsidian Cipher" placeholder="Search text or keywords...">
                                <label class="tdb-check"><input type="checkbox" class="cl-switch-input" data-tdb-search-adv checked><span class="cl-switch" aria-hidden="true"></span> Advanced Pipeline</label>
                                <button type="button" class="cl-btn cl-btn-primary cl-btn-sm" data-tdb-act="search">
                                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Search
                                </button>
                            </div>
                            <div class="tdb-output" data-tdb-search-out>
                                <p class="tdb-note">Click "Seed Demo Graph" then run a search to inspect hybrid hits and stage timings.</p>
                            </div>
                        </section>

                        <section class="tdb-panel">
                            <h3 class="tdb-heading">2. TQL Console (Cypher Graph + Document Filter + Vector Query)</h3>
                            <div class="tdb-verbs">
                                <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-preset="match-all">MATCH All Nodes</button>
                                <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-preset="find-char">FIND Characters</button>
                                <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-preset="create-node">CREATE Node</button>
                            </div>
                            <textarea class="glass-input tdb-code" rows="3" data-tdb-tql-input>MATCH (n) RETURN n</textarea>
                            <div class="tdb-row tdb-between">
                                <span class="tdb-note">Supports <code>MATCH</code>, <code>FIND</code>, <code>SEARCH VECTOR</code>, and <code>CREATE</code></span>
                                <button type="button" class="cl-btn cl-btn-primary cl-btn-sm" data-tdb-act="run-tql">
                                    <i class="fa-solid fa-play" aria-hidden="true"></i> Execute TQL
                                </button>
                            </div>
                            <pre class="tdb-pre" data-tdb-tql-out>// TQL output will appear here</pre>
                        </section>
                    </div>

                    <div class="tdb-pair">
                        <section class="tdb-panel">
                            <h3 class="tdb-heading">3. Knowledge Graph Traversal (Subgraph & Shortest Path)</h3>
                            <div class="tdb-row">
                                <label class="tdb-note">Root ID</label>
                                <input type="number" class="glass-input tdb-num" data-tdb-graph-root value="1" min="1">
                                <label class="tdb-note">Target ID</label>
                                <input type="number" class="glass-input tdb-num" data-tdb-graph-target value="4" min="1">
                                <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-act="subgraph">
                                    <i class="fa-solid fa-project-diagram" aria-hidden="true"></i> Subgraph
                                </button>
                                <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-act="shortest-path">
                                    <i class="fa-solid fa-route" aria-hidden="true"></i> Shortest Path
                                </button>
                                <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-act="leiden">
                                    <i class="fa-solid fa-circle-nodes" aria-hidden="true"></i> Leiden Clusters
                                </button>
                            </div>
                            <pre class="tdb-pre" data-tdb-graph-out>// Graph traversal output will appear here</pre>
                        </section>

                        <section class="tdb-panel">
                            <h3 class="tdb-heading">4. How Other Project Σ Extensions Hook Into TriviumDB</h3>
                            <p class="tdb-note">Any Project Σ client extension can access TriviumDB via <code>window.__SIGMA_TRIVIUM__.db</code> or <code>ctx.commands.run('triviumdb.*')</code>:</p>
                            <pre class="tdb-pre">const db = await window.__SIGMA_TRIVIUM__.db.open('my-ext', { dim: 1536 });
const a = await db.insert(vecA, { name: 'Alice', text: 'Knows the vault code' });
const b = await db.insert(vecB, { name: 'Vault 7', kind: 'location' });
await db.link(a, b, 'infiltrated', 0.95);
await db.indexText(a, 'Alice knows the vault code');
await db.buildTextIndex();

const hits = await db.searchAdvanced(null, {
  queryText: 'vault code',
  topK: 5,
  expandDepth: 2
});
const rows = await db.query('MATCH (n) WHERE n.id == $id RETURN n', { id: a });</pre>
                        </section>
                    </div>
                </div>`;

            const $ = (sel) => /** @type {HTMLElement} */ (el.querySelector(sel));
            const tile = (value, label) => `<div class="tdb-tile"><span class="tdb-tile-value">${esc(value)}</span><span class="tdb-tile-label">${esc(label)}</span></div>`;

            const refreshStats = async () => {
                try {
                    const st = await dbApi.status();
                    if (!shown) return;
                    if (!st.ok) {
                        $('[data-tdb-lead]').innerHTML = `<span class="is-error">Native binary not loaded (${esc(st.nativeError)}). Run <code>bash extensions/installed/triviumdb/scripts/build-termux.sh</code> in Termux.</span>`;
                        return;
                    }
                    const db = await dbApi.open(activeNs, { dim: 4 });
                    const stats = await db.stats();
                    if (!shown) return;
                    $('[data-tdb-lead]').textContent = `Engine: TriviumDB v${st.version} (${st.binary}) · Active Namespace: "${stats.namespace}" · Storage: ${stats.storage?.storage_mode || 'mmap'}`;
                    $('[data-tdb-tiles]').innerHTML = [
                        tile(stats.nodeCount, 'Nodes'),
                        tile(stats.graph?.edgeCount ?? 0, 'Graph Edges'),
                        tile(stats.graph?.labelCount ?? 0, 'Edge Labels'),
                        tile(`${stats.dim}D`, 'Vector Dim'),
                        tile(formatBytes(stats.estimatedMemoryBytes), 'Memory Used'),
                        tile((st.onDiskNamespaces || []).length, 'Disk Namespaces'),
                    ].join('');
                } catch (err) {
                    if (shown) $('[data-tdb-lead]').textContent = `Could not read engine status: ${why(err)}`;
                }
            };

            const runSearch = async () => {
                const q = /** @type {HTMLInputElement} */ ($('[data-tdb-search-q]')).value.trim();
                const adv = /** @type {HTMLInputElement} */ ($('[data-tdb-search-adv]')).checked;
                const outEl = $('[data-tdb-search-out]');
                outEl.innerHTML = '<p class="tdb-note">Searching...</p>';
                try {
                    const db = await dbApi.open(activeNs, { dim: 4 });
                    if (adv) {
                        const res = await db.searchAdvanced(null, { queryText: q, topK: 5, expandDepth: 2 });
                        const timings = Object.entries(res.context?.timingsMs || {})
                            .map(([k, v]) => `${k}: ${Number(v).toFixed(3)}ms`)
                            .join(' · ');
                        outEl.innerHTML = `
                            <p class="tdb-note">Pipeline timings: ${esc(timings || 'n/a')}</p>
                            ${(res.hits || []).map(h => `<div class="tdb-hit-card">
                                <div class="tdb-hit-head">
                                    <strong>#${esc(h.id)} ${esc(h.payload?.name || 'Node')} (${esc(h.payload?.kind || 'item')})</strong>
                                    <span class="tdb-score">score ${Number(h.score).toFixed(3)}</span>
                                </div>
                                <p class="tdb-hit-body">${esc(h.payload?.text || JSON.stringify(h.payload))}</p>
                            </div>`).join('') || '<p class="tdb-note">No hits returned.</p>'}`;
                    } else {
                        const hits = await db.search(null, { queryText: q, topK: 5, expandDepth: 1 });
                        outEl.innerHTML = (hits || []).map(h => `<div class="tdb-hit-card">
                            <div class="tdb-hit-head">
                                <strong>#${esc(h.id)} ${esc(h.payload?.name || 'Node')}</strong>
                                <span class="tdb-score">score ${Number(h.score).toFixed(3)}</span>
                            </div>
                            <p class="tdb-hit-body">${esc(h.payload?.text || JSON.stringify(h.payload))}</p>
                        </div>`).join('') || '<p class="tdb-note">No hits returned.</p>';
                    }
                } catch (err) {
                    outEl.innerHTML = `<p class="tdb-line is-error">${esc(why(err))}</p>`;
                }
            };

            const runTql = async () => {
                const queryStr = /** @type {HTMLTextAreaElement} */ ($('[data-tdb-tql-input]')).value.trim();
                const outPre = $('[data-tdb-tql-out]');
                outPre.textContent = 'Executing TQL...';
                try {
                    const db = await dbApi.open(activeNs, { dim: 4 });
                    const res = await db.query(queryStr);
                    outPre.textContent = JSON.stringify(res, null, 2);
                    await refreshStats();
                } catch (err) {
                    outPre.textContent = `Error: ${why(err)}`;
                }
            };

            el.addEventListener('click', async (ev) => {
                const presetBtn = /** @type {HTMLElement | null} */ (/** @type {Element} */ (ev.target).closest('[data-tdb-preset]'));
                if (presetBtn) {
                    const p = presetBtn.dataset.tdbPreset;
                    const input = /** @type {HTMLTextAreaElement} */ ($('[data-tdb-tql-input]'));
                    if (p === 'match-all') input.value = 'MATCH (n) RETURN n';
                    else if (p === 'find-char') input.value = "FIND {kind: 'character'} RETURN *";
                    else if (p === 'create-node') input.value = 'CREATE (n {name: "Ghost Drone", kind: "construct", text: "Autonomous recon drone patrolling Neon Spire"})';
                    return;
                }

                const actBtn = /** @type {HTMLElement | null} */ (/** @type {Element} */ (ev.target).closest('[data-tdb-act]'));
                if (!actBtn) return;
                const act = actBtn.dataset.tdbAct;

                if (act === 'seed') {
                    try {
                        const res = await dbApi.seedDemo(activeNs, true);
                        CoreAPI.showToast(`Seeded ${res.stats?.nodeCount ?? 5} nodes & ${res.stats?.graph?.edgeCount ?? 7} edges into "${activeNs}"`, 'success');
                        await refreshStats();
                        await runSearch();
                        await runTql();
                    } catch (err) {
                        CoreAPI.showToast(`Seed failed: ${why(err)}`, 'error');
                    }
                } else if (act === 'flush') {
                    try {
                        const res = await dbApi.flushAll();
                        CoreAPI.showToast(`Flushed ${res.flushed} open namespace(s) to disk`, 'success');
                        await refreshStats();
                    } catch (err) {
                        CoreAPI.showToast(`Flush failed: ${why(err)}`, 'error');
                    }
                } else if (act === 'refresh') {
                    await refreshStats();
                } else if (act === 'search') {
                    await runSearch();
                } else if (act === 'run-tql') {
                    await runTql();
                } else if (act === 'subgraph') {
                    const rootId = Number(/** @type {HTMLInputElement} */ ($('[data-tdb-graph-root]')).value) || 1;
                    const outPre = $('[data-tdb-graph-out]');
                    try {
                        const db = await dbApi.open(activeNs, { dim: 4 });
                        const sg = await db.subgraph(rootId, { maxDepth: 2, direction: 'both' });
                        outPre.textContent = JSON.stringify(sg, null, 2);
                    } catch (err) {
                        outPre.textContent = `Error: ${why(err)}`;
                    }
                } else if (act === 'shortest-path') {
                    const src = Number(/** @type {HTMLInputElement} */ ($('[data-tdb-graph-root]')).value) || 1;
                    const dst = Number(/** @type {HTMLInputElement} */ ($('[data-tdb-graph-target]')).value) || 4;
                    const outPre = $('[data-tdb-graph-out]');
                    try {
                        const db = await dbApi.open(activeNs, { dim: 4 });
                        const sp = await db.shortestPath(src, dst, { maxDepth: 6 });
                        outPre.textContent = JSON.stringify({ source: src, target: dst, shortestPath: sp }, null, 2);
                    } catch (err) {
                        outPre.textContent = `Error: ${why(err)}`;
                    }
                } else if (act === 'leiden') {
                    const outPre = $('[data-tdb-graph-out]');
                    try {
                        const db = await dbApi.open(activeNs, { dim: 4 });
                        const clusters = await db.leidenCluster({ minCommunitySize: 1, maxIterations: 10 });
                        outPre.textContent = JSON.stringify(clusters, null, 2);
                    } catch (err) {
                        outPre.textContent = `Error: ${why(err)}`;
                    }
                }
            });

            return {
                async refresh() {
                    await refreshStats();
                },
                enter() {
                    shown = true;
                    void refreshStats();
                },
                leave() {
                    shown = false;
                },
            };
        }
    },

    dispose() {
        if (typeof window !== 'undefined') {
            delete window.__SIGMA_TRIVIUM__;
        }
    },
};
