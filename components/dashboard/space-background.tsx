/**
 * Immersive space background for the trader dashboard: deep gradient, a faint
 * technical dot/line grid, and soft ambient glows. Fixed behind all content.
 * The `planet` variant is used only by Overview and drops the grid/glows in
 * favour of a CSS-only planet rising from the lower right corner.
 */
export function SpaceBackground({ variant = 'grid' }: { variant?: 'grid' | 'planet' }) {
  if (variant === 'planet') {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        style={{ background: 'linear-gradient(180deg,#05080F 0%,#08101F 55%,#060B16 100%)' }}
      >
        {/* Sparse stars, kept on the right so they do not sit behind text */}
        <div
          className="absolute inset-y-0 right-0 w-1/2 opacity-45"
          style={{
            backgroundImage:
              'radial-gradient(1px 1px at 25% 35%, rgba(200,220,255,0.9) 50%, transparent 60%), radial-gradient(1.5px 1.5px at 75% 70%, rgba(200,220,255,0.75) 50%, transparent 60%)',
            backgroundSize: '131px 173px, 197px 229px',
          }}
        />
        {/* Planet: a single radial-gradient disc with an atmospheric halo */}
        <div
          className="absolute"
          style={{
            right: '-30%',
            bottom: '-84%',
            width: '1150px',
            aspectRatio: '1',
            borderRadius: '50%',
            background:
              'radial-gradient(circle closest-side at 50% 50%, #07101E 0 62%, #0C1B31 70%, #1B4570 76%, #3E86C8 79.5%, #9BD4FF 81%, rgba(90,150,220,.45) 82%, transparent 86%)',
            boxShadow: '0 0 180px 40px rgba(70,140,220,.18)',
          }}
        />
      </div>
    )
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0"
      style={{ background: 'linear-gradient(180deg, #050811 0%, #0B0F19 100%)' }}
    >
      {/* Technical grid: fine lines every 44px plus a dot at each crossing */}
      <div
        className="absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px), radial-gradient(rgba(148,163,184,0.10) 1px, transparent 1px)',
          backgroundSize: '44px 44px, 44px 44px, 44px 44px',
          backgroundPosition: '0 0, 0 0, -1px -1px',
        }}
      />
      {/* Ambient glows: cyan top-left, warm orange bottom-right, faint blue center */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(720px 480px at 12% -8%, rgba(34,211,238,0.10), transparent 65%), radial-gradient(640px 420px at 92% 106%, rgba(249,115,22,0.07), transparent 65%), radial-gradient(900px 560px at 55% 45%, rgba(59,130,246,0.05), transparent 70%)',
        }}
      />
      {/* Vignette keeps card edges crisp and text readable */}
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(1200px 800px at 50% 40%, transparent 55%, rgba(3,5,10,0.55) 100%)' }}
      />
    </div>
  )
}

/** Glassmorphism surface used by all dashboard cards on top of the space background. */
export function GlassCard({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={`rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 backdrop-blur-md ${className}`}
    >
      {children}
    </section>
  )
}
