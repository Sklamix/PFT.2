'use client'

import { useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * Procedurally generated Venus surface texture: warm golden-brown cloud bands
 * with soft noise splotches, drawn once onto a canvas and wrapped as a texture.
 * No external asset is required, so the scene never breaks on a missing file.
 */
function makeVenusTexture(): THREE.CanvasTexture {
  const w = 1024
  const h = 512
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const texture = new THREE.CanvasTexture(canvas)
  if (!ctx) return texture

  // Base vertical gradient (deep shadow → warm core → deep shadow).
  const base = ctx.createLinearGradient(0, 0, 0, h)
  base.addColorStop(0, '#2f1d10')
  base.addColorStop(0.2, '#6e3f1c')
  base.addColorStop(0.4, '#bd8547')
  base.addColorStop(0.5, '#d9a05c')
  base.addColorStop(0.6, '#b57a3c')
  base.addColorStop(0.82, '#6e4220')
  base.addColorStop(1, '#1f1208')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, w, h)

  // Broad horizontal cloud bands (soft screen blend).
  for (let i = 0; i < 28; i += 1) {
    const y = Math.random() * h
    const bandH = 8 + Math.random() * 42
    const alpha = 0.05 + Math.random() * 0.13
    const band = ctx.createLinearGradient(0, y - bandH, 0, y + bandH)
    band.addColorStop(0, 'rgba(244,214,166,0)')
    band.addColorStop(0.5, `rgba(255,226,178,${alpha})`)
    band.addColorStop(1, 'rgba(244,214,166,0)')
    ctx.fillStyle = band
    ctx.fillRect(0, y - bandH, w, bandH * 2)
  }

  // Texture detail splotches, wrapped horizontally to hide the seam.
  for (let i = 0; i < 230; i += 1) {
    const x = Math.random() * w
    const y = Math.random() * h
    const r = 8 + Math.random() * 48
    const warm = Math.random() > 0.5
    const color = warm
      ? `rgba(246,220,178,${0.04 + Math.random() * 0.1})`
      : `rgba(84,48,20,${0.05 + Math.random() * 0.12})`
    for (const dx of [0, -w, w]) {
      const splotch = ctx.createRadialGradient(x + dx, y, 0, x + dx, y, r)
      splotch.addColorStop(0, color)
      splotch.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = splotch
      ctx.fillRect(x + dx - r, y - r, r * 2, r * 2)
    }
  }

  // Faint vertical cloud columns for a gentle streaked look.
  ctx.globalAlpha = 0.04
  ctx.fillStyle = '#ffd9a0'
  for (let i = 0; i < 130; i += 1) {
    const x = Math.random() * w
    const y = Math.random() * h
    ctx.fillRect(x, y, 1 + Math.random() * 2, 18 + Math.random() * 66)
  }
  ctx.globalAlpha = 1

  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

function Venus({ exiting }: { exiting: boolean }) {
  const group = useRef<THREE.Group>(null)
  const mesh = useRef<THREE.Mesh>(null)
  const velocity = useRef(0)
  const texture = useMemo(() => makeVenusTexture(), [])

  useEffect(() => () => texture.dispose(), [texture])

  useFrame((state, delta) => {
    if (mesh.current && !exiting) {
      // Continuous self-rotation, independent of frame rate.
      mesh.current.rotation.y += delta * 0.1
    }
    if (!group.current) return
    if (exiting) {
      // Accelerate to the right and out of frame with a slight roll.
      velocity.current = Math.min(velocity.current + delta * 3.4, 3.4)
      group.current.position.x += delta * velocity.current * 2.6
      group.current.rotation.z += delta * 0.14
      if (mesh.current) mesh.current.rotation.y += delta * 0.6
    }
    // Subtle breathing of the atmosphere is handled by the static light.
    void state
  })

  return (
    <group ref={group}>
      <mesh ref={mesh}>
        <sphereGeometry args={[1.08, 64, 64]} />
        <meshStandardMaterial
          map={texture}
          roughness={0.96}
          metalness={0}
          emissive="#3a1e0c"
          emissiveIntensity={0.22}
        />
      </mesh>
      {/* Soft warm atmosphere rim */}
      <mesh scale={1.05}>
        <sphereGeometry args={[1.08, 48, 48]} />
        <meshBasicMaterial
          color="#ffb46b"
          transparent
          opacity={0.1}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.BackSide}
        />
      </mesh>
      {/* Outer golden-orange halo, matching the hero Earth's glow treatment */}
      <mesh scale={2.6}>
        <sphereGeometry args={[1.08, 32, 32]} />
        <meshBasicMaterial
          color="#f59e0b"
          transparent
          opacity={0.08}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* Tight rim-light glow hugging the limb */}
      <mesh scale={1.18}>
        <sphereGeometry args={[1.08, 48, 48]} />
        <meshBasicMaterial
          color="#ffce8a"
          transparent
          opacity={0.14}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.BackSide}
        />
      </mesh>
    </group>
  )
}

export function VenusScene({ exiting }: { exiting: boolean }) {
  return (
    <>
      <ambientLight intensity={0.6} color="#ffe0b8" />
      <directionalLight position={[4, 2, 4]} intensity={2.6} color="#ffd9a8" />
      <directionalLight position={[-4, -1, -2]} intensity={0.5} color="#5b3417" />
      <pointLight position={[3, -1, 2]} intensity={7} distance={11} color="#ff9d4d" />
      {/* Warm backlight so the glow reads as Venus's own radiance */}
      <pointLight position={[-2.2, 0.4, -1.4]} intensity={9} distance={9} color="#ff8a3c" />
      <Venus exiting={exiting} />
    </>
  )
}

export function VenusCanvas({ exiting }: { exiting: boolean }) {
  return (
    <Canvas
      dpr={[1, 1.6]}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      camera={{ position: [0, 0, 4.4], fov: 44 }}
      style={{ pointerEvents: 'none' }}
    >
      <VenusScene exiting={exiting} />
    </Canvas>
  )
}
