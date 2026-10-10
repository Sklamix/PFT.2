'use client'

import { useRef, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

interface SegmentedOption<T extends string | number> {
  value: T
  label: string
}

interface SegmentedControlProps<T extends string | number> {
  label: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
  size?: 'sm' | 'md'
}

export function SegmentedControl<T extends string | number>({
  label,
  options,
  value,
  onChange,
  className,
  size = 'md',
}: SegmentedControlProps<T>) {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = options.findIndex((option) => option.value === value)
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      nextIndex = (currentIndex - 1 + options.length) % options.length
    else return
    event.preventDefault()
    onChange(options[nextIndex].value)
    buttonsRef.current[nextIndex]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn('flex gap-1 rounded-lg border border-border bg-background p-1', className)}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttonsRef.current[index] = element
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex-1 whitespace-nowrap rounded-md font-medium transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm',
              selected
                ? 'bg-primary/15 text-primary shadow-[inset_0_0_0_1px] shadow-primary/50'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
