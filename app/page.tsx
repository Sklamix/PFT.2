import { SiteHeader } from '@/components/site-header'
import { Hero } from '@/components/hero'
import { PayoutProofs } from '@/components/payout-proofs'
import { ChallengeCalculator } from '@/components/challenge-calculator'
import { FeaturesBento } from '@/components/features-bento'
import { RulesSection } from '@/components/rules-section'
import { DashboardPreview } from '@/components/dashboard-preview'
import { FaqSection } from '@/components/faq-section'
import { SiteFooter } from '@/components/site-footer'
import { HomeMotion } from '@/components/home-motion'

export default function Page() {
  return (
    <>
      <SiteHeader />
      <HomeMotion>
        <main>
          <Hero />
          <PayoutProofs />
          <ChallengeCalculator />
          <FeaturesBento />
          <RulesSection />
          <DashboardPreview />
          <FaqSection />
        </main>
        <SiteFooter />
      </HomeMotion>
    </>
  )
}
