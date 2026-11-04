// SPDX-License-Identifier: 0BSD
// TriviumDB for Project Σ — embeddings through the account's own connections: OpenAI-compatible servers
// (OpenAI, OpenRouter, Ollama, LM Studio, vLLM…) and Google AI Studio. Part of the server API other
// extensions reach through globalThis.__SIGMA_TRIVIUM_SERVER__.embeddings.

const EMBED_BATCH = 64;
const EMBED_CHARS = 6000;
const STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta';
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

export const clip = (text, max) => {
    const s = String(text || '').trim();
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

function unit(vec) {
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
});

/** @param {any} ctx the server context */
export function createEmbeddings(ctx) {
    /**
     * What makes embeddings for a connection: null when no connection is named, { error } when it cannot,
     * else the target embed() takes. model empty picks the service's small default.
     */
    function targetOf(db, profileId, model = '') {
        const id = profileId;
        if (!id) return null;
        const row = ctx.stores.llmProfiles.profileRow(db, id);
        if (!row || row.id !== id) return { error: 'The connection picked for embeddings was deleted. Pick another.' };
        const kind = String(row.kind || 'openai');
        model = String(model || '').trim();
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
    /** A stable name for how a target embeds: an index built under another signature must be rebuilt. */
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
    // opts.role: 'doc' for what is indexed, 'query' for what is searched with; opts.signal, opts.patient, opts.onWait. Models trained for retrieval
    // embed the two differently (Gemini's task types, nomic's prefixes), which ranks the right passage higher.
    async function embed(target, texts, opts = {}) {
        const { signal } = opts;
        const out = [];
        const query = opts.role === 'query';
        const nomic = /nomic-embed/i.test(target.model);
        for (let i = 0; i < texts.length; i += EMBED_BATCH) {
            const batch = texts.slice(i, i + EMBED_BATCH).map(t => {
                const text = clip(t, EMBED_CHARS) || ' ';
                return nomic ? `${query ? 'search_query' : 'search_document'}: ${text}` : text;
            });
            let vectors;
            if (target.via === 'gemini') {
                const json = await postJson(
                    `${target.base}/models/${encodeURIComponent(target.model)}:batchEmbedContents`,
                    target.key ? { 'x-goog-api-key': target.key } : {},
                    { requests: batch.map(text => ({ model: `models/${target.model}`, content: { parts: [{ text }] }, taskType: query ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' })) },
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

    return Object.freeze({ targetOf, signatureOf, embed });
}
