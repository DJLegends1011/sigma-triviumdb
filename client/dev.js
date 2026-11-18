// SPDX-License-Identifier: 0BSD
// TriviumDB for Project Σ — the developer workbench: the engine's raw doors (stats, hybrid search,
// TQL, graph traversal, CRUD) on a sample namespace, for extension authors.

import { why, formatBytes } from './api.js';

export function mountDevTools(el, { dbApi, CoreAPI }) {
    const esc = (s) => CoreAPI.escapeHtml(s);
    let activeNs = 'playground';
    let shown = false;

    el.innerHTML = `
        <div class="tdb-tour">
            <div class="tdb-header">
                <div>
                    <h3 class="tdb-title">TriviumDB engine workbench</h3>
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
                    <h3 class="tdb-heading">4. Node & Edge CRUD + Secondary Property Indexes</h3>
                    <div class="tdb-row">
                        <input type="search" class="glass-input tdb-flex" data-tdb-crud-name value="Viktor" placeholder="Node name">
                        <input type="search" class="glass-input tdb-flex" data-tdb-crud-text value="Ripperdoc in Sector 4 who installed Alice's neural deck." placeholder="Node text / lore...">
                        <button type="button" class="cl-btn cl-btn-primary cl-btn-sm" data-tdb-act="crud-insert">
                            <i class="fa-solid fa-plus" aria-hidden="true"></i> Insert + Index
                        </button>
                    </div>
                    <div class="tdb-row">
                        <label class="tdb-note">Src</label>
                        <input type="number" class="glass-input tdb-num" data-tdb-edge-src value="1" min="1">
                        <label class="tdb-note">Dst</label>
                        <input type="number" class="glass-input tdb-num" data-tdb-edge-dst value="6" min="1">
                        <input type="search" class="glass-input tdb-flex" data-tdb-edge-label value="treated_by" placeholder="Edge label">
                        <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-act="crud-link">
                            <i class="fa-solid fa-link" aria-hidden="true"></i> Link
                        </button>
                    </div>
                    <div class="tdb-row">
                        <input type="search" class="glass-input tdb-flex" data-tdb-idx-field value="faction" placeholder="Payload field (e.g. faction, kind)">
                        <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-act="idx-create">
                            <i class="fa-solid fa-bolt" aria-hidden="true"></i> Create Index
                        </button>
                        <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-act="idx-info">
                            <i class="fa-solid fa-list" aria-hidden="true"></i> Index Info
                        </button>
                        <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-tdb-act="graph-validate">
                            <i class="fa-solid fa-shield-halved" aria-hidden="true"></i> Validate Graph
                        </button>
                    </div>
                    <pre class="tdb-pre" data-tdb-crud-out>// CRUD, secondary index & integrity output will appear here</pre>
                </section>
            </div>

            <section class="tdb-panel">
                <h3 class="tdb-heading">5. Quick-Start Snippet for Project Σ Extensions</h3>
                <p class="tdb-note">Use the Project Σ command contract <code>ctx.commands.run('triviumdb.*')</code>:</p>
                <pre class="tdb-pre">const db = await ctx.commands.run('triviumdb.open', {
  namespace: 'my-ext', options: { dim: 1536 }
});
const a = await db.insert(vecA, { name: 'Alice', text: 'Knows the vault code' });
const b = await db.insert(vecB, { name: 'Vault 7', kind: 'location' });
await db.link(a, b, 'infiltrated', 0.95);
await db.indexText(a, 'Alice knows the vault code');
await db.buildTextIndex();

const hits = await ctx.commands.run('triviumdb.search', {
  namespace: 'my-ext', advanced: true, queryText: 'vault code',
  topK: 5,
  expandDepth: 2
});
const rows = await db.query('MATCH (n) WHERE n.id == $id RETURN n', { id: a });</pre>
            </section>

            <section class="tdb-panel">
                <h3 class="tdb-heading">The TriviumDB doors, as the extension exposes them</h3>
                <div data-tdb-doors></div>
            </section>
        </div>`;

    const $ = (sel) => /** @type {HTMLElement} */ (el.querySelector(sel));
    const tile = (value, label) => `<div class="tdb-tile"><span class="tdb-tile-value">${esc(value)}</span><span class="tdb-tile-label">${esc(label)}</span></div>`;

    const paintDoors = () => {
        const list = (title, rows) => `<details class="tdb-doors"><summary>${esc(title)} (${rows.length})</summary><ul class="tdb-door-list">${rows.join('')}</ul></details>`;
        const row = (name, type) => `<li><code>${esc(name)}</code> <span class="tdb-type">${esc(type)}</span></li>`;

        const handleDoors = [
            row('db.insert(vector, payload?)', '=> Promise<number> (NodeId)'),
            row('db.batchInsert(vectors, payloads)', '=> Promise<number[]> (atomic batch commit)'),
            row('db.upsert(id, vector, payload?)', '=> Promise<void> (insert or overwrite by NodeId)'),
            row('db.get(id)', '=> Promise<{ id, vector, payload, edges } | null>'),
            row('db.updatePayload(id, payload)', '=> Promise<void> (replace JSON payload)'),
            row('db.patchPayload(id, patch)', '=> Promise<void> ($set, $inc, $unset partial update)'),
            row('db.updateVector(id, vector)', '=> Promise<void>'),
            row('db.delete(id)', '=> Promise<void> (atomic 3-layer delete: vector + payload + edges)'),
            row('db.link(src, dst, label?, weight?)', '=> Promise<void> (directed weighted edge, negative = inhibitory)'),
            row('db.unlink(src, dst, label?)', '=> Promise<void>'),
            row('db.shortestPath(source, target, { maxDepth?, label? })', '=> Promise<number[] | null>'),
            row('db.subgraph(id, { maxDepth?, labels?, direction? })', '=> Promise<{ nodes, edges, visitedNodes, traversedEdges, truncated }>'),
            row('db.leidenCluster({ minCommunitySize?, maxIterations?, withCentroids? })', '=> Promise<{ nodeToCluster, clusterLabels, centroids }>'),
            row('db.indexText(id, text)', '=> Promise<void> (BM25 full-text document indexing)'),
            row('db.indexKeyword(id, keyword)', '=> Promise<void> (Aho-Corasick exact keyword automaton)'),
            row('db.buildTextIndex()', '=> Promise<void> (compile text index & flush)'),
            row('db.createIndex(field)', '=> Promise<void> (O(1) secondary property index on payload field)'),
            row('db.dropIndex(field)', '=> Promise<void>'),
            row('db.indexInfo()', '=> Promise<PropertyIndexInfo[]>'),
            row('db.validateGraph()', '=> Promise<GraphIntegrityReport>'),
            row('db.repairGraph()', '=> Promise<GraphRepairReport>'),
            row('db.search(vector?, { queryText?, topK?, expandDepth?, minScore?, filter? })', '=> Promise<SearchHit[]>'),
            row('db.searchBatch(vectors, { parallelism?, topK?, minScore? })', '=> Promise<SearchHit[][]>'),
            row('db.searchAdvanced(vector?, SearchOptions)', '=> Promise<{ hits, context: { timingsMs, stageCounts, observations } }>'),
            row('db.query(tqlText, params?)', '=> Promise<{ type: "query", rows } | { type: "mutation", affected, createdIds }>'),
            row('db.buildQuiverIndex()', '=> Promise<void> (build QuIVer vector index)'),
            row('db.compact()', '=> Promise<void> (compact storage & reclaim tombstones)'),
            row('db.flush()', '=> Promise<void> (flush WAL & sidecars to disk)'),
            row('db.close()', '=> Promise<{ closed: boolean, namespace: string }>'),
            row('db.stats()', '=> Promise<{ namespace, dim, nodeCount, estimatedMemoryBytes, graph, storage }>'),
        ];

        const pipelineDoors = [
            row('topK / recallK / rerankK', 'number — final top-K (default 5), recall pool, and pre-diffusion rerank pool'),
            row('expandDepth / expandLabels / edgeDirection', 'number / string[] / "out"|"in"|"both" — SA-PPR graph walk hop depth & edge filter'),
            row('minEdgeWeight / maxEdgesPerNode', 'number — edge weight threshold and fanout cap during graph walk'),
            row('teleportAlpha', 'number (0.0..1.0) — Personalized PageRank restart probability'),
            row('diffusionBias', 'number[] — CCSA context-gated directional bias vector for graph diffusion'),
            row('enableTextHybridSearch / textBoost', 'boolean / number — fuse BM25 + keyword automaton via weighted RRF'),
            row('enableSparseResidual / fistaLambda / fistaThreshold', 'boolean / number — FISTA sparse residual shadow query for multi-concept recall'),
            row('enableDpp / dppQualityWeight', 'boolean / number — Determinantal Point Process diversity sampling'),
            row('enableRefractoryFatigue', 'boolean — neural refractory period to suppress repetitive hub nodes across turns'),
            row('payloadFilter', 'Record<string, FilterOperator> — MongoDB-style pre-filter ($eq, $ne, $gt, $gte, $lt, $lte, $in, $and, $or)'),
        ];

        const tqlDoors = [
            row('MATCH (a)-[:label]->(b) WHERE ... RETURN a, b', 'Cypher-style pattern matching over nodes and directed edges'),
            row('FIND {field: "value", score: {$gte: 0.5}} RETURN *', 'MongoDB-style document filter query (uses secondary index when created)'),
            row('SEARCH VECTOR $vec TOP 5 RETURN *', 'Vector ANN query with $param token expansion'),
            row('CREATE (n {name: "Alice", role: "netrunner"})', 'TQL mutation returning { type: "mutation", affected, createdIds }'),
            row('MATCH (n) WHERE n.id == $id DELETE n', 'TQL node deletion with safe $param expansion'),
        ];

        const sigmaDoors = [
            row('triviumdb.open', 'ctx.commands.run("triviumdb.open", { namespace, options })'),
            row('triviumdb.search', 'ctx.commands.run("triviumdb.search", { namespace, vector, queryText, topK, expandDepth, advanced })'),
            row('triviumdb.query', 'ctx.commands.run("triviumdb.query", { namespace, query, params })'),
            row('triviumdb.list-namespaces', 'ctx.commands.run("triviumdb.list-namespaces")'),
            row('triviumdb.seed-demo', 'ctx.commands.run("triviumdb.seed-demo", { namespace, reset })'),
            row('triviumdb.status', 'ctx.commands.run("triviumdb.status")'),
            row('triviumdb.embed', 'ctx.commands.run("triviumdb.embed", { texts, role: "doc" | "query", profileId?, model? })'),
            row('TauriTavern database API', 'Extensions written for TauriTavern find the same handle where TauriTavern puts it'),
            row('{{trivium_recall::query}}', 'Server prompt macro expanding top hybrid search hits from default namespace'),
            row('{{trivium_recall::namespace::query}}', 'Server prompt macro targeting a specific namespace'),
            row('POST /api/ext/triviumdb/handle', 'Server RPC route ({ request: { type: "open" | "execute" | "close" | "listNamespaces" | "flushAll" } })'),
        ];

        $('[data-tdb-doors]').innerHTML = [
            list('Project Σ commands, macros & routes', sigmaDoors),
            list('DatabaseHandle methods (triviumdb.open command)', handleDoors),
            list('Cognitive Pipeline options (db.searchAdvanced)', pipelineDoors),
            list('TQL statements & patterns (db.query)', tqlDoors),
        ].join('');
    };

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
        } else if (act === 'crud-insert') {
            const name = /** @type {HTMLInputElement} */ ($('[data-tdb-crud-name]')).value.trim() || 'Unnamed Node';
            const text = /** @type {HTMLInputElement} */ ($('[data-tdb-crud-text]')).value.trim();
            const outPre = $('[data-tdb-crud-out]');
            try {
                const db = await dbApi.open(activeNs, { dim: 4 });
                const id = await db.insert(null, { name, kind: 'character', text });
                if (text) await db.indexText(id, text);
                await db.indexKeyword(id, name);
                await db.buildTextIndex();
                const node = await db.get(id);
                outPre.textContent = JSON.stringify({ insertedId: id, node }, null, 2);
                /** @type {HTMLInputElement} */ ($('[data-tdb-edge-dst]')).value = String(id);
                await refreshStats();
            } catch (err) {
                outPre.textContent = `Error: ${why(err)}`;
            }
        } else if (act === 'crud-link') {
            const src = Number(/** @type {HTMLInputElement} */ ($('[data-tdb-edge-src]')).value) || 1;
            const dst = Number(/** @type {HTMLInputElement} */ ($('[data-tdb-edge-dst]')).value) || 2;
            const label = /** @type {HTMLInputElement} */ ($('[data-tdb-edge-label]')).value.trim() || 'related';
            const outPre = $('[data-tdb-crud-out]');
            try {
                const db = await dbApi.open(activeNs, { dim: 4 });
                await db.link(src, dst, label, 1.0);
                const srcNode = await db.get(src);
                outPre.textContent = JSON.stringify({ linked: { src, dst, label }, srcEdges: srcNode?.edges || [] }, null, 2);
                await refreshStats();
            } catch (err) {
                outPre.textContent = `Error: ${why(err)}`;
            }
        } else if (act === 'idx-create') {
            const field = /** @type {HTMLInputElement} */ ($('[data-tdb-idx-field]')).value.trim() || 'faction';
            const outPre = $('[data-tdb-crud-out]');
            try {
                const db = await dbApi.open(activeNs, { dim: 4 });
                await db.createIndex(field);
                const indexes = await db.indexInfo();
                outPre.textContent = JSON.stringify({ createdIndex: field, indexes }, null, 2);
            } catch (err) {
                outPre.textContent = `Error: ${why(err)}`;
            }
        } else if (act === 'idx-info') {
            const outPre = $('[data-tdb-crud-out]');
            try {
                const db = await dbApi.open(activeNs, { dim: 4 });
                const indexes = await db.indexInfo();
                outPre.textContent = JSON.stringify({ indexes }, null, 2);
            } catch (err) {
                outPre.textContent = `Error: ${why(err)}`;
            }
        } else if (act === 'graph-validate') {
            const outPre = $('[data-tdb-crud-out]');
            try {
                const db = await dbApi.open(activeNs, { dim: 4 });
                const report = await db.validateGraph();
                outPre.textContent = JSON.stringify(report, null, 2);
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
            paintDoors();
            void refreshStats();
        },
        leave() {
            shown = false;
        },
    };
}
