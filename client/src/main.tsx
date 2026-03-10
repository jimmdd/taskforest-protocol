import { Buffer } from 'buffer'
;(window as any).Buffer = Buffer

import { useMemo } from 'react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets'
import '@solana/wallet-adapter-react-ui/styles.css'
import './index.css'
import App from './App.tsx'
import Landing from './Landing.tsx'
import Board from './Board.tsx'
import AgentDocs from './AgentDocs.tsx'
import Hire from './Hire.tsx'
import Grove from './Grove.tsx'

const L1_RPC = import.meta.env.VITE_SOLANA_RPC || 'https://api.devnet.solana.com'

function Root() {
  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
  ], [])

  return (
    <ConnectionProvider endpoint={L1_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/agents" element={<AgentDocs />} />
              <Route path="/demo" element={<App />} />
              <Route path="/pipeline" element={<App />} />
              <Route path="/board" element={<Board />} />
              <Route path="/hire" element={<Hire />} />
              <Route path="/grove" element={<Grove />} />
            </Routes>
          </BrowserRouter>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
