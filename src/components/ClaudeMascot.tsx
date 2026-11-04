import type { CSSProperties } from 'react'

// 픽셀 마스코트(16×10 칸). 몸통·팔·다리는 강조색, 눈은 테마와 상관없이 짙은 색으로 고정한다.
// width 는 16 의 배수일 때 칸 경계가 선명하다. 높이는 비율(10/16)로 정해진다.
export default function ClaudeMascot({ width, style }: { width: number; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 16 10" width={width} height={(width * 10) / 16} shapeRendering="crispEdges" aria-hidden="true" style={{ flexShrink: 0, ...style }}>
      <g fill="var(--accent)">
        <rect x="2" y="0" width="12" height="8" />
        <rect x="0" y="3" width="2" height="2" />
        <rect x="14" y="3" width="2" height="2" />
        <rect x="3" y="8" width="1" height="2" />
        <rect x="5" y="8" width="1" height="2" />
        <rect x="10" y="8" width="1" height="2" />
        <rect x="12" y="8" width="1" height="2" />
      </g>
      <g fill="#141413">
        <rect x="4" y="2" width="1" height="2" />
        <rect x="11" y="2" width="1" height="2" />
      </g>
    </svg>
  )
}
