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

/**
 * Fresnel-based atmosphere shader. Rendered on an inward-facing (BackSide) shell
 * slightly larger than the planet, so the glow hugs the limb, is brightest on the
 * sunlit side, and fades into deep space with no geometric boundary.
 */
const ATMO_VERTEX = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDirW = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const ATMO_FRAGMENT = /* glsl */ `
  uniform vec3 uLightDir;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uPower;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDirW);
    float ndv = abs(dot(N, V));
    float fres = pow(clamp(1.0 - ndv, 0.0, 1.0), uPower);
    // Soft base on the shadow side, much brighter toward the lit limb.
    float lit = 0.16 + 0.84 * pow(clamp(dot(N, normalize(uLightDir)), 0.0, 1.0), 1.35);
    float a = clamp(fres * lit * uIntensity, 0.0, 1.0);
    gl_FragColor = vec4(uColor, a);
  }
`

type AtmoProps = {
  radius: number
  color: string
  intensity: number
  power: number
  lightDir: [number, number, number]
}

function Atmosphere({ radius, color, intensity, power, lightDir }: AtmoProps) {
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uLightDir: { value: new THREE.Vector3(...lightDir).normalize() },
        uColor: { value: new THREE.Color(color) },
        uIntensity: { value: intensity },
        uPower: { value: power },
      },
      vertexShader: ATMO_VERTEX,
      fragmentShader: ATMO_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    })
  }, [color, intensity, power, lightDir])

  useEffect(() => () => material.dispose(), [material])

  return (
    <mesh material={material}>
      <sphereGeometry args={[radius, 64, 64]} />
    </mesh>
  )
}

const LIGHT_DIR: [number, number, number] = [4, 2, 4]

function Venus({ exiting }: { exiting: boolean }) {
  const group = useRef<THREE.Group>(null)
  const mesh = useRef<THREE.Mesh>(null)
  const velocity = useRef(0)
  const texture = useMemo(() => makeVenusTexture(), [])

  useEffect(() => () => texture.dispose(), [texture])

  useFrame((_state, delta) => {
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
  })

  return (
    <group ref={group}>
      {/* A. Lit surface: warm, textured, one side lit / other in shadow */}
      <mesh ref={mesh}>
        <sphereGeometry args={[1.08, 64, 64]} />
        <meshStandardMaterial
          map={texture}
          roughness={0.92}
          metalness={0}
          emissive="#2f1809"
          emissiveIntensity={0.16}
        />
      </mesh>

      {/* B. Atmospheric rim glow — thin, bright golden edge on the lit limb */}
      <Atmosphere radius={1.08 * 1.14} color="#ffd98a" intensity={1.35} power={4.4} lightDir={LIGHT_DIR} />

      {/* C. Outer soft bloom — wide amber aura that dissolves into the black */}
      <Atmosphere radius={1.08 * 2.05} color="#d97a2e" intensity={0.42} power={3.0} lightDir={LIGHT_DIR} />
    </group>
  )
}

export function VenusScene({ exiting }: { exiting: boolean }) {
  return (
    <>
      <ambientLight intensity={0.4} color="#ffe0b8" />
      <directionalLight position={[4, 2, 4]} intensity={3.4} color="#ffd9a8" />
      <directionalLight position={[-4, -1, -2]} intensity={0.35} color="#5b3417" />
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
