// Gemini (AI Studio) embeddings: batchEmbedContents with retrieval task types, documents vs queries.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..');
const KIT = [
    path.resolve(__dirname, '../../../../ProjectSigma-main/tools/extension-kit/index.mjs'),
    path.resolve(__dirname, '../../../../../ProjectSigma-main/tools/extension-kit/index.mjs'),
    'D:/ProjectSigma-main/tools/extension-kit/index.mjs',
].find(p => fs.existsSync(p));
const { startSigma } = await import(pathToFileURL(KIT).href);
const GOOGLE_AI = [
    path.resolve(EXT_DIR, '../google-ai'),
    'D:/ProjectSigma-main/extensions/installed/google-ai',
].find(p => fs.existsSync(path.join(p, 'manifest.json')));

const seen = [];
const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push({ url: req.url, key: req.headers['x-goog-api-key'], tasks: (body.requests || []).map(r => r.taskType), model: body.requests?.[0]?.model });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embeddings: body.requests.map((r, i) => ({ values: [1, i % 3, r.taskType === 'RETRIEVAL_QUERY' ? 1 : 0, 0.5] })) }));
});

let sigma;
before(async () => {
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    sigma = await startSigma({ extensions: [EXT_DIR, GOOGLE_AI].filter(Boolean), prefix: 'sigma-triviumdb-gemini' });
    await sigma.session.enable('triviumdb', true);
    if (GOOGLE_AI) await sigma.session.enable('google-ai', true);
});
after(async () => {
    try { await sigma?.session.ext('triviumdb')('/handle', 'POST', { request: { type: 'closeAll' } }); } catch { /* ignore */ }
    try { await sigma?.close(); } catch { /* ignore */ }
    mock.close();
});

test('documents are embedded as RETRIEVAL_DOCUMENT and searches as RETRIEVAL_QUERY', { skip: !GOOGLE_AI && 'the google-ai extension (the gemini kind) is not beside this one' }, async () => {
    const api = sigma.session.api;
    const ext = sigma.session.ext('triviumdb');
    const profile = await api('/llm/profiles', 'POST', { name: 'Studio', kind: 'gemini', baseUrl: `http://127.0.0.1:${mock.address().port}/v1beta`, apiKey: 'AIza-test', model: 'gemini-x' });
    assert.equal(profile.status, 200, JSON.stringify(profile.body));
    await api('/settings', 'PATCH', { 'ext:triviumdb:embedProfile': profile.body.id });
    const char = await sigma.session.importCard({ name: 'G', description: 'x', first_mes: 'hi' });
    const chat = await api(`/characters/${char.id}/chats`, 'POST', { name: 'c' });
    await api(`/chats/${chat.body.id}/messages`, 'PUT', { messages: [{ name: 'G', is_user: false, mes: 'one' }, { name: 'U', is_user: true, mes: 'two' }] });
    await ext('/recall/index', 'POST', {});
    let done = null;
    for (let i = 0; i < 100 && !done; i++) {
        const st = await ext('/recall/status');
        if (st.body.job?.status === 'done' || st.body.job?.status === 'failed') done = st.body.job;
        else await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(done?.status, 'done', JSON.stringify(done));
    const s = await ext('/recall/search', 'POST', { q: 'two' });
    assert.equal(s.body.by, 'meaning');
    const docs = seen.filter(x => x.tasks.includes('RETRIEVAL_DOCUMENT'));
    const queries = seen.filter(x => x.tasks.includes('RETRIEVAL_QUERY'));
    assert.ok(docs.length >= 1 && queries.length >= 1, JSON.stringify(seen));
    assert.ok(seen.every(x => /:batchEmbedContents$/.test(x.url) && x.key === 'AIza-test' && x.model === 'models/gemini-embedding-001'), JSON.stringify(seen));
});
