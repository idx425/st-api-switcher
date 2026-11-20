const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const initial = [
    { id: 'alpha', name: 'Alpha', url: 'https://alpha.invalid/v1', key: 'fixture-alpha', model: 'model-a', group: '分组' },
    { id: 'beta', name: 'Beta', url: 'https://beta.invalid/v1', key: 'fixture-beta', model: 'model-b' },
    { id: 'local', name: 'Local', url: 'https://local.invalid/v1', key: '', model: '' },
];
const fixture = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{margin:8px;font:16px sans-serif;background:#eee;color:#222}#extensionsMenu{position:fixed;left:12px;top:14px;width:180px;height:65px}#rm_api_block{margin-top:100px;width:min(100%, 540px)}
</style><div id="extensionsMenu"></div><div id="rm_api_block"><h3>API Connections</h3><select id="main_api"><option value="textgenerationwebui">Text</option><option value="openai">Chat</option></select><div id="connector"></div></div><div id="extensions_settings2"></div>`;
const timeout = { timeout: 3500 };
const wait = (page, fn, arg) => page.waitForFunction(fn, arg, timeout);
const activate = async (locator) => (await locator.page().evaluate(() => matchMedia('(pointer: coarse)').matches))
    ? locator.tap(timeout) : locator.click(timeout);

async function setup(page) {
    await page.goto('http://fixture.invalid/');
    await page.addScriptTag({ path: require.resolve('jquery') });
    await page.addStyleTag({ path: path.join(root, 'style.css') });
    await page.evaluate((profiles) => {
        const $ = window.$;
        const state = window.testState = {
            profiles, connects: [], lookup: [], requests: [], nextId: 0, suspended: 0,
            secrets: [{ id: 'native', value: 'native-test', label: '我的 API 快切备用', active: true }],
        };
        window.__TAURITAVERN__ = {};
        window.SillyTavern = { getContext: () => ({ extensionSettings: { st_api_switcher: state }, saveSettingsDebounced() {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }) };
        window.toastr = new Proxy({}, { get: (_, level) => (message) => { state.lastToast = { level, message }; } });
        const source = $('<select id="chat_completion_source"><option value="openai">OpenAI</option><option value="custom_openai_responses">Responses</option><option value="custom">Custom</option></select>');
        const controls = $('<div><input id="custom_api_url_text"><input id="custom_model_id"><input id="api_key_custom" type="password"></div>');
        const button = $('<button id="api_button_openai">Connect</button>');
        const connect = function (event) {
            event.stopPropagation();
            if (state.suspended) return;
            const key = String($('#api_key_custom').val() ?? '');
            $('#api_key_custom').val('');
            state.connects.push({ url: $('#custom_api_url_text').val(), model: $('#custom_model_id').val(), key: key || state.secrets.find(x => x.active)?.value });
        };
        button.on('click', connect);
        source.on('change', () => {
            controls.detach();
            if (source.val() === 'custom') button.before(controls);
            button.trigger('click');
        });
        $('#main_api').on('change', function () {
            source.detach(); button.detach(); controls.detach();
            if (this.value === 'openai') $('#connector').append(source, button);
        });
        const original = window.fetch;
        window.fetch = async (url, options) => {
            if (!url.startsWith('/api/')) return original(url, options);
            const body = options.body ? JSON.parse(options.body) : {};
            const json = (data, status) => Response.json(data, { status });
            if (options.signal?.aborted) throw options.signal.reason;
            state.requests.push(url);
            if (url.endsWith('/secrets/read')) return json({ api_key_custom: state.secrets });
            if (url.endsWith('/secrets/write')) {
                if (state.failWrite) return json({ error: true }, 503);
                for (const entry of state.secrets) entry.active = false;
                const id = 'fixture-' + ++state.nextId;
                state.secrets.push({ id, value: body.value, label: body.label, active: true });
                return json({ id });
            }
            if (url.endsWith('/secrets/delete')) {
                assertSpecific(body.id);
                state.secrets = state.secrets.filter(item => item.id !== body.id);
                return json({ ok: true });
            }
            if (url.endsWith('/chat-completions/status')) {
                state.lookup.push(body);
                if (state.delayLookup) await new Promise((resolve, reject) => {
                    state.releaseLookup = resolve;
                    options.signal.addEventListener('abort', () => { state.aborted = true; reject(options.signal.reason); }, { once: true });
                });
                if (state.denyLookup) return json({ error: true, message: '请在 TT 信任此端点', data: { data: [] } });
                return json({ data: { data: Array.from({ length: 28 }, (_, id) => ({ id: 'fixture-model-' + String(id).padStart(2, '0') })) } });
            }
            if (url.endsWith('/discover')) return json([{ name: 'third-party/st-api-switcher', type: 'local' }]);
            return json({ isUpToDate: true });
        };
        function assertSpecific(id) { if (!id || id === 'native') throw Error('Attempt to delete native key'); }
        window.testViewport = (width, height, offsetTop = 0) => {
            const viewport = Object.assign(new EventTarget(), { width, height, offsetLeft: 0, offsetTop });
            Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
            window.dispatchEvent(new Event('resize'));
        };
    }, initial);
    await page.addScriptTag({ path: process.env.AQS_BASELINE_JS || path.join(root, 'index.js') });
    await page.locator('#aqs_wand_btn').waitFor(timeout);
}

async function bounds(page, selector, width, height, top = 0) {
    const box = await page.locator(selector).boundingBox(timeout);
    assert.ok(box && box.width > 0 && box.height > 0, selector + ' has a visible box');
    assert.ok(box.x >= -1 && box.y >= top - 1 && box.x + box.width <= width + 1 && box.y + box.height <= height + top + 1,
        `${selector} outside ${width}×${height}+${top}: ${JSON.stringify(box)}`);
    return box;
}

async function switchAndWait(page, name, count) {
    await activate(page.locator('#aqs_api_embed').getByRole('button', { name, exact: false }).first());
    await wait(page, (n) => testState.connects.length === n, count);
}

const scenarios = {
    async search(page) {
        await activate(page.locator('#aqs_wand_btn'));
        const field = page.locator('#aqs_quick_panel input');
        await field.pressSequentially('Beta', timeout);
        assert.equal(await field.inputValue(), 'Beta');
        assert.equal(await field.evaluate(el => el === document.activeElement), true);
        assert.equal(await page.locator('#aqs_embed_search input').inputValue(), 'Beta');
        assert.equal(await page.locator('#aqs_profile_list input').inputValue(), 'Beta');
        assert.equal(await page.locator('#aqs_api_embed_body .aqs-qp-item').count(), 1);
        await activate(page.getByRole('button', { name: '关闭快切' }));
        assert.equal(await page.locator('#aqs_quick_panel').isVisible(), false);
        assert.equal(await page.locator('#extensionsMenu').isVisible(), true);
    },
    async viewport(page, size, _alternate, touch) {
        await page.locator('#aqs_url').fill('https://models.invalid/v1', timeout);
        await page.locator('#aqs_key').fill('fixture-own');
        await activate(page.locator('#aqs_fetch_models'));
        const list = page.locator('.aqs-modal-list');
        await page.locator('.aqs-modal-item').first().waitFor(timeout);
        await bounds(page, '.aqs-modal-box', size.width, size.height);
        assert.equal(await page.locator('.aqs-modal-filter').evaluate(el => el === document.activeElement), !touch);
        await activate(page.locator('.aqs-modal-filter'));
        await page.evaluate(({ width }) => testViewport(width, 235, 30), size);
        await bounds(page, '.aqs-modal-box', size.width, 235, 30);
        const scroller = await list.boundingBox();
        const target = { x: Math.round(scroller.x + scroller.width / 2), y: Math.round(scroller.y + scroller.height - 12) };
        if (touch) {
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [target] });
            for (let offset = 8; offset <= 60; offset += 8) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: target.x, y: target.y - offset }] });
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
            await page.mouse.move(target.x, target.y);
            await page.mouse.wheel(0, 100);
        }
        await list.evaluate(el => new Promise((resolve, reject) => {
            if (el.scrollTop > 0) return resolve();
            el.addEventListener('scroll', resolve, { once: true });
            setTimeout(() => reject(Error('Touch did not scroll model list')), 1000);
        }));
        assert.equal(await page.locator('#aqs_model').inputValue(), '');
        await page.locator('.aqs-modal-filter').fill('model-19');
        await activate(page.locator('.aqs-modal-item'));
        assert.equal(await page.locator('#aqs_model').inputValue(), 'fixture-model-19');
        assert.equal(await page.locator('#aqs_model_modal').count(), 0);
        assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    },
    async connection(page) {
        await switchAndWait(page, 'Alpha', 1);
        await switchAndWait(page, 'Beta', 2);
        await switchAndWait(page, 'Local', 3);
        const state = await page.evaluate(() => ({ connects: testState.connects, secrets: testState.secrets, suspended: testState.suspended }));
        assert.deepEqual(state.connects, initial.map(p => ({ url: p.url, model: p.model, key: p.key })));
        assert.equal(state.suspended, 0);
        assert.deepEqual(state.secrets.map(s => [s.id === 'native', s.active, s.value]), [[true, false, 'native-test'], [false, true, '']]);
        await page.evaluate(() => { testState.failWrite = true; });
        await activate(page.locator('#aqs_api_embed').getByRole('button', { name: /Alpha/ }));
        await wait(page, () => testState.lastToast?.level === 'error');
        assert.equal(await page.evaluate(() => testState.connects.length), 3);
    },
    async lookup(page) {
        await page.locator('#aqs_url').fill('https://models.invalid/v1', timeout);
        await page.locator('#aqs_key').fill('fixture-own');
        await page.evaluate(() => { testState.delayLookup = true; });
        await activate(page.locator('#aqs_fetch_models'));
        await wait(page, () => testState.lookup.length === 1);
        await activate(page.getByRole('button', { name: '关闭', exact: true }));
        await wait(page, () => testState.aborted);
        await page.evaluate(() => { testState.delayLookup = false; testState.denyLookup = true; });
        await activate(page.locator('#aqs_fetch_models'));
        await page.getByText('请在 TT 信任此端点').waitFor(timeout);
        assert.equal(await page.locator('#aqs_model_modal').count(), 1);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#aqs_model_modal').count(), 0);
        const state = await page.evaluate(() => ({ lookups: testState.lookup, secret: testState.secrets[0], writes: testState.nextId }));
        assert.equal(state.lookups.length, 2);
        assert.equal(state.writes, 0);
        assert.equal(state.secret.active, true);
        assert.ok(state.lookups.every(call => call.custom_include_headers.Authorization === 'Bearer fixture-own'));
    },
    async drawers(page, size, alternate) {
        await activate(page.locator('#aqs_wand_btn'));
        await page.setViewportSize(alternate);
        await bounds(page, '#aqs_quick_panel', alternate.width, alternate.height);
        await page.setViewportSize(size);
        await bounds(page, '#aqs_quick_panel', size.width, size.height);
        await page.locator('#aqs_url').fill('https://draft.invalid/v1');
        await page.evaluate(() => {
            for (const selector of ['#extensions_settings2', '#extensionsMenu', '#rm_api_block']) {
                const host = document.querySelector(selector);
                host.replaceWith(host.cloneNode(false));
            }
        });
        await page.locator('#aqs_url').waitFor(timeout);
        assert.equal(await page.locator('#aqs_url').inputValue(), 'https://draft.invalid/v1');
        assert.equal(await page.locator('#aqs_wand_btn').count(), 1);
        assert.equal(await page.locator('#aqs_api_embed').count(), 1);
        await activate(page.locator('#aqs_api_embed_toggle'));
        assert.equal(await page.locator('#aqs_embed_search').isVisible(), false);
        await activate(page.locator('#aqs_api_embed_toggle'));
        assert.equal(await page.locator('#aqs_embed_search').isVisible(), true);
    },
    async favoritesAndExport(page) {
        await activate(page.getByRole('button', { name: '收藏 Beta', exact: true }));
        assert.match(await page.locator('#aqs_api_embed_body .aqs-qp-item').first().innerText(), /Beta/);
        await activate(page.locator('#aqs_wand_btn'));
        assert.match(await page.locator('#aqs_quick_panel .aqs-qp-item').first().innerText(), /Beta/);
        await activate(page.getByRole('button', { name: '关闭快切' }));
        await page.evaluate(() => {
            const create = URL.createObjectURL;
            URL.createObjectURL = function (blob) {
                testState.exported = blob.text().then(JSON.parse);
                return create.call(URL, blob);
            };
        });
        await activate(page.getByRole('button', { name: '导出配置', exact: true }));
        const clean = await page.evaluate(() => testState.exported);
        assert.equal(clean.includesKeys, false);
        assert.ok(clean.profiles.every(p => !Object.hasOwn(p, 'key')));
        assert.equal(clean.profiles.find(p => p.name === 'Beta').favorite, true);
        const beta = clean.profiles.find(p => p.name === 'Beta');
        const input = page.locator('#aqs_import_file');
        await input.setInputFiles({ name: 'clean.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([beta])) });
        await wait(page, () => testState.lastToast?.message?.includes('更新 1'));
        assert.equal(await page.evaluate(() => testState.profiles.find(p => p.name === 'Beta').key), 'fixture-beta');
        const accept = page.waitForEvent('dialog').then(dialog => dialog.accept());
        await activate(page.getByRole('button', { name: '完整备份', exact: true }));
        await accept;
        const full = await page.evaluate(() => testState.exported);
        assert.equal(full.includesKeys, true);
        assert.equal(full.profiles.find(p => p.name === 'Beta').key, 'fixture-beta');
    },
    async nativeSync(page) {
        await switchAndWait(page, 'Alpha', 1);
        const key = page.locator('#api_key_custom');
        for (const value of ['fixture-key-1', 'fixture-key-2']) {
            await key.fill(value);
            await activate(page.locator('#api_button_openai'));
            await wait(page, input => testState.profiles.find(p => p.name === 'Alpha').key === input, value);
        }
        assert.equal(await page.evaluate(() => testState.profiles.length), 3);
    },
};

async function main() {
    const rounds = Number(process.env.AQS_ROUNDS || 126);
    const selected = process.env.AQS_SCENARIO;
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const devices = [
        { name: 'Pad 5 portrait', size: { width: 800, height: 1280 }, touch: true, scale: 2 },
        { name: 'Pad 5 landscape', size: { width: 1280, height: 800 }, touch: true, scale: 2 },
        { name: 'Pad 5 portrait', size: { width: 800, height: 1280 }, touch: true, scale: 2 },
        { name: 'Pad 5 landscape', size: { width: 1280, height: 800 }, touch: true, scale: 2 },
        { name: 'Android phone', size: { width: 390, height: 844 }, touch: true, scale: 2 },
        { name: 'Desktop', size: { width: 1440, height: 900 }, touch: false, scale: 1 },
    ];
    const themes = [
        { name: 'Light', text: 'rgb(26, 30, 37)', background: 'rgb(250, 249, 247)', accent: '#1e528c' },
        { name: 'Dark', text: 'rgb(231, 235, 239)', background: 'rgb(31, 36, 46)', accent: '#91bdff' },
        { name: 'OLED', text: 'rgb(234, 237, 242)', background: 'rgb(0, 0, 0)', accent: '#99cfaf' },
    ];
    const entries = Object.entries(scenarios).filter(([name]) => !selected || selected === name);
    const totals = {};
    try {
        for (let i = 0; i < rounds; i++) {
            const [name, scenario] = entries[Math.floor(i / devices.length) % entries.length];
            const device = devices[i % devices.length];
            const size = device.size;
            const theme = themes[Math.floor(i / (devices.length * entries.length)) % themes.length];
            const context = await browser.newContext({ viewport: size, hasTouch: device.touch, isMobile: device.touch, deviceScaleFactor: device.scale });
            const errors = [];
            try {
                await context.route('http://fixture.invalid/**', route => {
                    const url = new URL(route.request().url());
                    if (url.pathname === '/script.js') return route.fulfill({ contentType: 'text/javascript', body: `export async function withConnectionValidationSuspended(_, callback) { testState.suspended++; try { return await callback(); } finally { testState.suspended--; } }` });
                    return route.fulfill({ contentType: 'text/html', body: fixture });
                });
                const page = await context.newPage();
                page.on('pageerror', (error) => errors.push(error.message));
                await setup(page);
                await page.evaluate(({ text, background, accent }) => {
                    document.documentElement.style.setProperty('--SmartThemeBodyColor', text);
                    document.documentElement.style.setProperty('--SmartThemeBlurTintColor', background);
                    document.documentElement.style.setProperty('--SmartThemeFastUIBGColor', background);
                    document.documentElement.style.setProperty('--SmartThemeQuoteColor', accent);
                }, theme);
                assert.equal(await page.locator('#aqs_api_embed .aqs-qp-item').first().evaluate(el => getComputedStyle(el).color), theme.text);
                const alternate = device.touch ? { width: size.height, height: size.width } : { width: 1024, height: 768 };
                await scenario(page, size, alternate, device.touch);
                totals[theme.name] = (totals[theme.name] || 0) + 1;
                totals[device.name] = (totals[device.name] || 0) + 1;
                assert.deepEqual(errors, []);
                totals[name] = (totals[name] || 0) + 1;
                if ((i + 1) % 12 === 0 || i + 1 === rounds) console.log(`PASS ${i + 1}/${rounds}`);
            } catch (error) {
                console.error(`FAIL ${i + 1}/${rounds}: ${name} ${size.width}×${size.height}`);
                throw error;
            } finally { await context.close(); }
        }
        console.log(JSON.stringify(totals));
    } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
