/**
 * WorkBuddy2API-Hub 网关路由（kind `workbuddy2api`）：剩余积分。
 *
 * 取 GET {baseUrl}/v1/balance-summary，把网关侧多个账号的剩余积分（缓存快照）合成一个数字，
 * 以 points 形态交给展示层。该接口只读网关内存里的快照、不触发上游刷新（见网关的
 * credit_balance_summary 注释），因此适合按余额周期反复轮询。
 *
 * 与内置服务商的两点不同（它们决定了本文件不登记进 ./registry.ts）：
 *   ① 地址不是常量：网关跑在用户自己的机器/NAS 上，还得穿透隧道，只能由配置给出；
 *   ② 命中的 provider id 也不固定：DSH 里这类自定义端点通常都叫 `custom`，
 *      把 `custom` 硬写进内置名录会把「任何自定义端点」都认成这个网关。
 * 所以取数入口是 host/balance/index.ts 的 queryBalanceSource（配置声明 → 协议实现），
 * 本文件只负责「这套协议怎么请求、怎么解析」。
 *
 * 始终成立：balance 为 null（网关还没有任何账号上报过积分）算「未知」并抛错，不伪造 0；
 * 数字只做展示格式化，不重算、不折算、不猜基准（因此不产生档位动画）。
 *
 * @module dsh-pet/src/host/balance/providers/workbuddy2api
 */
import { fetchWithRetry, num, obj } from '../internal.ts';
import type { BalanceSuccess } from '../types.ts';

/** 配置里 kind 的取值：queryBalanceSource 据此分派到本协议。 */
export const WORKBUDDY_KIND = 'workbuddy2api';

/** 余额接口路径（相对 baseUrl）。 */
const SUMMARY_PATH = '/v1/balance-summary';

/**
 * 网关回传的单位串 → 气泡里的中文单位。
 * 网关固定回 `credit`；其余同义词一并收下，免得将来它改个说法就在气泡里露出英文。
 */
const UNIT_LABELS: Record<string, string> = {
  credit: '积分',
  credits: '积分',
  point: '积分',
  points: '积分',
};

/** 认不出的单位一律用这个：气泡是中文界面，宁可统一词也不留半截英文。 */
const DEFAULT_UNIT = '积分';

/**
 * 拼接口地址：去掉 baseUrl 结尾的斜杠，并容忍用户按 OpenAI 客户端习惯写成 `.../v1`。
 * @param baseUrl - 网关卡根地址（配置里的 baseUrl）
 * @returns 指向 /v1/balance-summary 的完整地址
 */
export function summaryUrl(baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  return root + SUMMARY_PATH;
}

/** 展示用数字串：整数不带小数尾巴，其余保留两位（网关本身就是两位小数）。 */
function totalText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** 单位文案：认识的中文单位表优先，其次原样透传网关给的串，都没有才用默认。 */
function unitLabel(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_UNIT;
  const text = raw.trim();
  const known = UNIT_LABELS[text.toLowerCase()];
  if (known !== undefined) return known;
  return text.length > 0 ? text : DEFAULT_UNIT;
}

/**
 * 解析 /v1/balance-summary 的响应（真实报文见 workbuddy.test.ts）。
 * @param body - 已 json() 的响应体
 * @param provider - 命中的 provider id，原样回填进结果
 * @returns points 形态的成功结果（unit 已中文化，total 是展示串）
 * @throws 响应不是对象、balance 缺失或为 null（未知≠0）、数字非法或为负时
 */
export function parseBalanceSummary(body: unknown, provider: string): BalanceSuccess {
  const o = obj(body);
  if (!o) throw new Error('dsh-pet: workbuddy 积分响应不是对象');
  // null 是「网关还没有任何账号的积分快照」，与「余额 0」是两件事：前者必须显式失败。
  if (o.balance === null || o.balance === undefined) {
    throw new Error('dsh-pet: workbuddy 网关暂无积分快照（还没有账号上报过积分）');
  }
  const total = num(o.balance, 'balance');
  if (total < 0) throw new Error('dsh-pet: workbuddy 积分余额为负：' + total);
  return { ok: true, provider, shape: 'points', data: { unit: unitLabel(o.unit), total: totalText(total) } };
}

/**
 * 取一次积分快照（超时与重试沿用 ./internal 的统一策略）并解析。
 * @param baseUrl - 网关卡根地址
 * @param key - 网关 API Key（以 Bearer 发出）
 * @param provider - 命中的 provider id，原样回填进结果
 * @returns points 形态的成功结果
 * @throws 网络失败、非 2xx、报文非法时——由 queryBalanceSource 统一落成 fetch-error
 */
export async function fetchBalanceSummary(baseUrl: string, key: string, provider: string): Promise<BalanceSuccess> {
  const res = await fetchWithRetry(summaryUrl(baseUrl), key);
  if (!res.ok) throw new Error('workbuddy balance HTTP ' + res.status);
  return parseBalanceSummary(await res.json(), provider);
}
