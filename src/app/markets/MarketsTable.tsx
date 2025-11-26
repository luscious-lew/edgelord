'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Market = {
  ticker: string;
  title: string;
  status: string;
  yesPrice: number | null;
  noPrice: number | null;
  volume: number | null;
};

export function MarketsTable() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Initial fetch
    async function fetchMarkets() {
      const { data, error } = await supabase
        .from('markets')
        .select('venue_market_ticker, title, status, yes_price_last, no_price_last, volume')
        .eq('venue', 'kalshi')
        .order('volume', { ascending: false, nullsLast: true })
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
        setMarkets(data.map((market) => ({
          ticker: market.venue_market_ticker,
          title: market.title,
          status: market.status || 'unknown',
          yesPrice: market.yes_price_last ? Number(market.yes_price_last) : null,
          noPrice: market.no_price_last ? Number(market.no_price_last) : null,
          volume: market.volume ? Number(market.volume) : null,
        })));
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
                  return {
                    ...market,
                    yesPrice: payload.new.yes_price_last ? Number(payload.new.yes_price_last) : null,
                    noPrice: payload.new.no_price_last ? Number(payload.new.no_price_last) : null,
                    volume: payload.new.volume ? Number(payload.new.volume) : null,
                    status: payload.new.status || market.status,
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
              
              return [
                {
                  ticker: payload.new.venue_market_ticker,
                  title: payload.new.title,
                  status: payload.new.status || 'unknown',
                  yesPrice: payload.new.yes_price_last ? Number(payload.new.yes_price_last) : null,
                  noPrice: payload.new.no_price_last ? Number(payload.new.no_price_last) : null,
                  volume: payload.new.volume ? Number(payload.new.volume) : null,
                },
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
                Volume
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
                  {market.status}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-edgelord-edge-positive">
                  {market.yesPrice !== null 
                    ? `${(market.yesPrice * 100).toFixed(1)}%` 
                    : '—'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-edgelord-edge-negative">
                  {market.noPrice !== null 
                    ? `${(market.noPrice * 100).toFixed(1)}%` 
                    : '—'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-edgelord-text-dim">
                  {market.volume !== null ? market.volume.toLocaleString() : '—'}
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

