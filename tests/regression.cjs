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
    await page.addStyleTag({ path: process.env.AQS_BASELINE_CSS || path.join(root, 'style.css') });
    await page.evaluate((profiles) => {
        const $ = window.$;
        const state = window.testState = {
            profiles, connects: [], lookup: [], requests: [], nextId: 0, suspended: 0,
            secrets: [{ id: 'native', value: 'native-test', label: '我的 API 快切备用', active: true }],
        };
        window.__TAURITAVERN__ = {};
        const bus = new EventTarget();
        const eventSource = { on: (name, fn) => bus.addEventListener(name, e => fn(e.detail)), emit: (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail })) };
        window.SillyTavern = { getContext: () => ({ eventSource, eventTypes: { SECRET_WRITTEN: 'secret_written' }, extensionSettings: { st_api_switcher: state }, saveSettingsDebounced() {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }) };
        window.toastr = new Proxy({}, { get: (_, level) => (message) => { state.lastToast = { level, message }; } });
        const source = $('<select id="chat_completion_source"><option value="openai">OpenAI</option><option value="custom_openai_responses">Responses</option><option value="custom">Custom</option></select>');
        const controls = $('<div><input id="custom_api_url_text"><input id="custom_model_id"><input id="api_key_custom" type="password"></div>');
        const button = $('<button id="api_button_openai">Connect</button>');
        const connect = function (event) {
            event.stopPropagation();
            if (state.suspended) return;
            const key = String($('#api_key_custom').val() ?? '');
            if (key) {
                state.completeNativeWrite = () => {
                    $('#api_key_custom').val('').trigger('input');
                    eventSource.emit('secret_written', 'api_key_custom');
                };
                if (!state.holdNativeWrite) queueMicrotask(state.completeNativeWrite);
            }
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
            if (url.endsWith('/secrets/read')) {
                if (state.delaySecretRead) await new Promise(resolve => { state.secretReadPending = resolve; });
                return json({ api_key_custom: state.secrets });
            }
            if (url.endsWith('/secrets/write')) {
                if (state.failWrite) return json({ error: true }, 503);
                for (const entry of state.secrets) entry.active = false;
                const id = 'fixture-' + ++state.nextId;
                state.secrets.push({ id, value: body.value, label: body.label, active: true });
                return json({ id });
            }
            if (url.endsWith('/secrets/rotate')) {
                if (!state.secrets.some(item => item.id === body.id)) return json({ error: true }, 404);
                for (const item of state.secrets) item.active = item.id === body.id;
                return json({ ok: true });
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
                if (state.nativeModels?.[body.custom_url]) return json({ data: state.nativeModels[body.custom_url].map(id => ({ id })) });
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
        await page.evaluate(() => { testState.holdNativeWrite = true; });
        await key.fill('fixture-key-1');
        await activate(page.locator('#api_button_openai'));
        assert.equal(await page.evaluate(() => testState.profiles.find(p => p.name === 'Alpha').key), 'fixture-alpha');
        await page.evaluate(() => testState.completeNativeWrite());
        await wait(page, () => testState.profiles.find(p => p.name === 'Alpha').key === 'fixture-key-1');
        await page.evaluate(() => { testState.holdNativeWrite = false; });
        await page.evaluate(() => { testState.nativeModels = { 'https://blank.invalid/v1': ['new-model'] }; });
        await page.locator('#custom_api_url_text').fill('https://blank.invalid/v1');
        await page.locator('#custom_model_id').fill('model-a');
        await key.fill('fixture-new-domain');
        await activate(page.locator('#api_button_openai'));
        await page.getByText(/本站没有所填模型/).waitFor(timeout);
        assert.deepEqual(await page.evaluate(() => {
            const p = testState.profiles.find(p => p.name === 'blank.invalid');
            return [p.key, p.models, p.model];
        }), ['fixture-new-domain', [], '']);
        await switchAndWait(page, 'Beta', 4);
        await switchAndWait(page, 'blank.invalid', 5);
        assert.equal(await page.evaluate(() => testState.connects.at(-1).key), 'fixture-new-domain');
        await page.locator('#custom_api_url_text').fill('https://bound.invalid/v1');
        await page.locator('#custom_model_id').fill('bound-model');
        await page.evaluate(() => {
            testState.nativeModels['https://bound.invalid/v1'] = ['bound-model'];
        });
        await activate(page.locator('#api_button_openai'));
        await wait(page, () => testState.profiles.find(p => p.name === 'bound.invalid')?.needsKey === true);
        assert.equal(await page.evaluate(() => testState.lookup.some(x => x.custom_url === 'https://bound.invalid/v1')), false);
        await page.evaluate(() => {
            testState.secrets.find(entry => entry.id === 'native').active = false;
        });
        await activate(page.locator('#aqs_bind_native_key'));
        assert.equal(await page.locator('#aqs_native_key_target').innerText(), 'https://bound.invalid/v1');
        assert.equal(await page.locator('#aqs_native_key_select option').count(), 2);
        assert.equal(await page.locator('#aqs_native_key_apply').isDisabled(), true);
        await page.locator('#aqs_native_key_select').selectOption('native');
        await activate(page.locator('#aqs_native_key_apply'));
        await page.locator('#aqs_native_key_picker').waitFor({ state: 'hidden', ...timeout });
        await wait(page, () => testState.profiles.find(p => p.name === 'bound.invalid')?.model === 'bound-model');
        const bound = await page.evaluate(() => testState.profiles.find(p => p.name === 'bound.invalid'));
        assert.equal(bound.nativeKeyId, 'native');
        assert.equal(bound.key, '');
        await page.locator('#aqs_embed_search input').fill('Beta');
        await switchAndWait(page, 'Beta', 7);
        await page.locator('#aqs_embed_search input').fill('bound.invalid');
        await switchAndWait(page, 'bound.invalid', 8);
        assert.equal(await page.evaluate(() => testState.connects.at(-1).key), 'native-test');
        await page.locator('#aqs_auto_sync_native').uncheck();
        await page.locator('#custom_api_url_text').fill('https://disabled.invalid/v1');
        await key.fill('fixture-key-disabled');
        await activate(page.locator('#api_button_openai'));
        assert.equal(await page.evaluate(() => testState.profiles.some(p => p.name === 'disabled.invalid')), false);
    },
    async newSite(page) {
        await switchAndWait(page, 'Alpha', 1);
        await activate(page.locator('#aqs_fill_current'));
        assert.equal(await page.locator('#aqs_url').inputValue(), initial[0].url);
        assert.equal(await page.locator('#aqs_model').inputValue(), initial[0].model);
        assert.equal(await page.locator('#aqs_key').inputValue(), '');
        await page.locator('#aqs_url').fill('https://new.invalid/v1/chat/completions');
        await page.locator('#aqs_key').fill('fixture-new');
        await activate(page.locator('#aqs_key_toggle'));
        assert.equal(await page.locator('#aqs_key').getAttribute('type'), 'text');
        await activate(page.locator('#aqs_save_use'));
        await wait(page, () => testState.connects.length === 2);
        assert.deepEqual(await page.evaluate(() => testState.connects[1]), { url: 'https://new.invalid/v1', key: 'fixture-new', model: 'model-a' });
        assert.equal(await page.locator('#aqs_key').getAttribute('type'), 'password');
        assert.equal(await page.evaluate(() => testState.profiles.find(p => p.url === 'https://new.invalid/v1').name), 'new.invalid');
    },
    async groupScroll(page) {
        const group = page.locator('#aqs_profile_list .aqs-group-head').first();
        const before = await group.evaluate(head => {
            const scroller = document.querySelector('#extensions_settings2');
            scroller.style.cssText = 'height:250px;overflow:auto';
            scroller.scrollTop = head.offsetTop - scroller.offsetTop - 35;
            return scroller.scrollTop;
        });
        assert.ok(before > 0);
        await activate(group);
        assert.equal(await group.getAttribute('aria-expanded'), 'false');
        await activate(group);
        assert.equal(await group.getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('#extensions_settings2').evaluate(el => el.scrollTop), before);
    },
    async locateAndTheme(page, size) {
        await switchAndWait(page, 'Alpha', 1);
        const bar = page.locator('#aqs_embed_search input');
        await bar.fill('Beta');
        assert.equal(await page.locator('#aqs_api_embed .aqs-active').count(), 0);
        await activate(page.locator('#aqs_api_embed_locate'));
        assert.equal(await bar.inputValue(), '');
        assert.match(await page.locator('#aqs_api_embed .aqs-active').innerText(), /Alpha/);
        await activate(page.locator('#aqs_api_embed_toggle'));
        await page.evaluate(() => { const host = document.querySelector('#rm_api_block'); host.replaceWith(host.cloneNode(false)); });
        await page.locator('#aqs_api_embed_toggle').waitFor(timeout);
        assert.equal(await page.locator('#aqs_api_embed_toggle').getAttribute('aria-expanded'), 'false');
        await activate(page.locator('#aqs_wand_btn'));
        await bounds(page, '#aqs_quick_panel', size.width, size.height);
        for (const palette of [
            { tint: 'rgba(97, 78, 64, 0.75)', text: 'rgb(240, 235, 230)', expected: [97, 78, 64] },
            { tint: 'rgb(245, 232, 222)', text: 'rgb(31, 26, 23)', expected: [245, 232, 222] },
            { tint: 'rgb(0, 0, 0)', text: 'rgb(223, 227, 233)', expected: [0, 0, 0] },
            { tint: 'rgba(255, 255, 255, 0.1)', text: 'rgb(223, 227, 233)' },
            { tint: 'transparent', text: 'rgb(223, 227, 233)' },
            { tint: '', text: 'rgb(223, 227, 233)' },
        ]) {
            // TT themes may scope variables to the body/drawer, while the wand floats outside body.
            await page.evaluate(({ tint, text }) => {
                document.documentElement.style.setProperty('--SmartThemeBlurTintColor', 'white');
                document.documentElement.style.setProperty('--SmartThemeBodyColor', '#e7ebef');
                const drawer = document.getElementById('rm_api_block');
                drawer.style.backgroundColor = tint;
                drawer.style.setProperty('--SmartThemeBlurTintColor', tint || 'transparent');
                drawer.style.setProperty('--SmartThemeBodyColor', text);
            }, palette);
            const appearance = await page.locator('#aqs_quick_panel').evaluate(el => {
                const canvas = document.createElement('canvas').getContext('2d');
                const rgba = value => {
                    canvas.clearRect(0, 0, 1, 1);
                    canvas.fillStyle = value;
                    canvas.fillRect(0, 0, 1, 1);
                    return [...canvas.getImageData(0, 0, 1, 1).data];
                };
                const luminance = c => c.slice(0, 3).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4)
                    .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
                const ratio = (a, b) => {
                    const l = [luminance(a), luminance(b)].sort((x, y) => x - y);
                    return (l[1] + .05) / (l[0] + .05);
                };
                const style = getComputedStyle(el);
                const bg = rgba(style.backgroundColor);
                const input = el.querySelector('input');
                return {
                    bg, image: style.backgroundImage, blur: style.backdropFilter,
                    title: ratio(bg, rgba(getComputedStyle(el.querySelector('.aqs-qp-title-text')).color)),
                    model: ratio(bg, rgba(getComputedStyle(el.querySelector('.aqs-qp-model')).color)),
                    search: ratio(rgba(getComputedStyle(input).backgroundColor), rgba(getComputedStyle(input, '::placeholder').color)),
                };
            });
            if (palette.expected) assert.ok(palette.expected.every((v, i) => Math.abs(v - appearance.bg[i]) <= 1));
            assert.equal(appearance.bg[3], 255);
            assert.equal(appearance.image, 'none');
            assert.equal(appearance.blur, 'none');
            assert.ok(appearance.title >= 4.5 && appearance.model >= 4.5 && appearance.search >= 4.5, JSON.stringify(appearance));
        }
    },
};

async function main() {
    const rounds = Number(process.env.AQS_ROUNDS || 180);
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
