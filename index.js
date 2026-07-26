/**
 * ST API Switcher · API 快切
 * 一键切换 OpenAI 兼容接口的 URL + API Key + 模型
 * License: MIT
 */
(() => {
    'use strict';

    const MODULE = 'st_api_switcher';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function getCtx() {
        try {
            return SillyTavern.getContext();
        } catch {
            return null;
        }
    }

    jQuery(async () => {
        const ctx = getCtx();
        if (!ctx) {
            console.error('[API快切] 无法获取 SillyTavern context，扩展未加载（酒馆版本过旧？）');
            return;
        }

        /* ---------------- 设置存取 ---------------- */
        if (!ctx.extensionSettings[MODULE] || !Array.isArray(ctx.extensionSettings[MODULE].profiles)) {
            ctx.extensionSettings[MODULE] = { profiles: [] };
        }
        const settings = ctx.extensionSettings[MODULE];
        const save = () => ctx.saveSettingsDebounced();
        const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        settings.profiles.forEach((p) => { if (!p.id) p.id = uid(); });

        let editingId = null;

        /* ---------------- 工具 ---------------- */
        const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
        const currentUrl = () => normUrl($('#custom_api_url_text').val());
        const isActive = (p) => !!currentUrl() && currentUrl() === normUrl(p.url);

        /* ---------------- 核心：应用配置 ---------------- */
        async function applyProfile(p) {
            try {
                if (!$('#custom_api_url_text').length) {
                    throw new Error('未找到自定义接口输入框，请确认酒馆版本（需 1.12+）');
                }
                const res = await fetch('/api/secrets/write', {
                    method: 'POST',
                    headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ key: 'api_key_custom', value: p.key || '' }),
                });
                if (!res.ok) throw new Error('写入密钥失败: HTTP ' + res.status);

                $('#main_api').val('openai').trigger('change');
                $('#chat_completion_source').val('custom').trigger('change');
                await sleep(150);

                $('#custom_api_url_text').val(p.url || '').trigger('input');
                if (p.model) $('#custom_model_id').val(p.model).trigger('input');
                await sleep(150);

                $('#api_button_openai').trigger('click');

                toastr.success('已切换到「' + p.name + '」', 'API 快切');
                renderAll();
            } catch (err) {
                console.error('[API快切]', err);
                toastr.error(String(err && err.message || err), 'API 快切失败');
            }
        }

        /* ---------------- 设置面板：配置卡片 ---------------- */
        function profileCard(p) {
            const active = isActive(p);
            const card = $('<div class="aqs-card"></div>').toggleClass('aqs-active', active);

            const head = $('<div class="aqs-card-head"></div>');
            $('<span class="aqs-card-name"></span>').text(p.name).appendTo(head);
            if (active) $('<span class="aqs-badge">当前</span>').appendTo(head);
            card.append(head);

            $('<div class="aqs-card-url"></div>').text(p.url).appendTo(card);

            const meta = $('<div class="aqs-card-meta"></div>');
            if (p.model) $('<span class="aqs-chip"></span>').text(p.model).appendTo(meta);
            $('<span class="aqs-chip aqs-chip-dim"></span>').text(p.key ? 'Key ✓' : '无 Key').appendTo(meta);
            card.append(meta);

            const btns = $('<div class="aqs-card-btns"></div>');
            $('<button class="menu_button aqs-btn" title="切换到此配置"><i class="fa-solid fa-plug"></i> 使用</button>')
                .on('click', () => applyProfile(p)).appendTo(btns);
            $('<button class="menu_button aqs-btn" title="编辑"><i class="fa-solid fa-pen"></i></button>')
                .on('click', () => startEdit(p)).appendTo(btns);
            $('<button class="menu_button aqs-btn aqs-danger" title="删除"><i class="fa-solid fa-trash"></i></button>')
                .on('click', () => {
                    if (!confirm('确定删除「' + p.name + '」？')) return;
                    settings.profiles = settings.profiles.filter((x) => x.id !== p.id);
                    if (editingId === p.id) resetForm();
                    save();
                    renderAll();
                }).appendTo(btns);
            card.append(btns);

            return card;
        }

        function renderList() {
            const list = $('#aqs_profile_list').empty();
            if (!settings.profiles.length) {
                list.append($('<div class="aqs-empty">还没有配置，在下方添加第一个吧</div>'));
                return;
            }
            settings.profiles.forEach((p) => list.append(profileCard(p)));
        }

        function renderAll() {
            renderList();
            if ($('#aqs_quick_panel').is(':visible')) renderQuickPanel();
        }

        /* ---------------- 表单 ---------------- */
        function startEdit(p) {
            editingId = p.id;
            $('#aqs_name').val(p.name);
            $('#aqs_url').val(p.url);
            $('#aqs_key').val(p.key || '');
            $('#aqs_model').val(p.model || '');
            $('#aqs_form_title').text('编辑：' + p.name);
            $('#aqs_save').html('<i class="fa-solid fa-floppy-disk"></i> 保存修改');
            $('#aqs_cancel_edit').show();
        }

        function resetForm() {
            editingId = null;
            $('#aqs_name, #aqs_url, #aqs_key, #aqs_model').val('');
            $('#aqs_form_title').text('新增配置');
            $('#aqs_save').html('<i class="fa-solid fa-plus"></i> 保存配置');
            $('#aqs_cancel_edit').hide();
        }

        function onSave() {
            const name = String($('#aqs_name').val() || '').trim();
            const url = normUrl($('#aqs_url').val());
            const key = String($('#aqs_key').val() || '').trim();
            const model = String($('#aqs_model').val() || '').trim();

            if (!name || !url) { toastr.warning('名称和 URL 必填'); return; }
            if (!/^https?:\/\//i.test(url)) { toastr.warning('URL 需要以 http:// 或 https:// 开头'); return; }

            if (editingId) {
                const p = settings.profiles.find((x) => x.id === editingId);
                if (!p) { resetForm(); return; }
                const dup = settings.profiles.find((x) => x.name === name && x.id !== editingId);
                if (dup) { toastr.warning('已存在同名配置「' + name + '」'); return; }
                Object.assign(p, { name, url, key, model });
                toastr.success('已更新「' + name + '」');
            } else {
                const dup = settings.profiles.find((x) => x.name === name);
                if (dup) {
                    if (!confirm('已存在同名配置「' + name + '」，覆盖它吗？')) return;
                    Object.assign(dup, { url, key, model });
                    toastr.success('已覆盖「' + name + '」');
                } else {
                    settings.profiles.push({ id: uid(), name, url, key, model });
                    toastr.success('已保存「' + name + '」');
                }
            }
            save();
            resetForm();
            renderAll();
        }

        /* ---------------- 导入 / 导出 ---------------- */
        function exportProfiles() {
            if (!settings.profiles.length) { toastr.warning('没有可导出的配置'); return; }
            const data = JSON.stringify({ app: 'st-api-switcher', version: 1, profiles: settings.profiles }, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'st-api-switcher-backup.json';
            a.click();
            URL.revokeObjectURL(a.href);
            toastr.info('备份文件包含明文 Key，请妥善保管', '已导出');
        }

        function importProfiles(file) {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(String(reader.result));
                    const arr = Array.isArray(data) ? data : data.profiles;
                    if (!Array.isArray(arr)) throw new Error('文件格式不正确');
                    let added = 0, updated = 0;
                    for (const item of arr) {
                        if (!item || typeof item.name !== 'string' || typeof item.url !== 'string') continue;
                        const clean = {
                            name: item.name.trim(),
                            url: normUrl(item.url),
                            key: typeof item.key === 'string' ? item.key : '',
                            model: typeof item.model === 'string' ? item.model : '',
                        };
                        if (!clean.name || !clean.url) continue;
                        const dup = settings.profiles.find((x) => x.name === clean.name);
                        if (dup) { Object.assign(dup, clean); updated++; }
                        else { settings.profiles.push({ id: uid(), ...clean }); added++; }
                    }
                    save();
                    renderAll();
                    toastr.success(`新增 ${added} 个，更新 ${updated} 个`, '导入完成');
                } catch (err) {
                    toastr.error(String(err && err.message || err), '导入失败');
                }
            };
            reader.readAsText(file);
        }

        /* ---------------- 快捷面板（魔棒菜单） ---------------- */
        function renderQuickPanel() {
            const panel = $('#aqs_quick_panel').empty();
            $('<div class="aqs-qp-title"><i class="fa-solid fa-shuffle"></i> API 快切</div>').appendTo(panel);
            if (!settings.profiles.length) {
                $('<div class="aqs-empty">先去扩展设置里添加配置</div>').appendTo(panel);
                return;
            }
            for (const p of settings.profiles) {
                const item = $('<div class="aqs-qp-item"></div>').toggleClass('aqs-active', isActive(p));
                $('<span class="aqs-qp-name"></span>').text(p.name).appendTo(item);
                if (p.model) $('<span class="aqs-qp-model"></span>').text(p.model).appendTo(item);
                item.on('click', async () => {
                    $('#aqs_quick_panel').hide();
                    await applyProfile(p);
                });
                panel.append(item);
            }
        }

        function setupQuickPanel() {
            $('<div id="aqs_quick_panel"></div>').hide().appendTo('body');

            const menuItem = $(
                '<div id="aqs_wand_item" class="list-group-item flex-container flexGap5 interactable" tabindex="0">' +
                '<i class="fa-solid fa-shuffle"></i><span>API 快切</span></div>'
            );
            $('#extensionsMenu').append(menuItem);
            menuItem.on('click', () => {
                const panel = $('#aqs_quick_panel');
                if (panel.is(':visible')) { panel.hide(); return; }
                renderQuickPanel();
                panel.show();
            });

            $(document).on('pointerdown', (e) => {
                const panel = $('#aqs_quick_panel');
                if (!panel.is(':visible')) return;
                if ($(e.target).closest('#aqs_quick_panel, #aqs_wand_item').length) return;
                panel.hide();
            });
        }

        /* ---------------- 斜杠命令 /apiswitch ---------------- */
        function setupSlashCommand() {
            try {
                const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
                if (!SlashCommandParser || !SlashCommand) return;
                SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                    name: 'apiswitch',
                    aliases: ['aqs'],
                    helpString: '按名称切换已保存的 API 配置，例如 /apiswitch 中转A；不带参数列出全部配置名。',
                    unnamedArgumentList: SlashCommandArgument ? [SlashCommandArgument.fromProps({
                        description: '配置名称',
                        typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.STRING] : undefined,
                        isRequired: false,
                    })] : [],
                    callback: async (_args, value) => {
                        const name = String(value || '').trim();
                        if (!name) {
                            const names = settings.profiles.map((p) => p.name).join('、') || '（空）';
                            toastr.info(names, '已保存的配置');
                            return names;
                        }
                        const p = settings.profiles.find((x) => x.name === name);
                        if (!p) { toastr.warning('没有找到配置：' + name); return ''; }
                        await applyProfile(p);
                        return p.name;
                    },
                }));
            } catch (e) {
                console.warn('[API快切] 斜杠命令注册失败（不影响其他功能）', e);
            }
        }

        /* ---------------- 设置面板挂载 ---------------- */
        const html = `
        <div class="aqs-settings">
          <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b><i class="fa-solid fa-shuffle"></i>&nbsp;API 快切</b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
              <div id="aqs_profile_list"></div>
              <div class="aqs-io-btns">
                <button id="aqs_export" class="menu_button aqs-btn" title="导出全部配置为 JSON 备份"><i class="fa-solid fa-download"></i> 导出</button>
                <button id="aqs_import" class="menu_button aqs-btn" title="从 JSON 备份导入（同名覆盖）"><i class="fa-solid fa-upload"></i> 导入</button>
                <input type="file" id="aqs_import_file" accept=".json,application/json" hidden>
              </div>
              <hr class="aqs-hr">
              <div id="aqs_form_title" class="aqs-form-title">新增配置</div>
              <input id="aqs_name" class="text_pole" placeholder="配置名称（如：中转A）">
              <input id="aqs_url" class="text_pole" placeholder="接口地址 URL（如 https://xx.com/v1）">
              <input id="aqs_key" class="text_pole" type="password" placeholder="API 密钥 Key" autocomplete="off">
              <input id="aqs_model" class="text_pole" placeholder="模型 ID（可选，留空则不改）">
              <div class="aqs-form-btns">
                <button id="aqs_fill_current" class="menu_button aqs-btn" title="读取当前连接面板里的 URL 和模型（Key 无法读取，需手填）"><i class="fa-solid fa-rotate"></i> 读取当前</button>
                <button id="aqs_save" class="menu_button aqs-btn"><i class="fa-solid fa-plus"></i> 保存配置</button>
                <button id="aqs_cancel_edit" class="menu_button aqs-btn" style="display:none">取消编辑</button>
              </div>
              <small class="aqs-note">Key 明文存于本机 settings.json，仅建议个人设备使用。快捷入口：输入框旁魔棒菜单 → API 快切，或命令 /apiswitch 配置名</small>
            </div>
          </div>
        </div>`;

        const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
        container.append(html);

        $('#aqs_save').on('click', onSave);
        $('#aqs_cancel_edit').on('click', resetForm);
        $('#aqs_fill_current').on('click', () => {
            $('#aqs_url').val($('#custom_api_url_text').val());
            $('#aqs_model').val($('#custom_model_id').val());
            toastr.info('已填入当前 URL 和模型，Key 需手动填写');
        });
        $('#aqs_export').on('click', exportProfiles);
        $('#aqs_import').on('click', () => $('#aqs_import_file').trigger('click'));
        $('#aqs_import_file').on('change', function () {
            if (this.files && this.files[0]) importProfiles(this.files[0]);
            this.value = '';
        });

        let urlTimer = null;
        $(document).on('input', '#custom_api_url_text', () => {
            clearTimeout(urlTimer);
            urlTimer = setTimeout(renderAll, 500);
        });

        setupQuickPanel();
        setupSlashCommand();
        renderList();

        console.log('[API快切] 已加载');
    });
})();
