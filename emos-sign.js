/**
 * emos 每日自动签到 · Loon 脚本
 * ---------------------------------------------------------------
 * 依据 somebyteorg/emos 公开 API 编写：
 *   GET  /api/user/base        基本信息（取用户名）
 *   GET  /api/sign/check       今日是否已签到
 *   PUT  /api/user/sign        签到（?content=留言）
 *   GET  /api/carrot/current   当前可用萝卜
 *
 * 认证：Bearer <token>，主站与社区镜像共用同一套账号
 * 说明：官方明确「禁止接口轮询、禁止 0 点签到」，本脚本每天只发出 2~4 个请求，
 *      且签到前先查询状态，已签到不再重复提交。
 * ---------------------------------------------------------------
 */

var VERSION = '1.1.0';
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
        log('请求失败 ' + String(method).toUpperCase() + ' ' + opts.url + ' → ' + (err && err.message ? err.message : String(err)));
      }
      cb(err, status, data || '');
    });
  } catch (e) {
    cb(e, 0, '');
  }
}

/* 只有幂等的 GET 才允许换线路重试，避免 PUT 重复提交 */
function retryable(err, code) {
  return (err || code === 0 || code >= 500 || code === 502 || code === 503 || code === 504);
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
        log(host(base) + ' 不可用（' + why + '），切换到 ' + host(CFG.bases[si + 1]));
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
    if (u.user_id) res.uid = u.user_id;

    checkSign(token, res, cb);
  });
}

function checkSign(token, res, cb) {
  http('get', '/api/sign/check', token, res.base, function (err, code, data) {
    if (err || code === 0) { res.msg = '网络请求失败'; return cb(res); }
    if (code === 401 || code === 403) { res.state = 'auth'; res.msg = 'Token 无效或已过期'; return cb(res); }

    var d = json(data);
    if (!d) { res.msg = '签到状态查询失败（HTTP ' + code + '）'; return cb(res); }

    var signed = (d.is_sign === true || d.is_sign === 1 || d.is_sign === 'true');
    if (d.user_id && !res.uid) res.uid = d.user_id;

    if (signed) {
      res.state = 'already';
      res.msg = '今日已签到';
      return fetchCarrot(token, res, cb);
    }
    doSign(token, res, cb);
  });
}

function doSign(token, res, cb) {
  var path = '/api/user/sign?content=' + encodeURIComponent(CFG.content);
  http('put', path, token, res.base, function (err, code, data) {
    if (err || code === 0) { res.msg = '网络请求失败'; return cb(res); }

    var d = json(data);

    if (code === 200 && d && (d.sign_index !== undefined || d.earn_point !== undefined)) {
      res.state = 'ok';
      res.index = d.sign_index;
      res.earn = d.earn_point;
      res.days = d.continuous_days;
      return fetchCarrot(token, res, cb);
    }
    if (code === 429) {
      res.state = 'already';
      res.msg = '今日已签到';
      return fetchCarrot(token, res, cb);
    }
    if (code === 401 || code === 403) { res.state = 'auth'; res.msg = 'Token 无效或已过期'; return cb(res); }

    res.msg = (d && d.message) ? d.message : ('签到失败（HTTP ' + code + '）');
    cb(res);
  });
}

function fetchCarrot(token, res, cb) {
  if (!CFG.carrot) return cb(res);
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

function detailLine(r) {
  var line = r.name || r.label || '未知账号';
  if (r.state === 'ok') {
    line += '：第 ' + (r.index === undefined ? '?' : r.index) + ' 名，+' + (r.earn === undefined ? 0 : r.earn) + ' 萝卜';
    if (r.days !== undefined && r.days !== null) line += '，连续 ' + r.days + ' 天';
  } else if (r.state === 'already') {
    line += '：' + (r.msg || '今日已签到');
  } else if (r.state === 'auth') {
    line += '：' + (r.msg || 'Token 无效');
  } else {
    line += '：' + (r.msg || '未知错误');
  }
  if (r.carrot !== undefined) line += '（余额 ' + r.carrot + '）';
  return line;
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
    body = detailLine(r);
    if (r.state === 'ok') {
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
    body = results.map(function (r, i) { return (i + 1) + '. ' + detailLine(r); }).join('\n');
  }

  var title, subtitle;
  if (results.length === 1) {
    var one = results[0];
    title = one.state === 'ok' ? 'emos 签到成功'
          : one.state === 'already' ? 'emos 今日已签到'
          : one.state === 'auth' ? 'emos 签到失败 · Token 失效'
          : 'emos 签到失败';
    subtitle = one.state === 'ok'
      ? '第 ' + (one.index === undefined ? '?' : one.index) + ' 名 · +' + (one.earn === undefined ? 0 : one.earn) + ' 萝卜'
      : one.state === 'auth'
        ? '请更新插件里的 token'
        : (one.name || one.label || '');
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
      log(title + ' | ' + subtitle + ' | ' + body.replace(/\n/g, ' / '));
      store('emos_sign_last', JSON.stringify({ date: today(), at: new Date().toISOString(), version: VERSION, bases: CFG.bases, results: results }));
      post(title, subtitle, body, openUrl);
      $done();
    });
  }

  log(title + ' | ' + subtitle + ' | ' + body.replace(/\n/g, ' / '));

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

  log('开始签到，账号数 ' + CFG.tokens.length + '，线路 ' + CFG.bases.join(' → ') + '，版本 ' + VERSION);

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
