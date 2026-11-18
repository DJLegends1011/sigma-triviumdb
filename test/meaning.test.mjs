// TriviumDB's meaning test and embed route: a connection's embeddings ranking texts against a query, and the
// Gemini request shape (retrieval task types). Mock embedding servers stand in for OpenAI and Google.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..');
const KIT = [
    process.env.SIGMA_DIR && path.resolve(process.env.SIGMA_DIR, 'tools/extension-kit/index.mjs'),
    path.resolve(__dirname, '../../../../ProjectSigma-main/tools/extension-kit/index.mjs'),
    path.resolve(__dirname, '../../../../../ProjectSigma-main/tools/extension-kit/index.mjs'),
    'D:/ProjectSigma-main/tools/extension-kit/index.mjs',
].filter(Boolean).find(p => fs.existsSync(p));
const { startSigma } = await import(pathToFileURL(KIT).href);
const GOOGLE_AI = [path.resolve(EXT_DIR, '../google-ai'), 'D:/ProjectSigma-main/extensions/installed/google-ai']
    .find(p => fs.existsSync(path.join(p, 'manifest.json')));

// a toy embedding: words folded to a concept, so related words land close and unrelated ones far
const CONCEPTS = { dragon: 'dragon', dragons: 'dragon', wyrm: 'dragon', drake: 'dragon', drakes: 'dragon',
    fire: 'fire', flame: 'fire', flames: 'fire', ablaze: 'fire', burned: 'fire', blaze: 'fire',
    tea: 'drink', inn: 'drink', brother: 'family', blade: 'metal', blacksmith: 'metal', fog: 'weather', morning: 'weather' };
const DIM = 32;
const embed = (t) => {
    const v = new Array(DIM).fill(0);
    for (const w of String(t).toLowerCase().match(/[a-z]+/g) || []) {
        const c = CONCEPTS[w];
        if (!c) continue;
        let h = 0;
        for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) % DIM;
        v[h] += 1;
    }
    v[DIM - 1] += 0.05;
    return v;
};
const seen = [];
const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith(':batchEmbedContents')) {
        seen.push({ key: req.headers['x-goog-api-key'], tasks: body.requests.map(r => r.taskType), model: body.requests[0]?.model });
        res.end(JSON.stringify({ embeddings: body.requests.map(r => ({ values: embed(r.content.parts[0].text) })) }));
        return;
    }
    const input = [].concat(body.input || []);
    res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: embed(t) })) }));
});

const TEXTS = [
    'The great wyrm set the forest ablaze with its flames, and the village burned until dawn.',
    'Drakes are lesser dragons that breathe fire and hoard gold in mountain caves.',
    'We drank tea at the inn by the river and talked until late.',
    'My brother Kai left for the capital years ago and never wrote back.',
    'The blacksmith quenched the glowing blade in a bucket of water.',
    'Morning came with fog over the plains.',
];

let sigma;
let ext;
let openai;
before(async () => {
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    sigma = await startSigma({ extensions: [EXT_DIR, GOOGLE_AI].filter(Boolean), prefix: 'sigma-triviumdb-meaning' });
    await sigma.session.enable('triviumdb', true);
    if (GOOGLE_AI) await sigma.session.enable('google-ai', true);
    ext = sigma.session.ext('triviumdb');
    openai = await sigma.session.api('/llm/profiles', 'POST', { name: 'Mock OpenAI', kind: 'openai', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'sk', model: 'm' });
});
after(async () => {
    try { await ext?.('/handle', 'POST', { request: { type: 'closeAll' } }); } catch { /* ignore */ }
    try { await sigma?.close(); } catch { /* ignore */ }
    mock.close();
});

test('"dragon fire" ranks the wyrm set ablaze and the drakes first, by meaning', async () => {
    const r = await ext('/embeddings/rank', 'POST', { query: 'dragon fire', texts: TEXTS, profileId: openai.body.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const top = r.body.ranked.slice(0, 2).map(h => h.text);
    assert.ok(top.includes(TEXTS[0]) && top.includes(TEXTS[1]), JSON.stringify(r.body.ranked));
    const wyrm = r.body.ranked.find(h => h.text === TEXTS[0]);
    assert.equal(wyrm.words, false, 'the wyrm line shares no word with "dragon fire": meaning alone found it');
    assert.ok(wyrm.match > r.body.ranked[2].match + 20, 'well clear of the unrelated texts');
    const scores = r.body.ranked.map(h => h.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.equal(r.body.dim, DIM);
});

test('the connection test and the errors say what is wrong', async () => {
    const ok = await ext('/embeddings/test', 'POST', { profileId: openai.body.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.dim, DIM);
    const none = await ext('/embeddings/rank', 'POST', { query: 'x', texts: ['y'] });
    assert.equal(none.status, 400);
    assert.match(none.body.error, /Pick a connection/);
});

test('/embeddings/embed (triviumdb.embed): one vector per text, and the errors say what is wrong', async () => {
    const r = await ext('/embeddings/embed', 'POST', { texts: ['dragon fire', 'tea at the inn'], role: 'query', profileId: openai.body.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.vectors.length, 2);
    assert.equal(r.body.dim, DIM);
    assert.ok(r.body.vectors.every(v => v.length === DIM));
    assert.ok(typeof r.body.signature === 'string' && r.body.signature.includes(r.body.model), r.body.signature);
    for (const texts of [[], ['x', ''], 'x']) {
        const bad = await ext('/embeddings/embed', 'POST', { texts, profileId: openai.body.id });
        assert.equal(bad.status, 400, JSON.stringify(texts));
    }
    const many = await ext('/embeddings/embed', 'POST', { texts: new Array(257).fill('x'), profileId: openai.body.id });
    assert.equal(many.status, 400);
    const none = await ext('/embeddings/embed', 'POST', { texts: ['x'] });
    assert.equal(none.status, 400);
    assert.match(none.body.error, /Pick a connection/);
});

test('no server globals: other extensions use the triviumdb.* commands', () => {
    assert.deepEqual(Object.keys(globalThis).filter(k => /^__SIGMA_/.test(k)), []);
});

test('Gemini embeds documents as RETRIEVAL_DOCUMENT and the query as RETRIEVAL_QUERY', { skip: !GOOGLE_AI && 'google-ai is not beside this extension' }, async () => {
    const g = await sigma.session.api('/llm/profiles', 'POST', { name: 'Studio', kind: 'gemini', baseUrl: `http://127.0.0.1:${mock.address().port}/v1beta`, apiKey: 'AIza-test', model: 'gemini-x' });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    const r = await ext('/embeddings/rank', 'POST', { query: 'dragon fire', texts: TEXTS, profileId: g.body.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.model, 'gemini-embedding-001');
    assert.ok(seen.some(s => s.tasks.every(t => t === 'RETRIEVAL_QUERY')), JSON.stringify(seen));
    assert.ok(seen.some(s => s.tasks.length === TEXTS.length && s.tasks.every(t => t === 'RETRIEVAL_DOCUMENT')), JSON.stringify(seen));
    assert.ok(seen.every(s => s.key === 'AIza-test' && s.model === 'models/gemini-embedding-001'));
});
