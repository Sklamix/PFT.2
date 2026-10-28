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
    ring: string
    star: string
  }
> = {
  orbit: {
    ring: '#f5c76a',
    star: '#bae6fd',
  },
  nebula: {
    ring: '#67e8f9',
    star: '#c4b5fd',
  },
  solar: {
    ring: '#fbbf24',
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
  motionScale,
}: {
  position: [number, number, number]
  scale: number
  ringColor: string
  pointer: RefObject<{ x: number; y: number }>
  motionScale: number
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
    group.current.position.x = THREE.MathUtils.damp(
      group.current.position.x,
      position[0] + p.x * 0.13 * motionScale,
      3,
      delta,
    )
    group.current.position.y = THREE.MathUtils.damp(
      group.current.position.y,
      position[1] + p.y * 0.08 * motionScale,
      3,
      delta,
    )
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

      {/* Outer cyan/blue atmosphere glow around the planet perimeter */}
      <mesh scale={2.4}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.1} blending={THREE.AdditiveBlending} depthWrite={false} />
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

function Scene({
  variant,
  pointer,
}: {
  variant: HeroSceneVariant
  pointer: RefObject<{ x: number; y: number }>
}) {
  const { size, camera } = useThree()
  const mobile = size.width < 768
  const aspect = size.width / Math.max(size.height, 1)
  const portrait = !mobile && aspect < 1.05
  const wide = size.width >= 1600
  const large = size.width >= 1200
  const scene = SCENES[variant]

  const perspectiveCamera = camera as THREE.PerspectiveCamera
  const tangent = Math.tan(THREE.MathUtils.degToRad(perspectiveCamera.fov / 2))
  const positionAt = (x: number, y: number, z: number): [number, number, number] => {
    const viewHeight = 2 * tangent * (perspectiveCamera.position.z - z)
    return [(x - 0.5) * viewHeight * aspect, (0.5 - y) * viewHeight, z]
  }
  const pixelsPerWorldUnitAt = (z: number) =>
    size.height / (2 * tangent * (perspectiveCamera.position.z - z))

  const earthZ = mobile || portrait ? -0.8 : wide ? -0.45 : -0.55
  const astronautZ = mobile || portrait ? 0.4 : 1
  const earthPoint: [number, number] = mobile
    ? [0.52, 0.7]
    : portrait
      ? [0.62, 0.68]
      : wide
        ? [0.7, 0.5]
        : large
          ? [0.72, 0.5]
          : [0.76, 0.55]
  const astronautPoint: [number, number] = mobile
    ? [0.62, 0.3]
    : portrait
      ? [0.76, 0.28]
      : wide
        ? [0.88, 0.52]
        : large
          ? [0.88, 0.52]
          : [0.8, 0.25]
  const earthRadiusPx = mobile
    ? Math.min(size.height * 0.15, size.width * 0.28)
    : portrait
      ? Math.min(size.height * 0.19, size.width * 0.22)
      : wide
        ? Math.min(size.height * 0.33, size.width * 0.16)
        : large
          ? Math.min(size.height * 0.29, size.width * 0.12)
          : Math.min(size.height * 0.22, size.width * 0.15)
  const astronautHeightPx = mobile
    ? Math.min(size.height * 0.14, size.width * 0.3)
    : portrait
      ? Math.min(size.height * 0.16, size.width * 0.2)
      : wide
        ? Math.min(size.height * 0.34, size.width * 0.16)
        : large
          ? Math.min(size.height * 0.24, size.width * 0.13)
          : Math.min(size.height * 0.18, size.width * 0.17)
  const earthPosition = positionAt(earthPoint[0], earthPoint[1], earthZ)
  const astronautPosition = positionAt(astronautPoint[0], astronautPoint[1], astronautZ)
  const earthScale = earthRadiusPx / (2.62 * pixelsPerWorldUnitAt(earthZ))
  const astronautScale = astronautHeightPx / (3 * pixelsPerWorldUnitAt(astronautZ))
  const motionScale = Math.min(1, 900 / Math.max(size.height, 1)) * 0.65

  return (
    <>
      <ambientLight intensity={0.42} color="#7dd3fc" />
      <directionalLight position={[-10, 2, 5]} intensity={4.2} color="#ffd6a3" />
      <directionalLight position={[4, 3, 6]} intensity={1.6} color="#bae6fd" />
      <pointLight position={[-4, 0, 3]} intensity={22} distance={16} color="#fbbf24" />
      <pointLight position={[4, -2, 2]} intensity={10} distance={12} color="#38bdf8" />

      <Stars radius={85} depth={50} count={mobile ? 1400 : wide ? 3400 : 2600} factor={3.1} saturation={0} fade speed={0.2} />
      <Sparkles count={mobile ? 35 : wide ? 90 : 70} scale={[16, 9, 8]} size={1.4} speed={0.18} color={scene.star} opacity={0.55} />

      <Earth
        position={earthPosition}
        scale={earthScale}
        ringColor={scene.ring}
        pointer={pointer}
        motionScale={motionScale}
      />
      <Astronaut position={astronautPosition} scale={astronautScale} pointer={pointer} motionScale={motionScale} />
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
