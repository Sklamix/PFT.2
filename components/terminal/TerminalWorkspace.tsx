'use client'

import { useEffect } from 'react'
import { useMarketData } from '@/hooks/useMarketData'
import { useTerminalBook } from '@/lib/stores/useTerminalBook'
import { useTradingStore } from '@/lib/stores/useTradingStore'
import { OrderPanel } from './OrderPanel'
import { PositionsTable } from './PositionsTable'
import { TerminalHeader } from './TerminalHeader'
import { TradingChart } from './TradingChart'

export function TerminalWorkspace() {
  useMarketData()
  const selectedSymbol = useTradingStore((state) => state.selectedSymbol)
  const bid = useTradingStore((state) => state.bid)
  const ask = useTradingStore((state) => state.ask)
  const currentPrice = useTradingStore((state) => state.currentPrice)
  const markMarket = useTerminalBook((state) => state.markMarket)

  useEffect(() => {
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(currentPrice)) return
    markMarket(selectedSymbol, bid, ask, currentPrice)
  }, [ask, bid, currentPrice, markMarket, selectedSymbol])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TerminalHeader />
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <TradingChart />
          <PositionsTable />
        </div>
        <OrderPanel />
      </div>
    </div>
  )
}
