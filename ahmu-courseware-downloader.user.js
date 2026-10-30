// ==UserScript==
// @name         安医教学平台课件下载助手
// @namespace    ahmu-toolkit
// @version      2.1.3
// @description  安徽医科大学教学平台课件/视频下载：走接口直取，自动识别课程、会话与文件类型
// @match        *://*.ahmu.edu.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var API = 'https://lms.ahmu.edu.cn';
  var top = true;
  try { top = window.top === window.self; } catch (e) { top = false; }
  if (!top) return; // 预览用的子框架不需要面板

  // 同一页可能装了多个副本，只让版本号最大的那个生效
  var VER = 2.2;
  if ((window.__ahmuVer || 0) >= VER) return;
  window.__ahmuVer = VER;
  try {
    var stale = document.getElementById('ahmu-hd');
    if (stale) stale.remove();
  } catch (e) {}

  var session = null;
  var state = { items: [], filter: 'all', busy: false };

  // ---------- 会话：平台用 x-session-id 请求头，不是 Cookie ----------
  function keepSession(key, value) {
    if (session || !key || !value) return;
    if (/^x-session-id$/i.test(String(key))) session = String(value);
  }

  function scanHeaders(h) {
    if (!h) return;
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      try { keepSession('x-session-id', h.get('x-session-id')); } catch (e) {}
      return;
    }
    if (Array.isArray(h)) { h.forEach(function (p) { if (p) keepSession(p[0], p[1]); }); return; }
    if (typeof h === 'object') { Object.keys(h).forEach(function (k) { keepSession(k, h[k]); }); }
  }

  function hookTransport() {
    try {
      var xhr = XMLHttpRequest.prototype, set = xhr.setRequestHeader;
      xhr.setRequestHeader = function (k, v) { keepSession(k, v); return set.apply(this, arguments); };
    } catch (e) {}
    try {
      var original = window.fetch;
      window.fetch = function (input, init) {
        try {
          if (init && init.headers) scanHeaders(init.headers);
          else if (input && typeof input === 'object' && input.headers) scanHeaders(input.headers);
        } catch (e) {}
        return original.apply(this, arguments);
      };
    } catch (e) {}
  }

  // ---------- 请求 ----------
  function apiGet(path) {
    var headers = {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept-Language': 'zh-CN'
    };
    if (session) headers['x-session-id'] = session;
    return fetch(API + path, { credentials: 'omit', headers: headers }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---------- 定位课程 ----------
  function courseId() {
    var m = /\/course\/(\d+)(?:[/?#]|$)/.exec(location.href) ||
            /[?&#]course[_-]?id=(\d+)/i.exec(location.href);
    return m ? m[1] : null;
  }

  // ---------- 文件类型 ----------
  var KINDS = {
    pdf:   { label: 'PDF',  cls: 'k-pdf' },
    ppt:   { label: 'PPT',  cls: 'k-ppt' },
    doc:   { label: '文档', cls: 'k-doc' },
    excel: { label: '表格', cls: 'k-xls' },
    video: { label: '视频', cls: 'k-video' },
    audio: { label: '音频', cls: 'k-audio' },
    zip:   { label: '压缩包', cls: 'k-zip' },
    other: { label: '文件', cls: 'k-other' }
  };

  function kindOf(name, mime) {
    var ext = (name || '').split('.').pop().toLowerCase();
    if (!~['pdf', 'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls',
          'mp4', 'm4v', 'mov', 'mkv', 'flv', 'wmv', 'avi', 'webm',
          'mp3', 'm4a', 'wav', 'flac', 'aac',
          'zip', 'rar', '7z', 'tar', 'gz'].indexOf(ext)) {
      var m = (mime || '').toLowerCase();
      if (/video/.test(m)) return 'video';
      if (/audio/.test(m)) return 'audio';
      return 'other';
    }
    if (ext === 'pdf') return 'pdf';
    if (ext === 'pptx' || ext === 'ppt') return 'ppt';
    if (ext === 'docx' || ext === 'doc') return 'doc';
    if (ext === 'xlsx' || ext === 'xls') return 'excel';
    if (ext === 'zip' || ext === 'rar' || ext === '7z' || ext === 'tar' || ext === 'gz') return 'zip';
    if (['mp3', 'm4a', 'wav', 'flac', 'aac'].indexOf(ext) >= 0) return 'audio';
    return 'video';
  }

  function humanSize(n) {
    n = Number(n);
    if (!n || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function safeName(name, fallback) {
    var n = String(name || fallback || '课件').replace(/[\\/:*?"<>|]/g, '_').trim();
    return n.slice(0, 120);
  }

  // ---------- 拉取清单 ----------
  function fetchActivities() {
    var cid = courseId();
    if (!cid) throw new Error('当前页面没有课程号');
    if (!session) throw new Error('会话未就绪');
    return apiGet('/api/courses/' + cid + '/activities').then(flatten);
  }

  function flatten(d) {
    var items = [];
    (d.activities || []).forEach(function (a) {
      var bucket = {
        id: a.id,
        title: a.title || ('活动 ' + a.id),
        type: a.type || ''
      };
      (a.uploads || []).forEach(function (u) {
        var name = safeName(u.name, bucket.title);
        items.push({
          name: name,
          uploadId: u.id,
          activityId: bucket.id,
          activityTitle: bucket.title,
          kind: kindOf(name, u.type),
          size: u.size,
          // 平台对部分资源（多为视频）标记为不可下载，但仍然可以试试真实地址
          blocked: u.allow_download === false
        });
      });
    });
    return items;
  }

  // ---------- 下载 ----------
  function fetchDownloadUrl(uploadId) {
    return apiGet('/api/uploads/' + uploadId + '/url').then(function (d) {
      if (!d || !d.url) throw new Error('接口未返回地址');
      return d.url;
    });
  }

  function saveByBlob(url, name) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (b) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
    });
  }

  // 大文件交给浏览器自己流式保存，不占内存；用隐藏 iframe 避免弹窗被拦截
  function saveByBrowser(url) {
    var f = document.createElement('iframe');
    f.style.display = 'none';
    f.src = url;
    document.body.appendChild(f);
    setTimeout(function () { f.remove(); }, 120000);
  }

  function download(item) {
    return fetchDownloadUrl(item.uploadId).then(function (url) {
      var big = item.kind === 'video' || item.kind === 'audio' || (item.size && item.size > 20 * 1024 * 1024);
      if (big) {
        saveByBrowser(url);
        return;
      }
      return saveByBlob(url, item.name).catch(function () { saveByBrowser(url); });
    });
  }

  // ---------- 界面 ----------
  var UI = {};

  function log(msg) { if (UI.status) UI.status.textContent = msg; }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function visible() {
    if (state.filter === 'all') return state.items;
    if (state.filter === 'video') return state.items.filter(function (i) { return i.kind === 'video'; });
    return state.items.filter(function (i) { return i.kind !== 'video'; });
  }

  function render() {
    var list = visible();
    var videos = state.items.filter(function (i) { return i.kind === 'video'; }).length;
    if (UI.tabAll) UI.tabAll.textContent = '全部 ' + state.items.length;
    if (UI.tabDoc) UI.tabDoc.textContent = '文档 ' + (state.items.length - videos);
    if (UI.tabVideo) UI.tabVideo.textContent = '视频 ' + videos;
    UI.buttons.forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-f') === state.filter);
    });

    if (!list.length) {
      UI.list.innerHTML = '<div class="empty">没有可下载的内容</div>';
      return;
    }
    var html = '', lastActivity = null;
    list.forEach(function (it) {
      if (it.activityTitle !== lastActivity) {
        lastActivity = it.activityTitle;
        html += '<div class="grp">' + escapeHtml(lastActivity) + '</div>';
      }
      var k = KINDS[it.kind] || KINDS.other;
      html += '<div class="row">' +
        '<span class="badge ' + k.cls + '">' + k.label + '</span>' +
        '<span class="nm" title="' + escapeHtml(it.name) + '">' + escapeHtml(it.name) + '</span>' +
        (it.blocked ? '<span class="lock">禁</span>' : '') +
        (it.size ? '<span class="sz">' + humanSize(it.size) + '</span>' : '') +
        '<button class="dl" data-id="' + it.uploadId + '">' + (it.blocked ? '试下' : '下载') + '</button>' +
        '</div>';
    });
    UI.list.innerHTML = html;

    UI.list.querySelectorAll('button.dl').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var it = findItem(Number(btn.getAttribute('data-id')));
        if (!it) return;
        btn.disabled = true;
        download(it).then(function () {
          log('已保存 ' + it.name);
          btn.disabled = false;
        }).catch(function (e) {
          log('失败：' + (e && e.message ? e.message : e));
          btn.disabled = false;
        });
      });
    });
  }

  function findItem(uploadId) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].uploadId === uploadId) return state.items[i];
    return null;
  }

  function downloadAll() {
    if (state.busy) return;
    var pending = visible();
    if (!pending.length) { log('当前分组没有可下载的文件'); return; }
    state.busy = true;
    var done = 0, ok = 0, fail = 0, i = 0;
    (function next() {
      if (i >= pending.length) {
        state.busy = false;
        log('完成：成功 ' + ok + '，失败 ' + fail);
        return;
      }
      var it = pending[i++];
      download(it).then(function () { ok++; }, function () { fail++; })
        .then(function () {
          done++;
          log('进度 ' + done + '/' + pending.length);
          setTimeout(next, 800);
        });
    })();
  }

  function buildUI() {
    if (document.getElementById('ahmu-hd')) return;
    var root = document.createElement('div');
    root.id = 'ahmu-hd';
    root.innerHTML =
      '<div class="hd">' +
      '<b>课件下载助手</b>' +
      '<span class="st">就绪</span>' +
      '<button class="fold">收起</button>' +
      '</div>' +
      '<div class="bd">' +
      '<div class="tabs">' +
      '<button class="tb on" data-f="all">全部 0</button>' +
      '<button class="tb" data-f="doc">文档 0</button>' +
      '<button class="tb" data-f="video">视频 0</button>' +
      '</div>' +
      '<div class="list"><div class="empty">正在扫描…</div></div>' +
      '<button class="all">下载当前分组全部</button>' +
      '<div class="foot"><a class="rescan">重新扫描</a></div>' +
      '</div>';

    var css = document.createElement('style');
    css.textContent =
      '#ahmu-hd{position:fixed;right:16px;bottom:16px;width:330px;z-index:2147483647;background:#fff;' +
      'border:1px solid #d8d8dd;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.18);' +
      'font:12px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:#171717}' +
      '#ahmu-hd .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #eee}' +
      '#ahmu-hd .hd b{font-size:13px;flex:1}' +
      '#ahmu-hd .st{font-size:11px;color:#8a8a8f;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#ahmu-hd .fold{border:0;background:none;font-size:11px;color:#555;cursor:pointer}' +
      '#ahmu-hd .bd{padding:8px 10px}' +
      '#ahmu-hd.collapsed .bd{display:none}' +
      '#ahmu-hd .tabs{display:flex;gap:4px;margin-bottom:6px}' +
      '#ahmu-hd .tb{flex:1;border:1px solid #e3e3e8;background:#fafafa;border-radius:6px;padding:3px 0;' +
      'font-size:11px;cursor:pointer;color:#52525b}' +
      '#ahmu-hd .tb.on{background:#111827;color:#fff;border-color:#111827}' +
      '#ahmu-hd .list{max-height:300px;overflow:auto;border:1px solid #f0f0f3;border-radius:6px}' +
      '#ahmu-hd .grp{padding:4px 8px;background:#fafafa;font-size:10px;color:#71717a;border-bottom:1px solid #f0f0f3}' +
      '#ahmu-hd .row{display:flex;align-items:center;gap:5px;padding:5px 8px;border-bottom:1px solid #f7f7f9}' +
      '#ahmu-hd .row:last-child{border-bottom:0}' +
      '#ahmu-hd .badge{font-size:10px;padding:1px 5px;border-radius:4px;flex:none;color:#fff}' +
      '#ahmu-hd .k-pdf{background:#2563eb}#ahmu-hd .k-ppt{background:#d97706}' +
      '#ahmu-hd .k-doc{background:#0ea5e9}#ahmu-hd .k-xls{background:#16a34a}' +
      '#ahmu-hd .k-video{background:#7c3aed}#ahmu-hd .k-audio{background:#db2777}' +
      '#ahmu-hd .k-zip{background:#64748b}#ahmu-hd .k-other{background:#94a3b8}' +
      '#ahmu-hd .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#ahmu-hd .sz{font-size:10px;color:#9a9a9f;flex:none}' +
      '#ahmu-hd .lock{font-size:10px;color:#92400e;background:#fef3c7;border-radius:4px;padding:0 4px;flex:none}' +
      '#ahmu-hd .dl{border:1px solid #16a34a;background:#16a34a;color:#fff;border-radius:5px;' +
      'padding:2px 8px;font-size:11px;cursor:pointer;flex:none}' +
      '#ahmu-hd .dl:disabled{background:#dcdce0;border-color:#dcdce0;cursor:not-allowed}' +
      '#ahmu-hd .all{width:100%;margin-top:6px;border:1px solid #d4d4d8;background:#fafafa;' +
      'border-radius:6px;padding:5px;font-size:11px;cursor:pointer}' +
      '#ahmu-hd .foot{display:flex;justify-content:flex-end;margin-top:6px;font-size:10px;color:#3f3f46}' +
      '#ahmu-hd .foot a{cursor:pointer;text-decoration:underline}';

    document.head.appendChild(css);
    document.body.appendChild(root);

    UI.root = root;
    UI.status = root.querySelector('.st');
    UI.list = root.querySelector('.list');
    UI.buttons = Array.prototype.slice.call(root.querySelectorAll('.tb'));
    UI.tabAll = root.querySelector('[data-f="all"]');
    UI.tabDoc = root.querySelector('[data-f="doc"]');
    UI.tabVideo = root.querySelector('[data-f="video"]');

    root.querySelector('.fold').addEventListener('click', function () {
      root.classList.toggle('collapsed');
      this.textContent = root.classList.contains('collapsed') ? '展开' : '收起';
    });
    UI.buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        state.filter = b.getAttribute('data-f');
        render();
      });
    });
    root.querySelector('.all').addEventListener('click', downloadAll);
    root.querySelector('.rescan').addEventListener('click', function () { scan(); });
  }

  // ---------- 扫描 ----------
  function scan() {
    log('正在读取课程内容…');
    var tries = 0;
    (function attempt() {
      // 同步抛出的错误（没有课程号 / 会话未就绪）也要进入重试，不能直接冒泡丢掉
      Promise.resolve().then(fetchActivities).then(function (items) {
        state.items = items;
        render();
        log('识别到 ' + items.length + ' 个文件');
      }).catch(function (e) {
        var msg = e && e.message ? e.message : String(e);
        var waiting = /会话/.test(msg) || /课程号/.test(msg);
        if (waiting && tries++ < 20) {
          log((/会话/.test(msg) ? '等待平台会话…' : '等待页面进入课程…') + '（' + tries + '/20）');
          setTimeout(attempt, 600);
          return;
        }
        log('扫描失败：' + msg);
      });
    })();
  }

  function main() {
    buildUI();
    var href = location.href;
    setTimeout(function () { scan(false); }, 800);
    // 平台是单页应用，路由变化不刷新页面，这里跟着重扫
    setInterval(function () {
      if (location.href !== href) {
        href = location.href;
        state.items = [];
        scan(false);
      }
    }, 1000);
  }

  hookTransport();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
})();
