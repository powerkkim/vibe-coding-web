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
export function estimateCost(modelId: string, usage: Pick<TokenUsage, 'promptTokens' | 'cacheWriteTokens' | 'cacheReadTokens' | 'completionTokens'>): number {
  const model = MODELS.find((m) => m.id === modelId)
  if (!model) return 0
  // 긴 프롬프트 판정은 캐시 토큰을 포함한 전체 입력 기준이다(Anthropic 가격표).
  const over = model.longPrompt && usage.promptTokens > model.longPrompt.overTokens
  const multiplier = over ? model.longPrompt!.multiplier : 1
  const uncached = usage.promptTokens - usage.cacheWriteTokens - usage.cacheReadTokens
  const input = uncached * model.inputPerMTok
    + usage.cacheWriteTokens * model.inputPerMTok * CACHE_WRITE_MULTIPLIER
    + usage.cacheReadTokens * model.cacheReadPerMTok
  return ((input + usage.completionTokens * model.outputPerMTok) * multiplier) / 1_000_000
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
  const next: UsageTotals = {
    day: current.day,
    todayCost: current.todayCost + cost,
    totalCost: current.totalCost + cost,
    totalTokens: current.totalTokens + usage.totalTokens,
  }
  save(next)
  return next
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
