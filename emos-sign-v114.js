/**
 * emos 每日自动签到 · Loon 脚本
 * ---------------------------------------------------------------
 * 依据 somebyteorg/emos 公开 API 编写：
 *   GET  /api/user/base        基本信息（取用户名 + user_id；401 即 token 失效）
 *   PUT  /api/user/sign        签到（?content=留言），429 表示今日已签
 *   GET  /api/user             完整信息，内含 sign 字段（最近一次签到）
 *   GET  /api/rank/sign        签到排行榜（可能只含前 N 名）
 *   GET  /api/pay/getUserSign  按 user_id 查签到（属 pay 域，普通账号可能 401）
 *   GET  /api/carrot/current   当前可用萝卜
 *
 * 注意：/api/sign/check 在 Postman 里的名称是「判断是否登录」，
 *      其中 is_sign 表示是否已登录，不能用来判断今日是否已签到。
 *
 * v1.1.4：签到记录改为「多来源兜底 + 本地缓存」，
 *         任一来源（user.sign / rank.sign / pay.getUserSign / carrot.history）
 *         能拿到记录就显示位次、签到时间、萝卜、连续天数；
 *         全部不可用时回落到本机上次成功记录，并在日志里写明每个来源的 HTTP 状态。
 *
 * 认证：Bearer <token>，主站与社区镜像共用同一套账号
 * 说明：官方明确「禁止接口轮询、禁止 0 点签到」，本脚本每天只发出 2~4 个请求，
 *      是否已签到由服务端返回的 429 判定，不额外轮询。
 * ---------------------------------------------------------------
 */

var VERSION = '1.1.5';
var DEFAULT_BASE = 'https://emos.best|https://emos.club';

/* 签到顺序奖惩（来自 emos wiki「萝卜货币」页）
 * 基础奖励 +1~5，下列位次额外加减，负数为扣除。 */
var RANK = { 3: 3, 9: -2, 11: 2, 26: -1, 59: 2, 89: -3, 113: -2, 199: -2, 311: 1, 457: 2 };

/* ------------------------------------------------------------------
 * 读取插件参数（Loon 的 [Argument] 面板）
 * ---------------------------------------------------------------- */
var CFG = (function () {
  var a = (typeof $argument === 'object' && $argument) ? $argument : {};
  if (typeof $argument === 'string') {
    try { a = JSON.parse($argument); } catch (e) { a = {}; }
  }

  function str(v, d) {
    if (v === undefined || v === null || v === '') return d;
    return String(v);
  }
  function bool(v, d) {
    if (v === undefined || v === null || v === '') return d;
    if (typeof v === 'boolean') return v;
    var s = String(v).toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }

  var tokens = [];
  str(a.token, '').split(/[\s,;，；、]+/).forEach(function (t) {
    t = t.trim().replace(/^Bearer\s+/i, '');
    if (t && tokens.indexOf(t) < 0) tokens.push(t);
  });

  var bases = [];
  str(a.baseUrl, DEFAULT_BASE).split(/[\s,;，；、|]+/).forEach(function (b) {
    b = b.trim().replace(/\/+$/, '');
    if (!b) return;
    if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
    if (bases.indexOf(b) < 0) bases.push(b);
  });

  return {
    bases: bases.length ? bases : [DEFAULT_BASE.split('|')[0]],
    tokens: tokens,
    content: str(a.signContent, '每日签到'),
    notify: bool(a.notify, true),
    carrot: bool(a.showCarrot, true)
  };
})();

/* ------------------------------------------------------------------
 * 小工具
 * ---------------------------------------------------------------- */
function log(msg) {
  console.log('[emos-sign] ' + msg);
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

/* 把多行/带 \uXXXX 转义的响应压成一行，日志里不占版面 */
function oneLine(s, max) {
  var t = String(s == null ? '' : s)
    .replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\s+/g, ' ')
    .trim();
  max = max || 80;
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function today() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function json(data) {
  if (!data) return null;
  if (typeof data === 'object') return data;
  try { return JSON.parse(String(data)); } catch (e) { return null; }
}

function host(base) {
  return String(base).replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

function post(title, subtitle, body, url) {
  if (!CFG.notify) {
    log('[通知已关闭] ' + title + ' / ' + subtitle + ' / ' + body);
    return;
  }
  try {
    $notification.post(title, subtitle, body, { openUrl: url || CFG.bases[0] });
  } catch (e) {
    log('通知发送失败: ' + e);
  }
}

function store(key, value) {
  try {
    if (value === undefined) return $persistentStore.read(key);
    $persistentStore.write(String(value), key);
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------
 * HTTP —— base 由调用方传入，便于多线路切换
 * ---------------------------------------------------------------- */
function http(method, path, token, base, cb) {
  var fn = $httpClient[method];
  if (typeof fn !== 'function') fn = $httpClient.post;

  var opts = {
    url: base + path,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'User-Agent': 'emos-sign/' + VERSION + ' (Loon; iPhone)'
    },
    timeout: 15000
  };

  try {
    fn.call($httpClient, opts, function (err, resp, data) {
      var status = 0;
      if (resp) status = resp.status || resp.statusCode || 0;
      if (err) {
        log('请求失败 ' + String(method).toUpperCase() + ' ' + path + ' → ' + oneLine(err && err.message ? err.message : err, 60));
      }
      cb(err, status, data || '');
    });
  } catch (e) {
    cb(e, 0, '');
  }
}

/* 只有幂等的 GET 才允许换线路重试，避免 PUT 重复提交 */
function retryable(err, code) {
  return !!err || code === 0 || code >= 500;
}

/* ------------------------------------------------------------------
 * 单账号流程
 * ---------------------------------------------------------------- */
function attempt(token, res, cb, si) {
  if (si >= CFG.bases.length) {
    res.msg = '所有站点均无法访问';
    return cb(res);
  }
  var base = CFG.bases[si];
  res.base = base;

  http('get', '/api/user/base', token, base, function (err, code, data) {
    if (retryable(err, code)) {
      var why = err ? ('连接失败: ' + (err && err.message ? err.message : String(err))) : ('HTTP ' + code);
      if (si + 1 < CFG.bases.length) {
        log(host(base) + ' 不可用，切到 ' + host(CFG.bases[si + 1]));
        return attempt(token, res, cb, si + 1);
      }
      res.msg = '网络请求失败（' + why + '）';
      res.netFail = true;
      return cb(res);
    }
    if (code === 401 || code === 403) {
      res.state = 'auth';
      res.msg = 'Token 无效或已过期';
      return cb(res);
    }

    var u = json(data);
    if (!u) { res.msg = '接口返回异常（HTTP ' + code + '）'; return cb(res); }
    if (u.username) res.name = u.username;
    /* 不同版本字段名不一致，全部兜一遍 */
    var uid = u.user_id || u.userId || u.id || u.uid;
    if (uid) res.uid = uid;
    if (u.sign && typeof u.sign === 'object' && u.sign.sign_index !== undefined) {
      res.index = u.sign.sign_index;
      res.earn = u.sign.earn_point;
      res.days = u.sign.continuous_days;
      res.at = u.sign.sign_at;
    }

    doSign(token, res, cb);
  });
}

function doSign(token, res, cb) {
  var path = '/api/user/sign?content=' + encodeURIComponent(CFG.content);
  http('put', path, token, res.base, function (err, code, data) {
    if (err || code === 0) {
      res.msg = '网络请求失败';
      return fetchRecord(token, res, function (r) {
        if (r.today === true) {
          r.state = 'ok';
          r.msg = '请求超时，但已确认签到成功';
          saveRec(r);
        } else {
          r.at = undefined; r.index = undefined;
          r.earn = undefined; r.days = undefined; r.today = undefined; r.local = undefined;
        }
        fetchCarrot(token, r, cb);
      });
    }

    var d = json(data);

    if (code === 200 && d && (d.sign_index !== undefined || d.earn_point !== undefined)) {
      res.state = 'ok';
      res.index = d.sign_index;
      res.earn = d.earn_point;
      res.days = d.continuous_days;
      res.at = nowFull();
      res.today = true;
      saveRec(res);
      return fetchCarrot(token, res, cb);
    }
    if (code === 429) {
      res.state = 'already';
      res.msg = '今日已签到';
      log('429 ' + oneLine((d && d.message) || data, 40));
      /* 少数部署会在 429 里直接带回签到详情 */
      var in429 = pickSign(d, res);
      if (in429 && (in429.index !== undefined || in429.at)) {
        applyRec(res, in429);
        log('记录藏在 429 响应里');
        return fetchCarrot(token, res, cb);
      }
      return fetchRecord(token, res, function (r) { fetchCarrot(token, r, cb); });
    }
    if (code === 401 || code === 403) { res.state = 'auth'; res.msg = 'Token 无效或已过期'; return cb(res); }

    res.msg = (d && d.message) ? d.message : ('签到失败（HTTP ' + code + '）');
    cb(res);
  });
}

/* ------------------------------------------------------------------
 * 签到记录反查：多来源兜底
 * ----------------------------------------------------------------
 * 1. /api/user            → sign 字段（最稳，和 user/base 同域）
 * 2. /api/rank/sign       → 按用户名/ID 匹配（可能只有前 N 名）
 * 3. /api/pay/getUserSign → 按 user_id 查（属 pay 域，普通账号可能 401）
 * 4. /api/carrot/history  → 萝卜流水里的最近一条签到
 * 全部失败 → 读本机缓存（今天写入过就直接用）
 * -------------------------------------------------------------- */

/* 从各种形状里挖出 { index, earn, days, at } */
function pickSign(o, res) {
  if (!o || typeof o !== 'object') return null;
  var c = o;
  if (Array.isArray(o)) {
    /* 排行榜：找自己那条 */
    var me = null;
    o.forEach(function (x) {
      if (!x || typeof x !== 'object') return;
      if ((res && res.uid && x.user_id === res.uid) ||
          (res && res.name && x.username === res.name)) me = x;
    });
    if (!me) return null;
    c = me;
  } else if (o.sign && typeof o.sign === 'object') {
    c = o.sign;
  } else if (o.data && typeof o.data === 'object' && !Array.isArray(o.data)) {
    c = o.data.sign && typeof o.data.sign === 'object' ? o.data.sign : o.data;
  }
  if (typeof c !== 'object') return null;
  var at = c.sign_at || c.last_sign_at || c.last_user_sign || c.created_at || c.at;
  /* 必须至少有一个「时间或位次」字段，仅有 carrot（如 /api/user 的余额）不算签到记录 */
  if (c.sign_index === undefined && !at) return null;
  return {
    index: c.sign_index,
    earn: c.earn_point !== undefined ? c.earn_point : c.carrot,
    days: c.continuous_days,
    at: at
  };
}

function applyRec(res, got) {
  if (!got) return res;
  if (got.index !== undefined && got.index !== null) res.index = got.index;
  if (got.earn !== undefined && got.earn !== null) res.earn = got.earn;
  if (got.days !== undefined && got.days !== null) res.days = got.days;
  if (got.at) {
    res.at = got.at;
    var t = todayFlag(got.at);
    if (t !== undefined) res.today = t;   /* 解析不了就不下结论，别误判成「未生效」 */
  }
  return res;
}

/* ---------------- 本机缓存：今天签过就先记下来 ---------------- */
function recKey(res) { return 'emos_sign_rec_' + (res.uid || res.name || 'default'); }

function saveRec(res) {
  try {
    store(recKey(res), JSON.stringify({
      date: today(), at: res.at, index: res.index, earn: res.earn, days: res.days, name: res.name
    }));
  } catch (e) { /* ignore */ }
}

function readRec(res) {
  try {
    var d = json(store(recKey(res)));
    if (d && d.date === today() && d.at) return d;
  } catch (e) { /* ignore */ }
  return null;
}

function fetchRecord(token, res, cb) {
  var tried = [];
  var fallback = null;
  var uid = res.uid;

  var sources = [
    ['user.sign', '/api/user', function (d) {
      var u = d && d.data && !Array.isArray(d.data) ? d.data : d;
      if (!u) return null;
      if (u.carrot !== undefined) res.carrot = u.carrot;   /* 顺手拿余额，省一次请求 */
      if (!u.sign) return null;
      if (typeof u.sign === 'string') return { at: u.sign };
      return pickSign(u.sign, res);
    }],
    ['rank.sign', '/api/rank/sign', function (d) {
      var arr = Array.isArray(d) ? d : (d && Array.isArray(d.items) ? d.items : null);
      return arr ? pickSign(arr, res) : null;
    }],
    ['pay.getUserSign', uid ? '/api/pay/getUserSign?user_id=' + encodeURIComponent(uid) : null, function (d) {
      return pickSign(d, res);
    }],
    ['carrot.history', '/api/carrot/history?type=sign' + (uid ? '&user_id=' + encodeURIComponent(uid) : ''), function (d) {
      var arr = Array.isArray(d) ? d : (d && Array.isArray(d.items) ? d.items : null);
      if (!arr || !arr.length) return null;
      /* 有 type 字段就只留签到流水，否则用全部 */
      var signs = arr.filter(function (x) {
        if (!x || typeof x !== 'object') return false;
        var t = x.type;
        return t === 'sign' || t === '签到' || t === 1;
      });
      var list = signs.length ? signs : arr;
      /* 不依赖返回顺序，按时间取最新一条 */
      var best = null, bt = -1;
      list.forEach(function (x) {
        var tt = x && (x.created_at || x.sign_at || x.at || x.time);
        var p = parseLocal(tt);
        var v = p && !isNaN(p.getTime()) ? p.getTime() : 0;
        if (v >= bt) { bt = v; best = x; }
      });
      return best ? pickSign(best, res) : null;
    }]
  ];

  function done() {
    if (fallback) applyRec(res, fallback);
    if (!res.at) {
      var rec = readRec(res);
      if (rec) {
        res.at = rec.at;
        res.today = true;
        res.local = true;
        if (res.index === undefined && rec.index !== undefined) res.index = rec.index;
        if (res.earn === undefined && rec.earn !== undefined) res.earn = rec.earn;
        if (res.days === undefined && rec.days !== undefined) res.days = rec.days;
        log('记录来自本机缓存');
      }
    }
    if (tried.length) log('反查失败：' + tried.join('，'));
    if (res.at && res.today !== false) saveRec(res);
    cb(res);
  }

  function step(i) {
    if (i >= sources.length) return done();
    var s = sources[i];
    if (!s[1]) { tried.push(s[0] + ' 跳过'); return step(i + 1); }
    http('get', s[1], token, res.base, function (err, code, data) {
      var d = json(data);
      var got = null;
      if (!err && code === 200) { try { got = s[2](d); } catch (e) { got = null; } }

      if (got && (got.index !== undefined || got.at)) {
        var isTodayRec = got.at ? todayFlag(got.at) : undefined;
        tried.push(s[0] + ' HTTP 200 命中');
        if (isTodayRec === true || isTodayRec === undefined) {
          applyRec(res, got);
          saveRec(res);
          if (s[0] !== 'user.sign') log('记录来自 ' + s[0]);
          return cb(res);
        }
        /* 是旧记录，先留着，继续找今天的 */
        if (!fallback) fallback = got;
        log(s[0] + ' 只有旧记录（' + fmtTime(got.at) + '），继续查');
        return step(i + 1);
      }

      tried.push(s[0] + ' ' + (code === 200 ? '无记录' : 'HTTP ' + code));
      step(i + 1);
    });
  }

  step(0);
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function nowStr() {
  var d = new Date();
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* 带年份的本地时间，供 isToday 解析 */
function nowFull() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/* emos 后端把本地时间（Asia/Shanghai）直接序列化成 "...Z"，
 * 例如签到时间 00:04 会返回 "2026-11-15T00:04:12.000000Z"。
 * 若按 UTC 换算会变成 08:04，甚至跨天被判成「昨天」，
 * 所以 Z 后缀一律当「无时区」按字面时间解析；只有 +08:00 这类真实偏移才换算。 */
function parseLocal(s) {
  if (!s) return null;
  var m = String(s).trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  var Y = +m[1], M = +m[2] - 1, D = +m[3];
  var h = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0;
  var tz = m[7];
  if (tz && tz !== 'Z') {
    var sg = tz.charAt(0) === '-' ? -1 : 1;
    var off = sg * (parseInt(tz.substr(1, 2), 10) * 60 + parseInt(tz.substr(3, 2), 10));
    return new Date(Date.UTC(Y, M, D, h, mi) - off * 60000);
  }
  return new Date(Y, M, D, h, mi);
}

function fmtTime(s) {
  if (!s) return '';
  var d = parseLocal(s);
  if (!d || isNaN(d.getTime())) return String(s);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function isToday(s) {
  if (!s) return false;
  var d = parseLocal(s);
  if (!d || isNaN(d.getTime())) return false;
  var now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/* 能判断才返回 true/false，时间串无法解析时返回 undefined（调用方据此跳过校验） */
function todayFlag(s) {
  if (!s) return undefined;
  var d = parseLocal(s);
  if (!d || isNaN(d.getTime())) return undefined;
  return isToday(s);
}

function fetchCarrot(token, res, cb) {
  if (!CFG.carrot || res.carrot !== undefined) return cb(res);
  http('get', '/api/carrot/current', token, res.base, function (err, code, data) {
    var d = json(data);
    if (d && d.carrot !== undefined) res.carrot = d.carrot;
    cb(res);
  });
}

/* ------------------------------------------------------------------
 * 汇总与通知
 * ---------------------------------------------------------------- */
function rankNote(idx) {
  if (idx === undefined || idx === null) return '';
  var v = RANK[idx];
  if (v === undefined) return '';
  return v < 0 ? '  ⚠ 第 ' + idx + ' 位扣 ' + (-v) : '  ↑ 第 ' + idx + ' 位额外 +' + v;
}

function detailLine(r, compact) {
  var line = r.name || r.label || '未知账号';
  var when = r.at ? fmtTime(r.at) : '';

  if (r.state === 'ok') {
    line += '：第 ' + (r.index === undefined || r.index === null ? '?' : r.index) + ' 名';
    line += '，+' + (r.earn === undefined || r.earn === null ? 0 : r.earn) + ' 萝卜';
    if (r.days !== undefined && r.days !== null) line += '，连续 ' + r.days + ' 天';
  } else if (r.state === 'already') {
    if (r.today === false) {
      line += '：今日无签到记录，上次 ' + (when || '未知时间');
      line += '（+' + (r.earn === undefined ? 0 : r.earn) + ' 萝卜';
      if (r.days !== undefined && r.days !== null) line += '，连续 ' + r.days + ' 天';
      line += '）';
      when = '';
    } else if (r.index === undefined || r.index === null) {
      line += '：' + (r.msg || '今日已签到');
      line += r.local ? '，时间取自本机记录' : '（位次暂时取不到）';
    } else {
      line += '：今日第 ' + r.index + ' 名';
      line += '，+' + (r.earn === undefined ? 0 : r.earn) + ' 萝卜';
      if (r.days !== undefined && r.days !== null) line += '，连续 ' + r.days + ' 天';
    }
  } else if (r.state === 'auth') {
    line += '：' + (r.msg || 'Token 无效');
  } else {
    line += '：' + (r.msg || '未知错误');
  }

  if (r.carrot !== undefined) line += '（余额 ' + r.carrot + '）';
  if (when) line += compact ? ' · ' + when : '\n签到时间 ' + when;
  return line;
}

function logFinish(title, subtitle, results) {
  var extra = (results.length === 1 && results[0].carrot !== undefined) ? ' · 余额 ' + results[0].carrot : '';
  log('完成 · ' + String(title).replace(/^emos\s*/, '') + ' · ' + subtitle + extra);
  if (results.length > 1) {
    results.forEach(function (r, i) {
      log('  ' + (i + 1) + '. ' + detailLine(r, true).split('\n')[0]);
    });
  }
}

function probe(cb) {
  var done = false;
  function back(ok) { if (!done) { done = true; cb(ok); } }
  try {
    setTimeout(function () { back(null); }, 16000);
    $httpClient.get({ url: 'https://www.apple.com/library/test/success.html', timeout: 15000 },
      function (err, resp) {
        var st = resp ? (resp.status || resp.statusCode || 0) : 0;
        back(!err && st > 0 && st < 500);
      });
  } catch (e) { back(false); }
}

function finish(results) {
  var ok = 0, already = 0, fail = 0, auth = 0;
  results.forEach(function (r) {
    if (r.state === 'ok') ok++;
    else if (r.state === 'already') already++;
    else if (r.state === 'auth') auth++;
    else fail++;
  });

  var body, openUrl = CFG.bases[0];
  if (results.length === 1) {
    var r = results[0];
    body = detailLine(r, false);
    if (r.state === 'ok' || r.state === 'already') {
      var note = rankNote(r.index);
      if (note) body += '\n' + note.replace(/^\s+/, '');
    }
    if (r.state === 'auth') body += '\n请到插件设置里更新 token';
    if (r.state === 'ok' || r.state === 'already') {
      openUrl = r.base || openUrl;
      body += '\n点击打开 ' + host(openUrl);
    }
    if (r.base && results.length === 1 && CFG.bases.length > 1) {
      body += '\n线路：' + host(r.base);
    }
  } else {
    body = results.map(function (r, i) { return (i + 1) + '. ' + detailLine(r, true); }).join('\n');
  }

  var title, subtitle;
  if (results.length === 1) {
    var one = results[0];
    title = one.state === 'ok' ? 'emos 签到成功'
          : one.state === 'already' ? (one.today === false ? 'emos 签到未生效' : 'emos 今日已签到')
          : one.state === 'auth' ? 'emos 签到失败 · Token 失效'
          : 'emos 签到失败';
    subtitle = one.state === 'ok'
      ? '第 ' + (one.index == null ? '?' : one.index) + ' 名 · +' + (one.earn == null ? 0 : one.earn) + ' 萝卜'
        + (one.days !== undefined && one.days !== null ? ' · 连续 ' + one.days + ' 天' : '')
        + (one.at ? ' · ' + fmtTime(one.at) : '')
      : one.state === 'already'
        ? (one.today === false
            ? '上次 ' + fmtTime(one.at) + ' · 今日未生效'
            : (one.index != null
                ? '今日第 ' + one.index + ' 名 · +' + (one.earn == null ? 0 : one.earn) + ' 萝卜'
                  + (one.days !== undefined && one.days !== null ? ' · 连续 ' + one.days + ' 天' : '')
                  + (one.at ? ' · ' + fmtTime(one.at) : '')
                : (one.at ? '已签到 · ' + fmtTime(one.at) : '已签到 · 位次查询失败')))
      : one.state === 'auth'
        ? '请更新插件里的 token'
        : (one.msg || one.name || one.label || '');
  } else {
    title = (fail + auth) === 0 ? 'emos 签到完成' : 'emos 签到部分失败';
    subtitle = '共 ' + results.length + ' 个账号 · 成功 ' + ok + ' · 已签 ' + already + ' · 失败 ' + (fail + auth);
  }

  var allNetFail = results.length > 0 && results.every(function (r) { return r.netFail; });

  if (allNetFail) {
    return probe(function (ok) {
      body += ok === true ? '\n\n诊断：外网正常，是这两个域名连不上（可能被本地网络拦截，或站点临时故障）'
            : ok === false ? '\n\n诊断：Loon 整体连不上外网，请确认 Loon 已启用、节点可用'
            : '\n\n诊断：探测超时，无法判断网络状态';
      logFinish(title, subtitle, results);
      store('emos_sign_last', JSON.stringify({ date: today(), at: new Date().toISOString(), version: VERSION, bases: CFG.bases, results: results }));
      post(title, subtitle, body, openUrl);
      $done();
    });
  }

  logFinish(title, subtitle, results);

  store('emos_sign_last', JSON.stringify({
    date: today(),
    at: new Date().toISOString(),
    version: VERSION,
    bases: CFG.bases,
    results: results
  }));

  post(title, subtitle, body, openUrl);
  $done();
}

/* ------------------------------------------------------------------
 * 入口
 * ---------------------------------------------------------------- */
(function main() {
  if (!CFG.tokens.length) {
    log('未配置 token');
    post('emos 签到未运行', '缺少 Token', '请在 Loon → 插件 → emos 自动签到 中填写 token');
    return $done();
  }

  log('开始 · ' + CFG.tokens.length + ' 账号 · ' + CFG.bases.map(host).join(' → ') + ' · v' + VERSION);

  var results = [];
  var i = 0;

  function next() {
    if (i >= CFG.tokens.length) return finish(results);
    var idx = i + 1;
    var token = CFG.tokens[i++];
    var res = { state: 'fail', msg: '', name: '', label: '账号 ' + idx, carrot: undefined, base: '' };
    attempt(token, res, function (r) {
      results.push(r);
      next();
    }, 0);
  }

  next();
})();
