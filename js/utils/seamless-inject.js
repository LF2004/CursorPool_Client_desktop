/**
 * Seamless account-switch injection script generator.
 * Keep this script self-contained and syntax-safe because it is appended
 * directly to Cursor's workbench.js at runtime.
 */

const SEAMLESS_MARKER = '/* __CURSORPOOL_SEAMLESS__ */';

/**
 * Build the runtime script appended to workbench.js.
 * The runtime now discovers a compatible auth service heuristically instead of
 * rewriting fragile internal source snippets.
 * @param {number} port
 * @returns {string}
 */
function buildInjectionScript(port) {
  const safePort = Number.isFinite(Number(port)) ? Number(port) : 36529;

  return `
${SEAMLESS_MARKER}
;(function () {
  'use strict';

  var PORT = ${safePort};
  var AUTH_SCAN_LIMIT = 4000;
  var AUTH_SCAN_INTERVAL = 1500;
  var EMAIL_SELECTOR = '.cursor-settings-sidebar-header-email';

  function removeChildren(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function ensureStyle() {
    if (document.getElementById('mc-st')) return;
    var style = document.createElement('style');
    style.id = 'mc-st';
    style.textContent = [
      '@keyframes mcFI{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:translateX(0)}}',
      '@keyframes mcSU{from{opacity:0;transform:translateY(16px)}to{transform:translateY(0);opacity:1}}',
      '#mc-btn{transition:opacity .2s,box-shadow .2s}',
      '#mc-btn:hover{opacity:1!important;box-shadow:0 4px 20px rgba(0,0,0,.5)!important}',
      '#mc-btn.mc-drag{opacity:1!important;box-shadow:0 0 0 2px #4fc3f7!important;cursor:grabbing!important}'
    ].join('');
    document.head.appendChild(style);
  }

  function notify(message, color) {
    try {
      var dock = document.getElementById('mc-n');
      if (!dock) {
        dock = document.createElement('div');
        dock.id = 'mc-n';
        dock.style.cssText = 'position:fixed;top:20px;right:20px;z-index:999999;display:flex;flex-direction:column;gap:8px;max-width:420px;pointer-events:auto';
        document.body.appendChild(dock);
      }

      var item = document.createElement('div');
      item.style.cssText = 'background:#1e1e1e;border:1px solid #333;border-left:3px solid ' + color + ';padding:12px 16px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.5);color:#ccc;font-size:13px;display:flex;align-items:center;gap:10px;animation:mcFI .3s ease';

      var icon = document.createElement('span');
      icon.style.cssText = 'font-size:16px;flex-shrink:0';
      icon.textContent = color === '#4ec9b0' ? 'OK' : 'ERR';
      item.appendChild(icon);

      var text = document.createElement('span');
      text.textContent = message;
      item.appendChild(text);

      dock.appendChild(item);
      setTimeout(function () {
        item.style.opacity = '0';
        item.style.transition = 'opacity .3s';
        setTimeout(function () {
          if (item.parentNode) item.parentNode.removeChild(item);
          if (dock && dock.children.length === 0 && dock.parentNode) dock.parentNode.removeChild(dock);
        }, 300);
      }, 5000);
    } catch (_error) {
      // ignore
    }
  }

  var SUBSCRIPTION_LABELS = {
    free: { text: 'Free', color: '#4a89dc', background: 'rgba(74,137,220,.12)' },
    pro: { text: 'Pro', color: '#a855f7', background: 'rgba(168,85,247,.15)' },
    pro_plus: { text: 'Pro+', color: '#a855f7', background: 'rgba(168,85,247,.15)' },
    ultra: { text: 'Ultra', color: '#f59e0b', background: 'rgba(245,158,11,.15)' },
    token_expired: { text: 'Expired', color: '#f48771', background: 'rgba(244,135,113,.15)' }
  };

  function getSubscriptionInfo(kind) {
    return SUBSCRIPTION_LABELS[kind] || {
      text: kind || 'Unknown',
      color: '#888',
      background: 'rgba(136,136,136,.12)'
    };
  }

  function createPill(text, active, onClick) {
    var pill = document.createElement('span');
    pill.textContent = text;
    pill.style.cssText =
      'padding:2px 10px;border-radius:12px;font-size:11px;cursor:pointer;transition:all .15s;user-select:none;white-space:nowrap;' +
      (active
        ? 'background:rgba(14,99,156,.3);color:#4fc3f7;border:1px solid rgba(14,99,156,.5)'
        : 'background:transparent;color:#888;border:1px solid #3c3c3c');
    pill.onclick = onClick;
    return pill;
  }

  function readButtonPosition() {
    try {
      var raw = localStorage.getItem('mc-btn-pos');
      return raw ? JSON.parse(raw) : null;
    } catch (_error) {
      return null;
    }
  }

  function ensureButton() {
    if (document.getElementById('mc-btn')) return;

    var saved = readButtonPosition();
    var button = document.createElement('div');
    button.id = 'mc-btn';
    button.style.cssText =
      'position:fixed;bottom:' + (saved && saved.b != null ? saved.b : 12) + 'px;' +
      'right:' + (saved && saved.r != null ? saved.r : 20) + 'px;' +
      'z-index:999998;width:26px;height:26px;border-radius:50%;' +
      'background:linear-gradient(135deg,#0e639c,#1177bb);color:#fff;' +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.35);font-size:12px;user-select:none;opacity:.5';
    button.textContent = 'S';
    button.title = 'Switch account';

    var dragged = false;
    var startX = 0;
    var startY = 0;
    var startRight = 0;
    var startBottom = 0;

    button.addEventListener('mousedown', function (event) {
      event.preventDefault();
      dragged = false;
      startX = event.clientX;
      startY = event.clientY;
      startRight = parseInt(button.style.right, 10) || 0;
      startBottom = parseInt(button.style.bottom, 10) || 0;
      button.classList.add('mc-drag');

      function onMove(moveEvent) {
        var dx = moveEvent.clientX - startX;
        var dy = moveEvent.clientY - startY;
        if (!dragged && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) dragged = true;
        if (!dragged) return;
        button.style.right = Math.max(0, Math.min(window.innerWidth - 30, startRight - dx)) + 'px';
        button.style.bottom = Math.max(0, Math.min(window.innerHeight - 30, startBottom - dy)) + 'px';
      }

      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        button.classList.remove('mc-drag');
        if (dragged) {
          try {
            localStorage.setItem(
              'mc-btn-pos',
              JSON.stringify({
                r: parseInt(button.style.right, 10) || 0,
                b: parseInt(button.style.bottom, 10) || 0
              })
            );
          } catch (_error) {
            // ignore
          }
          return;
        }
        requestAccounts();
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    document.body.appendChild(button);
  }

  function requestAccounts() {
    fetch('http://127.0.0.1:' + PORT + '/api/accounts')
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (data && data.code === 0 && data.data && data.data.length) {
          openPicker(data.data);
          return;
        }
        notify('No accounts available', '#f48771');
      })
      .catch(function () {
        notify('Failed to connect to local service', '#f48771');
      });
  }

  function openPicker(accounts) {
    var existing = document.getElementById('mc-pick');
    if (existing) existing.remove();

    var subscriptionMap = {};
    var tagMap = {};

    accounts.forEach(function (account) {
      var subscription = account.subscription_type || 'unknown';
      subscriptionMap[subscription] = (subscriptionMap[subscription] || 0) + 1;
      (account.tags || []).forEach(function (tag) {
        tagMap[tag] = (tagMap[tag] || 0) + 1;
      });
    });

    var selectedSubscription = 'all';
    var selectedTag = '';

    function filterAccounts() {
      return accounts.filter(function (account) {
        if (selectedSubscription !== 'all' && (account.subscription_type || 'unknown') !== selectedSubscription) {
          return false;
        }
        if (selectedTag && (!account.tags || account.tags.indexOf(selectedTag) === -1)) {
          return false;
        }
        return true;
      });
    }

    var overlay = document.createElement('div');
    overlay.id = 'mc-pick';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px)';

    var modal = document.createElement('div');
    modal.style.cssText = 'background:#1e1e1e;border:1px solid #3c3c3c;border-radius:12px;max-width:520px;width:92%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.6);animation:mcSU .25s ease';
    overlay.appendChild(modal);

    var header = document.createElement('div');
    header.style.cssText = 'padding:14px 20px;border-bottom:1px solid #2d2d2d;display:flex;align-items:center;justify-content:space-between';
    modal.appendChild(header);

    var titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'display:flex;align-items:center;gap:10px';
    header.appendChild(titleWrap);

    var title = document.createElement('span');
    title.style.cssText = 'color:#e0e0e0;font-size:15px;font-weight:600';
    title.textContent = 'Switch Account';
    titleWrap.appendChild(title);

    var count = document.createElement('span');
    count.style.cssText = 'color:#666;font-size:12px;margin-left:8px';
    titleWrap.appendChild(count);

    var closeButton = document.createElement('button');
    closeButton.textContent = 'x';
    closeButton.style.cssText = 'background:none;border:none;color:#666;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:6px';
    closeButton.onclick = function () { overlay.remove(); };
    header.appendChild(closeButton);

    var filters = document.createElement('div');
    filters.style.cssText = 'padding:10px 16px;border-bottom:1px solid #2d2d2d;display:flex;flex-direction:column;gap:6px';
    modal.appendChild(filters);

    var subscriptionRow = document.createElement('div');
    subscriptionRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    filters.appendChild(subscriptionRow);

    var subscriptionLabel = document.createElement('span');
    subscriptionLabel.style.cssText = 'color:#888;font-size:12px';
    subscriptionLabel.textContent = 'Plan:';
    subscriptionRow.appendChild(subscriptionLabel);

    var list = document.createElement('div');
    list.style.cssText = 'padding:12px 16px;overflow:auto;flex:1;min-height:120px';
    modal.appendChild(list);

    function renderFilters() {
      while (subscriptionRow.children.length > 1) subscriptionRow.removeChild(subscriptionRow.lastChild);
      subscriptionRow.appendChild(createPill('All', selectedSubscription === 'all', function () {
        selectedSubscription = 'all';
        render();
      }));

      Object.keys(subscriptionMap).forEach(function (key) {
        var info = getSubscriptionInfo(key);
        subscriptionRow.appendChild(createPill(info.text, selectedSubscription === key, function () {
          selectedSubscription = key;
          render();
        }));
      });

      var tagRow = document.getElementById('mc-tag-row');
      if (tagRow && tagRow.parentNode) tagRow.parentNode.removeChild(tagRow);
      if (Object.keys(tagMap).length === 0) return;

      tagRow = document.createElement('div');
      tagRow.id = 'mc-tag-row';
      tagRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
      filters.appendChild(tagRow);

      var tagLabel = document.createElement('span');
      tagLabel.style.cssText = 'color:#888;font-size:12px';
      tagLabel.textContent = 'Tag:';
      tagRow.appendChild(tagLabel);

      tagRow.appendChild(createPill('All', selectedTag === '', function () {
        selectedTag = '';
        render();
      }));

      Object.keys(tagMap).forEach(function (tag) {
        tagRow.appendChild(createPill(tag, selectedTag === tag, function () {
          selectedTag = tag;
          render();
        }));
      });
    }

    function render() {
      renderFilters();
      var filtered = filterAccounts();
      count.textContent = '(' + filtered.length + '/' + accounts.length + ')';
      removeChildren(list);

      if (filtered.length === 0) {
        var empty = document.createElement('div');
        empty.style.cssText = 'color:#666;padding:20px;text-align:center;font-size:13px';
        empty.textContent = 'No matching accounts';
        list.appendChild(empty);
        return;
      }

      filtered.forEach(function (account) {
        var info = getSubscriptionInfo(account.subscription_type || 'unknown');
        var item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:8px;cursor:pointer;transition:background .15s;margin-bottom:6px;background:' + info.background;
        item.onmouseenter = function () { item.style.background = 'rgba(255,255,255,.06)'; };
        item.onmouseleave = function () { item.style.background = info.background; };
        item.onclick = function () {
          overlay.remove();
          switchAccount(account);
        };

        var left = document.createElement('div');
        left.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:1;min-width:0';
        item.appendChild(left);

        var email = document.createElement('div');
        email.style.cssText = 'color:#e0e0e0;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        email.textContent = account.email || 'Unknown';
        left.appendChild(email);

        var meta = document.createElement('div');
        meta.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
        left.appendChild(meta);

        var status = document.createElement('span');
        status.style.cssText = 'color:' + info.color + ';font-size:11px;padding:1px 8px;border-radius:10px;background:rgba(0,0,0,.2)';
        status.textContent = info.text;
        meta.appendChild(status);

        (account.tags || []).forEach(function (tag) {
          var tagNode = document.createElement('span');
          tagNode.style.cssText = 'color:#888;font-size:10px;padding:0 6px;border-radius:8px;border:1px solid #333;background:rgba(0,0,0,.2)';
          tagNode.textContent = tag;
          meta.appendChild(tagNode);
        });

        var action = document.createElement('div');
        action.style.cssText = 'color:#4fc3f7;font-size:12px';
        action.textContent = 'Switch';
        item.appendChild(action);

        list.appendChild(item);
      });
    }

    document.body.appendChild(overlay);
    render();
  }

  function isAuthServiceCandidate(value) {
    return Boolean(
      value &&
      typeof value === 'object' &&
      typeof value.localOverrideAccessToken === 'function' &&
      typeof value.notifyLoginChangedListeners === 'function'
    );
  }

  function attachPatchedHelpers(service, payload) {
    if (!service || service.__mcPatched) return;
    service.__mcPatched = true;

    if (payload && payload.refresh_token) {
      service.refreshToken = function () {
        return payload.refresh_token;
      };
    }

    if (typeof service.storeAccessRefreshToken !== 'function') return;
    var originalStore = service.storeAccessRefreshToken.bind(service);
    service.storeAccessRefreshToken = function (accessToken, refreshToken) {
      try {
        return originalStore(accessToken, refreshToken);
      } finally {
        if (payload && payload.token && typeof service.localOverrideAccessToken === 'function') {
          service.localOverrideAccessToken(payload.token);
        }
      }
    };
  }

  function findAuthService() {
    if (isAuthServiceCandidate(window.__mcAuthService)) {
      return window.__mcAuthService;
    }

    var queue = [];
    var seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

    function push(value) {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
      if (seen) {
        if (seen.has(value)) return;
        seen.add(value);
      }
      queue.push(value);
    }

    push(window);

    var visited = 0;
    while (queue.length && visited < AUTH_SCAN_LIMIT) {
      var current = queue.shift();
      visited += 1;

      if (isAuthServiceCandidate(current)) {
        window.__mcAuthService = current;
        return current;
      }

      var keys;
      try {
        keys = Object.getOwnPropertyNames(current);
      } catch (_error) {
        continue;
      }

      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        if (key === 'parent' || key === 'top' || key === 'opener' || key === 'frameElement') continue;
        var next;
        try {
          next = current[key];
        } catch (_error) {
          continue;
        }
        if (isAuthServiceCandidate(next)) {
          window.__mcAuthService = next;
          return next;
        }
        if (next && (typeof next === 'object' || typeof next === 'function')) {
          push(next);
        }
      }
    }

    return null;
  }

  function syncEmailLabel(email) {
    window.__mcCurrentEmail = email || '';
    try {
      var emailNode = document.querySelector(EMAIL_SELECTOR);
      if (emailNode && window.__mcCurrentEmail) emailNode.textContent = window.__mcCurrentEmail;
    } catch (_error) {
      // ignore
    }
  }

  function watchEmail() {
    if (window.__mcEmailObserverInstalled) return;
    window.__mcEmailObserverInstalled = true;
    new MutationObserver(function () {
      if (!window.__mcCurrentEmail) return;
      var emailNode = document.querySelector(EMAIL_SELECTOR);
      if (emailNode && emailNode.textContent !== window.__mcCurrentEmail) {
        emailNode.textContent = window.__mcCurrentEmail;
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function switchAccount(account) {
    fetch('http://127.0.0.1:' + PORT + '/api/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: account.email })
    })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data || data.code !== 0 || !data.data || !data.data.token) {
          notify((data && data.msg) || 'Switch failed', '#f48771');
          return;
        }

        var auth = findAuthService();
        if (!auth) {
          notify('Compatible auth service was not found in this Cursor build', '#f48771');
          return;
        }

        attachPatchedHelpers(auth, data.data);
        auth.localOverrideAccessToken(data.data.token);

        if (data.data.machine_ids) {
          var machineIds = data.data.machine_ids;
          if (machineIds['telemetry.machineId']) auth._machineId = machineIds['telemetry.machineId'];
          if (machineIds['telemetry.macMachineId']) auth._macMachineId = machineIds['telemetry.macMachineId'];
        }

        try {
          auth.notifyLoginChangedListeners(true);
        } catch (_error) {
          // ignore
        }

        var nextEmail = data.data.email || account.email;
        syncEmailLabel(nextEmail);
        notify('Switched to ' + nextEmail, '#4ec9b0');
      })
      .catch(function () {
        notify('Switch failed', '#f48771');
      });
  }

  function startAuthServiceProbe() {
    findAuthService();
    setInterval(function () {
      if (!window.__mcAuthService) findAuthService();
    }, AUTH_SCAN_INTERVAL);
  }

  function boot() {
    if (!document.body) {
      setTimeout(boot, 300);
      return;
    }
    ensureStyle();
    ensureButton();
    watchEmail();
    startAuthServiceProbe();
  }

  boot();
})();
`;
}

module.exports = {
  SEAMLESS_MARKER,
  buildInjectionScript
};
