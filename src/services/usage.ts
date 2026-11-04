import { MODELS } from './ai'
import type { TokenUsage } from './ai'

/**
 * 이 브라우저에서 보낸 요청의 토큰·예상 비용 누적
 *
 * 예상 비용은 MODELS 단가로 계산한 근사값이다. fallback 모델이 처리한 요청 등은 실제 청구액과 다를 수 있다.
 * localStorage 를 쓸 수 없거나(사생활 보호 모드 등) 저장값이 깨져 있으면 0 에서 다시 시작한다.
 */
export interface UsageTotals {
  day: string        // 로컬 날짜 YYYY-MM-DD. 날짜가 바뀌면 today* 를 0 으로 되돌린다.
  todayCost: number
  totalCost: number
  totalTokens: number
}

const STORAGE_KEY = 'vibe_usage'
// 5분 TTL 캐시 쓰기는 입력 단가의 1.25배다(Anthropic 가격표, 모든 모델 공통).
const CACHE_WRITE_MULTIPLIER = 1.25

function today(): string {
  // sv 로캘은 YYYY-MM-DD 형식을 준다.
  return new Date().toLocaleDateString('sv')
}

function empty(): UsageTotals {
  return { day: today(), todayCost: 0, totalCost: 0, totalTokens: 0 }
}

/** 모델 단가로 계산한 요청 1건의 예상 비용(USD). 모르는 모델이면 0. */
export function estimateCost(modelId: string, usage: Pick<TokenUsage, 'promptTokens' | 'cacheWriteTokens' | 'cacheReadTokens' | 'completionTokens' | 'fast'>): number {
  const model = MODELS.find((m) => m.id === modelId)
  if (!model) return 0
  // 긴 프롬프트 판정은 캐시 토큰을 포함한 전체 입력 기준이다(Anthropic 가격표).
  const over = model.longPrompt && usage.promptTokens > model.longPrompt.overTokens
  const multiplier = over ? model.longPrompt!.multiplier : 1
  // 빠른 모드는 입·출력 단가가 바뀌고, 캐시 배율은 그 단가 위에 그대로 적용된다.
  const fast = usage.fast && model.fast
  const inputRate = fast ? model.fast!.inputPerMTok : model.inputPerMTok
  const outputRate = fast ? model.fast!.outputPerMTok : model.outputPerMTok
  const cacheReadRate = model.cacheReadPerMTok * (inputRate / model.inputPerMTok)
  const uncached = usage.promptTokens - usage.cacheWriteTokens - usage.cacheReadTokens
  const input = uncached * inputRate
    + usage.cacheWriteTokens * inputRate * CACHE_WRITE_MULTIPLIER
    + usage.cacheReadTokens * cacheReadRate
  return ((input + usage.completionTokens * outputRate) * multiplier) / 1_000_000
}

export function loadUsage(): UsageTotals {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<UsageTotals> | null
    const valid = parsed
      && typeof parsed.day === 'string'
      && [parsed.todayCost, parsed.totalCost, parsed.totalTokens].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    if (!valid) return empty()
    const totals = parsed as UsageTotals
    return totals.day === today() ? totals : { ...totals, day: today(), todayCost: 0 }
  } catch {
    return empty()
  }
}

function save(totals: UsageTotals): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(totals))
  } catch {
    // 저장 실패 시 이번 세션 화면 값만 유지된다.
  }
}

/** 요청 1건을 누적하고 새 합계를 돌려준다. */
export function addUsage(modelId: string, usage: TokenUsage): UsageTotals {
  const current = loadUsage()
  const cost = estimateCost(modelId, usage)
  spendBalance(cost)
  const next: UsageTotals = {
    day: current.day,
    todayCost: current.todayCost + cost,
    totalCost: current.totalCost + cost,
    totalTokens: current.totalTokens + usage.totalTokens,
  }
  save(next)
  return next
}

/**
 * 추정 잔액. Anthropic 은 일반 API 키로 잔액을 조회하는 API 를 제공하지 않으므로,
 * 사용자가 Console(Billing)에서 본 잔액을 입력하면 이후 예상 비용을 빼서 보여준다. 실제 청구액과 조금씩 어긋날 수 있다.
 * 사용량 '초기화'와는 따로 관리한다.
 */
export interface Balance {
  start: number   // 입력한 잔액(USD)
  spent: number   // 입력 이후 예상 비용 합계
  setAt: number
}
const BALANCE_KEY = 'vibe_balance'

export function loadBalance(): Balance | null {
  try {
    const b = JSON.parse(localStorage.getItem(BALANCE_KEY) ?? 'null') as Balance | null
    return b && Number.isFinite(b.start) && Number.isFinite(b.spent) ? b : null
  } catch {
    return null
  }
}

export function setBalance(amount: number | null): Balance | null {
  const b = amount === null ? null : { start: amount, spent: 0, setAt: Date.now() }
  try {
    if (b) localStorage.setItem(BALANCE_KEY, JSON.stringify(b))
    else localStorage.removeItem(BALANCE_KEY)
  } catch { /* 이번 세션만 유지 */ }
  return b
}

function spendBalance(cost: number) {
  const b = loadBalance()
  if (!b) return
  try { localStorage.setItem(BALANCE_KEY, JSON.stringify({ ...b, spent: b.spent + cost })) } catch { /* 무시 */ }
}

export function remainingBalance(b: Balance | null): number | null {
  return b ? b.start - b.spent : null
}

export function resetUsage(): UsageTotals {
  const next = empty()
  save(next)
  return next
}

/** $0.0043 → "$0.004", $1.237 → "$1.24" */
export function formatUsd(value: number): string {
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`
}
