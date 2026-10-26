'use client'

import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Sparkles, Stars } from '@react-three/drei'
import * as THREE from 'three'
import { Astronaut } from './hero-astronaut'

export type HeroSceneVariant = 'orbit' | 'nebula' | 'solar'

const SCENES: Record<
  HeroSceneVariant,
  {
    earth: [number, number, number]
    astronaut: [number, number, number]
    ring: string
    sun: [number, number, number]
    star: string
  }
> = {
  orbit: {
    earth: [1.45, 0, -0.25],
    astronaut: [3.65, 0.05, 0.9],
    ring: '#f5c76a',
    sun: [-9.2, 1.4, -4],
    star: '#bae6fd',
  },
  nebula: {
    earth: [1.55, -0.35, -0.8],
    astronaut: [3.45, 0.8, 0.6],
    ring: '#67e8f9',
    sun: [-10, 2.4, -5],
    star: '#c4b5fd',
  },
  solar: {
    earth: [2.05, 0.2, -1.2],
    astronaut: [3.8, -0.35, 1],
    ring: '#fbbf24',
    sun: [-8.6, 0.4, -3.8],
    star: '#fde68a',
  },
}

function terrain(x: number, y: number, z: number) {
  return (
    Math.sin(x * 5.3 + 0.7) * Math.cos(y * 4.1 - 0.2) * 0.55 +
    Math.sin(z * 6.2 + 1.3) * 0.25 +
    Math.cos((x + z) * 3.6) * 0.2 +
    Math.cos(y * 8.0) * 0.1
  )
}

function useLowPolyEarthGeometry() {
  const geometry = useMemo(() => {
    const flat = new THREE.IcosahedronGeometry(2.1, 2)
    const position = flat.attributes.position
    const colors = new Float32Array(position.count * 3)
    const point = new THREE.Vector3()
    const color = new THREE.Color()

    for (let i = 0; i < position.count; i += 3) {
      point.set(0, 0, 0)
      for (let vertex = 0; vertex < 3; vertex += 1) {
        point.x += position.getX(i + vertex)
        point.y += position.getY(i + vertex)
        point.z += position.getZ(i + vertex)
      }
      point.normalize()

      const height = terrain(point.x, point.y, point.z)
      const ice = Math.abs(point.y) > 0.82
      if (ice) color.set('#b9d9ec')
      else if (height > 0.3) color.set(point.y > 0.15 ? '#7e8f52' : '#3f8b68')
      else if (height > 0.12) color.set('#2c7b74')
      else color.set(point.z > 0 ? '#155b86' : '#0d3d69')

      for (let vertex = 0; vertex < 3; vertex += 1) {
        const index = (i + vertex) * 3
        colors[index] = color.r
        colors[index + 1] = color.g
        colors[index + 2] = color.b
      }
    }

    flat.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    flat.computeVertexNormals()
    return flat
  }, [])

  useEffect(() => () => geometry.dispose(), [geometry])
  return geometry
}

function Earth({
  position,
  scale,
  ringColor,
  pointer,
}: {
  position: [number, number, number]
  scale: number
  ringColor: string
  pointer: RefObject<{ x: number; y: number }>
}) {
  const group = useRef<THREE.Group>(null)
  const earth = useRef<THREE.Mesh>(null)
  const geometry = useLowPolyEarthGeometry()

  useFrame((state, delta) => {
    if (earth.current) {
      earth.current.rotation.y += delta * 0.05
      earth.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.1) * 0.04
    }
    if (!group.current) return
    const p = pointer.current
    group.current.position.x = THREE.MathUtils.damp(group.current.position.x, position[0] + p.x * 0.13, 3, delta)
    group.current.position.y = THREE.MathUtils.damp(group.current.position.y, position[1] + p.y * 0.08, 3, delta)
  })

  return (
    <group ref={group} position={position} scale={scale}>
      <mesh ref={earth} geometry={geometry} castShadow>
        <meshStandardMaterial
          vertexColors
          flatShading
          roughness={0.68}
          metalness={0.1}
          emissive="#06243d"
          emissiveIntensity={0.28}
        />
      </mesh>

      <mesh rotation={[0.18, 0, -0.08]}>
        <torusGeometry args={[2.62, 0.014, 8, 160]} />
        <meshStandardMaterial color={ringColor} emissive={ringColor} emissiveIntensity={2.4} toneMapped={false} />
      </mesh>
      <mesh rotation={[0.18, 0, -0.08]} scale={1.015}>
        <torusGeometry args={[2.62, 0.045, 8, 160]} />
        <meshBasicMaterial color={ringColor} transparent opacity={0.16} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      <mesh position={[1.55, 1.75, 0.8]} scale={0.055}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial color="#fef3c7" toneMapped={false} />
      </mesh>
    </group>
  )
}

function Sun({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh scale={3}>
        <sphereGeometry args={[1, 24, 24]} />
        <meshBasicMaterial color="#ffb45b" toneMapped={false} />
      </mesh>
      <mesh scale={3.8}>
        <sphereGeometry args={[1, 24, 24]} />
        <meshBasicMaterial color="#ff8a24" transparent opacity={0.14} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  )
}

function Scene({
  variant,
  pointer,
}: {
  variant: HeroSceneVariant
  pointer: RefObject<{ x: number; y: number }>
}) {
  const { size } = useThree()
  const mobile = size.width < 768
  const scene = SCENES[variant]

  const earthPosition: [number, number, number] = mobile ? [1.05, -1.15, -0.8] : scene.earth
  const astronautPosition: [number, number, number] = mobile ? [1.8, 1.55, 0.4] : scene.astronaut
  const earthScale = mobile ? 0.66 : 0.92
  const astronautScale = mobile ? 0.48 : 0.72
  const sunPosition: [number, number, number] = mobile ? [-7.8, 2.3, -5] : scene.sun

  return (
    <>
      <ambientLight intensity={0.42} color="#7dd3fc" />
      <directionalLight position={[-10, 2, 5]} intensity={4.2} color="#ffd6a3" />
      <directionalLight position={[4, 3, 6]} intensity={1.6} color="#bae6fd" />
      <pointLight position={[-4, 0, 3]} intensity={22} distance={16} color="#fbbf24" />
      <pointLight position={[4, -2, 2]} intensity={10} distance={12} color="#38bdf8" />

      <Stars radius={85} depth={50} count={mobile ? 1400 : 2600} factor={3.1} saturation={0} fade speed={0.2} />
      <Sparkles count={mobile ? 35 : 70} scale={[16, 9, 8]} size={1.4} speed={0.18} color={scene.star} opacity={0.55} />

      <Sun position={sunPosition} />
      <Earth position={earthPosition} scale={earthScale} ringColor={scene.ring} pointer={pointer} />
      <Astronaut position={astronautPosition} scale={astronautScale} pointer={pointer} />
    </>
  )
}

export function HeroSpaceScene({ variant }: { variant: HeroSceneVariant }) {
  const pointer = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointer.current.x = (event.clientX / window.innerWidth) * 2 - 1
      pointer.current.y = -(event.clientY / window.innerHeight) * 2 + 1
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  return (
    <Canvas
      dpr={[1, 1.6]}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      camera={{ position: [0, 0, 8.4], fov: 55 }}
      style={{ pointerEvents: 'none' }}
    >
      <Scene variant={variant} pointer={pointer} />
    </Canvas>
  )
}
