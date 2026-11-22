import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.pft.support',
  appName: 'PFT Support',
  webDir: 'public',
  server: {
    url: process.env.CAPACITOR_SERVER_URL || 'https://pft-app-prod.vercel.app/staff',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
}

export default config