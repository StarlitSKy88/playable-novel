/* ============================================================
 * WorkBuddy 云服务接入层
 * ------------------------------------------------------------
 * 形式：纯 HTML 项目（无构建步骤）→ CDN <script> 全局 WorkBuddyCloud
 * 配置：只来自 workbuddy_cloud_service 激活返回的 publicConfig，
 *       不硬编码其他来源、不手写 /.cloud/** 请求。
 * 模块：LLM（免密钥生成）· Auth（邮箱验证码登录）· Database（云端存档）
 *
 * 任何一步失败都必须「说人话」返回，不允许静默失败：
 * 离线 / SDK 未加载 / 未登录 / 配额不足 / 模型不可用 各有明确提示。
 * ============================================================ */
(function () {
  'use strict';

  /* ---- 仅来自 publicConfig 的三个值（publishableKey 不含权限，靠 Origin 校验） ---- */
  var PUBLIC_CONFIG = {
    endpoint: 'https://playable-novel.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_omCSYUEMmNCoRAl68xMWJP_5KdW7bdAJNv4LiUE12tr9rkkdAQKEr1f'
  };

  var TABLE = 'story_saves';
  var DEFAULT_SYSTEM = '你是可玩小说引擎的叙事引擎。用中文续写互动剧情，保持原著世界观与人物语气，输出凝练且有画面感。';

  var client = null;
  var initPromise = null;
  var cachedModelId = null;
  var lastUsage = null;

  function ensureClient() {
    if (client) return Promise.resolve(client);
    if (initPromise) return initPromise;
    initPromise = new Promise(function (resolve, reject) {
      if (!window.WorkBuddyCloud || typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
        reject(new Error('云服务 SDK 未加载：当前处于离线状态或 CDN 不可达，已回退本地模式'));
        return;
      }
      try {
        client = window.WorkBuddyCloud.createWorkBuddyCloud({
          endpoint: PUBLIC_CONFIG.endpoint,
          oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
          publishableKey: PUBLIC_CONFIG.publishableKey
        });
        resolve(client);
      } catch (e) {
        reject(new Error('云服务初始化失败：' + (e && e.message ? e.message : '未知错误')));
      }
    });
    return initPromise;
  }

  /* ---- 错误翻译：SDK 的 code 前缀 → 用户能看懂的话 ---- */
  function explain(err, fallback) {
    var code = err && err.error && err.error.code ? String(err.error.code) : '';
    var msg = err && err.message ? err.message : '';
    if (err && err.needLogin) return msg;
    if (code.indexOf('auth_') === 0) return '云服务凭据校验未通过，请确认在应用线上域名打开（发布后的链接），而非本地文件直开。';
    if (code.indexOf('quota_') === 0) return '云端模型额度已用尽或触发限流，请稍后再试，或在设置里填入你自己的 API Key。';
    if (code.indexOf('request_') === 0) return '模型请求参数不被接受：' + msg;
    if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return '云端模型服务暂时不可用，请重试，或改用你自己的 API Key。';
    if (code.indexOf('internal_') === 0) return '云服务内部错误，请稍后重试。';
    if (/network|Failed to fetch|NetworkError/i.test(msg)) return '网络不可用，云服务暂未连接，已回退本地模式。';
    return fallback || msg || '云服务调用失败';
  }

  /* ============================================================
   * LLM：免密钥生成
   * ============================================================ */
  var llm = {
    /* 可用模型列表（enabled !== false && disabled !== true） */
    listModels: function () {
      return ensureClient().then(function (c) {
        return c.llm.models.list();
      }).then(function (models) {
        var list = Array.isArray(models) ? models : [];
        return list.filter(function (m) { return m.disabled !== true && m.enabled !== false; });
      }).catch(function (e) {
        throw new Error(explain(e, '获取云端模型列表失败'));
      });
    },

    /* 取一个可用模型 id。
       互动叙事是「一轮一停」的对话场景，首字延迟比极限推理能力更重要：
       isDefault 的 auto 实测单轮要 100 秒级（重推理），不可用。
       因此按「快模型优先」的偏好序挑选，全部不在目录里时才退回 isDefault / 首个。 */
    PREFERRED: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'hy3'],

    pickModel: function () {
      if (cachedModelId) return Promise.resolve(cachedModelId);
      return llm.listModels().then(function (list) {
        if (!list.length) throw new Error('云端暂无可用模型，请在设置里填入你自己的 API Key');
        var byId = {};
        list.forEach(function (m) { byId[m.id] = m; });
        var picked = null;
        llm.PREFERRED.some(function (id) {
          var m = byId[id];
          if (m && m.disabled !== true && m.enabled !== false) { picked = m; return true; }
          return false;
        });
        if (!picked) picked = list.filter(function (m) { return m.isDefault; })[0] || list[0];
        cachedModelId = picked.id;
        return cachedModelId;
      });
    },

    setModel: function (id) { cachedModelId = id || null; },
    currentModel: function () { return cachedModelId; },

    /* 流式生成。messages[0] 必须是 system，SDK 不会替我们补 */
    chat: function (opts) {
      var messages = (opts.messages || []).slice();
      if (!messages.length || messages[0].role !== 'system') {
        messages.unshift({ role: 'system', content: DEFAULT_SYSTEM });
      }
      lastUsage = null;
      return ensureClient()
        .then(function (c) {
          return llm.pickModel().then(function (modelId) {
            return { c: c, modelId: modelId };
          });
        })
        .then(function (ctx) {
          var req = {
            model: ctx.modelId,
            messages: messages,
            stream: true,
            stream_options: { include_usage: true }
          };
          if (typeof opts.temperature === 'number') req.temperature = opts.temperature;
          if (opts.signal) req.signal = opts.signal;

          var content = '';
          var usage = null;

          /* 逐块消费 SSE；只取 delta.content，跳过 role 占位帧 */
          function step(iterator, last) {
            return iterator.next().then(function (res) {
              if (res.done) return { content: content, usage: usage };
              var chunk = res.value || {};
              var choice = chunk.choices && chunk.choices[0];
              var delta = choice && choice.delta;
              if (delta && delta.content) {
                content += delta.content;
                if (opts.onDelta) opts.onDelta(delta.content);
              }
              if (chunk.usage) usage = chunk.usage;
              lastUsage = usage;
              return step(iterator, res);
            });
          }

          /* create() 返回异步可迭代对象（SSE）；也兼容它直接是数组/Promise 的情况 */
          var created = ctx.c.llm.chat.completions.create(req);
          if (created && typeof created[Symbol.asyncIterator] === 'function') {
            return step(created[Symbol.asyncIterator](), null);
          }
          if (created && typeof created.next === 'function') {
            return step(created, null);
          }
          return Promise.resolve(created).then(function (val) {
            var arr = Array.isArray(val) ? val : [val];
            arr.forEach(function (chunk) {
              var delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
              if (delta && delta.content) {
                content += delta.content;
                if (opts.onDelta) opts.onDelta(delta.content);
              }
              if (chunk && chunk.usage) usage = chunk.usage;
            });
            return { content: content, usage: usage };
          });
        })
        .catch(function (e) {
          if (e && e.name === 'AbortError') throw e;
          throw new Error(explain(e, '云端生成失败'));
        });
    },

    lastUsage: function () { return lastUsage; }
  };

  /* ============================================================
   * Auth：邮箱验证码登录（OTP，无密码）
   * ============================================================ */
  var auth = {
    getSession: function () {
      return ensureClient().then(function (c) {
        return c.auth.getSession();
      }).then(function (res) {
        if (res && res.error) return null;
        return res && res.data ? res.data : null;
      }).catch(function () { return null; });
    },

    getUser: function () {
      return ensureClient().then(function (c) {
        return c.auth.getUser();
      }).then(function (res) {
        return res && !res.error && res.data ? res.data : null;
      }).catch(function () { return null; });
    },

    /* 发送验证码：与「提交验证码」必须分开绑定，提交时不得再次发送 */
    sendCode: function (email) {
      return ensureClient().then(function (c) {
        return c.auth.sendOtp({ email: email });
      }).then(function (res) {
        if (res && res.error) throw new Error(res.error.message || '验证码发送失败');
        return {
          email: email,
          verificationId: res.data.verificationId,
          isExistingUser: !!res.data.isExistingUser
        };
      }).catch(function (e) {
        throw new Error(explain(e, '验证码发送失败，请稍后再试'));
      });
    },

    /* 提交验证码：复用发送时保存的 challenge，绝不重新发码 */
    verifyCode: function (pending, token) {
      if (!pending || !pending.email) throw new Error('请先获取当前邮箱的验证码');
      return ensureClient().then(function (c) {
        return c.auth.verifyOtp({
          email: pending.email,
          verificationId: pending.verificationId,
          isExistingUser: pending.isExistingUser,
          token: token
        });
      }).then(function (res) {
        if (res && res.error) throw new Error(res.error.message || '验证码校验失败');
        return res.data;
      }).catch(function (e) {
        throw new Error(explain(e, '登录失败，请检查验证码是否正确'));
      });
    },

    signOut: function () {
      return ensureClient().then(function (c) { return c.auth.signOut(); })
        .then(function (res) { return !(res && res.error); })
        .catch(function () { return false; });
    },

    onChange: function (cb) {
      return ensureClient().then(function (c) {
        if (typeof c.auth.onAuthStateChange !== 'function') return function () {};
        try { return c.auth.onAuthStateChange(cb); } catch (e) { return function () {}; }
      }).catch(function () { return function () {}; });
    }
  };

  /* ============================================================
   * Database：云端存档（owner-only，RLS 在服务端兜底，前端不传 owner_id）
   * ============================================================ */
  function needLogin() {
    var e = new Error('云端存档需要登录后使用，请先登录');
    e.needLogin = true;
    return e;
  }

  var saves = {
    list: function () {
      return ensureClient().then(function (c) {
        return auth.getSession().then(function (session) {
          if (!session) throw needLogin();
          return c.database.from(TABLE)
            .select('id, novel_title, chapter_index, created_at')
            .order('created_at', { ascending: false })
            .limit(20);
        });
      }).then(function (res) {
        if (res && res.error) {
          if (res.error.code === '42P01') throw new Error('云端存档表尚未创建');
          if (res.error.code === '42501') throw new Error('没有权限读取云端存档，请重新登录');
          throw new Error(res.error.message || '读取云端存档失败');
        }
        return (res && res.data) || [];
      });
    },

    save: function (payload) {
      return ensureClient().then(function (c) {
        return auth.getSession().then(function (session) {
          if (!session) throw needLogin();
          var row = {
            novel_title: payload.novelTitle || '未命名小说',
            chapter_index: payload.chapterIndex || 0,
            payload: payload.payload || {},
            owner_name: (session.user && session.user.name) || null
          };
          return c.database.from(TABLE).insert(row).select();
        });
      }).then(function (res) {
        if (res && res.error) {
          if (res.error.code === '42501') throw new Error('写入被云端策略拒绝，请重新登录后重试');
          throw new Error(res.error.message || '云端存档写入失败');
        }
        var rows = (res && res.data) || [];
        if (!rows.length) throw new Error('云端存档未写入：当前登录状态可能已失效，请重新登录');
        return rows[0];
      });
    },

    remove: function (id) {
      return ensureClient().then(function (c) {
        return auth.getSession().then(function (session) {
          if (!session) throw needLogin();
          return c.database.from(TABLE).delete().eq('id', id).select();
        });
      }).then(function (res) {
        if (res && res.error) throw new Error(res.error.message || '删除云端存档失败');
        return ((res && res.data) || []).length > 0;
      });
    }
  };

  /* ---- 对外：一次性探测云服务是否可用（不抛错，只给状态） ---- */
  function status() {
    if (!window.WorkBuddyCloud || typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
      return Promise.resolve({ ready: false, reason: 'SDK 未加载（离线或 CDN 不可达）' });
    }
    return ensureClient().then(function () {
      return { ready: true, reason: '' };
    }).catch(function (e) {
      return { ready: false, reason: e && e.message ? e.message : '不可用' };
    });
  }

  window.PNCloud = {
    status: status,
    llm: llm,
    auth: auth,
    saves: saves,
    table: TABLE
  };
})();
