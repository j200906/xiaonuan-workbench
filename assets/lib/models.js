/* 小暖 · 模型清单（唯一来源）
 * 以前 MODEL_BY_PROVIDER / PROVIDERS / AI_CHOICES 三处各写一份，改一处漏两处。
 * 现在所有地方都从这里取；云端模型由 /api/config 动态覆盖。 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};
  var t = XN.t || function (k) { return k; };

  var PROVIDERS = {
    custom: { label: '自定义（自己填地址和模型名）', base: '', model: '', editable: true },
    gateway: { label: '自迭代模型（本机网关）', base: '', model: '', gateway: true, secret: true },
    deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    moonshot: { label: 'Moonshot / Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    zhipu: { label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    siliconflow: { label: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    cloud: { label: '云端自带（无需填 Key）', base: '/api', model: '', cloud: true }
  };

  var MODELS = {
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-latest'],
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    zhipu: ['glm-4-flash', 'glm-4-plus'],
    siliconflow: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    custom: [],
    gateway: []
  };

  var DEFAULT_CLOUD = [
    { id: '@cf/zai-org/glm-4.7-flash', name: 'GLM-4.7-Flash', note: '云端唯一' }
  ];

  var cloudModels = DEFAULT_CLOUD.slice();
  var runtime = { gatewayBase: '', gatewayModel: '', gatewayReady: false, cloudEnabled: true };

  function setCloudModels(list) {
    if (Array.isArray(list) && list.length) {
      cloudModels = list.filter(function (m) { return m && m.id; }).map(function (m) {
        return { id: String(m.id), name: String(m.name || m.id), note: String(m.note || '') };
      });
      if (!cloudModels.length) cloudModels = DEFAULT_CLOUD.slice();
      /* 重新赋值后要把全局别名指过去，否则 XN.CLOUD_MODELS 还指着旧数组 */
      XN.CLOUD_MODELS = cloudModels;
    }
  }

  function setRuntime(next) {
    Object.keys(next || {}).forEach(function (k) { runtime[k] = next[k]; });
    runtime.gatewayReady = !!runtime.gatewayBase;
    if (next && next.cloudEnabled != null) runtime.cloudEnabled = !!next.cloudEnabled;
    PROVIDERS.gateway.base = runtime.gatewayReady ? runtime.gatewayBase : '';
    PROVIDERS.gateway.model = runtime.gatewayReady ? (runtime.gatewayModel || '') : '';
  }

  function provider(id) {
    return PROVIDERS[id] || PROVIDERS.custom;
  }

  function providerOfBase(base) {
    var b = String(base || '').replace(/\/+$/, '');
    if (!b) return 'custom';
    var hit = Object.keys(PROVIDERS).filter(function (k) {
      return PROVIDERS[k].base && PROVIDERS[k].base.replace(/\/+$/, '') === b;
    })[0];
    return hit || 'custom';
  }

  function isCloud(id) { return String(id || '').indexOf('@cf/') === 0; }

  function label(id) {
    var hit = cloudModels.filter(function (m) { return m.id === id; })[0];
    if (hit) return hit.name;
    for (var p in MODELS) {
      if (MODELS[p].indexOf(id) >= 0) return id;
    }
    return id || '';
  }

  /* 模型条的分组：自己的 API 在前，云端永远在最后 */
  function groups(providerId, current) {
    var prov = PROVIDERS[providerId] ? providerId : 'custom';
    var out = [];
    if (prov !== 'cloud') {
      var own = (MODELS[prov] || []).slice();
      if (current && !isCloud(current) && own.indexOf(current) < 0) own.unshift(current);
      var items = own.map(function (m) { return { id: m, name: m, note: '' }; });
      if (!items.length) {
        items.push({ id: '', name: t('chat.noProvider'), note: '', disabled: true });
      }
      out.push({ label: t('chat.ownApi'), items: items });
    }
    if (runtime.cloudEnabled) {
      out.push({
        label: t('chat.cloud'),
        items: cloudModels.map(function (m) { return { id: m.id, name: m.name, note: m.note }; })
      });
    }
    return out;
  }

  function all() { return { providers: PROVIDERS, models: MODELS, cloud: cloudModels }; }

  XN.models = {
    PROVIDERS: PROVIDERS,
    MODELS: MODELS,
    DEFAULT_CLOUD: DEFAULT_CLOUD,
    provider: provider,
    providerGroups: providerGroups,
    providerOfBase: providerOfBase,
    isCloud: isCloud,
    label: label,
    groups: groups,
    setCloudModels: setCloudModels,
    setRuntime: setRuntime,
    runtime: function () { return runtime; },
    all: all
  };
  /* 兼容旧名字 */
  XN.MODEL_BY_PROVIDER = MODELS;
  XN.CLOUD_MODELS = cloudModels;
})(typeof window !== 'undefined' ? window : globalThis);
