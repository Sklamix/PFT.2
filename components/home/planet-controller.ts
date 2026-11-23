import type { PlanetMode, PlanetSpotId } from './planet-spots'

type MarkerProjection = {
  x: number
  y: number
  facing: boolean
  onScreen: boolean
}

export class PlanetController {
  private body: HTMLDivElement | null = null
  private markers: Record<PlanetSpotId, HTMLButtonElement | null> = {
    challenges: null,
    rules: null,
    payouts: null,
    platforms: null,
    faq: null,
  }
  private rotationX = 0
  private rotationY = 0
  private velocityX = 0
  private velocityY = 0
  private dragging = false
  private hovered = false

  setBody(node: HTMLDivElement | null) {
    this.body = node
  }

  setMarker(id: PlanetSpotId, node: HTMLButtonElement | null) {
    this.markers[id] = node
  }

  startDrag() {
    this.dragging = true
    this.velocityX = 0
    this.velocityY = 0
  }

  dragBy(dx: number, dy: number, elapsedMs: number) {
    const sensitivity = 0.007
    this.rotationY += dx * sensitivity
    this.rotationX = Math.max(-0.56, Math.min(0.56, this.rotationX + dy * sensitivity * 0.5))
    this.velocityY = Math.max(-3.2, Math.min(3.2, (dx / elapsedMs) * 1000 * sensitivity))
    this.velocityX = Math.max(-1.4, Math.min(1.4, (dy / elapsedMs) * 1000 * sensitivity * 0.5))
  }

  finishDrag() {
    this.dragging = false
  }

  setHovered(hovered: boolean) {
    this.hovered = hovered
  }

  advance(delta: number, mode: PlanetMode, reducedMotion: boolean) {
    if (!this.dragging) {
      this.rotationY += this.velocityY * delta
      this.rotationX = Math.max(-0.56, Math.min(0.56, this.rotationX + this.velocityX * delta))
      const inertia = Math.exp(-3.8 * delta)
      this.velocityY *= inertia
      this.velocityX *= inertia
      if (!reducedMotion) this.rotationY += delta * 0.05 * (mode === 'hero' ? 1 : 0.6)
    }

    return {
      dragging: this.dragging,
      hovered: this.hovered,
      rotationX: this.rotationX,
      rotationY: this.rotationY,
    }
  }

  updateBody(x: number, y: number, radius: number) {
    if (!this.body) return
    this.body.style.width = `${radius * 2}px`
    this.body.style.height = `${radius * 2}px`
    this.body.style.transform = `translate3d(${x - radius}px, ${y - radius}px, 0)`
  }

  updateMarker(id: PlanetSpotId, projection: MarkerProjection) {
    const button = this.markers[id]
    if (!button) return
    const keyboardFocused = button === document.activeElement
    button.style.transform = `translate3d(${projection.x}px, ${projection.y}px, 0) translate(-50%, -50%)`
    button.style.opacity = projection.onScreen && (projection.facing || keyboardFocused) ? '1' : projection.onScreen ? '0.08' : '0'
    button.style.pointerEvents = projection.onScreen && projection.facing ? 'auto' : 'none'
    button.style.zIndex = projection.facing ? '2' : '0'
    button.dataset.facing = projection.facing ? 'true' : 'false'
  }
}
