import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SectionHeadingProps {
  id: string
  eyebrow: string
  title: string
  description?: string
  align?: 'left' | 'center'
}

export function SectionHeading({ id, eyebrow, title, description, align = 'center' }: SectionHeadingProps) {
  return (
    <div className={cn('max-w-2xl xl:max-w-3xl', align === 'center' && 'mx-auto text-center')}>
      <p className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-primary shadow-[0_0_30px_-16px_rgba(59,130,246,0.9)] backdrop-blur-md">
        <Sparkles className="size-3.5" aria-hidden="true" />
        {eyebrow}
      </p>
      <h2
        id={id}
        className="mt-5 text-balance text-[clamp(2rem,3.2vw,4rem)] font-semibold leading-[1.02] tracking-[-0.04em] text-white"
      >
        {title}
      </h2>
      {description && (
        <p
          className={cn(
            'mt-5 text-pretty text-[clamp(0.95rem,1.05vw,1.15rem)] leading-relaxed text-slate-400',
            align === 'center' && 'mx-auto',
          )}
        >
          {description}
        </p>
      )}
    </div>
  )
}
