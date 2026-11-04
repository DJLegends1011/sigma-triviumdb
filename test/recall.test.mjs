// Smart Recall end to end: a mock OpenAI-compatible embeddings server, a chat and a lorebook indexed,
// search by meaning and by words, the chat's recall in its prompt, incremental updates, keyword mode.
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

// a toy embedding: words folded to a concept, each concept a direction, so related words land close
const CONCEPTS = {
    brother: 'sibling', sibling: 'sibling', sister: 'sibling', kai: 'sibling',
    dragon: 'dragon', wyrm: 'dragon', drake: 'dragon',
    fire: 'fire', flame: 'fire', flames: 'fire', burned: 'fire', burning: 'fire', blaze: 'fire',
    sword: 'blade', blade: 'blade', steel: 'blade',
    tea: 'drink', ale: 'drink', drink: 'drink', drank: 'drink',
    capital: 'city', city: 'city', town: 'city',
};
const DIM = 32;
function embed(text) {
    const v = new Array(DIM).fill(0);
    for (const w of String(text).toLowerCase().match(/[a-z]+/g) || []) {
        const c = CONCEPTS[w];
        if (!c) continue;
        let h = 0;
        for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) % DIM;
        v[h] += 1;
    }
    v[DIM - 1] += 0.05;
    return v;
}

let calls = 0;
let embedded = 0;
let fail429 = 0;
const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url !== '/v1/embeddings') { res.writeHead(404).end('{}'); return; }
    const body = JSON.parse(raw);
    calls++;
    if (fail429 > 0) {
        fail429--;
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota. Quota exceeded for metric: embed_content_free_tier_requests, limit: 100. Please retry in 1.2s.', status: 'RESOURCE_EXHAUSTED' } }));
        return;
    }
    const input = Array.isArray(body.input) ? body.input : [body.input];
    embedded += input.length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: embed(t) })), model: body.model }));
});

let sigma;
let ext;
let chatId;
let otherChatId;
let charId;
const api = (...a) => sigma.session.api(...a);

async function waitForJobs() {
    for (let i = 0; i < 200; i++) {
        const st = await ext('/recall/status');
        const j = st.body.job;
        if (j && (j.status === 'queued' || j.status === 'running')) { await new Promise(r => setTimeout(r, 100)); continue; }
        return st.body;
    }
    throw new Error('the indexing job never ended');
}

before(async () => {
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    sigma = await startSigma({ extensions: [EXT_DIR], prefix: 'sigma-triviumdb-recall' });
    assert.equal((await sigma.session.enable('triviumdb', true)).status, 200);
    ext = sigma.session.ext('triviumdb');

    const profile = await api('/llm/profiles', 'POST', { name: 'Mock Embeddings', kind: 'openai', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'sk-test', model: 'chat-model' });
    assert.equal(profile.status, 200, JSON.stringify(profile.body));
    const set = await api('/settings', 'PATCH', { 'ext:triviumdb:embedProfile': profile.body.id, 'ext:triviumdb:embedModel': 'mock-embed', 'ext:triviumdb:recallSkipRecent': 4 });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    const char = await sigma.session.importCard({ name: 'Aria', description: 'A traveling bard.', first_mes: 'Hello, traveler.' });
    charId = char.id;
    const chat = await api(`/characters/${charId}/chats`, 'POST', { name: 'Road to the capital' });
    chatId = chat.body.id || chat.body.chat?.id;
    assert.ok(chatId, JSON.stringify(chat.body));
    const lines = [
        'Hello, traveler.',
        'My brother Kai left for the capital years ago and never wrote back.',
        'That must hurt. Do you think he is alive?',
        'We drank tea at the inn by the river.',
        'The weather turned cold on the road.',
        'A merchant sold us bread.',
        'We passed an old mill.',
        'The horses needed rest.',
        'Night fell over the plains.',
        'Morning came with fog.',
        'Look, smoke in the distance!',
    ];
    const messages = lines.map((mes, i) => ({ name: i % 2 ? 'Traveler' : 'Aria', is_user: i % 2 === 1, is_system: false, mes, send_date: '2026-11-03T12:00:00Z' }));
    const put = await api(`/chats/${chatId}/messages`, 'PUT', { messages });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const other = await api(`/characters/${charId}/chats`, 'POST', { name: 'Old campaign' });
    otherChatId = other.body.id || other.body.chat?.id;
    await api(`/chats/${otherChatId}/messages`, 'PUT', { messages: [
        { name: 'Aria', is_user: false, is_system: false, mes: 'Welcome back, old friend.' },
        { name: 'Aria', is_user: false, is_system: false, mes: 'The great wyrm set the forest ablaze with its flames.' },
        { name: 'Traveler', is_user: true, is_system: false, mes: 'I raised my steel and charged.' },
    ] });

    const world = await api('/worlds/Bestiary', 'PUT', { entries: {
        0: { uid: 0, key: ['drake'], comment: 'Drakes', content: 'Drakes are lesser dragons that breathe fire and hoard gold.' },
        1: { uid: 1, key: ['inn'], comment: 'The Riverside Inn', content: 'A quiet inn that serves strong ale.' },
    } });
    assert.equal(world.status, 200, JSON.stringify(world.body));
});

after(async () => {
    try { await ext?.('/handle', 'POST', { request: { type: 'closeAll' } }); } catch { /* ignore */ }
    try { await sigma?.close(); } catch { /* ignore */ }
    mock.close();
});

test('status before indexing says what waits', async () => {
    const st = await ext('/recall/status');
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.engine.ok, true);
    assert.equal(st.body.mode, 'meaning');
    assert.equal(st.body.connection.model, 'mock-embed');
    assert.equal(st.body.index.built, false);
    assert.ok(st.body.index.library.messages >= 14);
    assert.equal(st.body.index.library.lore, 2);
});

test('the connection test embeds', async () => {
    const t = await ext('/recall/test', 'POST', {});
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.dim, DIM);
});

test('indexing embeds the library once, and a second pass embeds nothing', async () => {
    const q = await ext('/recall/index', 'POST', {});
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const st = await waitForJobs();
    assert.equal(st.job.status, 'done', JSON.stringify(st.job));
    assert.equal(st.index.built, true);
    assert.equal(st.index.indexed.lore, 2);
    assert.equal(st.index.indexed.messages, 14);
    assert.equal(st.index.waiting.messages, 0);

    const before = embedded;
    await ext('/recall/index', 'POST', {});
    const again = await waitForJobs();
    assert.equal(again.job.status, 'done');
    // only the dimension probe is never repeated: the space is kept, nothing changed
    assert.equal(embedded, before, 'an unchanged library is not embedded again');
});

test('search finds by meaning, not just words', async () => {
    const s = await ext('/recall/search', 'POST', { q: 'my sibling' });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.by, 'meaning');
    assert.match(s.body.hits[0].text, /brother Kai/);
    assert.equal(s.body.hits[0].chatId, chatId);
    assert.equal(s.body.hits[0].seq, 1);
    assert.ok(s.body.hits[0].match > 50);

    const lore = await ext('/recall/search', 'POST', { q: 'dragon', scope: 'lore' });
    assert.equal(lore.body.hits[0].src, 'lore');
    assert.equal(lore.body.hits[0].title, 'Drakes');
    assert.equal(lore.body.hits[0].world, 'Bestiary');

    const chats = await ext('/recall/search', 'POST', { q: 'dragon', scope: 'chats' });
    assert.ok(chats.body.hits.every(h => h.src === 'msg'));
    assert.match(chats.body.hits[0].text, /wyrm/);

    const here = await ext('/recall/search', 'POST', { q: 'dragon fire', chatId });
    assert.ok(here.body.hits.every(h => h.chatId === chatId));
});

test('a chat recalls its older moments into the prompt only when switched on', async () => {
    const off = await api(`/chats/${chatId}/prompt`);
    assert.equal(off.status, 200);
    assert.ok(!JSON.stringify(off.body.messages).includes('Earlier moments'), 'off by default');

    const on = await ext(`/recall/chats/${chatId}`, 'PUT', { on: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    // the composer primes the query with the message about to be sent
    const primed = await ext(`/recall/chats/${chatId}/prime`, 'POST', { text: 'Do you think my sibling is still alive?' });
    assert.equal(primed.body.primed, true, JSON.stringify(primed.body));

    const prompt = await api(`/chats/${chatId}/prompt`);
    const text = prompt.body.messages.map(m => m.content).join('\n');
    assert.match(text, /Earlier moments from this story/);
    assert.match(text, /brother Kai left for the capital/);

    const preview = await ext(`/recall/chats/${chatId}/preview`);
    assert.ok(preview.body.hits.length >= 1);
    // the newest messages (recallSkipRecent: 4) are never recalled; the prompt holds them already
    const maxSeq = 10;
    assert.ok(preview.body.hits.every(h => h.seq <= maxSeq - 4), JSON.stringify(preview.body.hits.map(h => h.seq)));

    const state = await ext(`/recall/chats/${chatId}`);
    assert.equal(state.body.on, true);
    assert.equal(state.body.indexed, 11);

    // every chat with this character: the old campaign's dragon joins
    await ext(`/recall/chats/${chatId}`, 'PUT', { scope: 'character' });
    await ext(`/recall/chats/${chatId}/prime`, 'POST', { text: 'Tell me about the dragon fire again.' });
    const wide = await ext(`/recall/chats/${chatId}/preview`);
    assert.ok(wide.body.hits.some(h => h.chatId === otherChatId), JSON.stringify(wide.body.hits));
});

test('new and edited messages join the index on their own', async () => {
    const before = embedded;
    const sent = await api(`/chats/${chatId}/messages`, 'POST', { mes: 'I still carry the blade my sister gave me.' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    let hit = null;
    for (let i = 0; i < 80 && !hit; i++) {
        await new Promise(r => setTimeout(r, 150));
        const s = await ext('/recall/search', 'POST', { q: 'sword', chatId });
        hit = s.body.hits.find(h => /blade my sister/.test(h.text));
    }
    assert.ok(hit, 'the new message was indexed by the catch-up job');
    await waitForJobs();
    // the new message, plus the queries the search and the recall embedded
    assert.ok(embedded - before <= 4 + 80, `${embedded - before} embedded`);
});

test('indexing waits out a per-minute rate limit instead of failing', async () => {
    await api(`/chats/${otherChatId}/messages`, 'POST', { mes: 'The drake circled the tower twice before it landed.' });
    await waitForJobs();
    await api(`/chats/${otherChatId}/messages`, 'POST', { mes: 'Its flames lit the whole valley.' });
    fail429 = 1;
    const t0 = Date.now();
    await ext('/recall/index', 'POST', {});
    const st = await waitForJobs();
    assert.equal(st.job.status, 'done', JSON.stringify(st.job));
    assert.equal(st.index.waiting.messages, 0);
    assert.equal(fail429, 0, 'the 429 was hit');
    assert.ok(Date.now() - t0 >= 1200, 'it waited as long as the service asked');
});

test('a greeting repeated in every chat shows once, below a real moment that matches as well', async () => {
    const greeting = 'Welcome to the fire festival, where the dragon dances at dawn.';
    const ids = [];
    for (const name of ['Festival one', 'Festival two']) {
        const c = await api(`/characters/${charId}/chats`, 'POST', { name });
        const id = c.body.id || c.body.chat?.id;
        ids.push(id);
        await api(`/chats/${id}/messages`, 'PUT', { messages: [
            { name: 'Aria', is_user: false, is_system: false, mes: greeting },
            { name: 'Traveler', is_user: true, is_system: false, mes: 'The dragon breathed fire over the dancers at dawn.' },
        ] });
    }
    await ext('/recall/index', 'POST', {});
    await waitForJobs();
    const s = await ext('/recall/search', 'POST', { q: 'dragon fire', scope: 'chats', limit: 30 });
    const greetings = s.body.hits.filter(h => h.text === greeting);
    assert.equal(greetings.length, 1, 'the same greeting in two chats is one result');
    assert.equal(greetings[0].greeting, true);
    const moment = s.body.hits.findIndex(h => /breathed fire over the dancers/.test(h.text));
    assert.ok(moment >= 0 && moment < s.body.hits.indexOf(greetings[0]), 'the real moment ranks above the greeting');
    assert.equal(s.body.hits.filter(h => /breathed fire over the dancers/.test(h.text)).length, 1, 'branch-shared text shows once');
});

test('the macro writes the chat recall anywhere', async () => {
    const st = await ext(`/recall/chats/${chatId}/preview`);
    assert.ok(st.body.text.startsWith('['));
});

test('without a connection it matches words', async () => {
    await api('/settings', 'PATCH', { 'ext:triviumdb:embedProfile': '' });
    const st = await ext('/recall/status');
    assert.equal(st.body.mode, 'words');
    assert.equal(st.body.index.stale, true);
    await ext('/recall/index', 'POST', { rebuild: true });
    const done = await waitForJobs();
    assert.equal(done.job.status, 'done', JSON.stringify(done.job));
    assert.equal(done.index.mode, 'words');
    const s = await ext('/recall/search', 'POST', { q: 'Kai capital' });
    assert.equal(s.body.by, 'words');
    assert.match(s.body.hits[0].text, /brother Kai/);
    assert.equal(s.body.hits[0].match, null);
    const none = await ext('/recall/search', 'POST', { q: 'sibling' });
    assert.ok(!none.body.hits.some(h => /brother Kai/.test(h.text)), 'words mode does not know meanings');
});
