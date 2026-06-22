import { useEffect, useRef, useCallback, type ReactNode, type CSSProperties } from 'react'

function resolveColor(color: string): string {
  if (!color.startsWith('var(')) return color
  const varName = color.replace('var(', '').replace(')', '').trim()
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return resolved || '#3A84FF'
}

function hexToRgba(hex: string, alpha = 1): string {
  if (!hex) return `rgba(0,0,0,${alpha})`
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const int = parseInt(h, 16)
  if (isNaN(int)) return `rgba(100,150,255,${alpha})`
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface ElectricBorderProps {
  children?: ReactNode
  color?: string
  speed?: number
  chaos?: number
  borderRadius?: number
  className?: string
  style?: CSSProperties
  active?: boolean
  /** Extra pixel padding around the content for the canvas */
  offset?: number
}

export default function ElectricBorder({
  children,
  color = '#3A84FF',
  speed = 1,
  chaos = 0.08,
  borderRadius = 6,
  className,
  style,
  active = true,
  offset = 4,
}: ElectricBorderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const animationRef = useRef<number | null>(null)
  const timeRef = useRef(0)
  const lastFrameTimeRef = useRef(0)

  const random = useCallback((x: number): number => {
    return (Math.sin(x * 12.9898) * 43758.5453) % 1
  }, [])

  const noise2D = useCallback(
    (x: number, y: number): number => {
      const i = Math.floor(x)
      const j = Math.floor(y)
      const fx = x - i
      const fy = y - j
      const a = random(i + j * 57)
      const b = random(i + 1 + j * 57)
      const c = random(i + (j + 1) * 57)
      const d = random(i + 1 + (j + 1) * 57)
      const ux = fx * fx * (3 - 2 * fx)
      const uy = fy * fy * (3 - 2 * fy)
      return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
    },
    [random]
  )

  const octavedNoise = useCallback(
    (
      x: number, octaves: number, lacunarity: number, gain: number,
      amplitude: number, frequency: number, time: number, seed: number, flatness: number
    ): number => {
      let sum = 0
      let amp = amplitude
      let freq = frequency
      for (let i = 0; i < octaves; i++) {
        sum += amp * (noise2D(x * freq + time + seed * 100, seed * 50 + i * 37.7) - 0.5 - flatness)
        amp *= gain
        freq *= lacunarity
      }
      return sum
    },
    [noise2D]
  )

  const getCornerPoint = useCallback(
    (centerX: number, centerY: number, radius: number, startAngle: number, arcLength: number, progress: number) => {
      const angle = startAngle + progress * arcLength
      return { x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle) }
    },
    []
  )

  const getRoundedRectPoint = useCallback(
    (t: number, left: number, top: number, width: number, height: number, radius: number): { x: number; y: number } => {
      const straightWidth = width - 2 * radius
      const straightHeight = height - 2 * radius
      const cornerArc = (Math.PI * radius) / 2
      const totalPerimeter = 2 * straightWidth + 2 * straightHeight + 4 * cornerArc
      const distance = t * totalPerimeter

      let accumulated = 0

      if (distance <= accumulated + straightWidth) {
        return { x: left + radius + ((distance - accumulated) / straightWidth) * straightWidth, y: top }
      }
      accumulated += straightWidth

      if (distance <= accumulated + cornerArc) {
        return getCornerPoint(left + width - radius, top + radius, radius, -Math.PI / 2, Math.PI / 2, (distance - accumulated) / cornerArc)
      }
      accumulated += cornerArc

      if (distance <= accumulated + straightHeight) {
        return { x: left + width, y: top + radius + ((distance - accumulated) / straightHeight) * straightHeight }
      }
      accumulated += straightHeight

      if (distance <= accumulated + cornerArc) {
        return getCornerPoint(left + width - radius, top + height - radius, radius, 0, Math.PI / 2, (distance - accumulated) / cornerArc)
      }
      accumulated += cornerArc

      if (distance <= accumulated + straightWidth) {
        return { x: left + width - radius - ((distance - accumulated) / straightWidth) * straightWidth, y: top + height }
      }
      accumulated += straightWidth

      if (distance <= accumulated + cornerArc) {
        return getCornerPoint(left + radius, top + height - radius, radius, Math.PI / 2, Math.PI / 2, (distance - accumulated) / cornerArc)
      }
      accumulated += cornerArc

      if (distance <= accumulated + straightHeight) {
        return { x: left, y: top + height - radius - ((distance - accumulated) / straightHeight) * straightHeight }
      }
      accumulated += straightHeight

      return getCornerPoint(left + radius, top + radius, radius, Math.PI, Math.PI / 2, (distance - accumulated) / cornerArc)
    },
    [getCornerPoint]
  )

  useEffect(() => {
    if (!active) {
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
      return
    }

    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const octaves = 6
    const lacunarity = 1.8
    const gain = 0.5
    const amplitude = chaos
    const frequency = 14
    const displacement = 6
    const borderOffset = offset

    // Flowing arc configuration — fewer, longer arcs that move smoothly
    const seLen: 0.18, baseSpeed: 0.08, phase: 0,       noiseSeed: 0 },
      { baseLen: 0.14, baseSpeed: 0.06, phase: 2.094,   noiseSeed: 50 },
      { baseLen: 0.22, baseSpeed: 0.10, phase: 4.189,   noiseSeed: 100 },
    ]

    const updateSize = () => {
      const rect = container.getBoundingClientRect()
      const w = rect.width + borderOffset * 2
      const h = rect.height + borderOffset * 2
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.scale(dpr, dpr)
      return { w, h }
    }

    let { w, h } = updateSize()
    let lastDpr = Math.min(window.devicePixelRatio || 1, 2)
    timeRef.current = 0
    lastFrameTimeRef.current = performance.now()

    const resolvedColor = resolveColor(color)

    const draw = (currentTime: number) => {
      if (!canvas || !ctx) return

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      if (dpr !== lastDpr) {
        lastDpr = dpr
        const s = updateSize()
        w = s.w
        h = s.h
      }

      const dt = (currentTime - lastFrameTimeRef.current) / 1000
      timeRef.current += dt * speed
      lastFrameTimeRef.current = currentTime

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.scale(dpr, dpr)

      const left = borderOffset
      const top = borderOffset
      const bw = w - 2 * borderOffset
      const bh = h - 2 * borderOffset
      const maxR = Math.min(bw, bh) / 2
      const r = Math.min(borderRadius, maxR)

      const perimeter = 2 * (bw + bh) + 2 * Math.PI * r
      const sampleCount = Math.floor(perimeter / 1.5)
      const t = timeRef.current

      // ── Faint base border (barely visible, slowly breathing) ──
      const baseAlpha = 0.06 + 0.03 * Math.sin(t * 0.8)
      ctx.strokeStyle = hexToRgba(resolvedColor, baseAlpha)
      ctx.lineWidth = 0.5
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      for (let i = 0; i <= sampleCount; i++) {
        const p = i / sampleCount
        const pt = getRoundedRectPoint(p, left, top, bw, bh, r)
        const xn = octavedNoise(p * 5, octaves - 2, lacunarity, gain, amplitude * 0.2, frequency, t * 0.3, 0, 0)
        const yn = octavedNoise(p * 5, octaves - 2, lacunarity, gain, amplitude * 0.2, frequency, t * 0.3, 1, 0)
        const px = pt.x + xn * displacement * 0.3
        const py = pt.y + yn * displacement * 0.3
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.stroke()

      // ── Flowing arc segments ──
      for (const cfg of arcConfigs) {
        // Smoothly moving position along perimeter
        const pos = (t * cfg.baseSpeed + cfg.phase) % 1

        // Gentle pulsing length
        const len = cfg.baseLen + 0.04 * Math.sin(t * 1.2 + cfg.phase)

        // Smooth brightness modulation — sine wave + subtle noise
        const brightness = 0.5 + 0.35 * Math.sin(t * 2.1 + cfg.phase * 0.7)
          + 0.15 * Math.sin(t * 5.3 + cfg.noiseSeed)
        const alpha = Math.max(0.05, Math.min(1, brightness))

        // Sample points along this arc
        const arcSamples = Math.max(24, Math.floor(len * sampleCount * 2))
        const arcPts: Array<{ x: number; y: number }> = []

        for (let j = 0; j <= arcSamples; j++) {
          const frac = j / arcSamples
          const tp = (pos + frac * len) % 1
          const pt = getRoundedRectPoint(tp, left, top, bw, bh, r)
          // Noise displacement — stronger in middle, tapers at edges
          const edgeFade = Math.sin(frac * Math.PI)
          const displaceAmt = displacement * edgeFade
          const xn = octavedNoise(tp * 8 + cfg.noiseSeed * 0.05, octaves, lacunarity, gain, amplitude, frequency, t * 1.5, 2 + cfg.noiseSeed * 0.01, 0)
          const yn = octavedNoise(tp * 8 + cfg.noiseSeed * 0.05, octaves, lacunarity, gain, amplitude, frequency, t * 1.5, 3 + cfg.noiseSeed * 0.01, 0)
          arcPts.push({ x: pt.x + xn * displaceAmt, y: pt.y + yn * displaceAmt })
        }

        if (arcPts.length < 2) continue

        // Tapered drawing: each segment gets its own width/alpha
        // Use a smooth power curve so taper is gradual
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'

        for (let j = 0; j < arcPts.length - 1; j++) {
          const frac = (j + 0.5) / (arcPts.length - 1)
          // Smooth taper: thick in middle, thin at both ends
          const taper = Math.sin(frac * Math.PI)
          // Ease the taper so edges stay visible longer
          const w = Math.pow(taper, 0.6)

          const segAlpha = alpha * (0.3 + 0.7 * w)

          // Glow layer
          ctx.strokeStyle = hexToRgba(resolvedColor, segAlpha * 0.35)
          ctx.lineWidth = 1.2 + w * 1.5  // range: ~1.2 – 2.7
          ctx.beginPath()
          ctx.moveTo(arcPts[j].x, arcPts[j].y)
          ctx.lineTo(arcPts[j + 1].x, arcPts[j + 1].y)
          ctx.stroke()

          // Core layer
          ctx.strokeStyle = hexToRgba(resolvedColor, segAlpha * 0.85)
          ctx.lineWidth = 0.3 + w * 0.7  // range: ~0.3 – 1.0
          ctx.beginPath()
          ctx.moveTo(arcPts[j].x, arcPts[j].y)
          ctx.lineTo(arcPts[j + 1].x, arcPts[j + 1].y)
          ctx.stroke()

          // White-hot center for the brightest segments
          if (segAlpha > 0.65) {
            ctx.strokeStyle = hexToRgba('#ffffff', (segAlpha - 0.65) * 0.5 * w)
            ctx.lineWidth = 0.15 + w * 0.35
            ctx.beginPath()
            ctx.moveTo(arcPts[j].x, arcPts[j].y)
            ctx.lineTo(arcPts[j + 1].x, arcPts[j + 1].y)
            ctx.stroke()
          }
        }
      }

      animationRef.current = requestAnimationFrame(draw)
    }

    const resizeObserver = new ResizeObserver(() => {
      const s = updateSize()
      w = s.w
      h = s.h
    })
    resizeObserver.observe(container)

    animationRef.current = requestAnimationFrame(draw)

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
      resizeObserver.disconnect()
    }
  }, [active, color, speed, chaos, borderRadius, offset, octavedNoise, getRoundedRectPoint])

  const resolvedGlow = hexToRgba(resolveColor(color), 0.6)

  return (
    <div
      ref={containerRef}
      className={`electric-border-wrapper${className ? ` ${className}` : ''}`}
      style={{
        position: 'relative',
        borderRadius,
        overflow: 'visible',
        isolation: 'isolate',
        ...style,
      }}
    >
      {active && (
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            zIndex: 2,
            display: 'block',
          }}
        />
      )}
      {active && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 'inherit',
              border: `1px solid ${resolvedGlow}`,
              filter: 'blur(1px)',
              boxSizing: 'border-box',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 'inherit',
              border: `1px solid ${resolveColor(color)}`,
              filter: 'blur(3px)',
              boxSizing: 'border-box',
            }}
          />
        </div>
      )}
      <div style={{ position: 'relative', borderRadius: 'inherit', zIndex: 1 }}>{children}</div>
    </div>
  )
}
