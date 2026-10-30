// 起動の見張り（モジュールではない普通のスクリプト。app.js より先に読む）
// 古いブラウザ・WebView でモジュールの読み込みや起動に失敗すると画面が「読み込み中…」のまま止まるので、
// 起動前に出たエラーを集め、10秒たっても起動しなければ画面に出す（調査用。外部には送らない）
(function () {
  var errors = [];
  function note(msg) {
    errors.push(String(msg));
  }
  window.addEventListener('error', function (e) {
    note((e.message || 'エラー') + (e.filename ? ' (' + e.filename.split('/').slice(-2).join('/') + ':' + e.lineno + ')' : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    note('Promise: ' + ((e.reason && (e.reason.message || e.reason)) || '不明'));
  });
  setTimeout(function () {
    if (document.documentElement.hasAttribute('data-started')) return;
    var view = document.getElementById('view');
    if (!view) return;
    var box = document.createElement('div');
    box.className = 'notice';
    var title = document.createElement('strong');
    title.textContent = 'Pocket会計を起動できませんでした';
    var info = document.createElement('pre');
    info.style.whiteSpace = 'pre-wrap';
    info.textContent = (errors.length ? errors.join('\n') : 'エラーの記録はありません') + '\n\n' + navigator.userAgent;
    box.appendChild(title);
    box.appendChild(info);
    view.replaceChildren(box);
  }, 10000);
})();
