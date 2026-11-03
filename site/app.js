/* arXivScan static front-end.
 *
 * Everything is pre-fetched by GitHub Actions (see scripts/fetch_feeds.py): this page only
 * downloads data/<category>.json for the selected categories, merges them client-side
 * (deduplicating papers that appear in several categories) and renders the list.
 */
(function () {
    'use strict';

    // ------------------------------------------------------------------ constants
    const DEFAULT_PRESETS = [
        { label: 'ML & AI', cats: ['stat.ML', 'cs.LG', 'cs.AI'] },
        { label: 'math.OC', cats: ['math.OC'] },
        { label: 'Stats & Prob', cats: ['stat.TH', 'math.PR'] },
        { label: 'CV & GR', cats: ['cs.CV', 'cs.GR'] },
    ];
    const STORAGE = {
        theme: 'arxivscan-theme',
        presets: 'arxivscan-presets',
        cross: 'arxivscan-cross',
        last: 'arxivscan-last',
    };
    const CAT_RE = /^[a-z\-]+(\.[a-zA-Z\-]+)?$/i;
    const STALE_RUN_HOURS = 36;

    // ------------------------------------------------------------------ state
    const state = {
        cats: [],            // selected category codes, in display order
        cross: false,        // include cross-lists
        taxonomy: [],        // [{id, name, group, archive}]
        taxonomyById: new Map(),
        index: null,         // data/index.json
        papers: [],          // merged papers
        metas: [],           // per-selected-category payload metadata
        items: [],           // rendered DOM rows
        searchText: [],      // lowercase text of each row
        loadSeq: 0,
    };

    const $ = (id) => document.getElementById(id);
    const el = {
        batchDate: $('batchDate'), statusBadge: $('statusBadge'), actionsLink: $('actionsLink'),
        presetNav: $('presetNav'), pickerBtn: $('pickerBtn'), customForm: $('customCatForm'),
        customInput: $('customCatInput'), notice: $('notice'), filter: $('filterInput'),
        cross: $('crossToggle'), count: $('paperCount'), toggleAll: $('toggleAllBtn'),
        toggleAllVerb: $('toggleAllVerb'), list: $('papersList'), footerInfo: $('footerInfo'),
        repoLink: $('repoLink'), pickerModal: $('pickerModal'), pickerBody: $('pickerBody'),
        pickerSearch: $('pickerSearch'), pickerCount: $('pickerCount'), pickerClear: $('pickerClear'),
        pickerApply: $('pickerApply'), presetName: $('presetName'), savePreset: $('savePresetBtn'),
        helpModal: $('helpModal'), helpBtn: $('helpBtn'), themeToggle: $('themeToggle'),
    };

    // ------------------------------------------------------------------ helpers
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
    function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* ignore */ } }

    function normalizeCats(raw) {
        const parts = String(raw || '').split(/[\s+,;]+/).map((c) => c.trim()).filter(Boolean);
        const out = [];
        for (const p of parts) {
            if (!CAT_RE.test(p)) continue;
            // Canonical spelling from the taxonomy when available (case-insensitive match).
            const known = state.taxonomy.find((c) => c.id.toLowerCase() === p.toLowerCase());
            const id = known ? known.id : p;
            if (!out.includes(id)) out.push(id);
        }
        return out;
    }
    function sameSet(a, b) {
        if (a.length !== b.length) return false;
        const s = new Set(a);
        return b.every((x) => s.has(x));
    }
    function catString(cats) { return cats.join('+'); }

    function abbreviateName(name) {
        // "Jane Doe (Some University)" -> drop the affiliation on mobile
        const parts = name.replace(/\s*\([^)]*\)\s*$/, '').trim().split(/\s+/);
        if (parts.length <= 1) return name.trim();
        const initials = parts.slice(0, -1).map((p) =>
            p.includes('-') ? p.split('-').filter(Boolean).map((sp) => sp[0] + '.').join('-') : p[0] + '.');
        return initials.concat(parts[parts.length - 1]).join(' ');
    }
    function formatDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso + 'T12:00:00Z');
        if (isNaN(d)) return iso;
        return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    }
    function timeAgo(iso) {
        const t = Date.parse(iso);
        if (isNaN(t)) return { text: 'unknown', hours: Infinity };
        const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
        const hours = mins / 60;
        let text;
        if (mins < 60) text = mins + 'm ago';
        else if (hours < 48) text = Math.round(hours) + 'h ago';
        else text = Math.round(hours / 24) + 'd ago';
        return { text, hours };
    }

    // ------------------------------------------------------------------ URL state
    function readUrl() {
        const params = new URLSearchParams(location.search);
        const cats = normalizeCats(params.get('cat'));
        const crossParam = params.get('cross');
        const cross = crossParam != null ? crossParam === '1' : storageGet(STORAGE.cross) === '1';
        return { cats, cross };
    }
    function writeUrl(push) {
        const q = '?cat=' + state.cats.map(encodeURIComponent).join('+') + (state.cross ? '&cross=1' : '');
        const url = location.pathname + q;
        if (url === location.pathname + location.search) return;
        if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
    }

    // ------------------------------------------------------------------ presets
    function customPresets() {
        try {
            const arr = JSON.parse(storageGet(STORAGE.presets) || '[]');
            return Array.isArray(arr) ? arr.filter((p) => p && Array.isArray(p.cats) && p.cats.length) : [];
        } catch (e) { return []; }
    }
    function saveCustomPresets(list) { storageSet(STORAGE.presets, JSON.stringify(list)); }

    function renderPresets() {
        el.presetNav.querySelectorAll('.cat-btn:not(.cat-btn-picker)').forEach((b) => b.remove());
        const all = DEFAULT_PRESETS.map((p) => ({ ...p, custom: false }))
            .concat(customPresets().map((p) => ({ ...p, custom: true })));
        let matched = false;
        const frag = document.createDocumentFragment();
        for (const p of all) {
            const active = sameSet(p.cats, state.cats);
            matched = matched || active;
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'cat-btn' + (active ? ' active' : '');
            b.title = p.cats.join(' + ');
            b.textContent = p.label || p.cats.join('+');
            b.addEventListener('click', () => selectCats(p.cats, true));
            if (p.custom) {
                const x = document.createElement('span');
                x.className = 'preset-remove';
                x.textContent = '×';
                x.title = 'Remove this preset';
                x.addEventListener('click', (e) => {
                    e.stopPropagation();
                    saveCustomPresets(customPresets().filter((q) => !(q.label === p.label && sameSet(q.cats, p.cats))));
                    renderPresets();
                });
                b.appendChild(x);
            }
            frag.appendChild(b);
        }
        if (!matched && state.cats.length) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'cat-btn active';
            b.title = 'Current selection (not saved as a preset)';
            b.textContent = state.cats.join(' + ');
            b.addEventListener('click', openPicker);
            frag.appendChild(b);
        }
        el.presetNav.insertBefore(frag, el.pickerBtn);
    }

    // ------------------------------------------------------------------ category picker
    function buildPicker() {
        const groups = [];
        const byGroup = new Map();
        for (const c of state.taxonomy) {
            if (!byGroup.has(c.group)) { byGroup.set(c.group, []); groups.push(c.group); }
            byGroup.get(c.group).push(c);
        }
        let html = '';
        for (const g of groups) {
            const cats = byGroup.get(g).slice().sort((a, b) => a.id.localeCompare(b.id));
            html += `<div class="picker-group" data-group="${esc(g)}">
                <div class="picker-group-title"><span>${esc(g)}</span>
                    <button type="button" data-group-all="${esc(g)}">all</button>
                    <button type="button" data-group-none="${esc(g)}">none</button></div>
                <div class="picker-grid">`;
            for (const c of cats) {
                const meta = state.index && state.index.categories[c.id];
                const n = meta ? meta.count_new : '';
                html += `<label class="picker-item" data-search="${esc((c.id + ' ' + c.name + ' ' + g).toLowerCase())}" title="${esc(c.name)}">
                    <input type="checkbox" value="${esc(c.id)}"><code>${esc(c.id)}</code><span>${esc(c.name)}</span>
                    <span class="count" title="new submissions in the current batch">${esc(n)}</span></label>`;
            }
            html += '</div></div>';
        }
        el.pickerBody.innerHTML = html;
        el.pickerBody.addEventListener('change', updatePickerCount);
        el.pickerBody.addEventListener('click', (e) => {
            const all = e.target.getAttribute('data-group-all');
            const none = e.target.getAttribute('data-group-none');
            if (all == null && none == null) return;
            const group = el.pickerBody.querySelector(`.picker-group[data-group="${CSS.escape(all != null ? all : none)}"]`);
            group.querySelectorAll('.picker-item:not([hidden]) input').forEach((i) => { i.checked = all != null; });
            updatePickerCount();
        });
    }
    function pickerChecked() {
        return Array.from(el.pickerBody.querySelectorAll('input:checked')).map((i) => i.value);
    }
    function updatePickerCount() {
        const n = pickerChecked().length;
        el.pickerCount.textContent = n ? `(${n} selected)` : '';
        el.pickerApply.disabled = n === 0;
    }
    function openPicker() {
        const sel = new Set(state.cats);
        el.pickerBody.querySelectorAll('input').forEach((i) => { i.checked = sel.has(i.value); });
        el.pickerSearch.value = '';
        filterPicker('');
        updatePickerCount();
        el.pickerModal.classList.add('visible');
        if (!window.matchMedia('(max-width: 640px)').matches) el.pickerSearch.focus();
    }
    function filterPicker(q) {
        q = q.trim().toLowerCase();
        el.pickerBody.querySelectorAll('.picker-group').forEach((g) => {
            let any = false;
            g.querySelectorAll('.picker-item').forEach((it) => {
                const show = !q || it.getAttribute('data-search').includes(q);
                it.hidden = !show;
                any = any || show;
            });
            g.hidden = !any;
        });
    }
    function closeModal(m) { m.classList.remove('visible'); }

    // ------------------------------------------------------------------ data loading
    async function fetchJson(url) {
        const r = await fetch(url, { cache: 'default' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }

    function selectCats(cats, push) {
        cats = normalizeCats(cats.join('+'));
        if (!cats.length) return;
        state.cats = cats;
        storageSet(STORAGE.last, catString(cats));
        writeUrl(push);
        renderPresets();
        el.customInput.value = '';
        el.customInput.blur();
        loadPapers();
    }

    async function loadPapers() {
        const seq = ++state.loadSeq;
        el.list.innerHTML = '<div class="empty-state">Loading…</div>';
        setStatus('loading', '');
        const results = await Promise.allSettled(state.cats.map((c) => fetchJson('data/' + encodeURIComponent(c) + '.json')));
        if (seq !== state.loadSeq) return; // a newer selection superseded this load

        const byId = new Map();
        const metas = [];
        const problems = [];
        results.forEach((r, i) => {
            const cat = state.cats[i];
            if (r.status !== 'fulfilled') {
                const known = state.taxonomyById.has(cat);
                problems.push({ cat, msg: known ? 'could not load its data (' + r.reason.message + ')' : 'is not an arXiv category' });
                metas.push({ category: cat, missing: true });
                return;
            }
            const data = r.value;
            metas.push(data);
            if (data.stale) problems.push({ cat, msg: 'is stale: ' + (data.stale_reason || 'last fetch failed'), stale: true });
            for (const p of data.papers || []) {
                let e = byId.get(p.id);
                if (!e) { e = Object.assign({}, p, { in: [] }); byId.set(p.id, e); }
                else if (p.type === 'new' && e.type !== 'new') e.type = 'new';
                e.in.push(cat);
            }
        });
        const papers = Array.from(byId.values());
        papers.sort((a, b) => (a.type === b.type ? a.id.localeCompare(b.id) : a.type === 'new' ? -1 : 1));
        state.papers = papers;
        state.metas = metas;
        renderHeader(problems);
        renderList();
    }

    // ------------------------------------------------------------------ header / status
    function setStatus(cls, text, title) {
        el.statusBadge.className = 'badge-status' + (cls ? ' ' + cls : '');
        el.statusBadge.textContent = text;
        el.statusBadge.title = title || '';
    }
    function renderHeader(problems) {
        const dates = Array.from(new Set(state.metas.map((m) => m.announced).filter(Boolean))).sort().reverse();
        el.batchDate.textContent = dates.length === 0 ? '—' : dates.length === 1 ? formatDate(dates[0]) : 'mixed (' + dates.join(', ') + ')';

        const idx = state.index;
        const ago = idx ? timeAgo(idx.generated_at) : { text: 'unknown', hours: Infinity };
        const anyStale = problems.some((p) => p.stale);
        const anyMissing = state.metas.some((m) => m.missing);
        if (anyMissing && state.metas.every((m) => m.missing)) setStatus('error', 'no data', 'No category could be loaded');
        else if (anyStale || anyMissing) setStatus('warning', 'Updated ' + ago.text + ' · issues', 'Some categories are stale or missing, see the notice');
        else if (ago.hours > STALE_RUN_HOURS) setStatus('warning', 'Updated ' + ago.text, 'The fetch workflow has not run successfully for a while');
        else setStatus('', 'Updated ' + ago.text, idx ? 'Data fetched at ' + idx.generated_at : '');

        if (problems.length) {
            const runLink = idx && idx.run_url ? ` <a href="${esc(idx.run_url)}" target="_blank" rel="noopener">last run</a>` : '';
            const actions = el.actionsLink.href && el.actionsLink.href !== '#'
                ? ` <a href="${esc(el.actionsLink.href)}" target="_blank" rel="noopener">Actions tab</a>` : '';
            el.notice.innerHTML = `<strong>Notice:</strong> some categories have problems. Check the${runLink || ' workflow'}${actions ? ' or the' + actions : ''}; re-running the workflow usually fixes it (see README).<ul>` +
                problems.map((p) => `<li><code>${esc(p.cat)}</code> ${esc(p.msg)}</li>`).join('') + '</ul>';
            el.notice.className = 'alert' + (anyMissing && !anyStale ? ' error' : '');
            el.notice.hidden = false;
        } else {
            el.notice.hidden = true;
        }
    }

    // ------------------------------------------------------------------ list rendering
    const COPY_SVG = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    const CHECK_SVG = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>';

    function authorLink(name, label) {
        return `<a href="https://arxiv.org/search/?searchtype=author&query=${encodeURIComponent(name)}" class="author-link" target="_blank" rel="noopener">${esc(label)}</a>`;
    }

    function renderList() {
        const papers = state.papers;
        if (!papers.length) {
            const why = state.metas.every((m) => m.missing)
                ? 'No data could be loaded for <strong>' + esc(state.cats.join(' + ')) + '</strong>. If the site was just set up, the fetch workflow may not have published anything yet.'
                : 'No new submissions were found for <strong>' + esc(state.cats.join(' + ')) + '</strong> in this batch.';
            el.list.innerHTML = `<div class="empty-state"><h3>No entries</h3><p>${why}</p></div>`;
            state.items = [];
            state.searchText = [];
            el.count.textContent = '0';
            return;
        }
        const parts = [];
        papers.forEach((p, i) => {
            const absUrl = 'https://arxiv.org/abs/' + p.id;
            const pdfUrl = 'https://arxiv.org/pdf/' + p.id;
            const htmlUrl = 'https://arxiv.org/html/' + p.id;
            const authorStr = p.authors.join(', ');
            const md = `[${p.id}: ${p.title}](${absUrl}) by ${authorStr}`;
            const mobileId = p.id.includes('.') ? '.' + p.id.split('.').slice(1).join('.') : p.id;
            const subjects = (p.cats || []).join(', ');
            const typePill = p.type === 'cross' ? '<span class="type-pill" title="cross-listed: primary category is ' + esc((p.cats || [])[0] || '?') + '">cross</span>' : '';
            parts.push(`<div class="paper-item" data-type="${esc(p.type)}" data-abs="${esc(absUrl)}" data-pdf="${esc(pdfUrl)}" data-html="${esc(htmlUrl)}" data-abs-id="abs-${i}">
    <div class="line-1">
        <button type="button" class="copy-btn" data-md="${esc(md)}" title="Copy markdown citation (y)">${COPY_SVG}</button>
        <span class="entry-links desktop-links">
            <a href="${esc(absUrl)}" class="paper-id" target="_blank" rel="noopener">${esc(p.id)}</a>
            <a href="${esc(pdfUrl)}" class="link-pill" target="_blank" rel="noopener">pdf</a>
            <a href="${esc(htmlUrl)}" class="link-pill" target="_blank" rel="noopener">html</a>
        </span>${typePill}
        <span class="paper-title" title="Click to preview abstract">${esc(p.title)}</span>
    </div>
    <div class="line-2">
        <span class="paper-authors desktop-authors" title="${esc(authorStr)}">${p.authors.map((a) => authorLink(a, a)).join(', ')}</span>
        <span class="paper-authors mobile-authors" title="${esc(authorStr)}">${p.authors.map((a) => authorLink(a, abbreviateName(a))).join(', ')}</span>
        ${subjects ? `<span class="meta-sep desktop-sep">•</span><span class="paper-subjects" title="${esc(subjects)}">${esc(subjects)}</span>` : ''}
        <span class="entry-links mobile-links">
            <a href="${esc(absUrl)}" class="paper-id" target="_blank" rel="noopener" title="${esc(p.id)}">${esc(mobileId)}</a>
            <a href="${esc(pdfUrl)}" class="link-pill" target="_blank" rel="noopener">pdf</a>
            <a href="${esc(htmlUrl)}" class="link-pill" target="_blank" rel="noopener">html</a>
        </span>
    </div>
    ${p.abstract ? `<div id="abs-${i}" class="paper-abstract">${esc(p.abstract)}</div>` : ''}
</div>`);
        });
        el.list.innerHTML = parts.join('');
        state.items = Array.from(el.list.querySelectorAll('.paper-item'));
        state.searchText = state.items.map((it) => it.textContent.toLowerCase());
        allExpanded = false;
        el.toggleAllVerb.textContent = 'Expand';
        applyFilters();
        renderMath(el.list, ['paper-abstract']);
    }

    function applyFilters() {
        const q = el.filter.value.toLowerCase().trim();
        let visible = 0;
        state.items.forEach((item, i) => {
            const show = (state.cross || item.dataset.type === 'new') && (!q || state.searchText[i].includes(q));
            item.hidden = !show;
            if (!show) item.classList.remove('selected');
            if (show) visible++;
        });
        el.count.textContent = String(visible);
    }

    // ------------------------------------------------------------------ KaTeX (lazy)
    let katexReady = typeof window.renderMathInElement === 'function';
    const pendingMath = [];
    window.addEventListener('katex-ready', () => {
        katexReady = true;
        while (pendingMath.length) { const [node, ignored] = pendingMath.shift(); renderMath(node, ignored); }
    });
    function renderMath(node, ignoredClasses) {
        if (!node) return;
        if (!katexReady) { pendingMath.push([node, ignoredClasses]); return; }
        try {
            window.renderMathInElement(node, {
                delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
                ignoredClasses: ignoredClasses || [],
                throwOnError: false,
            });
        } catch (e) { /* never break the page over math */ }
    }
    function renderAbstractMath(abs) {
        if (abs && !abs.dataset.mathRendered) {
            abs.dataset.mathRendered = '1';
            renderMath(abs, []);
        }
    }

    // ------------------------------------------------------------------ interactions
    function copyMarkdown(btn) {
        if (!btn) return;
        const md = btn.getAttribute('data-md');
        if (!md || !navigator.clipboard) return;
        navigator.clipboard.writeText(md).then(() => {
            btn.classList.add('copied');
            btn.innerHTML = CHECK_SVG;
            setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = COPY_SVG; }, 1200);
        });
    }
    function toggleAbstract(id) {
        const abs = document.getElementById(id);
        if (!abs) return;
        if (abs.classList.toggle('visible')) renderAbstractMath(abs);
    }
    let allExpanded = false;
    el.toggleAll.addEventListener('click', () => {
        allExpanded = !allExpanded;
        state.items.forEach((item) => {
            if (item.hidden) return;
            const abs = item.querySelector('.paper-abstract');
            if (!abs) return;
            abs.classList.toggle('visible', allExpanded);
            if (allExpanded) renderAbstractMath(abs);
        });
        el.toggleAllVerb.textContent = allExpanded ? 'Collapse' : 'Expand';
    });

    function visibleItems() { return state.items.filter((it) => !it.hidden); }
    function selectItem(target, scroll) {
        state.items.forEach((it) => it.classList.remove('selected'));
        if (target) {
            target.classList.add('selected');
            if (scroll) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }
    el.list.addEventListener('click', (e) => {
        const item = e.target.closest('.paper-item');
        if (!item) return;
        const copy = e.target.closest('.copy-btn');
        if (copy) { e.stopPropagation(); copyMarkdown(copy); return; }
        if (e.target.closest('.paper-title')) toggleAbstract(item.dataset.absId);
        selectItem(item, false);
    });

    el.filter.addEventListener('input', applyFilters);
    const mqMobile = window.matchMedia('(max-width: 640px)');
    function syncPlaceholder() {
        el.filter.placeholder = mqMobile.matches ? 'Filter papers…' : "Filter by keyword, title, author… ('/' to search, '?' for shortcuts)";
    }
    syncPlaceholder();
    if (mqMobile.addEventListener) mqMobile.addEventListener('change', syncPlaceholder);

    el.cross.addEventListener('change', () => {
        state.cross = el.cross.checked;
        storageSet(STORAGE.cross, state.cross ? '1' : '0');
        writeUrl(false);
        applyFilters();
    });

    el.customForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const cats = normalizeCats(el.customInput.value);
        if (cats.length) selectCats(cats, true);
    });
    el.pickerBtn.addEventListener('click', openPicker);
    el.pickerSearch.addEventListener('input', () => filterPicker(el.pickerSearch.value));
    el.pickerClear.addEventListener('click', () => { el.pickerBody.querySelectorAll('input').forEach((i) => { i.checked = false; }); updatePickerCount(); });
    el.pickerApply.addEventListener('click', () => {
        const cats = pickerChecked();
        if (!cats.length) return;
        closeModal(el.pickerModal);
        selectCats(cats, true);
    });
    el.savePreset.addEventListener('click', () => {
        const cats = pickerChecked();
        if (!cats.length) return;
        const label = el.presetName.value.trim() || cats.join('+');
        const list = customPresets().filter((p) => p.label !== label);
        list.push({ label, cats });
        saveCustomPresets(list);
        el.presetName.value = '';
        closeModal(el.pickerModal);
        selectCats(cats, true);
    });
    document.querySelectorAll('.modal-close').forEach((b) => b.addEventListener('click', () => closeModal($(b.dataset.close))));
    [el.pickerModal, el.helpModal].forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); }));
    el.helpBtn.addEventListener('click', () => el.helpModal.classList.toggle('visible'));

    // Theme toggle
    function currentTheme() {
        const explicit = document.documentElement.getAttribute('data-theme');
        if (explicit) return explicit;
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    el.themeToggle.addEventListener('click', () => {
        const next = currentTheme() === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        storageSet(STORAGE.theme, next);
    });

    // Vim-style keyboard navigation
    let gPrefix = false;
    let gTimer = null;
    function resetG() { gPrefix = false; if (gTimer) { clearTimeout(gTimer); gTimer = null; } }
    window.addEventListener('keydown', (e) => {
        const a = document.activeElement;
        const tag = a ? a.tagName : '';
        const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || (a && a.isContentEditable);
        if (inInput) {
            if (e.key === 'Escape' || (e.key === 'Enter' && a === el.filter)) a.blur();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        const modalOpen = el.helpModal.classList.contains('visible') || el.pickerModal.classList.contains('visible');
        if (e.key === 'Escape') {
            resetG();
            closeModal(el.helpModal);
            closeModal(el.pickerModal);
            return;
        }
        if (e.key === '?') { e.preventDefault(); resetG(); closeModal(el.pickerModal); el.helpModal.classList.toggle('visible'); return; }
        if (modalOpen) return;
        if (e.key === '/') { e.preventDefault(); resetG(); el.filter.focus(); el.filter.select(); return; }
        if (e.key === 'c') { e.preventDefault(); resetG(); openPicker(); return; }
        if (e.key === 'x') { e.preventDefault(); resetG(); el.cross.checked = !el.cross.checked; el.cross.dispatchEvent(new Event('change')); return; }

        const visible = visibleItems();
        if (!visible.length) return;
        const curIdx = visible.findIndex((it) => it.classList.contains('selected'));
        const current = curIdx >= 0 ? visible[curIdx] : visible[0];

        if (gPrefix) {
            resetG();
            if (curIdx < 0) selectItem(current, true);
            const target = { a: current.dataset.abs, h: current.dataset.html, p: current.dataset.pdf }[e.key];
            if (target) { e.preventDefault(); window.open(target, '_blank'); }
            return;
        }
        if (e.key === 'g') { e.preventDefault(); gPrefix = true; gTimer = setTimeout(resetG, 1000); return; }
        if (e.key === 'j') { e.preventDefault(); selectItem(visible[curIdx < 0 ? 0 : Math.min(curIdx + 1, visible.length - 1)], true); }
        else if (e.key === 'k') { e.preventDefault(); selectItem(visible[curIdx < 0 ? 0 : Math.max(curIdx - 1, 0)], true); }
        else if (e.key === 'Enter') { e.preventDefault(); if (curIdx < 0) selectItem(current, true); toggleAbstract(current.dataset.absId); }
        else if (e.key === 'y') { e.preventDefault(); if (curIdx < 0) selectItem(current, true); copyMarkdown(current.querySelector('.copy-btn')); }
    });

    window.addEventListener('popstate', () => {
        const u = readUrl();
        if (u.cats.length) {
            state.cats = u.cats;
            state.cross = u.cross;
            el.cross.checked = u.cross;
            renderPresets();
            loadPapers();
        }
    });

    // ------------------------------------------------------------------ boot
    async function boot() {
        const [tax, idx] = await Promise.allSettled([fetchJson('categories.json'), fetchJson('data/index.json')]);
        state.taxonomy = tax.status === 'fulfilled' ? tax.value.categories : [];
        state.taxonomy.forEach((c) => state.taxonomyById.set(c.id, c));
        state.index = idx.status === 'fulfilled' ? idx.value : null;

        const repoUrl = (state.index && state.index.repo_url) || el.repoLink.href;
        el.repoLink.href = repoUrl;
        el.actionsLink.href = repoUrl + '/actions';
        if (state.index) {
            const s = state.index.summary || {};
            el.footerInfo.innerHTML = `${esc(state.taxonomy.length)} categories, last fetch ${esc(state.index.generated_at)}` +
                (s.total ? ` (${esc(s.fresh)} fresh, ${esc(s.stale)} stale, ${esc(s.failed)} failed)` : '') +
                (state.index.run_url ? ` · <a href="${esc(state.index.run_url)}" target="_blank" rel="noopener">run log</a>` : '');
        }

        buildPicker();
        const u = readUrl();
        state.cross = u.cross;
        el.cross.checked = u.cross;
        let cats = u.cats;
        if (!cats.length) cats = normalizeCats(storageGet(STORAGE.last) || '');
        if (!cats.length) cats = DEFAULT_PRESETS[0].cats.slice();
        state.cats = cats;
        writeUrl(false);
        renderPresets();
        if (!state.index) {
            el.notice.className = 'alert error';
            el.notice.innerHTML = '<strong>No data published yet.</strong> The fetch workflow has not deployed anything to this site, or <code>data/index.json</code> is unreachable. Run the workflow from the Actions tab (see README).';
            el.notice.hidden = false;
        }
        loadPapers();
    }
    boot();
})();
