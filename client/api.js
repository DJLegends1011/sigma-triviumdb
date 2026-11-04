// SPDX-License-Identifier: 0BSD
// TriviumDB for Project Σ — the client's database handle, backed by /api/ext/triviumdb/handle.

/** @param {unknown} e */
export const why = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Build the TauriTavern-compatible `db` API object backed by Project Σ's `/api/ext/triviumdb/handle` route.
 * @param {(path: string, method?: string, body?: any) => Promise<any>} call
 */
export function createTriviumClientApi(call) {
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
                createIndex: (field) => exec({ type: 'createIndex', field }),
                dropIndex: (field) => exec({ type: 'dropIndex', field }),
                indexInfo: () => exec({ type: 'indexInfo' }),
                validateGraph: () => exec({ type: 'validateGraph' }),
                repairGraph: () => exec({ type: 'repairGraph' }),
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

export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
