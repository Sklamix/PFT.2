import { cn } from '@/lib/utils'

export function BrandLogo({ className, href = '#top' }: { className?: string; href?: string }) {
  return (
    <a href={href} className={cn('flex items-center gap-2.5', className)} aria-label="Professional Funded Trader home">
      <span className="relative flex h-8 items-center rounded-md bg-linear-to-br from-primary to-highlight p-px">
        <span className="flex h-full items-center rounded-[5px] bg-background px-2 font-mono text-xs font-bold tracking-widest text-foreground">
          PFT
        </span>
      </span>
      <span className="hidden text-sm font-semibold leading-tight tracking-tight text-foreground sm:block">
        Professional
        <span className="block font-normal text-muted-foreground">Funded Trader</span>
      </span>
    </a>
  )
}
