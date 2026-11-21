// SPDX-License-Identifier: GPL-3.0-only
// TriviumDB for Project Σ — Server Half:
// Multi-namespace TriviumDB 0.9.0 instance manager, TauriTavern-compatible database_handle
// execution contract, TQL parameter binding, {{trivium_recall}} macro, and optional prompt block.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createEmbeddings, keywordQuery } from './embed.js';

// append-only: an entry that ran is never edited, a change is a new entry. 0 held Smart Recall's index
// while it lived here; it moved to the smart-recall extension, and 1 drops what it left.
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
    `DROP TABLE IF EXISTS x_triviumdb_recall;
    DROP TABLE IF EXISTS x_triviumdb_meta;`,
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = path.resolve(__dirname, '..', 'native');
const require = createRequire(import.meta.url);

let TriviumDBClass = null;
let nativeLoadError = null;
let nativeBinaryUsed = null;

function loadNativeAddon() {
    if (TriviumDBClass) return { TriviumDB: TriviumDBClass, error: null, binary: nativeBinaryUsed };
    try {
        const mod = require(path.join(NATIVE_DIR, 'index.js'));
        TriviumDBClass = mod.TriviumDB;
        const platform = process.platform;
        const arch = process.arch;
        const libc = platform === 'linux' && process.report?.getReport?.().header?.glibcVersionRuntime ? 'gnu' : 'musl';
        const platformArch = platform === 'win32'
            ? `${platform}-${arch}-msvc`
            : platform === 'linux'
                ? `${platform}-${arch}-${libc}`
                : `${platform}-${arch}`;
        const candidates = [
            `triviumdb.${platformArch}.node`,
            `triviumdb.${platform}-${arch}.node`,
            'triviumdb.node',
        ];
        nativeBinaryUsed = candidates.find(c => fs.existsSync(path.join(NATIVE_DIR, c))) || `${platformArch}`;
        nativeLoadError = null;
    } catch (err) {
        nativeLoadError = err instanceof Error ? err.message : String(err);
    }
    return { TriviumDB: TriviumDBClass, error: nativeLoadError, binary: nativeBinaryUsed };
}

// Validate namespace: 1-128 lowercase ASCII letters, digits, '-', '_'
const NS_RE = /^[a-z0-9_-]{1,128}$/;

function validateNamespace(ns) {
    if (typeof ns !== 'string' || !NS_RE.test(ns)) {
        const err = new Error('Invalid namespace: must be 1–128 lowercase ASCII letters, digits, "-", or "_"');
        err.statusCode = 400;
        throw err;
    }
    return ns;
}

/**
 * Convert BigInt values inside objects (such as graphStats histogram upper_bound: 18446744073709551615n)
 * into safe JS numbers or strings so Express res.json() never throws TypeError: Do not know how to serialize a BigInt.
 */
function sanitizeBigInt(val) {
    if (typeof val === 'bigint') {
        return val <= BigInt(Number.MAX_SAFE_INTEGER) && val >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(val)
            : val.toString();
    }
    if (Array.isArray(val)) return val.map(sanitizeBigInt);
    if (val && typeof val === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(val)) out[k] = sanitizeBigInt(v);
        return out;
    }
    return val;
}

/**
 * Quote a string literal for TQL (single-quoted with \' and \\ escaped).
 */
function quoteTqlString(text) {
    let out = "'";
    for (const ch of String(text)) {
        if (ch === "'" || ch === '\\') out += '\\';
        out += ch;
    }
    out += "'";
    return out;
}

function toTqlLiteral(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return quoteTqlString(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Non-finite number in TQL parameter');
        return String(value);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) return `[${value.map(toTqlLiteral).join(',')}]`;
    if (typeof value === 'object') {
        const pairs = Object.entries(value).map(([k, v]) => `${quoteTqlString(k)}:${toTqlLiteral(v)}`);
        return `{${pairs.join(',')}}`;
    }
    return String(value);
}

/**
 * Expand $param tokens in TQL outside string literals and comments, skipping MongoDB-style filter keys like `$gte:`.
 */
function bindTqlParams(queryText, params = {}) {
    if (typeof queryText !== 'string' || !queryText.trim()) {
        const err = new Error('TQL query must be a non-empty string');
        err.statusCode = 400;
        throw err;
    }
    const paramObj = params && typeof params === 'object' ? params : {};
    let out = '';
    let i = 0;
    const len = queryText.length;

    while (i < len) {
        const ch = queryText[i];
        // Single or double quoted string
        if (ch === "'" || ch === '"') {
            const quote = ch;
            out += ch;
            i++;
            while (i < len) {
                const c = queryText[i];
                out += c;
                i++;
                if (c === '\\' && i < len) {
                    out += queryText[i];
                    i++;
                } else if (c === quote) {
                    break;
                }
            }
            continue;
        }
        // Line comment // or --
        if ((ch === '/' && queryText[i + 1] === '/') || (ch === '-' && queryText[i + 1] === '-')) {
            while (i < len && queryText[i] !== '\n') {
                out += queryText[i++];
            }
            continue;
        }
        // $param token
        if (ch === '$' && /[a-zA-Z_]/.test(queryText[i + 1] || '')) {
            let end = i + 1;
            while (end < len && /[a-zA-Z0-9_]/.test(queryText[end])) end++;
            const name = queryText.slice(i + 1, end);
            // Look ahead past whitespace for ':' (document filter operator like $gte: 0.7)
            let look = end;
            while (look < len && /\s/.test(queryText[look])) look++;
            if (queryText[look] === ':') {
                out += queryText.slice(i, end);
                i = end;
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(paramObj, name)) {
                const err = new Error(`Missing TQL parameter $${name}`);
                err.statusCode = 400;
                throw err;
            }
            out += toTqlLiteral(paramObj[name]);
            i = end;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

function isTqlMutation(boundQuery) {
    const trimmed = boundQuery.replace(/^\s*(?:(?:\/\/|--)[^\n]*\n\s*)*/, '').trim();
    if (/^(?:CREATE|DELETE|DETACH\s+DELETE|SET)\b/i.test(trimmed)) return true;
    if (/^MATCH\b/i.test(trimmed) && /\b(?:SET|DELETE|DETACH\s+DELETE)\b/i.test(trimmed) && !/\bRETURN\b/i.test(trimmed)) {
        return true;
    }
    return false;
}

/**
 * Deterministic 4D/N-D feature vector from text when caller passes a smaller or null vector in demos/macros.
 */
function textToDemoVector(text, dim) {
    const d = Math.max(1, Number(dim) || 4);
    const vec = new Array(d).fill(0);
    const str = String(text || '').toLowerCase();
    if (!str) {
        vec[0] = 1;
        return vec;
    }
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        const idx = (code * 31 + i * 17) % d;
        vec[idx] += ((code % 13) + 1) * 0.1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => Number((v / norm).toFixed(6)));
}

function normalizeVector(vector, dim, fallbackText = '') {
    if (Array.isArray(vector) && vector.length === dim) {
        return vector.map(n => Number(n) || 0);
    }
    if (vector === null || vector === undefined) {
        return textToDemoVector(fallbackText, dim);
    }
    const err = new Error(`Vector dimension mismatch: expected ${dim}, got ${Array.isArray(vector) ? vector.length : typeof vector}`);
    err.statusCode = 400;
    throw err;
}

export function register(router, ctx) {
    // Map of "<userHandle>:<namespace>" -> { user, namespace, dbPath, db, dim, options, openedAt, opsCount }
    const instances = new Map();

    function userRootDir(userHandle) {
        const safeUser = String(userHandle || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
        const dir = path.join(ctx.dataDir(), 'users', safeUser, 'databases');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    function dbFilePath(userHandle, namespace) {
        const ns = validateNamespace(namespace);
        const dir = path.join(userRootDir(userHandle), `db-${ns}`);
        fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, `${ns}.tdb`);
    }

    function instanceKey(userHandle, namespace) {
        return `${userHandle || 'default'}:${namespace}`;
    }

    function ensureNative() {
        const { TriviumDB, error } = loadNativeAddon();
        if (!TriviumDB) {
            const err = new Error(
                `TriviumDB native addon is not built for ${process.platform}-${process.arch} yet (${error}). ` +
                `On Termux, run: bash extensions/installed/triviumdb/scripts/build-termux.sh`,
            );
            err.statusCode = 503;
            throw err;
        }
        return TriviumDB;
    }

    function openNamespace(userHandle, dbSql, namespace, rawOptions = {}) {
        const ns = validateNamespace(namespace);
        const key = instanceKey(userHandle, ns);
        const existing = instances.get(key);

        if (existing) {
            if (rawOptions.dim !== undefined && Number(rawOptions.dim) !== existing.dim) {
                const err = new Error(`Namespace "${ns}" is already open with dim=${existing.dim} (requested dim=${rawOptions.dim}). Close it first.`);
                err.statusCode = 409;
                throw err;
            }
            if (rawOptions.syncMode !== undefined && rawOptions.syncMode !== existing.options.syncMode) {
                const err = new Error(`Namespace "${ns}" is already open with syncMode="${existing.options.syncMode}". Close it first.`);
                err.statusCode = 409;
                throw err;
            }
            if (rawOptions.storageMode !== undefined && rawOptions.storageMode !== existing.options.storageMode) {
                const err = new Error(`Namespace "${ns}" is already open with storageMode="${existing.options.storageMode}". Close it first.`);
                err.statusCode = 409;
                throw err;
            }
            return {
                namespace: existing.namespace,
                dim: existing.dim,
                options: existing.options,
            };
        }

        const TriviumDB = ensureNative();
        const defaultDim = dbSql ? (Number(ctx.setting(dbSql, 'defaultDim')) || 1536) : 1536;
        const defaultSync = dbSql ? (ctx.setting(dbSql, 'defaultSyncMode') || 'normal') : 'normal';

        const dbPath = dbFilePath(userHandle, ns);
        const options = {
            dim: Number(rawOptions.dim) > 0 ? Number(rawOptions.dim) : defaultDim,
            storageMode: rawOptions.storageMode === 'rom' ? 'rom' : 'mmap',
            syncMode: ['full', 'normal', 'off'].includes(rawOptions.syncMode) ? rawOptions.syncMode : defaultSync,
            loadTextIndex: true,
            autoBuildQuiver: rawOptions.autoBuildQuiver !== undefined ? !!rawOptions.autoBuildQuiver : true,
            memoryLimitMb: Number(rawOptions.memoryLimitMb) >= 0 ? Number(rawOptions.memoryLimitMb) : 0,
        };

        const db = new TriviumDB(dbPath, options);
        const actualDim = db.dim();
        if (rawOptions.dim !== undefined && Number(rawOptions.dim) !== actualDim) {
            db.close();
            const err = new Error(`Database "${ns}" on disk has dim=${actualDim}, which conflicts with requested dim=${rawOptions.dim}`);
            err.statusCode = 409;
            throw err;
        }
        options.dim = actualDim;

        const entry = {
            user: userHandle || 'default',
            namespace: ns,
            dbPath,
            db,
            dim: actualDim,
            options,
            openedAt: Date.now(),
            opsCount: 0,
        };
        instances.set(key, entry);
        return {
            namespace: ns,
            dim: actualDim,
            options,
        };
    }

    function getOpenInstance(userHandle, namespace) {
        const ns = validateNamespace(namespace);
        const entry = instances.get(instanceKey(userHandle, ns));
        if (!entry) {
            const err = new Error(`Database namespace "${ns}" is not open. Call open("${ns}") first.`);
            err.statusCode = 400;
            throw err;
        }
        return entry;
    }

    function closeNamespace(userHandle, namespace) {
        const ns = validateNamespace(namespace);
        const key = instanceKey(userHandle, ns);
        const entry = instances.get(key);
        if (!entry) return { closed: false, namespace: ns };
        entry.db.flush();
        entry.db.close();
        instances.delete(key);
        return { closed: true, namespace: ns };
    }

    /** Close a namespace and delete its files. */
    function dropNamespace(userHandle, namespace) {
        const ns = validateNamespace(namespace);
        closeNamespace(userHandle, ns);
        fs.rmSync(path.join(userRootDir(userHandle), `db-${ns}`), { recursive: true, force: true });
    }

    function listUserNamespaces(userHandle) {
        const prefix = `${userHandle || 'default'}:`;
        const openList = [];
        for (const [k, entry] of instances.entries()) {
            if (k.startsWith(prefix)) {
                openList.push({
                    namespace: entry.namespace,
                    dim: entry.dim,
                    nodeCount: entry.db.nodeCount(),
                    estimatedMemoryBytes: entry.db.estimatedMemory(),
                    options: entry.options,
                    openedAt: entry.openedAt,
                    opsCount: entry.opsCount,
                });
            }
        }
        // Also check on-disk namespaces in userRootDir
        const root = userRootDir(userHandle);
        const diskNamespaces = [];
        try {
            for (const item of fs.readdirSync(root, { withFileTypes: true })) {
                if (item.isDirectory() && item.name.startsWith('db-')) {
                    const ns = item.name.slice(3);
                    const tdbFile = path.join(root, item.name, `${ns}.tdb`);
                    if (fs.existsSync(tdbFile)) diskNamespaces.push(ns);
                }
            }
        } catch { /* ignore */ }
        return {
            namespaces: openList.map(o => o.namespace),
            details: openList,
            onDisk: diskNamespaces,
        };
    }

    function executeOperation(entry, operation) {
        const { db, dim, namespace } = entry;
        entry.opsCount++;
        const type = operation?.type;

        switch (type) {
            case 'insert': {
                const vec = normalizeVector(operation.vector, dim, operation.payload?.text || '');
                return db.insert(vec, operation.payload ?? null);
            }
            case 'batchInsert': {
                const vectors = Array.isArray(operation.vectors) ? operation.vectors : [];
                const payloads = Array.isArray(operation.payloads) ? operation.payloads : [];
                if (vectors.length !== payloads.length) {
                    const err = new Error('vectors and payloads must have the same length');
                    err.statusCode = 400;
                    throw err;
                }
                const normVecs = vectors.map((v, i) => normalizeVector(v, dim, payloads[i]?.text || ''));
                return db.batchInsert(normVecs, payloads);
            }
            case 'upsert': {
                const id = Number(operation.id);
                const vec = normalizeVector(operation.vector, dim, operation.payload?.text || '');
                db.upsertWithId(id, vec, operation.payload ?? null);
                return null;
            }
            case 'get': {
                const node = db.get(Number(operation.id));
                return node ? sanitizeBigInt(node) : null;
            }
            case 'updatePayload': {
                db.updatePayload(Number(operation.id), operation.payload ?? null);
                return null;
            }
            case 'patchPayload': {
                db.patchPayload(Number(operation.id), operation.patch ?? {});
                return null;
            }
            case 'updateVector': {
                const vec = normalizeVector(operation.vector, dim);
                db.updateVector(Number(operation.id), vec);
                return null;
            }
            case 'delete': {
                db.delete(Number(operation.id));
                return null;
            }
            case 'link': {
                const src = Number(operation.src);
                const dst = Number(operation.dst);
                const label = typeof operation.label === 'string' && operation.label ? operation.label : 'related';
                const weight = operation.weight !== undefined ? Number(operation.weight) : 1.0;
                db.link(src, dst, label, weight);
                return null;
            }
            case 'unlink': {
                db.unlink(Number(operation.src), Number(operation.dst), operation.label || undefined);
                return null;
            }
            case 'shortestPath': {
                const source = Number(operation.source);
                const target = Number(operation.target);
                const maxDepth = Number(operation.maxDepth) > 0 ? Number(operation.maxDepth) : 6;
                const labels = typeof operation.label === 'string' && operation.label ? [operation.label] : undefined;
                if (source === target) return [source];
                const reach = db.reachable(source, { maxDepth, labels, direction: 'outgoing' });
                const hit = reach.find(r => r.targetId === target);
                return hit ? hit.path : null;
            }
            case 'subgraph': {
                const id = Number(operation.id);
                const maxDepth = Number(operation.maxDepth) > 0 ? Number(operation.maxDepth) : 2;
                const labels = Array.isArray(operation.labels) ? operation.labels : undefined;
                const direction = ['outgoing', 'incoming', 'both'].includes(operation.direction) ? operation.direction : 'outgoing';
                const res = db.querySubgraph(id, { maxDepth, labels, direction });
                return sanitizeBigInt({
                    nodes: res.nodes,
                    edges: res.edges,
                    visitedNodes: res.visitedNodes,
                    traversedEdges: res.traversedEdges,
                    truncated: res.truncated,
                });
            }
            case 'indexText': {
                db.indexText(Number(operation.id), String(operation.text || ''));
                return null;
            }
            case 'indexKeyword': {
                db.indexKeyword(Number(operation.id), String(operation.keyword || ''));
                return null;
            }
            case 'buildTextIndex': {
                db.buildTextIndex();
                db.flush();
                return null;
            }
            case 'search': {
                const cfg = operation.config || {};
                const queryText = typeof operation.queryText === 'string' && operation.queryText.trim()
                    ? operation.queryText.trim()
                    : (typeof cfg.customQueryText === 'string' ? cfg.customQueryText.trim() : '');
                const vec = normalizeVector(operation.vector, dim, queryText);
                const topK = Number(cfg.topK) > 0 ? Number(cfg.topK) : 5;
                const expandDepth = Number(cfg.expandDepth) >= 0 ? Number(cfg.expandDepth) : 0;
                const minScore = cfg.minScore !== undefined ? Number(cfg.minScore) : 0.0;
                const payloadFilter = cfg.payloadFilter || undefined;

                if (queryText) {
                    return sanitizeBigInt(
                        db.searchHybrid(vec, queryText, topK, expandDepth, minScore, cfg.hybridAlpha ?? 0.5, payloadFilter),
                    );
                }
                return sanitizeBigInt(db.search(vec, topK, expandDepth, minScore, payloadFilter));
            }
            case 'searchBatch': {
                const vectors = Array.isArray(operation.vectors) ? operation.vectors : [];
                const cfg = operation.config || {};
                const topK = Number(cfg.topK) > 0 ? Number(cfg.topK) : 5;
                const minScore = cfg.minScore !== undefined ? Number(cfg.minScore) : 0.0;
                return vectors.map(v => sanitizeBigInt(db.search(normalizeVector(v, dim), topK, cfg.expandDepth ?? 0, minScore)));
            }
            case 'searchAdvanced': {
                const cfg = { ...(operation.config || {}) };
                const queryText = typeof operation.queryText === 'string' && operation.queryText.trim()
                    ? operation.queryText.trim()
                    : (typeof cfg.customQueryText === 'string' ? cfg.customQueryText.trim() : '');
                if (queryText) {
                    cfg.customQueryText = queryText;
                    if (cfg.enableTextHybridSearch === undefined) cfg.enableTextHybridSearch = true;
                }
                if (cfg.enableAdvancedPipeline === undefined) cfg.enableAdvancedPipeline = true;
                if (cfg.minScore === undefined) cfg.minScore = 0.0;
                const vec = normalizeVector(operation.vector, dim, queryText);
                const out = db.searchWithContext(vec, cfg);
                return sanitizeBigInt({
                    hits: out.hits,
                    context: {
                        timingsMs: out.context?.timings || {},
                        stageCounts: out.context?.counts || {},
                        observations: out.context?.observations || {},
                    },
                });
            }
            case 'query': {
                const bound = bindTqlParams(operation.query, operation.params || {});
                if (isTqlMutation(bound)) {
                    const mut = db.tqlMut(bound);
                    return sanitizeBigInt({
                        type: 'mutation',
                        affected: mut.affected,
                        createdIds: mut.createdIds,
                    });
                }
                const rows = db.tql(bound);
                return sanitizeBigInt({
                    type: 'query',
                    rows,
                });
            }
            case 'leidenCluster': {
                return sanitizeBigInt(db.leidenCluster(operation.config || {}));
            }
            case 'createIndex': {
                db.createIndex(String(operation.field || ''));
                return null;
            }
            case 'dropIndex': {
                db.dropIndex(String(operation.field || ''));
                return null;
            }
            case 'indexInfo': {
                return sanitizeBigInt(db.indexInfo());
            }
            case 'validateGraph': {
                return sanitizeBigInt(db.validateGraph());
            }
            case 'repairGraph': {
                return sanitizeBigInt(db.repairGraphIndexes());
            }
            case 'buildQuiverIndex': {
                db.flush();
                return null;
            }
            case 'compact': {
                db.compact();
                return null;
            }
            case 'flush': {
                db.flush();
                return null;
            }
            case 'stats': {
                const graph = sanitizeBigInt(db.graphStats());
                const storage = sanitizeBigInt(db.storageInfo());
                return {
                    namespace,
                    dim: db.dim(),
                    nodeCount: db.nodeCount(),
                    estimatedMemoryBytes: db.estimatedMemory(),
                    graph: {
                        nodeCount: graph.node_count ?? db.nodeCount(),
                        edgeCount: graph.edge_count ?? 0,
                        isolatedNodeCount: graph.isolated_node_count ?? 0,
                        labelCount: graph.label_count ?? 0,
                        labelStats: graph.label_stats ?? {},
                    },
                    storage,
                };
            }
            default: {
                const err = new Error(`Unsupported TriviumDB operation type: "${type}"`);
                err.statusCode = 400;
                throw err;
            }
        }
    }

    // ---- Server routes under /api/ext/triviumdb/ ----

    function closeAllUserNamespaces(userHandle = null) {
        for (const [k, entry] of [...instances.entries()]) {
            if (!userHandle || k.startsWith(`${userHandle}:`)) {
                try { entry.db.flush(); } catch { /* ignore */ }
                try { entry.db.close(); } catch { /* ignore */ }
                instances.delete(k);
            }
        }
    }

    // Ensure open mmap handles are closed cleanly on process exit so temp directories can be removed on Windows
    process.once('beforeExit', () => closeAllUserNamespaces());
    process.once('exit', () => closeAllUserNamespaces());

    router.get('/status', (req, res) => {
        const { TriviumDB, error, binary } = loadNativeAddon();
        const nsInfo = listUserNamespaces(req.userHandle);
        res.json({
            ok: !!TriviumDB,
            engine: 'TriviumDB',
            version: '0.9.0',
            platform: process.platform,
            arch: process.arch,
            binary,
            nativeError: error,
            user: req.userHandle,
            openNamespaces: nsInfo.namespaces,
            details: nsInfo.details,
            onDiskNamespaces: nsInfo.onDisk,
        });
    });

    // Unified RPC endpoint matching TauriTavern's `database_handle` command
    router.post('/handle', (req, res) => {
        try {
            const request = req.body?.request || req.body || {};
            const reqType = request.type;

            if (reqType === 'open') {
                const out = openNamespace(req.userHandle, req.db, request.namespace, request.options || {});
                return res.json(out);
            }
            if (reqType === 'close') {
                const out = closeNamespace(req.userHandle, request.namespace);
                return res.json(out);
            }
            if (reqType === 'listNamespaces') {
                const out = listUserNamespaces(req.userHandle);
                return res.json(out.namespaces);
            }
            if (reqType === 'flushAll') {
                const prefix = `${req.userHandle || 'default'}:`;
                let flushed = 0;
                for (const [k, entry] of instances.entries()) {
                    if (k.startsWith(prefix)) {
                        entry.db.flush();
                        flushed++;
                    }
                }
                return res.json({ flushed });
            }
            if (reqType === 'closeAll') {
                closeAllUserNamespaces(req.userHandle);
                return res.json({ closed: true });
            }
            if (reqType === 'execute') {
                const entry = getOpenInstance(req.userHandle, request.namespace);
                const result = executeOperation(entry, request.operation || {});
                return res.json({ result });
            }

            return res.status(400).json({ error: `Unknown request type: "${reqType}"` });
        } catch (err) {
            const status = err?.statusCode || 400;
            return res.status(status).json({
                error: err instanceof Error ? err.message : String(err),
                code: err?.code || 'TDB_ERROR',
            });
        }
    });

    // Demo seeder for the Workbench / Tour: populates a namespace with an interactive RP knowledge graph
    router.post('/seed-demo', (req, res) => {
        try {
            const ns = validateNamespace(req.body?.namespace || 'playground');
            // If already open with a different dim, close first; if on disk with different dim, wipe demo dir
            closeNamespace(req.userHandle, ns);
            const demoDir = path.join(userRootDir(req.userHandle), `db-${ns}`);
            if (req.body?.reset && fs.existsSync(demoDir)) {
                fs.rmSync(demoDir, { recursive: true, force: true });
            }

            const opened = openNamespace(req.userHandle, req.db, ns, { dim: 4, syncMode: 'normal' });
            const entry = getOpenInstance(req.userHandle, ns);
            const { db, dim } = entry;

            if (db.nodeCount() > 0 && !req.body?.reset) {
                return res.json({
                    seeded: false,
                    message: `Namespace "${ns}" already has ${db.nodeCount()} nodes. Pass reset: true to recreate.`,
                    stats: executeOperation(entry, { type: 'stats' }),
                });
            }

            const samples = [
                {
                    name: 'Alice Vance',
                    kind: 'character',
                    role: 'Netrunner',
                    faction: 'Eclipse Syndicate',
                    text: 'Alice Vance is an elite netrunner who stole the Obsidian Cipher from Arasaka Vault 7.',
                    keywords: ['Alice', 'Netrunner', 'Obsidian Cipher', 'Vault 7'],
                },
                {
                    name: 'Marcus Holt',
                    kind: 'character',
                    role: 'Fixer',
                    faction: 'Night Market',
                    text: 'Marcus Holt brokers illegal neuralware in Sector 4 and hired Alice for the Vault 7 heist.',
                    keywords: ['Marcus', 'Fixer', 'Sector 4'],
                },
                {
                    name: 'Obsidian Cipher',
                    kind: 'artifact',
                    role: 'Quantum Key',
                    faction: 'Aethelgard AI',
                    text: 'The Obsidian Cipher is a pre-collapse quantum key capable of unlocking the Aethelgard orbital relay.',
                    keywords: ['Obsidian Cipher', 'Quantum Key', 'Aethelgard'],
                },
                {
                    name: 'Sector 4 Safehouse',
                    kind: 'location',
                    role: 'Hideout',
                    faction: 'Night Market',
                    text: 'An abandoned mag-lev station beneath Neon Spire where Alice hid the Obsidian Cipher.',
                    keywords: ['Sector 4', 'Safehouse', 'Neon Spire'],
                },
                {
                    name: 'Seraphina',
                    kind: 'character',
                    role: 'Inquisitor',
                    faction: 'Aethelgard AI',
                    text: 'Seraphina is a cybernetic inquisitor hunting Alice Vance across Sector 4 to recover the Obsidian Cipher.',
                    keywords: ['Seraphina', 'Inquisitor', 'Aethelgard'],
                },
            ];

            const ids = [];
            for (const item of samples) {
                const vec = textToDemoVector(item.text, dim);
                const id = db.insert(vec, {
                    name: item.name,
                    kind: item.kind,
                    role: item.role,
                    faction: item.faction,
                    text: item.text,
                });
                db.indexText(id, item.text);
                for (const kw of item.keywords) db.indexKeyword(id, kw);
                ids.push(id);
            }

            // Build knowledge graph edges:
            // Alice (0) -> Marcus (1), Obsidian Cipher (2), Sector 4 Safehouse (3)
            // Seraphina (4) -> Alice (0), Obsidian Cipher (2)
            db.link(ids[0], ids[1], 'hired_by', 0.9);
            db.link(ids[0], ids[2], 'stole', 1.0);
            db.link(ids[0], ids[3], 'hides_at', 0.85);
            db.link(ids[2], ids[3], 'stashed_in', 0.95);
            db.link(ids[4], ids[0], 'hunts', 1.0);
            db.link(ids[4], ids[2], 'seeks', 0.9);
            db.link(ids[1], ids[3], 'owns', 0.75);

            db.buildTextIndex();
            db.flush();

            return res.json({
                seeded: true,
                namespace: ns,
                dim: opened.dim,
                createdIds: ids,
                stats: executeOperation(entry, { type: 'stats' }),
            });
        } catch (err) {
            return res.status(err?.statusCode || 400).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });

    // ---- embeddings through the account's connections: the meaning test, and triviumdb.embed for other extensions ----
    const embeddings = createEmbeddings(ctx);

    // texts in, one vector each through a connection's embeddings (role 'query' for a search, 'doc' for what is stored)
    router.post('/embeddings/embed', async (req, res) => {
        try {
            const texts = (Array.isArray(req.body?.texts) ? req.body.texts : []).map(x => String(x ?? '').trim());
            if (!texts.length || texts.some(t => !t)) return res.status(400).json({ error: 'texts must be a list of non-empty strings.' });
            if (texts.length > 256) return res.status(400).json({ error: 'At most 256 texts per call.' });
            const role = req.body?.role === 'query' ? 'query' : 'doc';
            const target = embeddings.targetOf(req.db, String(req.body?.profileId || ''), String(req.body?.model || ''));
            if (!target) return res.status(400).json({ error: 'Pick a connection first.' });
            if (target.error) return res.status(400).json({ error: target.error });
            const vectors = await embeddings.embed(target, texts, { role, signal: AbortSignal.timeout(120_000) });
            res.json({ model: target.model, signature: embeddings.signatureOf(target), dim: vectors[0]?.length ?? 0, vectors });
        } catch (e) {
            res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // ---- the meaning test: how a connection's embeddings rank texts against a query ----
    router.post('/embeddings/test', async (req, res) => {
        try {
            const target = embeddings.targetOf(req.db, String(req.body?.profileId || ''), String(req.body?.model || ''));
            if (!target) return res.status(400).json({ error: 'Pick a connection first.' });
            if (target.error) return res.status(400).json({ error: target.error });
            const t0 = Date.now();
            const [vec] = await embeddings.embed(target, ['TriviumDB connection test'], { role: 'query', signal: AbortSignal.timeout(60_000) });
            res.json({ ok: true, model: target.model, dim: vec.length, ms: Date.now() - t0 });
        } catch (e) {
            res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // query + texts in, every text ranked by closeness in meaning (through a scratch namespace, so the
    // engine's own search answers) and whether it shares the query's words
    router.post('/embeddings/rank', async (req, res) => {
        const ns = 'meaning-test';
        try {
            const query = String(req.body?.query || '').trim().slice(0, 2000);
            const texts = (Array.isArray(req.body?.texts) ? req.body.texts : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 64);
            if (!query || !texts.length) return res.status(400).json({ error: 'A query and at least one text are needed.' });
            const target = embeddings.targetOf(req.db, String(req.body?.profileId || ''), String(req.body?.model || ''));
            if (!target) return res.status(400).json({ error: 'Pick a connection first.' });
            if (target.error) return res.status(400).json({ error: target.error });
            ensureNative();
            const signal = AbortSignal.timeout(90_000);
            const t0 = Date.now();
            const [qv] = await embeddings.embed(target, [query], { role: 'query', signal });
            const docs = await embeddings.embed(target, texts, { role: 'doc', signal });
            const embedMs = Date.now() - t0;
            dropNamespace(req.userHandle, ns);
            openNamespace(req.userHandle, req.db, ns, { dim: qv.length, syncMode: 'off' });
            const entry = getOpenInstance(req.userHandle, ns);
            const ids = texts.map((text, i) => {
                const id = entry.db.insert(docs[i], { i, text });
                entry.db.indexText(id, text);
                return id;
            });
            entry.db.buildTextIndex();
            const t1 = Date.now();
            const hits = entry.db.search(qv, texts.length, 0, -1);
            const words = keywordQuery(query);
            const wordHits = new Set(words ? entry.db.searchHybrid(new Array(qv.length).fill(0), words, texts.length, 0, 0, 0).filter(h => h.score >= 2).map(h => h.id) : []);
            const searchMs = Date.now() - t1;
            const ranked = hits.map(h => ({ text: h.payload?.text ?? texts[ids.indexOf(h.id)], score: Number(h.score.toFixed(4)), match: Math.round(Math.max(0, Math.min(1, h.score)) * 100), words: wordHits.has(h.id) }));
            dropNamespace(req.userHandle, ns);
            res.json({ model: target.model, dim: qv.length, embedMs, searchMs, ranked });
        } catch (e) {
            try { dropNamespace(req.userHandle, ns); } catch { /* none */ }
            res.status(e?.statusCode || 502).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // ---- Macro: {{trivium_recall::query}} or {{trivium_recall::namespace::query}}: a search of a namespace ----
    ctx.macros.add('trivium_recall', {
        args: [
            { name: 'first', optional: true },
            { name: 'second', optional: true },
        ],
        handler: ({ db, user, unnamedArgs: [first, second] }) => {
            try {
                if (!first && !second) return '';
                const { TriviumDB } = loadNativeAddon();
                if (!TriviumDB) return '';
                let ns = ctx.setting(db, 'recallNamespace') || 'playground';
                let queryText = '';
                if (first && second) {
                    ns = first.trim();
                    queryText = second.trim();
                } else {
                    queryText = String(first).trim();
                }
                if (!queryText) return '';
                openNamespace(user, db, ns, {});
                const entry = getOpenInstance(user, ns);
                if (entry.db.nodeCount() === 0) return '';
                const topK = Math.max(1, Math.min(20, Number(ctx.setting(db, 'recallTopK')) || 5));
                const hits = executeOperation(entry, {
                    type: 'search',
                    vector: null,
                    queryText,
                    config: { topK, expandDepth: 1, minScore: 0 },
                });
                if (!Array.isArray(hits) || !hits.length) return '';
                return hits
                    .map(h => {
                        const p = h.payload || {};
                        const label = p.name || p.title || `Node #${h.id}`;
                        const body = p.text || p.content || JSON.stringify(p);
                        return `- [${label}]: ${body}`;
                    })
                    .join('\n');
            } catch {
                return '';
            }
        },
    });
}
