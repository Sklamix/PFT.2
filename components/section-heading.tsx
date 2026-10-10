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
    <div className={cn('max-w-2xl', align === 'center' && 'mx-auto text-center')}>
      <p className="font-mono text-xs uppercase tracking-widest text-primary">{eyebrow}</p>
      <h2 id={id} className="mt-3 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        {title}
      </h2>
      {description && <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">{description}</p>}
    </div>
  )
}
