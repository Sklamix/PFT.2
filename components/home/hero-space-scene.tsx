'use client'

import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Sparkles, Stars } from '@react-three/drei'
import * as THREE from 'three'

import type { PlanetController } from './planet-controller'
import { PLANET_SPOTS, type PlanetMode } from './planet-spots'

export type HeroSceneVariant = 'orbit' | 'nebula' | 'solar'

const SCENES: Record<HeroSceneVariant, { ring: string; star: string }> = {
  orbit: { ring: '#f5c76a', star: '#bae6fd' },
  nebula: { ring: '#67e8f9', star: '#c4b5fd' },
  solar: { ring: '#fbbf24', star: '#fde68a' },
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

function Atmosphere({
  mobile,
  wide,
  starColor,
  dimmed,
  reducedMotion,
}: {
  mobile: boolean
  wide: boolean
  starColor: string
  dimmed: boolean
  reducedMotion: boolean
}) {
  const stars = useRef<THREE.Points>(null)
  const sparkles = useRef<THREE.Points>(null)

  useFrame((_, delta) => {
    const target = dimmed ? 0.14 : 1
    for (const points of [stars.current, sparkles.current]) {
      if (!points || Array.isArray(points.material)) continue
      points.material.opacity = THREE.MathUtils.damp(points.material.opacity, target, 4.5, delta)
    }
  })

  return (
    <>
      <Stars
        ref={stars}
        radius={85}
        depth={50}
        count={mobile ? 1400 : wide ? 3400 : 2600}
        factor={3.1}
        saturation={0}
        fade
        speed={reducedMotion ? 0 : 0.2}
      />
      <Sparkles
        ref={sparkles}
        count={mobile ? 35 : wide ? 90 : 70}
        scale={[16, 9, 8]}
        size={1.4}
        speed={reducedMotion ? 0 : 0.18}
        color={starColor}
        opacity={0.55}
      />
    </>
  )
}

function Earth({
  targetPosition,
  targetScale,
  ringColor,
  pointer,
  motionScale,
  mode,
  activeSpot,
  reducedMotion,
  controller,
}: {
  targetPosition: [number, number, number]
  targetScale: number
  ringColor: string
  pointer: RefObject<{ x: number; y: number }>
  motionScale: number
  mode: PlanetMode
  activeSpot: string | null
  reducedMotion: boolean
  controller: PlanetController
}) {
  const group = useRef<THREE.Group>(null)
  const earth = useRef<THREE.Mesh>(null)
  const atmosphere = useRef<THREE.Mesh>(null)
  const geometry = useLowPolyEarthGeometry()
  const projection = useMemo(
    () => ({
      center: new THREE.Vector3(),
      centerNdc: new THREE.Vector3(),
      edge: new THREE.Vector3(),
      edgeNdc: new THREE.Vector3(),
      cameraRight: new THREE.Vector3(),
      cameraPosition: new THREE.Vector3(),
      worldPoint: new THREE.Vector3(),
      worldNormal: new THREE.Vector3(),
      toCamera: new THREE.Vector3(),
      worldQuaternion: new THREE.Quaternion(),
      worldScale: new THREE.Vector3(),
      localPoint: new THREE.Vector3(),
      screen: new THREE.Vector3(),
    }),
    [],
  )

  useFrame((state, delta) => {
    if (!group.current || !earth.current) return
    const control = controller.advance(delta, mode, reducedMotion)
    const parallax = mode === 'hero' ? 1 : 0.22

    group.current.position.x = THREE.MathUtils.damp(
      group.current.position.x,
      targetPosition[0] + pointer.current.x * 0.13 * motionScale * parallax,
      4.2,
      delta,
    )
    group.current.position.y = THREE.MathUtils.damp(
      group.current.position.y,
      targetPosition[1] + pointer.current.y * 0.08 * motionScale * parallax,
      4.2,
      delta,
    )
    group.current.position.z = THREE.MathUtils.damp(group.current.position.z, targetPosition[2], 4.2, delta)
    const scale = THREE.MathUtils.damp(group.current.scale.x, targetScale, 4.2, delta)
    group.current.scale.setScalar(scale)

    earth.current.rotation.y = THREE.MathUtils.damp(earth.current.rotation.y, control.rotationY, control.dragging ? 14 : 7, delta)
    const idleTilt = reducedMotion ? 0 : Math.sin(state.clock.elapsedTime * 0.1) * 0.025
    earth.current.rotation.x = THREE.MathUtils.damp(earth.current.rotation.x, control.rotationX + idleTilt, 7, delta)

    const earthMaterial = earth.current.material as THREE.MeshStandardMaterial
    earthMaterial.emissiveIntensity = THREE.MathUtils.damp(
      earthMaterial.emissiveIntensity,
      control.hovered ? 0.42 : activeSpot ? 0.34 : 0.28,
      5,
      delta,
    )
    const atmosphereMaterial = atmosphere.current?.material as THREE.MeshBasicMaterial | undefined
    if (atmosphereMaterial) {
      atmosphereMaterial.opacity = THREE.MathUtils.damp(atmosphereMaterial.opacity, control.hovered ? 0.16 : 0.1, 5, delta)
    }

    earth.current.updateWorldMatrix(true, false)
    projection.center.setFromMatrixPosition(earth.current.matrixWorld)
    projection.centerNdc.copy(projection.center).project(state.camera)
    state.camera.getWorldPosition(projection.cameraPosition)
    projection.cameraRight.set(1, 0, 0).applyQuaternion(state.camera.quaternion)
    earth.current.getWorldScale(projection.worldScale)
    projection.edge
      .copy(projection.center)
      .addScaledVector(projection.cameraRight, 2.18 * projection.worldScale.x)
    projection.edgeNdc.copy(projection.edge).project(state.camera)

    const centerX = (projection.centerNdc.x * 0.5 + 0.5) * state.size.width
    const centerY = (-projection.centerNdc.y * 0.5 + 0.5) * state.size.height
    const radius = Math.max(36, Math.abs(projection.edgeNdc.x - projection.centerNdc.x) * state.size.width * 0.5)
    controller.updateBody(centerX, centerY, radius)

    earth.current.getWorldQuaternion(projection.worldQuaternion)
    for (const spot of PLANET_SPOTS) {
      projection.localPoint.set(...spot.position).normalize().multiplyScalar(2.16)
      projection.worldPoint.copy(projection.localPoint).applyMatrix4(earth.current.matrixWorld)
      projection.worldNormal.copy(projection.localPoint).normalize().applyQuaternion(projection.worldQuaternion)
      projection.toCamera.copy(projection.cameraPosition).sub(projection.worldPoint).normalize()
      const facing = projection.worldNormal.dot(projection.toCamera) > 0.08
      projection.screen.copy(projection.worldPoint).project(state.camera)
      const onScreen =
        projection.screen.z > -1 &&
        projection.screen.z < 1 &&
        Math.abs(projection.screen.x) < 1.08 &&
        Math.abs(projection.screen.y) < 1.08
      const x = (projection.screen.x * 0.5 + 0.5) * state.size.width
      const y = (-projection.screen.y * 0.5 + 0.5) * state.size.height
      controller.updateMarker(spot.id, { x, y, facing, onScreen })
    }
  })

  return (
    <group ref={group} position={targetPosition} scale={targetScale}>
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

      <mesh ref={atmosphere} scale={2.4}>
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
  mode,
  activeSpot,
  reducedMotion,
  controller,
}: {
  variant: HeroSceneVariant
  pointer: RefObject<{ x: number; y: number }>
  mode: PlanetMode
  activeSpot: string | null
  reducedMotion: boolean
  controller: PlanetController
}) {
  const { size, camera } = useThree()
  const mobile = size.width < 768
  const aspect = size.width / Math.max(size.height, 1)
  const portrait = !mobile && aspect < 1.05
  const compact = mobile || portrait
  const wide = size.width >= 1600
  const large = size.width >= 1200
  const scene = SCENES[variant]

  const perspectiveCamera = camera as THREE.PerspectiveCamera
  const tangent = Math.tan(THREE.MathUtils.degToRad(perspectiveCamera.fov / 2))
  const positionAt = (x: number, y: number, z: number): [number, number, number] => {
    const viewHeight = 2 * tangent * (perspectiveCamera.position.z - z)
    return [(x - 0.5) * viewHeight * aspect, (0.5 - y) * viewHeight, z]
  }
  const pixelsPerWorldUnitAt = (z: number) => size.height / (2 * tangent * (perspectiveCamera.position.z - z))

  const earthZ = mobile || portrait ? -0.8 : wide ? -0.45 : -0.55
  const heroPoint: [number, number] = mobile
    ? [0.52, 0.78]
    : portrait
      ? [0.58, 0.72]
      : wide
        ? [0.72, 0.5]
        : large
          ? [0.74, 0.5]
          : [0.76, 0.5]
  const targetPoint: [number, number] = compact
    ? heroPoint
    : mode === 'focus'
      ? [0.5, 0.5]
      : mode === 'detail'
        ? [0.77, 0.5]
        : heroPoint
  const earthRadiusPx = mobile
    ? Math.min(size.height * 0.15, size.width * 0.28)
    : portrait
      ? Math.min(size.height * 0.19, size.width * 0.22)
      : wide
        ? Math.min(size.height * 0.26, size.width * 0.13)
        : large
          ? Math.min(size.height * 0.24, size.width * 0.11)
          : Math.min(size.height * 0.2, size.width * 0.13)
  const baseScale = earthRadiusPx / (2.62 * pixelsPerWorldUnitAt(earthZ))
  const targetScale = baseScale * (compact ? (mode === 'focus' ? 1.12 : 1) : mode === 'focus' ? 1.2 : mode === 'detail' ? 1.08 : 1)
  const motionScale = Math.min(1, 900 / Math.max(size.height, 1)) * 0.65 * (reducedMotion ? 0 : 1)

  return (
    <>
      <ambientLight intensity={0.42} color="#7dd3fc" />
      <directionalLight position={[-10, 2, 5]} intensity={4.2} color="#ffd6a3" />
      <directionalLight position={[4, 3, 6]} intensity={1.6} color="#bae6fd" />
      <pointLight position={[-4, 0, 3]} intensity={22} distance={16} color="#fbbf24" />
      <pointLight position={[4, -2, 2]} intensity={10} distance={12} color="#38bdf8" />

      <Atmosphere mobile={mobile} wide={wide} starColor={scene.star} dimmed={mode !== 'hero'} reducedMotion={reducedMotion} />
      <Earth
        targetPosition={positionAt(targetPoint[0], targetPoint[1], earthZ)}
        targetScale={targetScale}
        ringColor={scene.ring}
        pointer={pointer}
        motionScale={motionScale}
        mode={mode}
        activeSpot={activeSpot}
        reducedMotion={reducedMotion}
        controller={controller}
      />
    </>
  )
}

export function HeroSpaceScene({
  variant,
  mode,
  activeSpot,
  reducedMotion,
  controller,
}: {
  variant: HeroSceneVariant
  mode: PlanetMode
  activeSpot: string | null
  reducedMotion: boolean
  controller: PlanetController
}) {
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
      aria-hidden="true"
      dpr={[1, 1.6]}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      camera={{ position: [0, 0, 8.4], fov: 55 }}
      style={{ pointerEvents: 'none' }}
    >
      <Scene
        variant={variant}
        pointer={pointer}
        mode={mode}
        activeSpot={activeSpot}
        reducedMotion={reducedMotion}
        controller={controller}
      />
    </Canvas>
  )
}
