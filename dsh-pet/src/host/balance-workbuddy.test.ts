/**
 * 自建网关余额源（kind `workbuddy2api`）的契约测试。
 *
 * 背景：WorkBuddy2API-Hub 跑在用户自己的机器/NAS 上，DSH 里被登记成 provider `custom`。
 * 插件不能把地址写进常量、也不能按 id 认人，于是取数入口是「配置声明」（queryBalanceSource）。
 *
 * 本文件钉住四件事：
 *   ① 真实报文 `{balance, unit, realm, accounts_enabled, accounts_with_credit_data, updated_at}`
 *      解析成 points 形态，单位中文化；
 *   ② `balance: null` 是「网关还没有快照」而非「0 积分」——必须显式失败；
 *   ③ 失败口径：非 2xx / 报文非法 / 缺凭证都落成带 reason 的失败，绝不伪造数字；
 *   ④ 地址拼接容忍 `.../v1` 与结尾斜杠，请求带 Bearer。
 *
 * 用 Node 内置 test runner，fetch 用手写 stub 顶替（只跑假数据，不联网）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseBalanceSummary, queryBalanceSource, summaryUrl, WORKBUDDY_KIND } from './balance/index.ts';
import type { BalanceResult, BalanceSourceConfig } from './balance/index.ts';

/** 线上真实报文（2026-11-03 取自用户 NAS 部署的网关，5 个账号、国内区） */
const REAL = {
  balance: 23405.58,
  unit: 'credit',
  realm: 'cn',
  accounts_enabled: 5,
  accounts_with_credit_data: 5,
  updated_at: 1793696300.8979034,
};

/** 一份齐备的余额源声明 */
function source(over: Partial<BalanceSourceConfig> = {}): BalanceSourceConfig {
  return {
    provider: 'custom',
    kind: WORKBUDDY_KIND,
    baseUrl: 'https://nas.example.test:8788',
    credential: 'CUSTOM_API_KEY',
    ...over,
  };
}

/** 取成功的积分读数；形状不对直接失败（省得每个用例都写一遍收窄） */
function pointsOf(result: BalanceResult): { unit: string; total: string } {
  if (!result.ok || result.shape !== 'points') {
    assert.fail('期望 points 的成功结果，实际：' + JSON.stringify(result));
  }
  return result.data;
}

/** 极简 Response 替身：被测代码只用到 ok / status / json() */
function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** 装上 fetch stub（可抛错模拟网络失败）；返回记录与卸载函数 */
function stubFetch(handler: (url: string, key: string | null) => Response): {
  calls: string[];
  auths: (string | null)[];
  restore: () => void;
} {
  const calls: string[] = [];
  const auths: (string | null)[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = new Headers(init?.headers).get('authorization');
    calls.push(url);
    auths.push(key);
    return Promise.resolve(handler(url, key));
  }) as unknown as typeof fetch;
  return {
    calls,
    auths,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

describe('summaryUrl：地址拼接', () => {
  test('原样拼接接口路径', () => {
    assert.equal(summaryUrl('https://nas.example.test:8788'), 'https://nas.example.test:8788/v1/balance-summary');
  });

  test('结尾斜杠不产生双斜杠', () => {
    assert.equal(summaryUrl('https://nas.example.test:8788///'), 'https://nas.example.test:8788/v1/balance-summary');
  });

  test('按 OpenAI 习惯写成 .../v1 也认（不会拼出 /v1/v1）', () => {
    assert.equal(summaryUrl('https://nas.example.test:8788/v1'), 'https://nas.example.test:8788/v1/balance-summary');
    assert.equal(summaryUrl('https://nas.example.test:8788/V1/'), 'https://nas.example.test:8788/v1/balance-summary');
  });

  test('两端空白被吃掉（从 yaml/jsonc 里复制粘贴常见）', () => {
    assert.equal(summaryUrl('  https://nas.example.test:8788  '), 'https://nas.example.test:8788/v1/balance-summary');
  });
});

describe('parseBalanceSummary：真实报文', () => {
  test('单位 credit 中文化为「积分」，积分保留两位小数', () => {
    const data = pointsOf(parseBalanceSummary(REAL, 'custom'));
    assert.deepEqual(data, { unit: '积分', total: '23405.58' });
  });

  test('整数不带小数尾巴', () => {
    const data = pointsOf(parseBalanceSummary({ balance: 1200, unit: 'credit' }, 'custom'));
    assert.equal(data.total, '1200');
  });

  test('provider 原样回填', () => {
    const result = parseBalanceSummary(REAL, 'custom');
    assert.equal(result.provider, 'custom');
  });

  test('认不出的单位原样透传，缺 unit 时用默认中文单位', () => {
    assert.equal(pointsOf(parseBalanceSummary({ balance: 5, unit: 'tokens' }, 'x')).unit, 'tokens');
    assert.equal(pointsOf(parseBalanceSummary({ balance: 5 }, 'x')).unit, '积分');
    assert.equal(pointsOf(parseBalanceSummary({ balance: 5, unit: '   ' }, 'x')).unit, '积分');
  });

  test('单位大小写不敏感', () => {
    assert.equal(pointsOf(parseBalanceSummary({ balance: 5, unit: 'CREDIT' }, 'x')).unit, '积分');
  });

  test('多余字段（realm / accounts_* / updated_at）不影响解析', () => {
    const data = pointsOf(parseBalanceSummary({ ...REAL, extra: { deep: [1, 2] } }, 'custom'));
    assert.deepEqual(data, { unit: '积分', total: '23405.58' });
  });
});

describe('parseBalanceSummary：未知与非法一律抛错（绝不伪造 0）', () => {
  test('balance 为 null = 网关还没有快照，不是 0 积分', () => {
    assert.throws(
      () => parseBalanceSummary({ balance: null, unit: 'credit', accounts_enabled: 0 }, 'x'),
      /暂无积分快照/,
    );
  });

  test('balance 缺失同样算未知', () => {
    assert.throws(() => parseBalanceSummary({ unit: 'credit' }, 'x'), /暂无积分快照/);
  });

  test('balance 非数字抛错', () => {
    assert.throws(() => parseBalanceSummary({ balance: 'abc' }, 'x'), /余额数据非法字段/);
  });

  test('负积分抛错（网关不该给出负数）', () => {
    assert.throws(() => parseBalanceSummary({ balance: -1 }, 'x'), /积分余额为负/);
  });

  test('响应不是对象抛错', () => {
    assert.throws(() => parseBalanceSummary(null, 'x'), /不是对象/);
    assert.throws(() => parseBalanceSummary([1, 2], 'x'), /不是对象/);
  });
});

describe('queryBalanceSource：改道与失败口径', () => {
  test('成功：请求带 Bearer，结果带 provider 与积分', async () => {
    const stub = stubFetch(() => res(REAL));
    try {
      const result = await queryBalanceSource(source(), async (ref) =>
        ref === 'CUSTOM_API_KEY' ? 'k-123' : undefined,
      );
      assert.deepEqual(pointsOf(result), { unit: '积分', total: '23405.58' });
      assert.equal(result.provider, 'custom');
      assert.deepEqual(stub.calls, ['https://nas.example.test:8788/v1/balance-summary']);
      assert.deepEqual(stub.auths, ['Bearer k-123']);
    } finally {
      stub.restore();
    }
  });

  test('凭证按配置里的名字取：拿不到 Key 不发请求', async () => {
    const stub = stubFetch(() => res(REAL));
    try {
      const result = await queryBalanceSource(source({ credential: 'MISSING_KEY' }), async () => undefined);
      assert.deepEqual(result, {
        ok: false,
        provider: 'custom',
        reason: 'credential-missing',
        message: '缺少凭证 MISSING_KEY',
      });
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });

  test('未知 kind = unsupported，不发请求', async () => {
    const stub = stubFetch(() => res(REAL));
    try {
      const result = await queryBalanceSource(source({ kind: 'nope' }), async () => 'k');
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.reason, 'unsupported');
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });

  test('非 2xx → fetch-error，message 带状态码', async () => {
    const stub = stubFetch(() => res({ error: 'invalid api key' }, 401));
    try {
      const result = await queryBalanceSource(source(), async () => 'k');
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.reason, 'fetch-error');
      assert.match(!result.ok ? String(result.message) : '', /HTTP 401/);
    } finally {
      stub.restore();
    }
  });

  test('400 与 500 都落成 fetch-error（不因 4xx 当成「配置错误」静默）', async () => {
    for (const status of [400, 500, 502]) {
      const stub = stubFetch(() => res({}, status));
      try {
        const result = await queryBalanceSource(source(), async () => 'k');
        assert.equal(!result.ok && result.reason, 'fetch-error', 'status ' + status);
      } finally {
        stub.restore();
      }
    }
  });

  test('balance 为 null → fetch-error（气泡会弹文字说明）', async () => {
    const stub = stubFetch(() => res({ balance: null, unit: 'credit' }));
    try {
      const result = await queryBalanceSource(source(), async () => 'k');
      assert.equal(!result.ok && result.reason, 'fetch-error');
      assert.match(!result.ok ? String(result.message) : '', /暂无积分快照/);
    } finally {
      stub.restore();
    }
  });

  test('网络抖动：第一次抛错、第二次成功（沿用统一重试策略）', async () => {
    let n = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (() => {
      n++;
      if (n === 1) return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve(res(REAL));
    }) as unknown as typeof fetch;
    try {
      const result = await queryBalanceSource(source(), async () => 'k');
      assert.equal(result.ok, true);
      assert.equal(n, 2);
    } finally {
      globalThis.fetch = real;
    }
  });
});
