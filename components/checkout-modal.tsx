'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Apple,
  Bitcoin,
  Check,
  CreditCard,
  Info,
  Loader2,
  Lock,
  Mail,
  MapPin,
  ShieldCheck,
  Sparkles,
  Tag,
  UserRound,
  Wallet,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  CHALLENGES,
  FROZEN_BACKUP_RATE,
  formatCurrency,
  formatPrice,
  getCheckoutTotal,
  getFrozenBackupPrice,
  type AccountSize,
  type ChallengeType,
  type DrawdownMode,
} from '@/lib/challenges'
import { cn } from '@/lib/utils'

const COUNTRIES = [
  'United States',
  'United Kingdom',
  'Canada',
  'Australia',
  'Germany',
  'France',
  'Netherlands',
  'Switzerland',
  'United Arab Emirates',
  'Singapore',
  'Hong Kong',
  'Japan',
  'South Korea',
  'India',
  'Brazil',
  'Mexico',
  'South Africa',
  'Nigeria',
  'Poland',
  'Spain',
  'Italy',
  'Sweden',
  'Norway',
  'Ukraine',
  'Other',
] as const

const CRYPTO_ASSETS = [
  { ticker: 'USDT', networks: 'TRC20 / ERC20' },
  { ticker: 'BTC', networks: 'Bitcoin' },
  { ticker: 'ETH', networks: 'ERC20' },
] as const

type PaymentMethod = 'crypto' | 'card'

export type CheckoutModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountSize: AccountSize
  evaluationType: ChallengeType
  calculatedPrice: number
  drawdownMode?: DrawdownMode
  dailyLossType?: 3 | 5
  customer?: { email: string; name?: string }
}

function evaluationPayload(type: ChallengeType) {
  return type === 'one-step' ? '1-Step' : '2-Step'
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

const fieldClass =
  'h-11 w-full rounded-lg border border-[#1E293B] bg-[#0B0F19] px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/50 focus:ring-3 focus:ring-primary/20'

export function CheckoutModal({
  open,
  onOpenChange,
  accountSize,
  evaluationType,
  calculatedPrice,
  drawdownMode = 'trailing',
  dailyLossType = 3,
  customer,
}: CheckoutModalProps) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [country, setCountry] = useState('')
  const [promoCode, setPromoCode] = useState('')
  const [promoStatus, setPromoStatus] = useState<'idle' | 'applied' | 'invalid'>('idle')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('crypto')
  const [agreed, setAgreed] = useState(false)
  const [hasFrozenBackup, setHasFrozenBackup] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rules = CHALLENGES[evaluationType]
  const basePrice = calculatedPrice
  const frozenBackupPrice = getFrozenBackupPrice(basePrice)
  const totalAmount = getCheckoutTotal(basePrice, hasFrozenBackup)
  const tierBadge = useMemo(
    () => `${formatCurrency(accountSize)} · ${rules.label}`,
    [accountSize, rules.label],
  )

  useEffect(() => {
    if (open) setHasFrozenBackup(false)
  }, [open, accountSize, calculatedPrice])

  useEffect(() => {
    if (!open || !customer) return
    setEmail(customer.email)
    if (customer.name) setFullName(customer.name)
  }, [open, customer?.email, customer?.name])

  function resetTransient() {
    setError(null)
    setSubmitting(false)
    setHasFrozenBackup(false)
  }

  function applyPromo() {
    const code = promoCode.trim()
    if (!code) {
      setPromoStatus('invalid')
      return
    }
    setPromoStatus('applied')
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (!fullName.trim()) {
      setError('Enter your full name as it should appear on your trader profile.')
      return
    }
    if (!isValidEmail(email.trim())) {
      setError('Enter a valid email address so we can deliver your MT5 credentials.')
      return
    }
    if (!country) {
      setError('Select your country or region.')
      return
    }
    if (paymentMethod !== 'crypto') {
      setError('Card processing is in review. Pay with crypto for instant activation.')
      return
    }
    if (!agreed) {
      setError('Please agree to the Terms of Service and evaluation rules to continue.')
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planSize: accountSize,
          evaluationType: evaluationPayload(evaluationType),
          email: email.trim(),
          fullName: fullName.trim(),
          paymentMethod: 'crypto',
          country,
          promoCode: promoCode.trim() || undefined,
          drawdownMode,
          dailyLossType: evaluationType === 'two-step' ? dailyLossType : undefined,
          hasFrozenBackup,
          totalAmount,
        }),
      })

      const data = (await response.json()) as { url?: string; error?: string }

      if (!response.ok || !data.url) {
        setError(data.error || 'Unable to create your invoice. Please try again.')
        setSubmitting(false)
        return
      }

      window.location.assign(data.url)
    } catch {
      setError('Network error while starting checkout. Check your connection and try again.')
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetTransient()
        onOpenChange(next)
      }}
    >
      <DialogContent
        overlayClassName="z-[80] bg-[#0B0F19]/70 backdrop-blur-md supports-backdrop-filter:backdrop-blur-md duration-200"
        className="z-[80] max-h-[min(92vh,880px)] w-full gap-0 overflow-hidden border-[#1E293B] bg-[#0B0F19] p-0 text-foreground shadow-[0_24px_80px_-24px_rgba(16,185,129,0.25)] duration-200 sm:max-w-lg"
      >
        <form onSubmit={handleSubmit} className="flex max-h-[min(92vh,880px)] flex-col">
          <DialogHeader className="border-b border-[#1E293B] px-5 pt-5 pb-4 sm:px-6">
            <div className="flex items-start justify-between gap-3 pr-8">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Checkout</p>
                <DialogTitle className="mt-1 text-lg font-semibold tracking-tight">Complete your evaluation</DialogTitle>
                <DialogDescription className="mt-1 text-sm text-muted-foreground">
                  Credentials are emailed the moment payment confirms.
                </DialogDescription>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Sparkles className="size-3.5" aria-hidden="true" />
                {tierBadge}
              </span>
              <p className="text-right">
                <span className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Total due</span>
                <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                  {formatPrice(totalAmount)}
                  <span className="ml-1 text-sm font-medium text-muted-foreground">USD</span>
                </span>
              </p>
            </div>
          </DialogHeader>

          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
            {error && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {error}
              </p>
            )}

            <fieldset className="space-y-3">
              <legend className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Customer information
              </legend>

              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-sm text-foreground">
                  <UserRound className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  Full name
                </span>
                <input
                  required
                  autoComplete="name"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="Alex Rivera"
                  className={fieldClass}
                />
              </label>

              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-sm text-foreground">
                  <Mail className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  Email address
                </span>
                <input
                  required
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  readOnly={Boolean(customer)}
                  placeholder="trader@example.com"
                  className={cn(fieldClass, customer && 'cursor-not-allowed opacity-70')}
                />
                <span className="mt-1.5 block text-xs text-muted-foreground">
                  {customer ? 'This challenge will be added to your signed-in account.' : 'Used to deliver your MT5 login credentials.'}
                </span>
              </label>

              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-sm text-foreground">
                  <MapPin className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  Country / region
                </span>
                <select
                  required
                  value={country}
                  onChange={(event) => setCountry(event.target.value)}
                  className={cn(fieldClass, !country && 'text-muted-foreground/70')}
                >
                  <option value="" disabled>
                    Select country
                  </option>
                  {COUNTRIES.map((item) => (
                    <option key={item} value={item} className="bg-[#0B0F19] text-foreground">
                      {item}
                    </option>
                  ))}
                </select>
              </label>

              <div>
                <span className="mb-1.5 flex items-center gap-1.5 text-sm text-foreground">
                  <Tag className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  Promo code
                  <span className="text-xs text-muted-foreground">(optional)</span>
                </span>
                <div className="flex gap-2">
                  <input
                    value={promoCode}
                    onChange={(event) => {
                      setPromoCode(event.target.value)
                      setPromoStatus('idle')
                    }}
                    placeholder="PFT-LAUNCH"
                    className={cn(fieldClass, 'flex-1')}
                  />
                  <button
                    type="button"
                    onClick={applyPromo}
                    className="inline-flex h-11 shrink-0 items-center rounded-lg border border-[#1E293B] bg-[#0F172A] px-3 text-sm font-medium text-foreground transition-colors hover:border-highlight/40 hover:bg-accent"
                  >
                    Apply
                  </button>
                </div>
                {promoStatus === 'applied' && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-primary">
                    <Check className="size-3.5" aria-hidden="true" />
                    Code noted — eligible discounts are applied on the invoice.
                  </p>
                )}
                {promoStatus === 'invalid' && (
                  <p className="mt-1.5 text-xs text-destructive">Enter a promo code before applying.</p>
                )}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Payment method
              </legend>
              <div className="grid gap-2.5">
                <label
                  className={cn(
                    'cursor-pointer rounded-xl border p-3.5 transition-colors',
                    paymentMethod === 'crypto'
                      ? 'border-primary/50 bg-primary/5 shadow-[0_0_24px_-16px] shadow-primary'
                      : 'border-[#1E293B] bg-[#0F172A]/60 hover:border-muted-foreground/30',
                  )}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="payment-method"
                      value="crypto"
                      checked={paymentMethod === 'crypto'}
                      onChange={() => setPaymentMethod('crypto')}
                      className="mt-1 accent-[var(--primary)]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Wallet className="size-4 text-primary" aria-hidden="true" />
                        <span className="text-sm font-semibold text-foreground">Crypto (Cryptomus)</span>
                        <span className="rounded-full border border-highlight/30 bg-highlight/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-highlight">
                          Recommended · Instant activation · 0% fee
                        </span>
                      </div>
                      <ul className="mt-3 flex flex-wrap gap-2">
                        {CRYPTO_ASSETS.map((asset) => (
                          <li
                            key={asset.ticker}
                            className="inline-flex items-center gap-1.5 rounded-md border border-[#1E293B] bg-[#0B0F19] px-2 py-1 font-mono text-[11px] text-foreground"
                          >
                            {asset.ticker === 'BTC' ? (
                              <Bitcoin className="size-3 text-highlight" aria-hidden="true" />
                            ) : (
                              <span className="size-1.5 rounded-full bg-primary" />
                            )}
                            {asset.ticker}
                            <span className="text-muted-foreground">{asset.networks}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </label>

                <label
                  aria-disabled="true"
                  className="cursor-not-allowed rounded-xl border border-[#1E293B] bg-[#0F172A]/40 p-3.5 opacity-70"
                >
                  <div className="flex items-start gap-3">
                    <input type="radio" name="payment-method" value="card" disabled className="mt-1" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CreditCard className="size-4 text-muted-foreground" aria-hidden="true" />
                        <Apple className="size-4 text-muted-foreground" aria-hidden="true" />
                        <span className="text-sm font-semibold text-muted-foreground">Credit Card / Apple Pay</span>
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Card processing in review / Crypto instant
                      </p>
                    </div>
                  </div>
                </label>
              </div>
            </fieldset>

            <div
              className={cn(
                'relative rounded-xl border p-3.5 transition-colors',
                hasFrozenBackup
                  ? 'border-primary/50 bg-primary/5 shadow-[0_0_24px_-16px] shadow-primary'
                  : 'border-[#1E293B] bg-[#0F172A]/50 hover:border-primary/30',
              )}
            >
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  aria-label="Frozen Backup Rules"
                  className="absolute top-3 right-3 rounded-md p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Info className="h-4 w-4 text-slate-400 hover:text-white" />
                </TooltipTrigger>
                <TooltipContent
                  side="left"
                  align="start"
                  className="flex max-w-[280px] flex-col items-start gap-2 border border-[#1E293B] bg-[#0F172A] px-3 py-2.5 text-left text-xs text-slate-300 shadow-[0_12px_40px_-16px_rgba(0,0,0,0.8)]"
                >
                  <p className="font-semibold text-white">Frozen Backup Rules</p>
                  <ul className="space-y-1.5 leading-relaxed">
                    <li>• Standby mode: Sits dormant while you trade your main account.</li>
                    <li>• Auto-activation: Automatically unlocks only if your main account breaches drawdown rules.</li>
                    <li>• Success policy: If you pass your evaluation, this backup permanently expires.</li>
                  </ul>
                </TooltipContent>
              </Tooltip>

              <label className="flex cursor-pointer items-start gap-3 pr-7">
                <input
                  type="checkbox"
                  checked={hasFrozenBackup}
                  onChange={(event) => setHasFrozenBackup(event.target.checked)}
                  className="mt-0.5 size-4 accent-[var(--primary)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-foreground">
                    Add Frozen Backup Account (+50% OFF)
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                    Get an instant dormant backup account. Automatically unfreezes if you fail your main account. Expires
                    if you pass. (+{(basePrice * FROZEN_BACKUP_RATE).toFixed(2)})
                  </span>
                  {hasFrozenBackup && (
                    <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                      <span>Base {formatPrice(basePrice)}</span>
                      <span>+ Backup {formatPrice(frozenBackupPrice)}</span>
                      <span className="text-primary">Total {formatPrice(totalAmount)}</span>
                    </span>
                  )}
                </span>
              </label>
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[#1E293B] bg-[#0F172A]/50 px-3 py-3">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
                className="mt-0.5 size-4 accent-[var(--primary)]"
                required
              />
              <span className="text-xs leading-relaxed text-muted-foreground">
                I agree to the{' '}
                <a href="#faq" className="text-highlight underline-offset-2 hover:underline">
                  Terms of Service
                </a>
                , Refund Policy, and confirm that I have read the{' '}
                <a href="#rules" className="text-highlight underline-offset-2 hover:underline">
                  risk evaluation rules
                </a>
                .
              </span>
            </label>

            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <ShieldCheck className="size-3.5 text-primary" aria-hidden="true" />
              {rules.label} · {drawdownMode === 'static' ? 'Static' : 'Trailing'} drawdown · encrypted checkout
            </p>
          </div>

          <div className="border-t border-[#1E293B] bg-[#0F172A]/80 px-5 py-4 sm:px-6">
            <button
              type="submit"
              disabled={submitting}
              className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-linear-to-r from-primary to-highlight px-6 text-sm font-semibold text-primary-foreground shadow-[0_0_40px_-12px] shadow-primary transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Creating invoice…
                </>
              ) : (
                <>
                  <Lock className="size-4" aria-hidden="true" />
                  Proceed to Payment — {formatPrice(totalAmount)}
                </>
              )}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
