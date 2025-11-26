'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  
  if (diffSecs < 10) return 'just now';
  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  
  return date.toLocaleDateString();
}

type Market = {
  ticker: string;
  title: string;
  status: string;
  yesPrice: number | null;
  noPrice: number | null;
  volume: number | null;
  updatedAt: string | null;
  yesPriceDirection: 'up' | 'down' | 'neutral';
  noPriceDirection: 'up' | 'down' | 'neutral';
};

export function MarketsTable() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [previousPrices, setPreviousPrices] = useState<Record<string, { yesPrice: number | null; noPrice: number | null }>>({});

  useEffect(() => {
    // Initial fetch
    async function fetchMarkets() {
      const { data, error } = await supabase
        .from('markets')
        .select('venue_market_ticker, title, status, yes_price_last, no_price_last, volume, updated_at')
        .eq('venue', 'kalshi')
        .order('volume', { ascending: false, nullsFirst: false })
        .limit(100);

      if (error) {
        console.error('Error fetching markets:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      if (data) {
        const marketsData = data.map((market) => ({
          ticker: market.venue_market_ticker,
          title: market.title,
          status: market.status || 'unknown',
          yesPrice: market.yes_price_last ? Number(market.yes_price_last) : null,
          noPrice: market.no_price_last ? Number(market.no_price_last) : null,
          volume: market.volume ? Number(market.volume) : null,
          updatedAt: market.updated_at || null,
          yesPriceDirection: 'neutral' as const,
          noPriceDirection: 'neutral' as const,
        }));
        
        // Store initial prices for direction tracking
        const initialPrices: Record<string, { yesPrice: number | null; noPrice: number | null }> = {};
        marketsData.forEach(m => {
          initialPrices[m.ticker] = { yesPrice: m.yesPrice, noPrice: m.noPrice };
        });
        setPreviousPrices(initialPrices);
        
        setMarkets(marketsData);
      }
      setLoading(false);
    }

    fetchMarkets();

    // Subscribe to real-time updates
    const channel = supabase
      .channel('markets-changes')
      .on(
        'postgres_changes',
        {
          event: '*', // Listen to all changes (INSERT, UPDATE, DELETE)
          schema: 'public',
          table: 'markets',
          filter: 'venue=eq.kalshi',
        },
        (payload) => {
          console.log('🔴 Real-time market update received:', payload);
          
          if (payload.eventType === 'UPDATE' && payload.new) {
            setMarkets((prevMarkets) => {
              const updated = prevMarkets.map((market) => {
                if (market.ticker === payload.new.venue_market_ticker) {
                  const newYesPrice = payload.new.yes_price_last ? Number(payload.new.yes_price_last) : null;
                  const newNoPrice = payload.new.no_price_last ? Number(payload.new.no_price_last) : null;
                  
                  // Calculate direction based on previous price
                  const prev = previousPrices[market.ticker];
                  let yesDirection: 'up' | 'down' | 'neutral' = 'neutral';
                  let noDirection: 'up' | 'down' | 'neutral' = 'neutral';
                  
                  if (prev) {
                    if (newYesPrice !== null && prev.yesPrice !== null) {
                      yesDirection = newYesPrice > prev.yesPrice ? 'up' : newYesPrice < prev.yesPrice ? 'down' : 'neutral';
                    }
                    if (newNoPrice !== null && prev.noPrice !== null) {
                      noDirection = newNoPrice > prev.noPrice ? 'up' : newNoPrice < prev.noPrice ? 'down' : 'neutral';
                    }
                  }
                  
                  // Update previous prices
                  setPreviousPrices(prev => ({
                    ...prev,
                    [market.ticker]: { yesPrice: newYesPrice, noPrice: newNoPrice }
                  }));
                  
                  return {
                    ...market,
                    yesPrice: newYesPrice,
                    noPrice: newNoPrice,
                    volume: payload.new.volume ? Number(payload.new.volume) : null,
                    status: payload.new.status || market.status,
                    updatedAt: payload.new.updated_at || market.updatedAt,
                    yesPriceDirection: yesDirection,
                    noPriceDirection: noDirection,
                  };
                }
                return market;
              });
              return updated;
            });
          } else if (payload.eventType === 'INSERT' && payload.new) {
            // Add new market
            setMarkets((prevMarkets) => {
              const exists = prevMarkets.some(m => m.ticker === payload.new.venue_market_ticker);
              if (exists) return prevMarkets;
              
              const newMarket = {
                ticker: payload.new.venue_market_ticker,
                title: payload.new.title,
                status: payload.new.status || 'unknown',
                yesPrice: payload.new.yes_price_last ? Number(payload.new.yes_price_last) : null,
                noPrice: payload.new.no_price_last ? Number(payload.new.no_price_last) : null,
                volume: payload.new.volume ? Number(payload.new.volume) : null,
                updatedAt: payload.new.updated_at || null,
                yesPriceDirection: 'neutral' as const,
                noPriceDirection: 'neutral' as const,
              };
              
              // Store initial prices
              setPreviousPrices(prev => ({
                ...prev,
                [newMarket.ticker]: { yesPrice: newMarket.yesPrice, noPrice: newMarket.noPrice }
              }));
              
              return [
                newMarket,
                ...prevMarkets,
              ].sort((a, b) => (b.volume || 0) - (a.volume || 0));
            });
          }
        }
      )
      .subscribe((status) => {
        console.log('Realtime subscription status:', status);
        if (status === 'SUBSCRIBED') {
          console.log('✅ Successfully subscribed to real-time market updates');
        } else if (status === 'CHANNEL_ERROR') {
          console.error('❌ Error subscribing to real-time updates');
        }
      });

    return () => {
      console.log('Cleaning up real-time subscription');
      supabase.removeChannel(channel);
    };
  }, []);

  if (loading) {
    return (
      <div className="text-center py-12 text-edgelord-text-muted">
        <p>Loading markets...</p>
      </div>
    );
  }

  if (markets.length === 0) {
    return (
      <div className="text-center py-12 text-edgelord-text-muted">
        <p className="mb-2">No markets found.</p>
        <p className="text-sm mb-4">
          Run the <code className="bg-edgelord-raised px-2 py-1 rounded">ingest_markets</code> function to fetch data from Kalshi.
        </p>
        <p className="text-xs">
          🔴 Real-time updates are enabled - new markets will appear automatically when added.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-edgelord-border">
          <thead>
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-edgelord-text-muted uppercase tracking-wider">
                Ticker
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-edgelord-text-muted uppercase tracking-wider">
                Title
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-edgelord-text-muted uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-edgelord-text-muted uppercase tracking-wider">
                Yes
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-edgelord-text-muted uppercase tracking-wider">
                No
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-edgelord-text-muted uppercase tracking-wider">
                Volume ($)
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-edgelord-text-muted uppercase tracking-wider">
                Last Update
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edgelord-border">
            {markets.map((market) => (
              <tr key={market.ticker} className="hover:bg-edgelord-raised">
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-edgelord-primary">
                  {market.ticker}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-edgelord-text-primary">
                  {market.title}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-edgelord-text-muted">
                  <span 
                    className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
                      market.status === 'open' ? 'bg-green-500/20 text-green-400' :
                      market.status === 'closed' ? 'bg-yellow-500/20 text-yellow-400' :
                      market.status === 'settled' ? 'bg-gray-500/20 text-gray-400' :
                      'bg-gray-500/20 text-gray-400'
                    }`}
                    title={
                      market.status === 'open' ? 'Market is open for trading' :
                      market.status === 'closed' ? 'Market is closed, no new trades' :
                      market.status === 'settled' ? 'Market has been settled and resolved' :
                      'Unknown status'
                    }
                  >
                    {market.status}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm">
                  {market.yesPrice !== null ? (
                    <div className={`flex items-center gap-1.5 transition-all duration-300 ${
                      market.yesPriceDirection === 'up' ? 'animate-pulse' : 
                      market.yesPriceDirection === 'down' ? '' : ''
                    }`}>
                      <span className={`text-edgelord-edge-positive ${
                        market.yesPriceDirection === 'up' ? 'font-semibold' : 
                        market.yesPriceDirection === 'down' ? 'opacity-70' : ''
                      }`}>
                        {(market.yesPrice * 100).toFixed(1)}%
                      </span>
                      {market.yesPriceDirection === 'up' && (
                        <span className="text-green-500 text-lg font-bold animate-bounce" title="Price increased">↑</span>
                      )}
                      {market.yesPriceDirection === 'down' && (
                        <span className="text-red-500 text-lg font-bold" title="Price decreased">↓</span>
                      )}
                    </div>
                  ) : '—'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm">
                  {market.noPrice !== null ? (
                    <div className={`flex items-center gap-1.5 transition-all duration-300 ${
                      market.noPriceDirection === 'up' ? 'animate-pulse' : 
                      market.noPriceDirection === 'down' ? '' : ''
                    }`}>
                      <span className={`text-edgelord-edge-negative ${
                        market.noPriceDirection === 'up' ? 'font-semibold' : 
                        market.noPriceDirection === 'down' ? 'opacity-70' : ''
                      }`}>
                        {(market.noPrice * 100).toFixed(1)}%
                      </span>
                      {market.noPriceDirection === 'up' && (
                        <span className="text-green-500 text-lg font-bold animate-bounce" title="Price increased">↑</span>
                      )}
                      {market.noPriceDirection === 'down' && (
                        <span className="text-red-500 text-lg font-bold" title="Price decreased">↓</span>
                      )}
                    </div>
                  ) : '—'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-edgelord-text-dim">
                  {market.volume !== null ? (
                    <span title="Volume in dollars">${market.volume.toLocaleString()}</span>
                  ) : '—'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-edgelord-text-dim">
                  {market.updatedAt ? (
                    <span title={new Date(market.updatedAt).toLocaleString()}>
                      {formatTimeAgo(market.updatedAt)}
                    </span>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 text-xs text-edgelord-text-muted text-center">
        🔴 Live updates enabled
      </div>
    </>
  );
}

