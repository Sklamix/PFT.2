'use client'

import { useRef, type ReactNode, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

function SuitMaterial({ tone = '#e8eef6', roughness = 0.52 }: { tone?: string; roughness?: number }) {
  return <meshStandardMaterial color={tone} flatShading roughness={roughness} metalness={0.12} />
}

function JointMaterial() {
  return <meshStandardMaterial color="#8fa3b8" flatShading roughness={0.6} metalness={0.24} />
}

function Limb({
  length,
  radius = 0.11,
  tone = '#e8eef6',
  children,
}: {
  length: number
  radius?: number
  tone?: string
  children?: ReactNode
}) {
  return (
    <group>
      <mesh position={[0, -length / 2, 0]}>
        <capsuleGeometry args={[radius, length, 4, 8]} />
        <SuitMaterial tone={tone} />
      </mesh>
      {children}
    </group>
  )
}

export function Astronaut({
  position,
  scale,
  pointer,
  motionScale,
}: {
  position: [number, number, number]
  scale: number
  pointer: RefObject<{ x: number; y: number }>
  motionScale: number
}) {
  const group = useRef<THREE.Group>(null)
  const waveShoulder = useRef<THREE.Group>(null)
  const waveElbow = useRef<THREE.Group>(null)

  useFrame((state, delta) => {
    if (!group.current) return
    const time = state.clock.elapsedTime
    const p = pointer.current
    const floatX = Math.sin(time * 0.45) * 0.14 * motionScale
    const floatY = Math.sin(time * 0.68 + 1.1) * 0.2 * motionScale

    group.current.position.x = THREE.MathUtils.damp(
      group.current.position.x,
      position[0] + floatX + p.x * 0.34 * motionScale,
      2.8,
      delta,
    )
    group.current.position.y = THREE.MathUtils.damp(
      group.current.position.y,
      position[1] + floatY + p.y * 0.2 * motionScale,
      2.8,
      delta,
    )
    group.current.rotation.y = THREE.MathUtils.damp(
      group.current.rotation.y,
      Math.PI + Math.sin(time * 0.3) * 0.06 + p.x * 0.04 * motionScale,
      2.2,
      delta,
    )
    group.current.rotation.z = Math.sin(time * 0.36) * 0.035

    if (waveShoulder.current) {
      const phase = time % 10
      const waving = phase > 6.2 && phase < 8.7
      const armTarget = waving ? 1.5 : 0.12
      const elbowTarget = waving ? 0.72 + Math.sin((phase - 6.2) * 9) * 0.2 : 0.06
      waveShoulder.current.rotation.z = THREE.MathUtils.damp(waveShoulder.current.rotation.z, armTarget, 5, delta)
      waveShoulder.current.rotation.x = THREE.MathUtils.damp(waveShoulder.current.rotation.x, waving ? -0.16 : 0, 5, delta)
      if (waveElbow.current) {
        waveElbow.current.rotation.z = THREE.MathUtils.damp(waveElbow.current.rotation.z, elbowTarget, 6, delta)
      }
    }
  })

  return (
    <group ref={group} position={position} scale={scale} rotation={[0.02, Math.PI, 0.025]}>
      {/* Backpack and tanks */}
      <mesh position={[0, 0.28, -0.34]} scale={[0.72, 0.92, 0.3]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#b9c6d6" flatShading roughness={0.62} metalness={0.22} />
      </mesh>
      <mesh position={[-0.46, 0.25, -0.31]} rotation={[0, 0, -0.12]}>
        <capsuleGeometry args={[0.055, 0.34, 4, 7]} />
        <meshStandardMaterial color="#7f93a8" flatShading roughness={0.55} metalness={0.3} />
      </mesh>
      <mesh position={[0.46, 0.25, -0.31]} rotation={[0, 0, 0.12]}>
        <capsuleGeometry args={[0.055, 0.34, 4, 7]} />
        <meshStandardMaterial color="#7f93a8" flatShading roughness={0.55} metalness={0.3} />
      </mesh>
      <mesh position={[0, 0.67, -0.28]} scale={[0.32, 0.1, 0.12]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#38bdf8" />
      </mesh>

      {/* Torso */}
      <mesh position={[0, 0.15, 0]} scale={[0.66, 0.86, 0.42]}>
        <icosahedronGeometry args={[0.7, 2]} />
        <SuitMaterial />
      </mesh>
      <mesh position={[0, -0.28, 0]} scale={[0.58, 0.26, 0.38]}>
        <icosahedronGeometry args={[0.5, 1]} />
        <SuitMaterial tone="#d7e1ec" />
      </mesh>

      {/* Chest control panel */}
      <mesh position={[0, 0.24, 0.42]} scale={[0.4, 0.34, 0.07]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#9fb1c3" flatShading roughness={0.5} metalness={0.28} />
      </mesh>
      <mesh position={[-0.1, 0.3, 0.47]} scale={[0.1, 0.045, 0.02]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#38bdf8" />
      </mesh>
      <mesh position={[0.06, 0.3, 0.47]} scale={[0.12, 0.035, 0.02]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#fbbf24" />
      </mesh>
      <mesh position={[-0.08, 0.2, 0.47]} scale={[0.15, 0.025, 0.02]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#e2e8f0" />
      </mesh>
      <mesh position={[0.1, 0.19, 0.47]} scale={[0.06, 0.06, 0.02]}>
        <cylinderGeometry args={[1, 1, 1, 10]} />
        <meshBasicMaterial color="#94a3b8" />
      </mesh>

      {/* Torso straps and hoses */}
      <mesh position={[-0.34, 0.05, 0.3]} rotation={[0, 0, 0.25]} scale={[0.06, 0.48, 0.04]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#cbd5e1" flatShading roughness={0.6} />
      </mesh>
      <mesh position={[0.34, 0.05, 0.3]} rotation={[0, 0, -0.25]} scale={[0.06, 0.48, 0.04]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#cbd5e1" flatShading roughness={0.6} />
      </mesh>
      <mesh position={[-0.25, 0.42, 0.24]} rotation={[0.1, 0, -0.55]}>
        <capsuleGeometry args={[0.035, 0.24, 4, 7]} />
        <meshStandardMaterial color="#64748b" flatShading roughness={0.55} metalness={0.35} />
      </mesh>
      <mesh position={[0.25, 0.42, 0.24]} rotation={[0.1, 0, 0.55]}>
        <capsuleGeometry args={[0.035, 0.24, 4, 7]} />
        <meshStandardMaterial color="#64748b" flatShading roughness={0.55} metalness={0.35} />
      </mesh>

      {/* Neck ring */}
      <mesh position={[0, 0.72, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.27, 0.055, 8, 24]} />
        <JointMaterial />
      </mesh>

      {/* Helmet */}
      <mesh position={[0, 1.02, 0]} scale={[0.95, 1, 0.9]}>
        <icosahedronGeometry args={[0.4, 2]} />
        <SuitMaterial tone="#eef4fb" roughness={0.4} />
      </mesh>
      <mesh position={[0, 1.04, 0.25]} scale={[1.06, 0.92, 0.62]}>
        <icosahedronGeometry args={[0.32, 2]} />
        <meshStandardMaterial color="#071827" flatShading metalness={0.75} roughness={0.08} emissive="#0ea5e9" emissiveIntensity={0.3} />
      </mesh>
      <mesh position={[0, 1.04, 0.255]} scale={[1.1, 0.9, 0.64]}>
        <icosahedronGeometry args={[0.32, 2]} />
        <meshBasicMaterial color="#60a5fa" transparent opacity={0.08} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh position={[-0.36, 1.03, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.13, 0.13, 0.08, 10]} />
        <JointMaterial />
      </mesh>
      <mesh position={[0.36, 1.03, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.13, 0.13, 0.08, 10]} />
        <JointMaterial />
      </mesh>
      <mesh position={[-0.28, 1.37, -0.04]} rotation={[0, 0, -0.3]}>
        <cylinderGeometry args={[0.012, 0.012, 0.24, 5]} />
        <meshStandardMaterial color="#94a3b8" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[-0.33, 1.49, -0.04]}>
        <sphereGeometry args={[0.025, 8, 8]} />
        <meshBasicMaterial color="#38bdf8" />
      </mesh>

      {/* Shoulder pads */}
      <mesh position={[-0.52, 0.52, 0]} scale={[0.25, 0.18, 0.26]}>
        <icosahedronGeometry args={[0.5, 1]} />
        <SuitMaterial tone="#dbe5f0" />
      </mesh>
      <mesh position={[0.52, 0.52, 0]} scale={[0.25, 0.18, 0.26]}>
        <icosahedronGeometry args={[0.5, 1]} />
        <SuitMaterial tone="#dbe5f0" />
      </mesh>

      {/* Left arm */}
      <group position={[-0.55, 0.48, 0]} rotation={[0, 0, -0.12]}>
        <Limb length={0.38} radius={0.1}>
          <mesh position={[0, -0.38, 0]}>
            <icosahedronGeometry args={[0.13, 1]} />
            <JointMaterial />
          </mesh>
        </Limb>
        <group position={[0, -0.38, 0]} rotation={[0, 0, 0.03]}>
          <Limb length={0.34} radius={0.09} tone="#d7e1ec">
            <mesh position={[0, -0.34, 0]} scale={[0.9, 0.8, 0.8]}>
              <icosahedronGeometry args={[0.14, 1]} />
              <meshStandardMaterial color="#b9c6d6" flatShading roughness={0.55} />
            </mesh>
          </Limb>
        </group>
      </group>

      {/* Right waving arm */}
      <group ref={waveShoulder} position={[0.55, 0.48, 0]} rotation={[0, 0, 0.12]}>
        <Limb length={0.38} radius={0.1}>
          <mesh position={[0, -0.38, 0]}>
            <icosahedronGeometry args={[0.13, 1]} />
            <JointMaterial />
          </mesh>
        </Limb>
        <group ref={waveElbow} position={[0, -0.38, 0]} rotation={[0, 0, 0.06]}>
          <Limb length={0.34} radius={0.09} tone="#d7e1ec">
            <mesh position={[0, -0.34, 0]} scale={[0.9, 0.8, 0.8]}>
              <icosahedronGeometry args={[0.14, 1]} />
              <meshStandardMaterial color="#b9c6d6" flatShading roughness={0.55} />
            </mesh>
          </Limb>
        </group>
      </group>

      {/* Legs */}
      {[-1, 1].map((side) => (
        <group key={side} position={[side * 0.22, -0.38, 0]} rotation={[0, 0, side * 0.035]}>
          <mesh position={[0, -0.25, 0]}>
            <capsuleGeometry args={[0.14, 0.42, 5, 9]} />
            <SuitMaterial tone="#dce6f1" />
          </mesh>
          <mesh position={[0, -0.53, 0.03]} scale={[1, 0.8, 1]}>
            <icosahedronGeometry args={[0.16, 1]} />
            <JointMaterial />
          </mesh>
          <mesh position={[0, -0.77, 0]}>
            <capsuleGeometry args={[0.12, 0.34, 5, 9]} />
            <SuitMaterial tone="#e8eef6" />
          </mesh>
          <mesh position={[0, -1.03, 0.06]} scale={[1.1, 0.7, 1.35]}>
            <boxGeometry args={[0.24, 0.22, 0.34]} />
            <meshStandardMaterial color="#cbd5e1" flatShading roughness={0.62} metalness={0.18} />
          </mesh>
        </group>
      ))}
    </group>
  )
}
