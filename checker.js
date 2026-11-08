// Trust checker shared by index.html and translated copies of it.
//
// Expects the page to contain a <table id="results"> with a <tbody>, a
// <button id="rerun"> and an element with id="summary". Include it with
// `defer` (from <head>) or at the end of <body>. To translate the user-facing
// text, define window.CHECKER_STRINGS in an inline script before this one
// runs; any key left out keeps the English default.

// Hosts under test. Each intermediate is served twice: first chaining to its
// emSign root, then via the Sectigo cross-sign chaining to AAA Certificate
// All probe hosts on this Japanese mirror use leaf certificates that were
// not logged to Certificate Transparency and have no SCTs. Clients that
// enforce CT may reject them even if they still trust the intermediate CA.
//
// Each probe server must allow requests from https://emudhra.tki.jp and
// respond to GET / with a body containing EXPECTED_BODY.
const HOSTS = [
  { host: 'dv-g3b.emudhra.tki.jp',     label: 'CN=EM DV TLS CA - G3B, O=eMudhra BV, C=NL', root: 'emSign Root TLS CA - G3', noct: true },
  { host: 'dv-g3c.emudhra.tki.jp',     label: 'CN=EM DV TLS CA - G3C, O=eMudhra Inc, C=US', root: 'emSign Root TLS CA - G3', noct: true },
  { host: 'ov-g3b.emudhra.tki.jp',     label: 'CN=EM OV TLS CA - G3B, O=eMudhra BV, C=NL', root: 'emSign Root TLS CA - G3', noct: true },
  { host: 'ov-g3c.emudhra.tki.jp',     label: 'CN=EM OV TLS CA - G3C, O=eMudhra Inc, C=US', root: 'emSign Root TLS CA - G3', noct: true },
  { host: 'ev-g3b.emudhra.tki.jp',     label: 'CN=EM EV TLS CA - G3B, O=eMudhra BV, C=NL', root: 'emSign Root TLS CA - G3', noct: true },
  { host: 'ev-g3c.emudhra.tki.jp',     label: 'CN=EM EV TLS CA - G3C, O=eMudhra Inc, C=US', root: 'emSign Root TLS CA - G3', noct: true },
  { host: 'dv-g3b-aaa.emudhra.tki.jp', label: 'CN=EM DV TLS CA - G3B, O=eMudhra BV, C=NL', root: 'AAA Certificate Services', noct: true },
  { host: 'dv-g3c-aaa.emudhra.tki.jp', label: 'CN=EM DV TLS CA - G3C, O=eMudhra Inc, C=US', root: 'AAA Certificate Services', noct: true },
  { host: 'ov-g3b-aaa.emudhra.tki.jp', label: 'CN=EM OV TLS CA - G3B, O=eMudhra BV, C=NL', root: 'AAA Certificate Services', noct: true },
  { host: 'ov-g3c-aaa.emudhra.tki.jp', label: 'CN=EM OV TLS CA - G3C, O=eMudhra Inc, C=US', root: 'AAA Certificate Services', noct: true },
  { host: 'ev-g3b-aaa.emudhra.tki.jp', label: 'CN=EM EV TLS CA - G3B, O=eMudhra BV, C=NL', root: 'AAA Certificate Services', noct: true },
  { host: 'ev-g3c-aaa.emudhra.tki.jp', label: 'CN=EM EV TLS CA - G3C, O=eMudhra Inc, C=US', root: 'AAA Certificate Services', noct: true },
  // { host: 'dv-g3b-noct.emudhra.tki.jp',     label: 'CN=EM DV TLS CA - G3B, O=eMudhra BV, C=NL', root: 'emSign Root TLS CA - G3', noct: true },
  // { host: 'dv-g3b-aaa-noct.emudhra.tki.jp', label: 'CN=EM DV TLS CA - G3B, O=eMudhra BV, C=NL', root: 'AAA Certificate Services', noct: true },
];
// Fetched alongside the hosts above as a liveness check: an ordinary, publicly
// trusted certificate on the same servers, so every client should reach it. If
// it cannot be reached, the results above may reflect a network problem rather
// than the trust store, and a note says so. It also gives the statistics a
// count of the clients that ran the check, patched or not.
const PROBE_HOST = 'probe.emudhra.tki.jp';
const TIMEOUT_MS = 10000;
const COOLDOWN_MS = 10000;
// Present in every test server's response body. A response without it came
// from something else, such as a TLS-intercepting proxy's block page.
const EXPECTED_BODY = 'Your client successfully connected to the site.';

const S = Object.assign({
  noctTitle: 'Certificate Transparencyなし：この証明書はCTログに一度も記録されておらず，SCTもありません。' +
     'Chrome，Safari，Firefoxなど，CTを必須とするクライアントは，中間CAをまだ信頼していてもこの証明書を拒否します。',
  notYetChecked: 'まだテストしていません',
  checking: '接続をテスト中…',
  insecure: '❌ 危険（侵害された中間CAを信頼しています）',
  didNotConnect: '✅ 接続されませんでした',
  timedOut: '⚠️ 判定できません（時間内に応答がありませんでした）',
  offline: '⚠️ 判定できません（ブラウザがオフラインと報告しています）',
  unexpected: status => `⚠️ 判定できません（テスト用の応答を確認できませんでした：HTTP ${status}）`,
  summary: (n, total) => `このブラウザは，侵害された証明書チェーン${total}件のうち${n}件を信頼しました。`,
  incomplete: unknown => `${unknown}件は判定できなかったため，結果は不完全です。` +
     'しばらくしてから，またはTLS通信を中継・検査するプロキシを経由しないネットワークから，もう一度お試しください。',
  runAgain: 'もう一度接続をテストする',
  livenessFailed: 'サーバーの死活確認に失敗したため，これらの結果は正しくない可能性があります。',
}, window.CHECKER_STRINGS || {});

const resultsBody = document.querySelector('#results tbody');
const summary = document.getElementById('summary');
const rerun = document.getElementById('rerun');

function cell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

// A random token for one run of the check, sent as `r=` with the probe and
// every test-site request so the statistics server can tell that they came
// from the same run and count the run once as protected or not. It identifies
// nothing: it is fresh each run and the server keeps only a salted hash of it.
function runNonce() {
  const bytes = new Uint8Array(16);
  (self.crypto || {}).getRandomValues
    ? self.crypto.getRandomValues(bytes)
    : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function probe(host, nonce) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://${host}/?t=${Date.now()}&r=${nonce}`, { cache: 'no-store', signal: controller.signal });
    // A TLS-intercepting proxy terminates the connection itself, so its
    // responses say nothing about whether this browser trusts the chain.
    const body = await res.text();
    if (!body.includes(EXPECTED_BODY)) {
      return { status: 'unknown', text: S.unexpected(res.status) };
    }
    return { status: 'connected', text: S.insecure };
  } catch (err) {
    // A browser that reports being offline never reached the server.
    if (navigator.onLine === false) return { status: 'unknown', text: S.offline };
    // A slow server is not evidence that the chain was rejected.
    if (err.name === 'AbortError') return { status: 'unknown', text: S.timedOut };
    // Browsers report TLS failures and network errors identically here.
    return { status: 'blocked', text: S.didNotConnect };
  } finally {
    clearTimeout(timer);
  }
}

const cells = HOSTS.map(({ host, label, root, noct }) => {
  const tr = document.createElement('tr');
  const tdName = document.createElement('td');
  const a = document.createElement('a');
  a.href = `https://${host}/`; a.rel = 'noopener'; a.target = '_blank'; a.textContent = label; a.translate = false;
  tdName.appendChild(a);
  if (noct) {
    const abbr = document.createElement('abbr');
    abbr.title = S.noctTitle; abbr.textContent = 'No CT';
    tdName.append(' (', abbr, ')');
  }
  const tdResult = cell(S.notYetChecked, 'pending');
  const tdRoot = cell(root); tdRoot.translate = false;
  tr.append(tdName, tdRoot, tdResult);
  resultsBody.appendChild(tr);
  return tdResult;
});

async function run() {
  summary.textContent = '';
  for (const td of cells) {
    td.textContent = S.checking;
    td.className = 'pending';
  }
  const nonce = runNonce();
  const liveness = probe(PROBE_HOST, nonce);
  const results = await Promise.all(HOSTS.map(async ({ host }, i) => {
    const r = await probe(host, nonce);
    cells[i].textContent = r.text;
    cells[i].className = { connected: 'bad', blocked: 'good', unknown: 'pending' }[r.status];
    return r.status;
  }));
  const n = results.filter(s => s === 'connected').length;
  const unknown = results.filter(s => s === 'unknown').length;
  summary.textContent = S.summary(n, HOSTS.length) + (unknown ? S.incomplete(unknown) : '');
  if ((await liveness).status !== 'connected') {
    const note = document.createElement('span');
    note.className = 'bad';
    note.textContent = S.livenessFailed;
    summary.append(' ', note);
  }
}

// Disable the button until the run has finished and the cooldown has passed.
async function start() {
  observer.disconnect();
  rerun.disabled = true;
  await Promise.all([run(), new Promise(r => setTimeout(r, COOLDOWN_MS))]);
  rerun.textContent = S.runAgain;
  rerun.disabled = false;
}

// Run automatically the first time the results table scrolls into view.
const observer = new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting)) start();
});
observer.observe(document.getElementById('results'));

rerun.addEventListener('click', start);
