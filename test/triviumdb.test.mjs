import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { startSigma } = await import(pathToFileURL('D:/ProjectSigma-main/tools/extension-kit/index.mjs').href);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..');

let sigma;
let page;

before(async () => {
    sigma = await startSigma({
        extensions: [EXT_DIR],
        prefix: 'sigma-triviumdb-test',
    });
});

after(async () => {
    try { await sigma?.session?.ext('triviumdb')('/handle', 'POST', { request: { type: 'closeAll' } }); } catch { /* ignore */ }
    try { await page?.close(); } catch { /* ignore */ }
    try { await sigma?.close(); } catch { /* ignore */ }
});

test('server status and TauriTavern-compatible database_handle API', async () => {
    const enabled = await sigma.session.enable('triviumdb', true);
    assert.equal(enabled.status, 200);
    const ext = sigma.session.ext('triviumdb');

    const statusRes = await ext('/status', 'GET');
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.ok, true);
    assert.equal(statusRes.body.version, '0.9.0');

    // Open namespace "test-ns" with dim 4
    const openRes = await ext('/handle', 'POST', {
        request: { type: 'open', namespace: 'test-ns', options: { dim: 4, syncMode: 'normal' } },
    });
    assert.equal(openRes.status, 200);
    assert.equal(openRes.body.namespace, 'test-ns');
    assert.equal(openRes.body.dim, 4);

    // Insert two nodes
    const ins1 = await ext('/handle', 'POST', {
        request: {
            type: 'execute',
            namespace: 'test-ns',
            operation: { type: 'insert', vector: [1, 0, 0, 0], payload: { name: 'Alice', text: 'Alice holds the key' } },
        },
    });
    assert.equal(ins1.status, 200);
    const id1 = ins1.body.result;
    assert.equal(typeof id1, 'number');

    const ins2 = await ext('/handle', 'POST', {
        request: {
            type: 'execute',
            namespace: 'test-ns',
            operation: { type: 'insert', vector: [0, 1, 0, 0], payload: { name: 'Bob', text: 'Bob guards the vault' } },
        },
    });
    const id2 = ins2.body.result;

    // Link & index text
    await ext('/handle', 'POST', {
        request: { type: 'execute', namespace: 'test-ns', operation: { type: 'link', src: id1, dst: id2, label: 'knows', weight: 0.9 } },
    });
    await ext('/handle', 'POST', {
        request: { type: 'execute', namespace: 'test-ns', operation: { type: 'indexText', id: id1, text: 'Alice holds the key' } },
    });
    await ext('/handle', 'POST', {
        request: { type: 'execute', namespace: 'test-ns', operation: { type: 'buildTextIndex' } },
    });

    // Shortest path
    const sp = await ext('/handle', 'POST', {
        request: { type: 'execute', namespace: 'test-ns', operation: { type: 'shortestPath', source: id1, target: id2 } },
    });
    assert.deepEqual(sp.body.result, [id1, id2]);

    // Advanced hybrid search
    const adv = await ext('/handle', 'POST', {
        request: {
            type: 'execute',
            namespace: 'test-ns',
            operation: { type: 'searchAdvanced', vector: [1, 0, 0, 0], queryText: 'Alice', config: { topK: 5 } },
        },
    });
    assert.equal(adv.status, 200);
    assert.ok(Array.isArray(adv.body.result.hits));
    assert.ok(adv.body.result.hits.length >= 1);

    // Parameterized TQL query
    const tqlRes = await ext('/handle', 'POST', {
        request: {
            type: 'execute',
            namespace: 'test-ns',
            operation: { type: 'query', query: 'MATCH (n) WHERE n.id == $id RETURN n', params: { id: id1 } },
        },
    });
    assert.equal(tqlRes.status, 200);
    assert.equal(tqlRes.body.result.type, 'query');
    assert.equal(tqlRes.body.result.rows.length, 1);

    // Seed demo endpoint
    const seedRes = await ext('/seed-demo', 'POST', { namespace: 'playground', reset: true });
    assert.equal(seedRes.status, 200);
    assert.equal(seedRes.body.seeded, true);
    assert.equal(seedRes.body.stats.nodeCount, 5);
    assert.equal(seedRes.body.stats.graph.edgeCount, 7);
});

test('client page boot, window.__SIGMA_TRIVIUM__.db handle, and commands', async () => {
    page = await sigma.session.page();
    await page.boot();

    // Verify window.__SIGMA_TRIVIUM__.db is exposed and __TAURITAVERN__ is not set
    const tdbGlobal = globalThis.window.__SIGMA_TRIVIUM__;
    assert.ok(tdbGlobal?.db, 'window.__SIGMA_TRIVIUM__.db should be installed');
    assert.equal(globalThis.window.__TAURITAVERN__, undefined);

    // Open playground via the client handle and query it
    const handle = await tdbGlobal.db.open('playground', { dim: 4 });
    assert.equal(handle.namespace, 'playground');
    const stats = await handle.stats();
    assert.equal(stats.nodeCount, 5);

    const searchHits = await handle.search(null, { queryText: 'Obsidian Cipher', topK: 3 });
    assert.ok(searchHits.length > 0);

    // Secondary property index & graph validation via client handle
    await handle.createIndex('faction');
    const idxInfo = await handle.indexInfo();
    assert.ok(Array.isArray(idxInfo) && idxInfo.some(i => i.field === 'faction'));
    const valid = await handle.validateGraph();
    assert.equal(valid.valid, true);

    // Also test cross-extension command registration on page.registry
    assert.ok(page.registry.hasCommand('triviumdb.open'));
    assert.ok(page.registry.hasCommand('triviumdb.search'));
    assert.ok(page.registry.hasCommand('triviumdb.query'));
    assert.ok(page.registry.hasCommand('triviumdb.recall-search'));
});

test('the Smart Recall view, chat window and settings render', async () => {
    const views = page.host.getViews();
    const view = views.find(v => v.name === 'ext:triviumdb/recall');
    assert.ok(view, `views: ${JSON.stringify(views)}`);
    assert.equal(view.label, 'Smart Recall');
    assert.equal(views.some(v => /workbench/.test(v.name)), false, 'the workbench is no longer a view of its own');

    const el = page.dom.createElement('div');
    assert.equal(page.host.enterView(view.name, el, { first: true }), true);
    for (let i = 0; i < 50 && !/indexed|Nothing indexed/.test(el.innerHTML); i++) await new Promise(r => setTimeout(r, 20));
    assert.match(el.innerHTML, /Smart Recall/);
    assert.match(el.innerHTML, /Nothing indexed yet/);
    assert.match(el.innerHTML, /Index my library/);
    assert.match(el.innerHTML, /Developer tools/);
    assert.doesNotMatch(el.innerHTML, /Flush WAL/, 'the workbench stays folded until opened');
    page.host.leaveView(view.name);

    assert.ok(page.host.getChatWindows().some(w => w.id === 'recall' || w.key?.endsWith?.('recall')), 'chat window registered');

    const set = page.dom.createElement('div');
    assert.equal(page.host.renderSettingsSection('triviumdb', set), true);
    assert.match(set.innerHTML, /Understand text with/);
    assert.match(set.innerHTML, /Remind the AI in every chat/);
});
