"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// =============================================================================
// TYPES
// =============================================================================

type Market = {
  id: string;
  ticker: string;
  title: string;
  player_name: string;
  yes_price: number;
  yes_bid: number;
  yes_ask: number;
  volume: number;
  volume_24h?: number;
  open_interest: number;
  status: string;
  close_time?: string;
  market_type: "trade" | "next_team";
  team_code?: string;
};

type Trade = {
  order_id: string;
  ticker: string;
  player_name: string;
  side: string;
  action: string;
  type: string;
  status: string;
  price: number;
  count: number;
  remaining_count?: number;
  created_at: string;
  expiration?: string;
  is_fill?: boolean;
  is_taker?: boolean;
};

type Position = {
  ticker: string;
  player_name: string;
  contracts: number;
  side: "yes" | "no";
  current_price: number;
  yes_price?: number;
  avg_entry_price: number;
  cost_basis_breakdown?: Array<{ price: number; count: number; side: string }>;
  pnl: number;
  pnl_percent: number;
  value: number;
  market_type: "trade" | "next_team";
  team_code?: string;
  momentum?: "up" | "down" | "flat";
  momentum_change?: number;
  recent_signals?: any[];
  latest_confidence?: string | null;
  recommendation: "winner" | "strong_buy" | "buy_more" | "hold" | "take_profit" | "reduce" | "sell" | "loss";
  recommendation_reason: string;
  recommendation_strength: number;
};

type PlayerExposure = {
  trade_yes: number;
  trade_no: number;
  trade_price: number;
  next_team_positions: Array<{ team: string; contracts: number; price: number }>;
};

type PortfolioBalance = {
  cash: number;
  position_value: number;
  total: number;
};

type LLMAnalysis = {
  id: number;
  tweet_id: string;
  author_handle: string;
  tweet_text: string;
  model: string;
  latency_ms: number;
  players_analyzed: Array<{
    name: string;
    is_being_traded: boolean;
    confidence: string;
    confidence_score: number;
    sentiment_score: number;
    reasoning: string;
    destination_team?: string;
  }>;
  created_at: string;
};

type Signal = {
  id: number;
  market_id: string;
  signal_type: string;
  ts: string;
  meta: any;
  markets?: Market;
};

type Tweet = {
  id: number;
  tweet_id: string;
  author_handle: string;
  text: string;
  created_at: string;
  players_mentioned: string[];
  confidence_tier: string | null;
};

type PriceHistoryPoint = {
  id: number;
  ticker: string;
  player_name: string;
  price_cents: number;
  volume: number;
  open_interest: number;
  recorded_at: string;
};

type MarketEvent = {
  id: number;
  ticker: string;
  player_name: string;
  event_type: string;
  description: string;
  metadata: Record<string, any> | null;
  created_at: string;
};

type BotSettings = {
  base_contract_count: number;
  max_price_confirmed: number;
  max_price_imminent: number;
  max_price_serious: number;
  min_volume_for_alert: number;
  min_volume_for_auto_buy: number;
  price_spike_threshold: number;
  // Price spike safeguards
  price_spike_max_entry: number; // Don't buy if price already above this
  price_spike_require_twitter: boolean; // Only buy spikes with twitter confirmation
  price_spike_cooldown_minutes: number; // Wait X minutes after spike starts before buying
  price_spike_position_limit: number; // Max contracts per spike trade
  features: {
    twitter_monitoring: boolean;
    price_spike_trading: boolean;
    orderbook_monitoring: boolean;
    profit_taking: boolean;
    telegram_notifications: boolean;
  };
};

type TradeOpportunity = {
  player_name: string;
  ticker: string;
  current_price: number;
  confidence: string;
  reason: string;
  suggested_contracts: number;
  source: "twitter" | "price_spike" | "orderbook" | "manual";
  tweet_id?: string;
  analysis_id?: number;
};

// Navigation tabs
type Tab = "dashboard" | "positions" | "analytics" | "signals" | "settings";

// Portfolio history point for analytics
type PortfolioHistoryPoint = {
  timestamp: string;
  total_value: number;
  cost_basis: number;
  pnl: number;
};

// =============================================================================
// CONSTANTS
// =============================================================================

const TRUSTED_SOURCES = [
  { handle: "ShamsCharania", org: "The Athletic" },
  { handle: "TheSteinLine", org: "Independent" },
  { handle: "ChrisBHaynes", org: "TNT" },
  { handle: "WindhorstESPN", org: "ESPN" },
  { handle: "TimBontemps", org: "ESPN" },
  { handle: "JakeLFischer", org: "Yahoo" },
  { handle: "BobbyMarks42", org: "ESPN (Cap)" },
];

const DEFAULT_SETTINGS: BotSettings = {
  base_contract_count: 100,
  max_price_confirmed: 99,
  max_price_imminent: 92,
  max_price_serious: 80,
  min_volume_for_alert: 5000,
  min_volume_for_auto_buy: 10000,
  price_spike_threshold: 15,
  // Safeguards for PRICE SPIKE ONLY trading (not twitter-based)
  price_spike_max_entry: 85, // Don't auto-buy spikes if price already above 85¢ (twitter trades use their own limits)
  price_spike_require_twitter: true, // Only buy spikes that have twitter confirmation
  price_spike_cooldown_minutes: 2, // Wait 2 minutes after spike detected before buying
  price_spike_position_limit: 50, // Max 50 contracts per spike trade (smaller than twitter trades)
  features: {
    twitter_monitoring: true,
    price_spike_trading: false, // OFF by default - risky strategy
    orderbook_monitoring: true,
    profit_taking: true,
    telegram_notifications: true,
  },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function getTwitterAvatar(handle: string): string {
  return `https://unavatar.io/twitter/${handle}`;
}

function getPlayerHeadshot(playerName: string): string {
  const playerIds: Record<string, string> = {
    "anthony davis": "6583",
    "benedict mathurin": "4433246",
    "bradley beal": "6580",
    "brandon ingram": "4066259",
    "cam johnson": "3138158",
    "cam reddish": "4395651",
    "cam thomas": "4433627",
    "chris paul": "2779",
    "coby white": "4395651",
    "collin sexton": "4278055",
    "daniel gafford": "4277848",
    "darius garland": "4396907",
    "de'aaron fox": "4066261",
    "dejounte murray": "3908845",
    "demar derozan": "3978",
    "desmond bane": "4433247",
    "devin booker": "3136193",
    "domantas sabonis": "3155942",
    "donte divincenzo": "3934672",
    "donovan mitchell": "3908809",
    "dorian finney-smith": "2578185",
    "dyson daniels": "4698385",
    "giannis antetokounmpo": "3032977",
    "gordon hayward": "4249",
    "grayson allen": "3134908",
    "herbert jones": "4433171",
    "immanuel quickley": "4432158",
    "ivica zubac": "3149391",
    "ja morant": "4279888",
    "james harden": "3992",
    "jaren jackson jr": "4277961",
    "jaylen brown": "3917376",
    "jayson tatum": "4065648",
    "jimmy butler": "6430",
    "john collins": "4066636",
    "jonas valanciunas": "6477",
    "jonathan kuminga": "4433218",
    "jordan clarkson": "2566769",
    "jordan poole": "4278129",
    "julius randle": "3064440",
    "karl-anthony towns": "3136195",
    "kawhi leonard": "6450",
    "keldon johnson": "4395693",
    "kevin durant": "3202",
    "kevin love": "3449",
    "klay thompson": "6475",
    "kyle kuzma": "3134907",
    "lamelo ball": "4432166",
    "lauri markkanen": "4066336",
    "lebron james": "1966",
    "luka doncic": "3945274",
    "malik beasley": "4066650",
    "malik monk": "4066328",
    "marcus morris sr": "6462",
    "marcus smart": "2580782",
    "michael porter jr": "4066378",
    "mikal bridges": "4278078",
    "mike conley": "3024",
    "myles turner": "3064439",
    "naz reid": "4066342",
    "nic claxton": "4278572",
    "nicolas claxton": "4278572",
    "nikola jokic": "3112335",
    "nikola vucevic": "6478",
    "norman powell": "2595516",
    "og anunoby": "4066354",
    "pascal siakam": "3149673",
    "paul george": "4251",
    "rj barrett": "4395625",
    "rudy gobert": "3032976",
    "spencer dinwiddie": "2527963",
    "stephen curry": "3975",
    "terry rozier": "3074752",
    "tobias harris": "6440",
    "trae young": "4277905",
    "trey murphy iii": "4433167",
    "trey murphy": "4433167",
    "tyler herro": "4395725",
    "walker kessler": "4432811",
    "wendell carter jr": "4278104",
    "zach lavine": "3064514",
    "zion williamson": "4395628",
  };
  const normalized = playerName.toLowerCase().replace(/\./g, "").trim();
  const id = playerIds[normalized];
  if (id) {
    return `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${id}.png&w=96&h=70&cb=1`;
  }
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(playerName)}&background=6366f1&color=fff&size=96`;
}

function extractPlayerName(title: string): string {
  const match = title.match(/Will\s+(.+?)\s+be\s+traded/i);
  return match ? match[1] : title;
}

function formatTime(ts: string): string {
  const date = new Date(ts);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateTime(ts: string): string {
  const date = new Date(ts);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getRecommendation(price: number): { text: string; color: string; action: "hold" | "maybe_sell" | "sell" | "strong_sell" } {
  if (price >= 90) return { text: "HOLD (near lock)", color: "text-green-400", action: "hold" };
  if (price >= 60) return { text: "HOLD (likely)", color: "text-green-400", action: "hold" };
  if (price >= 40) return { text: "MAYBE SELL", color: "text-yellow-400", action: "maybe_sell" };
  if (price >= 25) return { text: "SELL (low odds)", color: "text-orange-400", action: "sell" };
  return { text: "SELL NOW", color: "text-red-400", action: "strong_sell" };
}

// =============================================================================
// UI COMPONENTS
// =============================================================================

function PriceBar({ price }: { price: number }) {
  // Price is now in cents (0-100)
  const color =
    price >= 90
      ? "bg-green-500"
      : price >= 70
      ? "bg-yellow-500"
      : price >= 40
      ? "bg-orange-500"
      : "bg-red-500";

  return (
    <div className="w-full bg-gray-700 rounded-full h-4 relative">
      <div
        className={`${color} h-4 rounded-full transition-all duration-500`}
        style={{ width: `${price}%` }}
      />
      <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white">
        {price}¢
      </span>
    </div>
  );
}

function TierBadge({ tier }: { tier: string | null }) {
  if (!tier) return null;
  const colors: Record<string, string> = {
    Confirmed: "bg-green-600",
    Imminent: "bg-yellow-600",
    Serious: "bg-orange-600",
    Exploring: "bg-gray-600",
    Negative: "bg-red-600",
  };
  return (
    <span className={`${colors[tier] || "bg-gray-600"} px-2 py-0.5 rounded text-xs font-medium`}>
      {tier}
    </span>
  );
}

function SentimentBar({ score }: { score: number }) {
  const isPositive = score >= 0;
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 bg-gray-600 rounded-full h-2 relative">
        <div
          className={`h-2 rounded-full ${isPositive ? "bg-green-500" : "bg-red-500"}`}
          style={{ width: `${Math.abs(score)}%`, marginLeft: isPositive ? "50%" : `${50 - Math.abs(score)}%` }}
        />
        <div className="absolute left-1/2 top-0 w-0.5 h-2 bg-gray-400" />
      </div>
      <span className={`text-xs font-medium ${isPositive ? "text-green-400" : "text-red-400"}`}>
        {score >= 0 ? "+" : ""}{score}
      </span>
    </div>
  );
}

function Toggle({ enabled, onChange, label }: { enabled: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-sm text-gray-300">{label}</span>
      <div
        className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? "bg-green-600" : "bg-gray-600"}`}
        onClick={() => onChange(!enabled)}
      >
        <div
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${enabled ? "translate-x-5" : ""}`}
        />
      </div>
    </label>
  );
}

function NumberInput({ value, onChange, label, min, max, step = 1 }: { value: number; onChange: (v: number) => void; label: string; min: number; max: number; step?: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-300">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        min={min}
        max={max}
        step={step}
        className="w-24 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-pink-500"
      />
    </div>
  );
}

// Price Chart Component
function PriceChart({ data, height = 150 }: { data: PriceHistoryPoint[]; height?: number }) {
  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
        Not enough data for chart
      </div>
    );
  }

  const width = 600;
  const padding = { top: 20, right: 50, bottom: 30, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const prices = data.map(d => d.price_cents);
  const minPrice = Math.max(0, Math.min(...prices) - 5);
  const maxPrice = Math.max(...prices) + 5;
  const priceRange = maxPrice - minPrice || 1;

  const times = data.map(d => new Date(d.recorded_at).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeRange = maxTime - minTime || 1;

  const points = data.map((d, i) => {
    const x = padding.left + ((times[i] - minTime) / timeRange) * chartWidth;
    const y = padding.top + chartHeight - ((d.price_cents - minPrice) / priceRange) * chartHeight;
    return `${x},${y}`;
  }).join(' ');

  const currentPrice = data[data.length - 1].price_cents;
  const startPrice = data[0].price_cents;
  const priceChange = currentPrice - startPrice;
  const isUp = priceChange >= 0;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
      {[0, 25, 50, 75, 100].filter(p => p >= minPrice && p <= maxPrice).map(price => {
        const y = padding.top + chartHeight - ((price - minPrice) / priceRange) * chartHeight;
        return (
          <g key={price}>
            <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#374151" strokeDasharray="2,2" />
            <text x={width - padding.right + 5} y={y + 4} fill="#6B7280" fontSize="10">{price}¢</text>
          </g>
        );
      })}
      <polyline points={points} fill="none" stroke={isUp ? "#10B981" : "#EF4444"} strokeWidth="2" />
      <polygon
        points={`${padding.left},${padding.top + chartHeight} ${points} ${width - padding.right},${padding.top + chartHeight}`}
        fill={isUp ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)"}
      />
      <circle
        cx={width - padding.right}
        cy={padding.top + chartHeight - ((currentPrice - minPrice) / priceRange) * chartHeight}
        r="4"
        fill={isUp ? "#10B981" : "#EF4444"}
      />
      <text x={padding.left} y={height - 5} fill="#6B7280" fontSize="10">
        {new Date(minTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </text>
      <text x={width - padding.right} y={height - 5} fill="#6B7280" fontSize="10" textAnchor="end">
        {new Date(maxTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </text>
    </svg>
  );
}

// Navigation Tabs
function NavTabs({ activeTab, onTabChange }: { activeTab: Tab; onTabChange: (tab: Tab) => void }) {
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "positions", label: "Positions", icon: "💰" },
    { id: "analytics", label: "Analytics", icon: "📈" },
    { id: "signals", label: "Signals", icon: "📡" },
    { id: "settings", label: "Settings", icon: "⚙️" },
  ];

  return (
    <div className="flex gap-1 bg-gray-800 rounded-lg p-1 mb-6">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            activeTab === tab.id
              ? "bg-pink-600 text-white"
              : "text-gray-400 hover:text-white hover:bg-gray-700"
          }`}
        >
          <span>{tab.icon}</span>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// Trade Execution Modal
function TradeModal({
  opportunity,
  onClose,
  onExecute,
}: {
  opportunity: TradeOpportunity;
  onClose: () => void;
  onExecute: (contracts: number, maxPrice: number) => void;
}) {
  const [contracts, setContracts] = useState(opportunity.suggested_contracts);
  const [maxPrice, setMaxPrice] = useState(Math.min(99, opportunity.current_price + 5));
  const [isExecuting, setIsExecuting] = useState(false);

  const estimatedCost = (contracts * opportunity.current_price) / 100;
  const potentialProfit = (contracts * (100 - opportunity.current_price)) / 100;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-lg max-w-md w-full border border-pink-500/50">
        <div className="flex items-center justify-between p-4 border-b border-gray-700 bg-pink-900/30">
          <div className="flex items-center gap-3">
            <img
              src={getPlayerHeadshot(opportunity.player_name)}
              alt={opportunity.player_name}
              className="w-12 h-12 rounded-full bg-gray-600 object-cover"
            />
            <div>
              <h2 className="text-xl font-bold text-white">{opportunity.player_name}</h2>
              <p className="text-sm text-gray-400">Current: {opportunity.current_price}¢</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl">×</button>
        </div>

        <div className="p-4 space-y-4">
          {/* Signal Info */}
          <div className="bg-gray-700/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <TierBadge tier={opportunity.confidence} />
              <span className="text-xs text-gray-400">via {opportunity.source}</span>
            </div>
            <p className="text-sm text-gray-300">{opportunity.reason}</p>
          </div>

          {/* Trade Inputs */}
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Contracts to Buy</label>
              <input
                type="number"
                value={contracts}
                onChange={(e) => setContracts(Math.max(1, Number(e.target.value)))}
                min={1}
                max={500}
                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-pink-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Max Price (¢)</label>
              <input
                type="number"
                value={maxPrice}
                onChange={(e) => setMaxPrice(Math.min(99, Math.max(1, Number(e.target.value))))}
                min={1}
                max={99}
                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-pink-500"
              />
            </div>
          </div>

          {/* Cost Breakdown */}
          <div className="bg-gray-900 rounded-lg p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Est. Cost</span>
              <span className="text-white font-medium">${estimatedCost.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Potential Profit</span>
              <span className="text-green-400 font-medium">${potentialProfit.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm border-t border-gray-700 pt-2">
              <span className="text-gray-400">Max Payout</span>
              <span className="text-white font-bold">${(contracts).toFixed(2)}</span>
            </div>
          </div>

          {/* Execute Button */}
          <button
            onClick={async () => {
              setIsExecuting(true);
              await onExecute(contracts, maxPrice);
              setIsExecuting(false);
              onClose();
            }}
            disabled={isExecuting}
            className={`w-full py-3 rounded-lg font-bold text-white transition-colors ${
              isExecuting
                ? "bg-gray-600 cursor-not-allowed"
                : "bg-green-600 hover:bg-green-500"
            }`}
          >
            {isExecuting ? "Executing..." : `BUY ${contracts} YES @ ${maxPrice}¢`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Player Detail Modal with Chart, Timeline, and Exposure
function PlayerDetailModal({
  playerName,
  ticker,
  currentPrice,
  priceHistory,
  events,
  tweets,
  exposure,
  onClose,
  onTrade,
}: {
  playerName: string;
  ticker: string;
  currentPrice: number;
  priceHistory: PriceHistoryPoint[];
  events: MarketEvent[];
  tweets: Tweet[];
  exposure?: PlayerExposure;
  onClose: () => void;
  onTrade: (opportunity: TradeOpportunity) => void;
}) {
  const timelineItems = [
    ...events.map(e => ({
      id: `event-${e.id}`,
      type: e.event_type,
      description: e.description,
      timestamp: e.created_at,
      metadata: e.metadata,
    })),
    ...tweets.filter(t => t.players_mentioned.includes(playerName)).map(t => ({
      id: `tweet-${t.id}`,
      type: 'tweet',
      description: `@${t.author_handle}: ${t.text.substring(0, 150)}${t.text.length > 150 ? '...' : ''}`,
      timestamp: t.created_at,
      metadata: { handle: t.author_handle, tier: t.confidence_tier },
    })),
  ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const { text: recText, color: recColor } = getRecommendation(currentPrice);
  const hasExposure = exposure && (exposure.trade_yes > 0 || exposure.trade_no > 0 || exposure.next_team_positions.length > 0);

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-lg max-w-3xl w-full max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <img
              src={getPlayerHeadshot(playerName)}
              alt={playerName}
              className="w-12 h-12 rounded-full bg-gray-600 object-cover"
            />
            <div>
              <h2 className="text-xl font-bold">{playerName}</h2>
              <div className="flex items-center gap-2 text-sm">
                <span className={`font-mono text-lg ${currentPrice >= 50 ? 'text-green-400' : 'text-gray-300'}`}>
                  {currentPrice}¢
                </span>
                <span className="text-gray-500">|</span>
                <span className={recColor}>{recText}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onTrade({
                player_name: playerName,
                ticker,
                current_price: currentPrice,
                confidence: "Serious",
                reason: "Manual trade from player detail view",
                suggested_contracts: 25,
                source: "manual",
              })}
              className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded-lg text-sm font-medium"
            >
              Trade
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl">×</button>
          </div>
        </div>

        <div className="overflow-y-auto max-h-[calc(90vh-80px)]">
          {/* Your Exposure Section */}
          {hasExposure && (
            <div className="p-4 border-b border-gray-700 bg-gradient-to-r from-blue-900/20 to-purple-900/20">
              <h3 className="text-sm font-semibold text-blue-400 mb-3">Your Exposure</h3>
              <div className="grid grid-cols-2 gap-4">
                {/* Trade Market Exposure */}
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-xs text-gray-400 mb-2">Will be traded?</p>
                  <div className="space-y-2">
                    {exposure!.trade_yes > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-green-400 font-medium">YES</span>
                        <span className="text-white">{exposure!.trade_yes} contracts @ {exposure!.trade_price}¢</span>
                      </div>
                    )}
                    {exposure!.trade_no > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-red-400 font-medium">NO</span>
                        <span className="text-white">{exposure!.trade_no} contracts @ {100 - exposure!.trade_price}¢</span>
                      </div>
                    )}
                    {exposure!.trade_yes === 0 && exposure!.trade_no === 0 && (
                      <p className="text-gray-500 text-sm">No trade market position</p>
                    )}
                  </div>
                </div>

                {/* Next Team Predictions */}
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-xs text-gray-400 mb-2">Next Team Predictions</p>
                  {exposure!.next_team_positions.length > 0 ? (
                    <div className="space-y-1">
                      {exposure!.next_team_positions.map((pos, idx) => (
                        <div key={idx} className="flex items-center justify-between text-sm">
                          <span className="text-purple-400 font-medium">{pos.team}</span>
                          <span className="text-white">{pos.contracts} @ {pos.price}¢</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-gray-500 text-sm">No team predictions</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Price Chart */}
          <div className="p-4 border-b border-gray-700">
            <h3 className="text-sm font-semibold text-gray-400 mb-2">Price History</h3>
            <div className="bg-gray-900 rounded-lg p-3">
              <PriceChart data={priceHistory} height={180} />
            </div>
          </div>

          {/* Activity Timeline */}
          <div className="p-4">
            <h3 className="text-sm font-semibold text-gray-400 mb-3">Activity Timeline</h3>
            {timelineItems.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-4">No events recorded yet</p>
            ) : (
              <div className="space-y-2">
                {timelineItems.slice(0, 20).map((item) => {
                  const iconMap: Record<string, string> = {
                    price_spike_buy: '🟢',
                    trade_executed: '🟢',
                    price_spike: '📈',
                    price_drop: '📉',
                    volume_alert: '📊',
                    tweet: '🐦',
                    orderbook_whale: '🐋',
                  };
                  const icon = iconMap[item.type] || '📌';
                  return (
                    <div key={item.id} className="flex gap-3 bg-gray-700/30 rounded p-2">
                      <span className="text-lg">{icon}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-300">{item.description}</p>
                        <p className="text-xs text-gray-500 mt-1">
                          {new Date(item.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Tweet Modal
function TweetModal({
  title,
  tweets,
  onClose,
  onPlayerClick,
  onHandleClick,
}: {
  title: string;
  tweets: Tweet[];
  onClose: () => void;
  onPlayerClick: (player: string) => void;
  onHandleClick: (handle: string) => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-lg max-w-2xl w-full max-h-[80vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-xl font-bold">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl">×</button>
        </div>
        <div className="overflow-y-auto max-h-[calc(80vh-60px)] p-4 space-y-3">
          {tweets.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No tweets found</p>
          ) : (
            tweets.map((tweet) => (
              <div key={tweet.id} className="bg-gray-700/50 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <button
                    onClick={() => onHandleClick(tweet.author_handle)}
                    className="text-blue-400 hover:underline font-medium"
                  >
                    @{tweet.author_handle}
                  </button>
                  <div className="flex items-center gap-2">
                    <TierBadge tier={tweet.confidence_tier} />
                    <span className="text-gray-500 text-sm">{formatDateTime(tweet.created_at)}</span>
                  </div>
                </div>
                <p className="text-gray-200 text-sm whitespace-pre-wrap mb-2">{tweet.text}</p>
                {tweet.players_mentioned.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {tweet.players_mentioned.map((player) => (
                      <button
                        key={player}
                        onClick={() => onPlayerClick(player)}
                        className="bg-pink-900/50 text-pink-300 px-2 py-0.5 rounded text-xs hover:bg-pink-800/50"
                      >
                        {player}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// LLM Analysis Modal
function AnalysisModal({ analysis, onClose }: { analysis: LLMAnalysis; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-lg max-w-2xl w-full max-h-[80vh] overflow-hidden border border-purple-500/50">
        <div className="flex items-center justify-between p-4 border-b border-gray-700 bg-purple-900/30">
          <div>
            <h2 className="text-xl font-bold text-purple-300">LLM Analysis</h2>
            <p className="text-xs text-gray-400">{analysis.model} · {analysis.latency_ms}ms</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl">×</button>
        </div>
        <div className="overflow-y-auto max-h-[calc(80vh-120px)] p-4 space-y-4">
          <div className="bg-gray-700/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-blue-400 font-medium">@{analysis.author_handle}</span>
              <span className="text-gray-500 text-xs">{formatDateTime(analysis.created_at)}</span>
            </div>
            <p className="text-gray-200 text-sm whitespace-pre-wrap">{analysis.tweet_text}</p>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-purple-300 uppercase tracking-wide">Player Analysis</h3>
            {analysis.players_analyzed.map((player, idx) => (
              <div key={idx} className="bg-gray-700/30 rounded-lg p-3 border-l-4 border-purple-500">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <img
                      src={getPlayerHeadshot(player.name)}
                      alt={player.name}
                      className="w-10 h-10 rounded-full object-cover bg-gray-600"
                    />
                    <span className="font-bold text-white">{player.name}</span>
                  </div>
                  <TierBadge tier={player.confidence.charAt(0).toUpperCase() + player.confidence.slice(1)} />
                </div>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <div>
                    <span className="text-xs text-gray-400">Confidence</span>
                    <div className="flex items-center gap-2">
                      <div className="w-full bg-gray-600 rounded-full h-2">
                        <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${player.confidence_score}%` }} />
                      </div>
                      <span className="text-xs font-medium text-blue-400">{player.confidence_score}%</span>
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-gray-400">Sentiment</span>
                    <SentimentBar score={player.sentiment_score} />
                  </div>
                </div>
                <p className="text-sm text-gray-300 italic">"{player.reasoning}"</p>
                {player.destination_team && (
                  <p className="text-xs text-green-400 mt-1">→ {player.destination_team}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function NBATrades() {
  // State
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [markets, setMarkets] = useState<Market[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tweets, setTweets] = useState<Tweet[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [priceAlerts, setPriceAlerts] = useState<any[]>([]);
  const [opportunities, setOpportunities] = useState<TradeOpportunity[]>([]);
  const [settings, setSettings] = useState<BotSettings>(DEFAULT_SETTINGS);
  const [portfolioBalance, setPortfolioBalance] = useState<PortfolioBalance>({ cash: 0, position_value: 0, total: 0 });
  const [playerExposure, setPlayerExposure] = useState<Record<string, PlayerExposure>>({});

  const [botStatus, setBotStatus] = useState<"running" | "stopped" | "unknown">("unknown");
  const [lastPoll, setLastPoll] = useState<Date | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [botSettingsLoadedAt, setBotSettingsLoadedAt] = useState<Date | null>(null);
  const [totalPnL, setTotalPnL] = useState<number>(0);
  const [totalInvested, setTotalInvested] = useState<number>(0);
  const [portfolioHistory, setPortfolioHistory] = useState<PortfolioHistoryPoint[]>([]);
  const [realizedPnL, setRealizedPnL] = useState<{
    settlements: Array<{
      type: "settlement";
      ticker: string;
      player_name: string;
      market_result: string;
      yes_cost: number;
      yes_payout: number;
      no_cost: number;
      no_payout: number;
      total_pnl: number;
    }>;
    early_exits: Array<{
      type: "early_exit";
      ticker: string;
      player_name: string;
      side: string;
      contracts_sold: number;
      avg_buy_price: number;
      avg_sell_price: number;
      total_cost: number;
      total_proceeds: number;
      total_pnl: number;
    }>;
    summary: {
      total_realized_pnl: number;
      settled_pnl: number;
      early_exit_pnl: number;
    };
  }>({ settlements: [], early_exits: [], summary: { total_realized_pnl: 0, settled_pnl: 0, early_exit_pnl: 0 } });

  // Modal states
  const [showTweetModal, setShowTweetModal] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalTweets, setModalTweets] = useState<Tweet[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState<{ name: string; ticker: string; price: number } | null>(null);
  const [playerPriceHistory, setPlayerPriceHistory] = useState<PriceHistoryPoint[]>([]);
  const [playerEvents, setPlayerEvents] = useState<MarketEvent[]>([]);
  const [selectedAnalysis, setSelectedAnalysis] = useState<LLMAnalysis | null>(null);
  const [tradeOpportunity, setTradeOpportunity] = useState<TradeOpportunity | null>(null);
  const [settingsSaved, setSettingsSaved] = useState<"saving" | "saved" | "bot_updated" | false>(false);
  const [signalFilter, setSignalFilter] = useState<{ player: string; source: string }>({ player: "", source: "" });
  const [selectedSignal, setSelectedSignal] = useState<any | null>(null);

  // ==========================================================================
  // DATA FETCHING
  // ==========================================================================

  const fetchData = useCallback(async () => {
    await Promise.all([
      fetchMarkets(),
      fetchTrades(),
      fetchTweets(),
      fetchBotStatus(),
      fetchPriceAlerts(),
      fetchPositions(),
      fetchSettings(),
      fetchOpportunities(),
      fetchPortfolioHistory(),
      fetchSettlements(),
    ]);
    setLastUpdate(new Date());
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  async function fetchMarkets() {
    try {
      const response = await fetch("/api/markets");
      if (!response.ok) throw new Error("Failed to fetch markets");
      const data = await response.json();

      // Combine trade and next team markets, prioritizing trade markets
      const allMarkets: Market[] = [
        ...(data.trade_markets || []),
        ...(data.next_team_markets || []),
      ].sort((a, b) => b.yes_price - a.yes_price);

      setMarkets(allMarkets);
    } catch (e) {
      console.error("Failed to fetch markets:", e);
    }
  }

  async function fetchTrades() {
    try {
      const response = await fetch("/api/orders");
      if (!response.ok) throw new Error("Failed to fetch orders");
      const data = await response.json();

      // Combine orders and fills, marking fills appropriately
      const allTrades: Trade[] = [
        ...(data.orders || []).map((o: any) => ({ ...o, is_fill: false })),
        ...(data.fills || []).map((f: any) => ({ ...f, order_id: f.trade_id || f.order_id, is_fill: true })),
      ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      setTrades(allTrades);

      // Calculate P&L from fills (executed trades)
      let pnl = 0;
      let invested = 0;
      for (const fill of data.fills || []) {
        if (fill.side === "yes" && fill.action === "buy") {
          // For YES buys, we've invested at the fill price
          invested += (fill.price * fill.count) / 100;
          // Find current market price
          const market = markets.find(m => m.ticker === fill.ticker);
          if (market) {
            const currentPrice = market.yes_price;
            const priceDiff = currentPrice - fill.price;
            pnl += (priceDiff * fill.count) / 100;
          }
        }
      }
      setTotalPnL(pnl);
      setTotalInvested(invested);
    } catch (e) {
      console.error("Failed to fetch orders:", e);
    }
  }

  async function fetchTweets() {
    const { data } = await supabase
      .from("tweets")
      .select("*")
      .order("fetched_at", { ascending: false })
      .limit(100);
    if (data) {
      setTweets(data);
      if (data.length > 0) {
        const lastFetch = new Date(data[0].fetched_at);
        const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
        if (lastFetch > twoMinAgo) setBotStatus("running");
      }
    }
  }

  async function fetchBotStatus() {
    const { data } = await supabase
      .from("bot_status")
      .select("*")
      .eq("id", "nba-trade-bot")
      .single();
    if (data) {
      const lastPollTime = data.last_poll_at ? new Date(data.last_poll_at) : null;
      setLastPoll(lastPollTime);
      if (lastPollTime) {
        // Allow 90 seconds grace period (3x poll interval) for timing variations
        const ninetySecsAgo = new Date(Date.now() - 90 * 1000);
        setBotStatus(lastPollTime > ninetySecsAgo ? "running" : "stopped");
      }
      // Track when bot last loaded settings
      if (data.settings_loaded_at) {
        setBotSettingsLoadedAt(new Date(data.settings_loaded_at));
      }
    }
  }

  async function fetchPriceAlerts() {
    // Fetch unified activity feed from our signals API
    try {
      const response = await fetch("/api/signals");
      if (!response.ok) throw new Error("Failed to fetch signals");
      const data = await response.json();
      setPriceAlerts(data.activity || []);
      console.log("[SIGNALS] Fetched:", data.stats, "raw counts:", data.raw);
    } catch (e) {
      console.error("Failed to fetch signals:", e);
      // Fallback to direct Supabase query
      const { data } = await supabase
        .from("signals")
        .select("*")
        .gte("ts", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order("ts", { ascending: false })
        .limit(50);
      if (data) setPriceAlerts(data);
    }
  }

  async function fetchPositions() {
    // Fetch real positions from Kalshi API with smart recommendations
    try {
      const response = await fetch("/api/positions");
      if (!response.ok) throw new Error("Failed to fetch positions");
      const data = await response.json();

      const sortedPositions = (data.positions || []).sort((a: Position, b: Position) => {
        // Primary sort: value descending
        if (b.value !== a.value) return b.value - a.value;
        // Secondary sort: recommendation strength descending
        return b.recommendation_strength - a.recommendation_strength;
      });

      setPositions(sortedPositions);
      setPortfolioBalance(data.balance || { cash: 0, position_value: 0, total: 0 });
      setPlayerExposure(data.player_exposure || {});

      // Calculate total P&L from positions with corrected NO pricing
      // For NO positions where entry price > 50, the API likely recorded YES price instead of NO price
      // So we need to invert it: actual NO entry = 100 - recorded entry
      // Also exclude Darius Garland "stays with Cleveland" - glitched test trade
      const correctedPositions = sortedPositions
        .filter((pos: Position) => !(pos.player_name === "Darius Garland" && pos.market_type === "next_team"))
        .map((pos: Position) => {
          // For NO positions with entry > 50, the price was likely recorded as YES price
          // Correct by inverting: real NO cost = 100 - recorded_yes_price
          if (pos.side === "no" && pos.avg_entry_price > 50) {
            const correctedEntry = 100 - pos.avg_entry_price;
            const correctedCostBasis = (correctedEntry * pos.contracts) / 100;
            const currentValue = pos.value; // This should already be correct (NO price * contracts)
            const correctedPnL = currentValue - correctedCostBasis;
            return { ...pos, pnl: correctedPnL, avg_entry_price: correctedEntry };
          }
          return pos;
        });
      const totalUnrealizedPnL = correctedPositions.reduce((sum: number, pos: Position) => sum + (pos.pnl || 0), 0);
      setTotalPnL(totalUnrealizedPnL);
    } catch (e) {
      console.error("Failed to fetch positions:", e);
    }
  }

  async function fetchSettings() {
    const { data } = await supabase
      .from("bot_settings")
      .select("*")
      .eq("id", "nba-trade-bot")
      .single();
    if (data?.settings) {
      setSettings({ ...DEFAULT_SETTINGS, ...data.settings });
    }
  }

  async function fetchOpportunities() {
    // Get recent high-confidence signals that haven't been acted on
    const { data: signals } = await supabase
      .from("signals")
      .select("*")
      .in("signal_type", ["twitter_signal", "price_movement"])
      .gte("ts", new Date(Date.now() - 30 * 60 * 1000).toISOString())
      .order("ts", { ascending: false });

    const opps: TradeOpportunity[] = [];
    for (const signal of signals ?? []) {
      const meta = signal.meta || {};
      if (meta.confidence_tier && ["Confirmed", "Imminent", "Serious"].includes(meta.confidence_tier)) {
        const market = markets.find(m => m.ticker === signal.market_id);
        if (market && (market.yes_price ?? 0) < 90) {
          opps.push({
            player_name: meta.player_name || market.player_name || extractPlayerName(market.title),
            ticker: signal.market_id,
            current_price: market.yes_price ?? 0,
            confidence: meta.confidence_tier,
            reason: meta.reason || meta.tweet_text || "Signal detected",
            suggested_contracts: settings.base_contract_count,
            source: signal.signal_type === "twitter_signal" ? "twitter" : "price_spike",
            analysis_id: meta.analysis_id,
          });
        }
      }
    }
    setOpportunities(opps);
  }

  async function fetchPortfolioHistory() {
    // Get fills from Kalshi API to build portfolio value over time
    try {
      const response = await fetch("/api/orders");
      if (!response.ok) {
        setPortfolioHistory([]);
        return;
      }
      const data = await response.json();
      const fills = data.fills || [];

      if (fills.length === 0) {
        setPortfolioHistory([]);
        return;
      }

      // Sort fills by created_at ascending
      const sortedFills = [...fills].sort(
        (a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

      // Group fills by hour for chart
      const fillsByHour: Record<string, { cost: number; contracts: number }> = {};

      for (const fill of sortedFills) {
        const hour = new Date(fill.created_at).toISOString().slice(0, 13) + ":00:00.000Z";
        if (!fillsByHour[hour]) {
          fillsByHour[hour] = { cost: 0, contracts: 0 };
        }

        const fillCost = (fill.price * fill.count) / 100;
        if (fill.action === "buy") {
          fillsByHour[hour].cost += fillCost;
          fillsByHour[hour].contracts += fill.count;
        } else if (fill.action === "sell") {
          fillsByHour[hour].cost -= fillCost;
          fillsByHour[hour].contracts -= fill.count;
        }
      }

      // Convert to history points with cumulative values
      const history: PortfolioHistoryPoint[] = [];
      let cumulativeCost = 0;
      let cumulativeContracts = 0;

      for (const [timestamp, data] of Object.entries(fillsByHour).sort()) {
        cumulativeCost += data.cost;
        cumulativeContracts += data.contracts;

        history.push({
          timestamp,
          total_value: cumulativeCost, // At time of purchase, value = cost
          cost_basis: cumulativeCost,
          pnl: 0, // Historical PnL would need historical prices
        });
      }

      setPortfolioHistory(history);
    } catch (e) {
      console.error("Failed to fetch portfolio history:", e);
      setPortfolioHistory([]);
    }
  }

  async function fetchSettlements() {
    try {
      const response = await fetch("/api/settlements");
      if (!response.ok) return;
      const data = await response.json();
      setRealizedPnL({
        settlements: data.settlements || [],
        early_exits: data.early_exits || [],
        summary: data.summary || { total_realized_pnl: 0, settled_pnl: 0, early_exit_pnl: 0 },
      });
    } catch (e) {
      console.error("Failed to fetch settlements:", e);
    }
  }

  async function saveSettings(newSettings: BotSettings) {
    setSettingsSaved("saving");
    setSettings(newSettings);

    const updateTime = new Date().toISOString();
    await supabase.from("bot_settings").upsert({
      id: "nba-trade-bot",
      settings: newSettings,
      updated_at: updateTime,
    });

    setSettingsSaved("saved");

    // Poll for bot acknowledgment (up to 5 seconds)
    let attempts = 0;
    const maxAttempts = 10;
    const pollInterval = setInterval(async () => {
      attempts++;
      const { data } = await supabase
        .from("bot_status")
        .select("settings_loaded_at, settings_version")
        .eq("id", "nba-trade-bot")
        .single();

      if (data?.settings_version === updateTime) {
        clearInterval(pollInterval);
        setSettingsSaved("bot_updated");
        setTimeout(() => setSettingsSaved(false), 3000);
      } else if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        // Settings saved but bot hasn't confirmed yet - that's ok
        setTimeout(() => setSettingsSaved(false), 2000);
      }
    }, 500);
  }

  async function executeTrade(ticker: string, contracts: number, maxPrice: number) {
    // This calls the API to execute the trade
    try {
      const response = await fetch("/api/execute-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, contracts, maxPrice, side: "yes", action: "buy" }),
      });
      if (!response.ok) throw new Error("Trade failed");
      await fetchTrades();
      await fetchPositions();
    } catch (e) {
      console.error("Trade execution failed:", e);
      alert("Trade execution failed. Check console for details.");
    }
  }

  async function executeSell(ticker: string, contracts: number, currentPrice: number, positionSide: string) {
    // Sell position - this is selling (closing) the position
    const minPrice = Math.max(1, currentPrice - 5); // Accept up to 5¢ below current price
    try {
      const response = await fetch("/api/execute-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          contracts,
          maxPrice: positionSide === "yes" ? minPrice : (100 - minPrice), // Sell YES means selling at bid
          side: positionSide,
          action: "sell",
        }),
      });
      if (!response.ok) throw new Error("Sell failed");
      await fetchTrades();
      await fetchPositions();
      alert(`Sell order placed for ${contracts} contracts`);
    } catch (e) {
      console.error("Sell execution failed:", e);
      alert("Sell execution failed. Check console for details.");
    }
  }

  // Helpers for modals
  async function showPlayerTweets(playerName: string) {
    const { data } = await supabase
      .from("tweets")
      .select("*")
      .contains("players_mentioned", [playerName])
      .order("created_at", { ascending: false })
      .limit(50);

    const { data: textMatches } = await supabase
      .from("tweets")
      .select("*")
      .ilike("text", `%${playerName}%`)
      .order("created_at", { ascending: false })
      .limit(50);

    const allTweets = [...(data || []), ...(textMatches || [])];
    const uniqueTweets = Array.from(new Map(allTweets.map((t) => [t.tweet_id, t])).values())
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    setModalTitle(`Tweets about ${playerName}`);
    setModalTweets(uniqueTweets);
    setShowTweetModal(true);
  }

  async function showHandleTweets(handle: string) {
    const { data } = await supabase
      .from("tweets")
      .select("*")
      .eq("author_handle", handle)
      .order("created_at", { ascending: false })
      .limit(50);

    setModalTitle(`@${handle}'s Tweets`);
    setModalTweets(data || []);
    setShowTweetModal(true);
  }

  async function openPlayerDetail(playerName: string, market: Market) {
    const ticker = market.ticker;
    const price = market.yes_price ?? 0;

    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: historyData } = await supabase
      .from("price_history")
      .select("*")
      .eq("ticker", ticker)
      .gte("recorded_at", since)
      .order("recorded_at", { ascending: true });

    const { data: eventsData } = await supabase
      .from("market_events")
      .select("*")
      .eq("ticker", ticker)
      .order("created_at", { ascending: false })
      .limit(50);

    setPlayerPriceHistory(historyData || []);
    setPlayerEvents(eventsData || []);
    setSelectedPlayer({ name: playerName, ticker, price });
  }

  async function showTradeAnalysis(analysisId: number) {
    const { data } = await supabase.from("llm_analyses").select("*").eq("id", analysisId).single();
    if (data) setSelectedAnalysis(data as LLMAnalysis);
  }

  // Computed values - prices are now in cents (0-100)
  const tradeMarkets = markets.filter((m) => m.market_type === "trade");
  const tradedMarkets = tradeMarkets.filter((m) => (m.yes_price ?? 0) >= 95);
  const hotMarkets = tradeMarkets.filter((m) => (m.yes_price ?? 0) >= 60 && (m.yes_price ?? 0) < 95);
  const activeMarkets = tradeMarkets.filter((m) => (m.yes_price ?? 0) < 60);
  const recentPlayerTweets = tweets
    .filter((t) => t.players_mentioned.length > 0)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10);

  // ==========================================================================
  // RENDER
  // ==========================================================================

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-pink-500">NBA Trade Terminal</h1>
            <p className="text-gray-400 mt-1">Real-time trading on Kalshi prediction markets</p>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${
                botStatus === "running" ? "bg-green-500 animate-pulse" :
                botStatus === "stopped" ? "bg-red-500" : "bg-yellow-500"
              }`} />
              <span className="text-sm text-gray-400">
                {botStatus === "running" ? "Bot Active" : botStatus === "stopped" ? "Bot Stopped" : "Unknown"}
              </span>
            </div>
            {lastPoll && <p className="text-xs text-gray-500 mt-1">Last poll: {formatTime(lastPoll.toISOString())}</p>}
          </div>
        </div>

        {/* Navigation */}
        <NavTabs activeTab={activeTab} onTabChange={setActiveTab} />

        {/* Dashboard Tab */}
        {activeTab === "dashboard" && (
          <>
            {/* Stats Row */}
            <div className="grid grid-cols-6 gap-4 mb-6">
              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-gray-400 text-sm">Total Markets</p>
                <p className="text-2xl font-bold">{markets.length}</p>
              </div>
              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-gray-400 text-sm">Traded (95%+)</p>
                <p className="text-2xl font-bold text-green-500">{tradedMarkets.length}</p>
              </div>
              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-gray-400 text-sm">Hot (60-95%)</p>
                <p className="text-2xl font-bold text-yellow-500">{hotMarkets.length}</p>
              </div>
              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-gray-400 text-sm">Your Positions</p>
                <p className="text-2xl font-bold text-pink-500">{positions.length}</p>
              </div>
              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-gray-400 text-sm">Orders Placed</p>
                <p className="text-2xl font-bold">{trades.length}</p>
              </div>
              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-gray-400 text-sm">Total P&L</p>
                <p className={`text-2xl font-bold ${(totalPnL + realizedPnL.summary.total_realized_pnl) >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {(totalPnL + realizedPnL.summary.total_realized_pnl) >= 0 ? "+" : ""}${(totalPnL + realizedPnL.summary.total_realized_pnl).toFixed(2)}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Unrealized: {totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)} | Realized: {realizedPnL.summary.total_realized_pnl >= 0 ? "+" : ""}${realizedPnL.summary.total_realized_pnl.toFixed(2)}
                </p>
              </div>
            </div>

            {/* Trade Opportunities */}
            {opportunities.length > 0 && (
              <div className="bg-gradient-to-r from-pink-900/30 to-purple-900/30 border border-pink-500/50 rounded-lg p-4 mb-6">
                <h2 className="text-lg font-semibold text-pink-400 mb-3 flex items-center gap-2">
                  <span>🎯</span> Trade Opportunities
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {opportunities.slice(0, 6).map((opp, idx) => (
                    <div key={idx} className="bg-gray-800/80 rounded-lg p-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <img src={getPlayerHeadshot(opp.player_name)} alt="" className="w-10 h-10 rounded-full bg-gray-600" />
                        <div>
                          <p className="font-medium">{opp.player_name}</p>
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-gray-400">{opp.current_price}¢</span>
                            <TierBadge tier={opp.confidence} />
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => setTradeOpportunity(opp)}
                        className="px-3 py-1 bg-green-600 hover:bg-green-500 rounded text-sm font-medium"
                      >
                        Trade
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-6">
              {/* Markets Column */}
              <div className="col-span-2 space-y-4">
                {tradedMarkets.length > 0 && (
                  <div className="bg-gray-800 rounded-lg p-4">
                    <h2 className="text-lg font-semibold text-green-500 mb-3">Traded (Resolved YES)</h2>
                    <div className="space-y-2">
                      {tradedMarkets.map((m) => (
                        <div
                          key={m.id}
                          className="flex items-center justify-between bg-gray-700/50 rounded p-2 hover:bg-gray-700 cursor-pointer"
                          onClick={() => openPlayerDetail(m.player_name, m)}
                        >
                          <div className="flex items-center gap-2">
                            <img src={getPlayerHeadshot(m.player_name)} alt="" className="w-8 h-8 rounded-full bg-gray-600 object-cover" />
                            <span className="font-medium text-green-400">{m.player_name}</span>
                          </div>
                          <div className="w-32"><PriceBar price={m.yes_price ?? 0} /></div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {hotMarkets.length > 0 && (
                  <div className="bg-gray-800 rounded-lg p-4">
                    <h2 className="text-lg font-semibold text-yellow-500 mb-3">Hot (Trade Likely)</h2>
                    <div className="space-y-2">
                      {hotMarkets.map((m) => (
                        <div
                          key={m.id}
                          className="flex items-center justify-between bg-gray-700/50 rounded p-2 hover:bg-gray-700 cursor-pointer"
                          onClick={() => openPlayerDetail(m.player_name, m)}
                        >
                          <div className="flex items-center gap-2">
                            <img src={getPlayerHeadshot(m.player_name)} alt="" className="w-8 h-8 rounded-full bg-gray-600 object-cover" />
                            <span className="font-medium text-yellow-400">{m.player_name}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setTradeOpportunity({
                                  player_name: m.player_name,
                                  ticker: m.ticker,
                                  current_price: m.yes_price ?? 0,
                                  confidence: "Serious",
                                  reason: "Hot market - manual trade",
                                  suggested_contracts: settings.base_contract_count / 2,
                                  source: "manual",
                                });
                              }}
                              className="px-2 py-1 bg-green-600 hover:bg-green-500 rounded text-xs"
                            >
                              Trade
                            </button>
                            <div className="w-32"><PriceBar price={m.yes_price ?? 0} /></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-gray-800 rounded-lg p-4">
                  <h2 className="text-lg font-semibold text-gray-400 mb-3">Active Markets</h2>
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {activeMarkets.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between bg-gray-700/50 rounded p-2 hover:bg-gray-700 cursor-pointer"
                        onClick={() => openPlayerDetail(m.player_name, m)}
                      >
                        <div className="flex items-center gap-2">
                          <img src={getPlayerHeadshot(m.player_name)} alt="" className="w-8 h-8 rounded-full bg-gray-600 object-cover" />
                          <span className="font-medium">{m.player_name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setTradeOpportunity({
                                player_name: m.player_name,
                                ticker: m.ticker,
                                current_price: m.yes_price ?? 0,
                                confidence: "Exploring",
                                reason: "Manual speculative trade",
                                suggested_contracts: settings.base_contract_count / 4,
                                source: "manual",
                              });
                            }}
                            className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-xs"
                          >
                            Trade
                          </button>
                          <div className="w-32"><PriceBar price={m.yes_price ?? 0} /></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Activity Feed */}
              <div className="space-y-4">
                <div className="bg-gray-800 rounded-lg p-4">
                  <h2 className="text-lg font-semibold mb-3">Recent Orders</h2>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {trades.slice(0, 8).map((t, idx) => {
                      const isFilled = t.is_fill || t.status === "filled";
                      return (
                        <div key={t.order_id + idx} className={`text-sm p-2 rounded ${isFilled ? "bg-green-900/30 border border-green-700" : "bg-gray-700/50"}`}>
                          <div className="flex justify-between">
                            <span className="font-medium">{t.player_name || t.ticker.slice(-20)}</span>
                            <span className="text-gray-400 text-xs">{formatTime(t.created_at)}</span>
                          </div>
                          <div className="flex justify-between text-xs mt-1">
                            <span className="text-gray-400">
                              {t.action?.toUpperCase()} {t.count}{" "}
                              <span className={t.side === "yes" ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                                {t.side?.toUpperCase()}
                              </span>{" "}
                              @ {t.price}¢
                            </span>
                            <span className={`${isFilled ? "text-green-400" : "text-yellow-400"}`}>
                              {isFilled ? "Filled" : t.status}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="bg-gray-800 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-lg font-semibold">Live Tweets</h2>
                    <button
                      onClick={() => {
                        setModalTitle("All Tweets");
                        setModalTweets(tweets);
                        setShowTweetModal(true);
                      }}
                      className="text-sm text-blue-400 hover:underline"
                    >
                      View All
                    </button>
                  </div>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {recentPlayerTweets.map((tweet) => (
                      <div key={tweet.id} className="text-sm p-2 rounded bg-gray-700/50">
                        <div className="flex items-center justify-between mb-1">
                          <button onClick={() => showHandleTweets(tweet.author_handle)} className="text-blue-400 hover:underline font-medium text-xs">
                            @{tweet.author_handle}
                          </button>
                          <TierBadge tier={tweet.confidence_tier} />
                        </div>
                        <p className="text-gray-300 text-xs line-clamp-2">{tweet.text}</p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {tweet.players_mentioned.slice(0, 2).map((player) => (
                            <button key={player} onClick={() => showPlayerTweets(player)} className="bg-pink-900/50 text-pink-300 px-1.5 py-0.5 rounded text-xs hover:bg-pink-800/50">
                              {player}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-gray-800 rounded-lg p-4">
                  <h2 className="text-lg font-semibold mb-3">Monitored Sources</h2>
                  <div className="space-y-2">
                    {TRUSTED_SOURCES.map((source) => (
                      <div key={source.handle} className="flex items-center gap-2 cursor-pointer hover:bg-gray-700/50 rounded p-1" onClick={() => showHandleTweets(source.handle)}>
                        <img src={getTwitterAvatar(source.handle)} alt="" className="w-7 h-7 rounded-full bg-gray-600" />
                        <div>
                          <span className="text-blue-400 text-sm font-medium">@{source.handle}</span>
                          <span className="text-xs text-gray-500 block">{source.org}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Positions Tab */}
        {activeTab === "positions" && (
          <div className="space-y-4">
            {/* Portfolio Summary */}
            {(() => {
              // Apply NO position correction: if entry > 50 for NO, use 100 - entry
              const allPositions = positions
                .filter(p => p.market_type === "trade")
                .map(p => {
                  if (p.side === "no" && p.avg_entry_price > 50) {
                    const correctedEntry = 100 - p.avg_entry_price;
                    return { ...p, avg_entry_price: correctedEntry };
                  }
                  return p;
                });
              // Calculate cost basis (what we paid) with corrected entries
              const totalCostBasis = allPositions.reduce((sum, p) => sum + ((p.avg_entry_price || 0) * p.contracts / 100), 0);
              // Calculate current value (what it's worth now)
              const totalCurrentValue = allPositions.reduce((sum, p) => sum + (p.value || 0), 0);
              // Net P&L = current value - cost basis
              const totalPnL = totalCurrentValue - totalCostBasis;
              const pnlPercent = totalCostBasis > 0 ? (totalPnL / totalCostBasis) * 100 : 0;
              const bullishCount = allPositions.filter(p => ["strong_buy", "buy_more", "winner"].includes(p.recommendation)).length;
              const bearishCount = allPositions.filter(p => ["reduce", "sell", "loss"].includes(p.recommendation)).length;

              return (
                <div className="grid grid-cols-6 gap-3">
                  <div className="bg-gray-800 rounded-lg p-4">
                    <p className="text-gray-400 text-sm">Cash Available</p>
                    <p className="text-2xl font-bold text-green-400">${portfolioBalance.cash.toFixed(2)}</p>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-4">
                    <p className="text-gray-400 text-sm">Cost Basis</p>
                    <p className="text-2xl font-bold text-gray-300">${totalCostBasis.toFixed(2)}</p>
                    <p className="text-xs text-gray-500 mt-1">Total invested</p>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-4">
                    <p className="text-gray-400 text-sm">Current Value</p>
                    <p className="text-2xl font-bold text-blue-400">${totalCurrentValue.toFixed(2)}</p>
                    <p className="text-xs text-gray-500 mt-1">Market value</p>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-4">
                    <p className="text-gray-400 text-sm">Unrealized P&L</p>
                    <p className={`text-2xl font-bold ${totalPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}
                    </p>
                    <p className={`text-xs mt-1 ${pnlPercent >= 0 ? "text-green-500" : "text-red-500"}`}>
                      {pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}% return
                    </p>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-4">
                    <p className="text-gray-400 text-sm">Total Portfolio</p>
                    <p className="text-2xl font-bold text-pink-400">${portfolioBalance.total.toFixed(2)}</p>
                    <p className="text-xs text-gray-500 mt-1">Cash + positions</p>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-4">
                    <p className="text-gray-400 text-sm">Signal Outlook</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-green-400 font-bold">{bullishCount}</span>
                      <span className="text-gray-500">/</span>
                      <span className="text-red-400 font-bold">{bearishCount}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{allPositions.length} positions</p>
                  </div>
                </div>
              );
            })()}

            {/* Trade Market Positions */}
            <div className="bg-gray-800 rounded-lg p-4">
              <h2 className="text-xl font-semibold mb-3">Trade Market Positions</h2>
              {positions.filter(p => p.market_type === "trade").length === 0 ? (
                <p className="text-gray-500 text-center py-8">No trade market positions</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {positions
                    .filter(p => p.market_type === "trade")
                    .sort((a, b) => {
                      // Sort by position value (contracts × current price) descending
                      const valueA = a.contracts * (a.current_price || 0);
                      const valueB = b.contracts * (b.current_price || 0);
                      return valueB - valueA;
                    })
                    .map((pos) => {
                    const recColors: Record<string, string> = {
                      winner: "border-green-400 bg-green-900/40",
                      strong_buy: "border-green-500 bg-green-900/20",
                      buy_more: "border-green-600 bg-green-900/10",
                      hold: "border-gray-600",
                      take_profit: "border-yellow-500 bg-yellow-900/20",
                      reduce: "border-orange-500 bg-orange-900/20",
                      sell: "border-red-500 bg-red-900/20",
                      loss: "border-red-600 bg-red-900/40",
                    };
                    const recLabels: Record<string, { text: string; color: string }> = {
                      winner: { text: "🎉 WINNER", color: "text-green-300" },
                      strong_buy: { text: "STRONG BUY", color: "text-green-400" },
                      buy_more: { text: "BUY MORE", color: "text-green-500" },
                      hold: { text: "HOLD", color: "text-gray-400" },
                      take_profit: { text: "TAKE PROFIT", color: "text-yellow-400" },
                      reduce: { text: "REDUCE", color: "text-orange-400" },
                      sell: { text: "SELL", color: "text-red-400" },
                      loss: { text: "💀 LOSS", color: "text-red-300" },
                    };
                    const recInfo = recLabels[pos.recommendation] || { text: pos.recommendation, color: "text-gray-400" };
                    const posValue = (pos.contracts * pos.current_price / 100).toFixed(2);

                    return (
                      <div
                        key={pos.ticker}
                        className={`rounded-lg border-l-4 p-3 ${recColors[pos.recommendation] || "border-gray-600"}`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <img src={getPlayerHeadshot(pos.player_name)} alt="" className="w-8 h-8 rounded-full bg-gray-600" />
                            <div>
                              <div className="flex items-center gap-1.5">
                                <span className="font-bold">{pos.player_name}</span>
                                <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${pos.side === "yes" ? "bg-green-600" : "bg-red-600"}`}>
                                  {pos.side.toUpperCase()}
                                </span>
                                {pos.momentum && pos.momentum !== "flat" && (
                                  <span className={`text-xs ${pos.momentum === "up" ? "text-green-400" : "text-red-400"}`}>
                                    {pos.momentum === "up" ? "↑" : "↓"}{Math.abs(pos.momentum_change || 0)}¢
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className={`text-sm font-bold ${recInfo.color}`}>{recInfo.text}</p>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-xs text-gray-400 mb-2">
                          <div className="flex items-center gap-3">
                            <span
                              className="cursor-help border-b border-dotted border-gray-500"
                              title={pos.cost_basis_breakdown && pos.cost_basis_breakdown.length > 1
                                ? `Buys: ${pos.cost_basis_breakdown.map((f) => `${f.count}× @ ${f.price}¢`).join(", ")}`
                                : undefined
                              }
                            >
                              {pos.contracts}× @ {pos.avg_entry_price}¢
                              {pos.cost_basis_breakdown && pos.cost_basis_breakdown.length > 1 && (
                                <span className="text-gray-500 ml-1">({pos.cost_basis_breakdown.length} buys)</span>
                              )}
                            </span>
                            <span>Now: {pos.current_price}¢</span>
                            <span className="text-blue-400 font-medium">${posValue}</span>
                          </div>
                          <span className={pos.pnl >= 0 ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                            {pos.pnl >= 0 ? "+" : ""}${pos.pnl.toFixed(2)}
                          </span>
                        </div>

                        <div className="text-xs text-gray-500 mb-2 truncate" title={pos.recommendation_reason}>
                          {pos.recommendation_reason}
                        </div>

                        <div className="flex gap-2">
                          <button
                            onClick={() => setTradeOpportunity({
                              player_name: pos.player_name,
                              ticker: pos.ticker,
                              current_price: pos.current_price,
                              confidence: pos.latest_confidence || "Serious",
                              reason: `Add to existing position · ${pos.recommendation_reason}`,
                              suggested_contracts: Math.round(settings.base_contract_count / 2),
                              source: "manual",
                            })}
                            className={`flex-1 px-3 py-1 rounded text-xs font-medium ${
                              ["strong_buy", "buy_more"].includes(pos.recommendation)
                                ? "bg-green-600 hover:bg-green-500"
                                : "bg-gray-600 hover:bg-gray-500"
                            }`}
                          >
                            Buy More
                          </button>
                          <button
                            onClick={() => executeSell(pos.ticker, pos.contracts, pos.current_price, pos.side)}
                            className={`flex-1 px-3 py-1 rounded text-xs font-medium ${
                              ["sell", "reduce", "take_profit", "loss"].includes(pos.recommendation)
                                ? "bg-red-600 hover:bg-red-500"
                                : "bg-gray-600 hover:bg-gray-500"
                            }`}
                          >
                            {pos.recommendation === "take_profit" ? "Take Profit" : "Sell"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Next Team Predictions */}
            {positions.filter(p => p.market_type === "next_team").length > 0 && (
              <div className="bg-gray-800 rounded-lg p-4">
                <h2 className="text-xl font-semibold mb-4">Next Team Predictions</h2>
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-gray-400 text-sm border-b border-gray-700">
                      <th className="pb-2">Player</th>
                      <th className="pb-2">Team</th>
                      <th className="pb-2">Contracts</th>
                      <th className="pb-2">Current Price</th>
                      <th className="pb-2">Value</th>
                      <th className="pb-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.filter(p => p.market_type === "next_team").map((pos) => (
                      <tr key={pos.ticker} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <img src={getPlayerHeadshot(pos.player_name)} alt="" className="w-8 h-8 rounded-full bg-gray-600" />
                            <span className="font-medium">{pos.player_name}</span>
                          </div>
                        </td>
                        <td className="py-3">
                          <span className="px-2 py-0.5 bg-purple-600 rounded text-xs font-medium">{pos.team_code}</span>
                        </td>
                        <td className="py-3">{pos.contracts}</td>
                        <td className="py-3 font-mono">{pos.current_price}¢</td>
                        <td className="py-3 font-mono text-green-400">${pos.value.toFixed(2)}</td>
                        <td className="py-3">
                          <div className="flex gap-2">
                            <button
                              onClick={() => setTradeOpportunity({
                                player_name: pos.player_name,
                                ticker: pos.ticker,
                                current_price: pos.current_price,
                                confidence: "Serious",
                                reason: `Add to existing ${pos.team_code} team prediction (${pos.contracts} contracts)`,
                                suggested_contracts: Math.round(settings.base_contract_count / 2),
                                source: "manual",
                              })}
                              className="px-3 py-1 bg-green-600 hover:bg-green-500 rounded text-sm"
                            >
                              Buy More
                            </button>
                            <button
                              onClick={() => executeSell(pos.ticker, pos.contracts, pos.current_price, pos.side)}
                              className="px-3 py-1 bg-red-600 hover:bg-red-500 rounded text-sm"
                            >
                              Sell
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Recommendation Summary */}
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-green-900/30 border border-green-700 rounded-lg p-4">
                <h3 className="font-semibold text-green-400 mb-2">🚀 Strong Buy / Buy More</h3>
                <ul className="space-y-1 text-sm">
                  {positions.filter(p => p.market_type === "trade" && ["strong_buy", "buy_more"].includes(p.recommendation)).map(p => (
                    <li key={p.ticker} className="flex justify-between">
                      <span>{p.player_name}</span>
                      <span className="text-green-400">{p.current_price}¢</span>
                    </li>
                  ))}
                  {positions.filter(p => p.market_type === "trade" && ["strong_buy", "buy_more"].includes(p.recommendation)).length === 0 && (
                    <li className="text-gray-500">None</li>
                  )}
                </ul>
              </div>
              <div className="bg-gray-800 border border-gray-600 rounded-lg p-4">
                <h3 className="font-semibold text-gray-300 mb-2">✋ Hold</h3>
                <ul className="space-y-1 text-sm">
                  {positions.filter(p => p.market_type === "trade" && p.recommendation === "hold").map(p => (
                    <li key={p.ticker} className="flex justify-between">
                      <span>{p.player_name}</span>
                      <span className="text-gray-400">{p.current_price}¢</span>
                    </li>
                  ))}
                  {positions.filter(p => p.market_type === "trade" && p.recommendation === "hold").length === 0 && (
                    <li className="text-gray-500">None</li>
                  )}
                </ul>
              </div>
              <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-4">
                <h3 className="font-semibold text-yellow-400 mb-2">💰 Take Profit</h3>
                <ul className="space-y-1 text-sm">
                  {positions.filter(p => p.market_type === "trade" && p.recommendation === "take_profit").map(p => (
                    <li key={p.ticker} className="flex justify-between">
                      <span>{p.player_name}</span>
                      <span className="text-yellow-400">+{p.pnl_percent.toFixed(0)}%</span>
                    </li>
                  ))}
                  {positions.filter(p => p.market_type === "trade" && p.recommendation === "take_profit").length === 0 && (
                    <li className="text-gray-500">None</li>
                  )}
                </ul>
              </div>
              <div className="bg-red-900/30 border border-red-700 rounded-lg p-4">
                <h3 className="font-semibold text-red-400 mb-2">⚠️ Reduce / Sell</h3>
                <ul className="space-y-1 text-sm">
                  {positions.filter(p => p.market_type === "trade" && ["reduce", "sell"].includes(p.recommendation)).map(p => (
                    <li key={p.ticker} className="flex justify-between">
                      <span>{p.player_name}</span>
                      <span className="text-red-400">{p.pnl_percent.toFixed(0)}%</span>
                    </li>
                  ))}
                  {positions.filter(p => p.market_type === "trade" && ["reduce", "sell"].includes(p.recommendation)).length === 0 && (
                    <li className="text-gray-500">None</li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Analytics Tab */}
        {activeTab === "analytics" && (
          <div className="space-y-6">
            {/* Portfolio Performance Summary */}
            {(() => {
              // Apply NO position correction and include all positions
              const allPositions = positions.map(p => {
                if (p.side === "no" && p.avg_entry_price > 50) {
                  const correctedEntry = 100 - p.avg_entry_price;
                  const correctedCostBasis = (correctedEntry * p.contracts) / 100;
                  const correctedPnL = p.value - correctedCostBasis;
                  return { ...p, avg_entry_price: correctedEntry, pnl: correctedPnL };
                }
                return p;
              });
              const totalCostBasis = allPositions.reduce((sum, p) => sum + ((p.avg_entry_price || 0) * p.contracts / 100), 0);
              const totalCurrentValue = allPositions.reduce((sum, p) => sum + (p.value || 0), 0);
              const unrealizedPnL = totalCurrentValue - totalCostBasis;

              // Get realized P&L
              const realizedPnLTotal = realizedPnL.summary.total_realized_pnl;

              // Combined P&L
              const combinedPnL = unrealizedPnL + realizedPnLTotal;
              const pnlPercent = totalCostBasis > 0 ? (unrealizedPnL / totalCostBasis) * 100 : 0;

              // Calculate wins vs losses (using corrected positions)
              const winners = allPositions.filter(p => p.pnl > 0);
              const losers = allPositions.filter(p => p.pnl < 0);
              const totalWins = winners.reduce((sum, p) => sum + p.pnl, 0);
              const totalLosses = Math.abs(losers.reduce((sum, p) => sum + p.pnl, 0));

              return (
                <div className="grid grid-cols-4 gap-4">
                  <div className="bg-gray-800 rounded-lg p-6 col-span-2">
                    <h3 className="text-lg font-semibold mb-4">Portfolio Performance</h3>
                    <div className="grid grid-cols-4 gap-4">
                      <div>
                        <p className="text-gray-400 text-sm">Cost Basis</p>
                        <p className="text-2xl font-bold text-gray-300">${totalCostBasis.toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-gray-400 text-sm">Current Value</p>
                        <p className="text-2xl font-bold text-blue-400">${totalCurrentValue.toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-gray-400 text-sm">Unrealized P&L</p>
                        <p className={`text-xl font-bold ${unrealizedPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {unrealizedPnL >= 0 ? "+" : ""}${unrealizedPnL.toFixed(2)}
                          <span className="text-xs ml-1">({pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%)</span>
                        </p>
                      </div>
                      <div className="border-l border-gray-700 pl-4">
                        <p className="text-gray-400 text-sm">Total P&L</p>
                        <p className={`text-2xl font-bold ${combinedPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {combinedPnL >= 0 ? "+" : ""}${combinedPnL.toFixed(2)}
                        </p>
                        <p className="text-xs text-gray-500">
                          Realized: {realizedPnLTotal >= 0 ? "+" : ""}${realizedPnLTotal.toFixed(2)}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="bg-gray-800 rounded-lg p-6">
                    <h3 className="text-lg font-semibold mb-4">Win/Loss</h3>
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Winners</span>
                        <span className="text-green-400 font-bold">{winners.length} (+${totalWins.toFixed(2)})</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Losers</span>
                        <span className="text-red-400 font-bold">{losers.length} (-${totalLosses.toFixed(2)})</span>
                      </div>
                      <div className="flex justify-between pt-2 border-t border-gray-700">
                        <span className="text-gray-400">Win Rate</span>
                        <span className="font-bold">
                          {allPositions.length > 0 ? ((winners.length / allPositions.length) * 100).toFixed(0) : 0}%
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-gray-800 rounded-lg p-6">
                    <h3 className="text-lg font-semibold mb-4">Position Breakdown</h3>
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <span className="text-gray-400">YES Positions</span>
                        <span className="text-green-400 font-bold">{allPositions.filter(p => p.side === "yes").length}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">NO Positions</span>
                        <span className="text-red-400 font-bold">{allPositions.filter(p => p.side === "no").length}</span>
                      </div>
                      <div className="flex justify-between pt-2 border-t border-gray-700">
                        <span className="text-gray-400">Total Positions</span>
                        <span className="font-bold">{allPositions.length}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Realized P&L Section - From Kalshi Settlements + Early Exits */}
            <div className="bg-gray-800 rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-4">Realized P&L</h3>
              <p className="text-gray-400 text-sm mb-4">
                Includes settled markets and positions you sold early.
              </p>

              {/* Summary Cards */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-gray-900/50 rounded-lg p-4">
                  <p className="text-gray-400 text-sm">Total Realized P&L</p>
                  <p className={`text-2xl font-bold ${realizedPnL.summary.total_realized_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {realizedPnL.summary.total_realized_pnl >= 0 ? "+" : ""}${realizedPnL.summary.total_realized_pnl.toFixed(2)}
                  </p>
                </div>
                <div className="bg-gray-900/50 rounded-lg p-4">
                  <p className="text-gray-400 text-sm">From Settlements</p>
                  <p className={`text-xl font-bold ${realizedPnL.summary.settled_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {realizedPnL.summary.settled_pnl >= 0 ? "+" : ""}${realizedPnL.summary.settled_pnl.toFixed(2)}
                  </p>
                </div>
                <div className="bg-gray-900/50 rounded-lg p-4">
                  <p className="text-gray-400 text-sm">From Early Exits</p>
                  <p className={`text-xl font-bold ${realizedPnL.summary.early_exit_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {realizedPnL.summary.early_exit_pnl >= 0 ? "+" : ""}${realizedPnL.summary.early_exit_pnl.toFixed(2)}
                  </p>
                </div>
              </div>

              {/* Settled Markets Table */}
              {realizedPnL.settlements.length > 0 && (
                <div className="mb-6">
                  <h4 className="text-md font-medium mb-3 text-purple-400">Settled Markets</h4>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-400 border-b border-gray-700">
                        <th className="pb-2">Player</th>
                        <th className="pb-2">Result</th>
                        <th className="pb-2 text-right">YES Cost</th>
                        <th className="pb-2 text-right">YES Payout</th>
                        <th className="pb-2 text-right">NO Cost</th>
                        <th className="pb-2 text-right">NO Payout</th>
                        <th className="pb-2 text-right">Net P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {realizedPnL.settlements.map((s, idx) => (
                        <tr key={idx} className="border-t border-gray-700/50">
                          <td className="py-2 font-medium">{s.player_name}</td>
                          <td className={`py-2 ${s.market_result === "yes" ? "text-green-400" : "text-red-400"}`}>
                            {s.market_result === "yes" ? "YES (traded)" : "NO (not traded)"}
                          </td>
                          <td className="py-2 text-right font-mono text-gray-400">${s.yes_cost.toFixed(2)}</td>
                          <td className="py-2 text-right font-mono text-blue-400">${s.yes_payout.toFixed(2)}</td>
                          <td className="py-2 text-right font-mono text-gray-400">${s.no_cost.toFixed(2)}</td>
                          <td className="py-2 text-right font-mono text-gray-500">${s.no_payout.toFixed(2)}</td>
                          <td className={`py-2 text-right font-mono font-medium ${s.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {s.total_pnl >= 0 ? "+" : ""}${s.total_pnl.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Early Exits Table */}
              {realizedPnL.early_exits.length > 0 && (
                <div>
                  <h4 className="text-md font-medium mb-3 text-blue-400">Early Exits (Sold Positions)</h4>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-400 border-b border-gray-700">
                        <th className="pb-2">Player</th>
                        <th className="pb-2">Side</th>
                        <th className="pb-2 text-right">Contracts</th>
                        <th className="pb-2 text-right">Avg Buy</th>
                        <th className="pb-2 text-right">Avg Sell</th>
                        <th className="pb-2 text-right">Cost</th>
                        <th className="pb-2 text-right">Proceeds</th>
                        <th className="pb-2 text-right">P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {realizedPnL.early_exits.map((e, idx) => (
                        <tr key={idx} className="border-t border-gray-700/50">
                          <td className="py-2 font-medium">{e.player_name}</td>
                          <td className="py-2">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                              e.side === "yes" ? "bg-green-600/80" : "bg-red-600/80"
                            }`}>
                              {e.side.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-2 text-right font-mono">{e.contracts_sold}</td>
                          <td className="py-2 text-right font-mono text-gray-400">{e.avg_buy_price}¢</td>
                          <td className="py-2 text-right font-mono text-blue-400">{e.avg_sell_price}¢</td>
                          <td className="py-2 text-right font-mono text-gray-400">${e.total_cost.toFixed(2)}</td>
                          <td className="py-2 text-right font-mono text-blue-400">${e.total_proceeds.toFixed(2)}</td>
                          <td className={`py-2 text-right font-mono font-medium ${e.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {e.total_pnl >= 0 ? "+" : ""}${e.total_pnl.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {realizedPnL.settlements.length === 0 && realizedPnL.early_exits.length === 0 && (
                <p className="text-gray-500 text-center py-4">No realized P&L yet. Markets settle on Feb 6, or sell positions early to realize gains/losses.</p>
              )}
            </div>

            {/* Portfolio Value Chart */}
            <div className="bg-gray-800 rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-4">Portfolio Value Over Time</h3>
              {portfolioHistory.length > 0 ? (
                <div className="h-64">
                  <svg width="100%" height="100%" viewBox="0 0 800 250" preserveAspectRatio="none">
                    {(() => {
                      const padding = { top: 20, right: 20, bottom: 30, left: 60 };
                      const chartWidth = 800 - padding.left - padding.right;
                      const chartHeight = 250 - padding.top - padding.bottom;

                      const values = portfolioHistory.map(p => p.cost_basis);
                      const minValue = Math.min(...values) * 0.9;
                      const maxValue = Math.max(...values) * 1.1;
                      const valueRange = maxValue - minValue || 1;

                      const points = portfolioHistory.map((point, i) => {
                        const x = padding.left + (i / (portfolioHistory.length - 1 || 1)) * chartWidth;
                        const y = padding.top + chartHeight - ((point.cost_basis - minValue) / valueRange) * chartHeight;
                        return `${x},${y}`;
                      }).join(" ");

                      return (
                        <>
                          {/* Grid lines */}
                          {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => (
                            <g key={i}>
                              <line
                                x1={padding.left}
                                y1={padding.top + chartHeight * (1 - pct)}
                                x2={800 - padding.right}
                                y2={padding.top + chartHeight * (1 - pct)}
                                stroke="#374151"
                                strokeWidth="1"
                              />
                              <text
                                x={padding.left - 5}
                                y={padding.top + chartHeight * (1 - pct) + 4}
                                fill="#6B7280"
                                fontSize="10"
                                textAnchor="end"
                              >
                                ${(minValue + valueRange * pct).toFixed(0)}
                              </text>
                            </g>
                          ))}
                          {/* Area fill */}
                          <polygon
                            points={`${padding.left},${padding.top + chartHeight} ${points} ${800 - padding.right},${padding.top + chartHeight}`}
                            fill="rgba(236, 72, 153, 0.2)"
                          />
                          {/* Line */}
                          <polyline
                            points={points}
                            fill="none"
                            stroke="#EC4899"
                            strokeWidth="2"
                          />
                          {/* End point */}
                          {portfolioHistory.length > 0 && (
                            <circle
                              cx={800 - padding.right}
                              cy={padding.top + chartHeight - ((portfolioHistory[portfolioHistory.length - 1].cost_basis - minValue) / valueRange) * chartHeight}
                              r="4"
                              fill="#EC4899"
                            />
                          )}
                        </>
                      );
                    })()}
                  </svg>
                </div>
              ) : (
                <div className="h-64 flex items-center justify-center text-gray-500">
                  No trade history yet. Portfolio chart will appear after your first trades.
                </div>
              )}
            </div>

            {/* P&L Accounting Table */}
            <div className="bg-gray-800 rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-4">P&L Accounting by Position</h3>
              {(() => {
                // Include ALL positions with corrected NO pricing
                // For NO positions where entry > 50, the API recorded YES price instead of NO price
                // Correct by inverting: actual NO entry = 100 - recorded_yes_price
                // Also exclude Darius Garland "stays with Cleveland" - glitched test trade
                const allPositions = positions
                  .filter(pos => !(pos.player_name === "Darius Garland" && pos.market_type === "next_team"))
                  .map(pos => {
                    // Correct NO position entry prices that were recorded as YES prices
                    let correctedEntry = pos.avg_entry_price;
                    if (pos.side === "no" && pos.avg_entry_price > 50) {
                      correctedEntry = 100 - pos.avg_entry_price;
                    }
                    const costBasis = (correctedEntry * pos.contracts) / 100;
                    const currentValue = pos.value;
                    const pnl = currentValue - costBasis;
                    const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
                    return { ...pos, costBasis, currentValue, pnl, pnlPct, avg_entry_price: correctedEntry };
                  })
                  .sort((a, b) => b.pnl - a.pnl); // Sort by P&L descending

                const totals = allPositions.reduce(
                  (acc, pos) => ({
                    contracts: acc.contracts + pos.contracts,
                    costBasis: acc.costBasis + pos.costBasis,
                    currentValue: acc.currentValue + pos.currentValue,
                    pnl: acc.pnl + pos.pnl,
                  }),
                  { contracts: 0, costBasis: 0, currentValue: 0, pnl: 0 }
                );
                const totalPnlPct = totals.costBasis > 0 ? (totals.pnl / totals.costBasis) * 100 : 0;

                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-400 border-b border-gray-600">
                          <th className="pb-3 pr-4">Player</th>
                          <th className="pb-3 pr-4 text-center">Type</th>
                          <th className="pb-3 pr-4 text-center">Side</th>
                          <th className="pb-3 pr-4 text-right">Contracts</th>
                          <th className="pb-3 pr-4 text-right">Avg Entry</th>
                          <th className="pb-3 pr-4 text-right">Current</th>
                          <th className="pb-3 pr-4 text-right">Cost Basis</th>
                          <th className="pb-3 pr-4 text-right">Market Value</th>
                          <th className="pb-3 pr-4 text-right">Unrealized P&L</th>
                          <th className="pb-3 text-right">Return</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allPositions.map((pos) => (
                          <tr key={pos.ticker} className="border-t border-gray-700/50 hover:bg-gray-700/30">
                            <td className="py-2.5 pr-4">
                              <div className="flex items-center gap-2">
                                <img
                                  src={getPlayerHeadshot(pos.player_name)}
                                  alt=""
                                  className="w-6 h-6 rounded-full bg-gray-600"
                                />
                                <div>
                                  <span className="font-medium">{pos.player_name}</span>
                                  {pos.team_code && <span className="text-xs text-gray-500 ml-1">→ {pos.team_code}</span>}
                                </div>
                              </div>
                            </td>
                            <td className="py-2.5 pr-4 text-center">
                              <span className={`px-1.5 py-0.5 rounded text-xs ${
                                pos.market_type === "trade" ? "bg-purple-600/50 text-purple-300" : "bg-blue-600/50 text-blue-300"
                              }`}>
                                {pos.market_type === "trade" ? "Trade" : "Next Team"}
                              </span>
                            </td>
                            <td className="py-2.5 pr-4 text-center">
                              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                pos.side === "yes" ? "bg-green-600/80" : "bg-red-600/80"
                              }`}>
                                {pos.side.toUpperCase()}
                              </span>
                            </td>
                            <td className="py-2.5 pr-4 text-right font-mono">{pos.contracts}</td>
                            <td className="py-2.5 pr-4 text-right font-mono">{pos.avg_entry_price}¢</td>
                            <td className="py-2.5 pr-4 text-right font-mono">
                              <span className={pos.current_price > pos.avg_entry_price ? "text-green-400" : pos.current_price < pos.avg_entry_price ? "text-red-400" : ""}>
                                {pos.current_price}¢
                              </span>
                            </td>
                            <td className="py-2.5 pr-4 text-right font-mono text-gray-300">${pos.costBasis.toFixed(2)}</td>
                            <td className="py-2.5 pr-4 text-right font-mono text-blue-400">${pos.currentValue.toFixed(2)}</td>
                            <td className={`py-2.5 pr-4 text-right font-mono font-medium ${pos.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                              {pos.pnl >= 0 ? "+" : ""}${pos.pnl.toFixed(2)}
                            </td>
                            <td className={`py-2.5 text-right font-mono ${pos.pnlPct >= 0 ? "text-green-400" : "text-red-400"}`}>
                              {pos.pnlPct >= 0 ? "+" : ""}{pos.pnlPct.toFixed(1)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-gray-500 font-semibold bg-gray-700/30">
                          <td className="py-3 pr-4">TOTAL</td>
                          <td className="py-3 pr-4 text-center text-gray-400 text-xs">
                            {allPositions.filter(p => p.market_type === "trade").length} trade / {allPositions.filter(p => p.market_type === "next_team").length} next team
                          </td>
                          <td className="py-3 pr-4 text-center text-gray-400">{allPositions.length} pos</td>
                          <td className="py-3 pr-4 text-right font-mono">{totals.contracts}</td>
                          <td className="py-3 pr-4 text-right text-gray-400">—</td>
                          <td className="py-3 pr-4 text-right text-gray-400">—</td>
                          <td className="py-3 pr-4 text-right font-mono">${totals.costBasis.toFixed(2)}</td>
                          <td className="py-3 pr-4 text-right font-mono text-blue-400">${totals.currentValue.toFixed(2)}</td>
                          <td className={`py-3 pr-4 text-right font-mono ${totals.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {totals.pnl >= 0 ? "+" : ""}${totals.pnl.toFixed(2)}
                          </td>
                          <td className={`py-3 text-right font-mono ${totalPnlPct >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {totalPnlPct >= 0 ? "+" : ""}{totalPnlPct.toFixed(1)}%
                          </td>
                        </tr>
                      </tfoot>
                    </table>

                    {/* Fill Breakdown Section */}
                    <div className="mt-6 pt-4 border-t border-gray-700">
                      <h4 className="text-sm font-semibold text-gray-400 mb-3">Fill Breakdown by Position</h4>
                      <div className="grid grid-cols-2 gap-4">
                        {allPositions.filter(p => p.cost_basis_breakdown && p.cost_basis_breakdown.length > 0).map((pos) => (
                          <div key={pos.ticker} className="bg-gray-900/50 rounded-lg p-3">
                            <div className="flex items-center gap-2 mb-2">
                              <img
                                src={getPlayerHeadshot(pos.player_name)}
                                alt=""
                                className="w-5 h-5 rounded-full bg-gray-600"
                              />
                              <span className="font-medium text-sm">{pos.player_name}</span>
                              <span className={`ml-auto text-xs px-1.5 py-0.5 rounded ${pos.pnl >= 0 ? "bg-green-600/30 text-green-400" : "bg-red-600/30 text-red-400"}`}>
                                {pos.pnl >= 0 ? "+" : ""}${pos.pnl.toFixed(2)}
                              </span>
                            </div>
                            <div className="space-y-1">
                              {(pos.cost_basis_breakdown || []).map((fill: { price: number; count: number; side: string }, idx: number) => (
                                <div key={idx} className="flex justify-between text-xs text-gray-400">
                                  <span>{fill.count} contracts @ {fill.price}¢</span>
                                  <span className="font-mono">${((fill.price * fill.count) / 100).toFixed(2)}</span>
                                </div>
                              ))}
                              <div className="flex justify-between text-xs font-medium pt-1 border-t border-gray-700">
                                <span>Total: {pos.contracts} @ avg {pos.avg_entry_price}¢</span>
                                <span className="font-mono">${pos.costBasis.toFixed(2)}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Signals Tab */}
        {activeTab === "signals" && (
          <div className="space-y-4">
            {/* Filters */}
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <label className="block text-sm text-gray-400 mb-1">Filter by Player</label>
                  <input
                    type="text"
                    value={signalFilter.player}
                    onChange={(e) => setSignalFilter(prev => ({ ...prev, player: e.target.value }))}
                    placeholder="Search player name..."
                    className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-pink-500"
                  />
                </div>
                <div className="w-48">
                  <label className="block text-sm text-gray-400 mb-1">Filter by Source</label>
                  <select
                    value={signalFilter.source}
                    onChange={(e) => setSignalFilter(prev => ({ ...prev, source: e.target.value }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-pink-500"
                  >
                    <option value="">All Activity</option>
                    <option value="twitter">Tweets</option>
                    <option value="signal">Signals</option>
                    <option value="event">Events</option>
                  </select>
                </div>
                <button
                  onClick={() => setSignalFilter({ player: "", source: "" })}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm mt-6"
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold">Activity Feed (Last 48h)</h2>
                <span className="text-sm text-gray-400">
                  {(() => {
                    const filtered = priceAlerts.filter((a: any) => {
                      const playerMatch = !signalFilter.player ||
                        (a.player_name || "").toLowerCase().includes(signalFilter.player.toLowerCase()) ||
                        (a.data?.players_mentioned || []).some((p: string) => p.toLowerCase().includes(signalFilter.player.toLowerCase()));
                      const sourceMatch = !signalFilter.source || a.source === signalFilter.source;
                      return playerMatch && sourceMatch;
                    });
                    return `${filtered.length} of ${priceAlerts.length} items`;
                  })()}
                </span>
              </div>
              {priceAlerts.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-gray-500 text-lg mb-2">No activity yet</p>
                  <p className="text-gray-600 text-sm">Activity appears when tweets, price movements, or trades are detected</p>
                  <p className="text-gray-600 text-xs mt-2">Check browser console for debug info</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {priceAlerts
                    .filter((item: any) => {
                      const playerMatch = !signalFilter.player ||
                        (item.player_name || "").toLowerCase().includes(signalFilter.player.toLowerCase()) ||
                        (item.data?.players_mentioned || []).some((p: string) => p.toLowerCase().includes(signalFilter.player.toLowerCase()));
                      const sourceMatch = !signalFilter.source || item.source === signalFilter.source;
                      return playerMatch && sourceMatch;
                    })
                    .map((item: any) => {
                      // Determine display based on source type
                      const isTwitter = item.source === "twitter";
                      const isEvent = item.source === "event";
                      const isSignal = item.source === "signal";

                      const typeColors: Record<string, string> = {
                        twitter: "bg-blue-600",
                        price_movement: "bg-orange-600",
                        price_spike: "bg-orange-500",
                        price_spike_buy: "bg-green-600",
                        trade_executed: "bg-green-600",
                        large_order: "bg-purple-600",
                        twitter_signal: "bg-blue-500",
                        signal: "bg-gray-600",
                        event: "bg-yellow-600",
                      };

                      const typeLabels: Record<string, string> = {
                        twitter: "Tweet",
                        price_movement: "Price Move",
                        price_spike: "Price Spike",
                        price_spike_buy: "Auto-Buy",
                        trade_executed: "Trade",
                        large_order: "Whale",
                        twitter_signal: "Signal",
                      };

                      return (
                        <div
                          key={item.id}
                          className="bg-gray-700/50 rounded-lg p-3 hover:bg-gray-700/70 transition-colors cursor-pointer"
                          onClick={() => setSelectedSignal(item)}
                        >
                          <div className="flex items-start gap-3">
                            {/* Avatar */}
                            {isTwitter && item.data?.author ? (
                              <img
                                src={getTwitterAvatar(item.data.author)}
                                alt=""
                                className="w-10 h-10 rounded-full bg-gray-600"
                              />
                            ) : item.player_name ? (
                              <img
                                src={getPlayerHeadshot(item.player_name)}
                                alt=""
                                className="w-10 h-10 rounded-full bg-gray-600"
                              />
                            ) : (
                              <div className="w-10 h-10 rounded-full bg-gray-600 flex items-center justify-center text-lg">
                                {item.type === "price_spike" || item.type === "price_movement" ? "📈" :
                                 item.type === "trade_executed" || item.type === "price_spike_buy" ? "💰" : "📊"}
                              </div>
                            )}

                            {/* Content */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                {isTwitter ? (
                                  <span className="text-blue-400 font-medium">@{item.data?.author}</span>
                                ) : (
                                  <span className="font-medium">{item.player_name || item.ticker || "Unknown"}</span>
                                )}
                                <span className={`px-2 py-0.5 rounded text-xs ${typeColors[item.type] || typeColors[item.source] || "bg-gray-600"}`}>
                                  {typeLabels[item.type] || item.type}
                                </span>
                                {item.data?.confidence_tier && <TierBadge tier={item.data.confidence_tier} />}
                              </div>

                              {/* Tweet content */}
                              {isTwitter && item.data?.text && (
                                <p className="text-sm text-gray-300 mb-2 whitespace-pre-wrap">
                                  {item.data.text.length > 200 ? item.data.text.substring(0, 200) + "..." : item.data.text}
                                </p>
                              )}

                              {/* Players mentioned in tweet */}
                              {isTwitter && item.data?.players_mentioned?.length > 0 && (
                                <div className="flex flex-wrap gap-1 mb-2">
                                  {item.data.players_mentioned.map((player: string) => (
                                    <span key={player} className="bg-pink-900/50 text-pink-300 px-2 py-0.5 rounded text-xs">
                                      {player}
                                    </span>
                                  ))}
                                </div>
                              )}

                              {/* Event/Signal description */}
                              {!isTwitter && item.data?.description && (
                                <p className="text-sm text-gray-400">{item.data.description}</p>
                              )}

                              {/* Price movement details */}
                              {(item.type === "price_movement" || item.type === "price_spike") && item.data && (
                                <p className="text-sm text-gray-400">
                                  {item.data.direction === "UP" ? "↑" : "↓"} {((item.data.pct_change || 0) * 100).toFixed(0)}% ·
                                  {((item.data.old_price || 0) * 100).toFixed(0)}¢ → {((item.data.new_price || 0) * 100).toFixed(0)}¢
                                  {item.data.volume && ` · Vol: ${item.data.volume.toLocaleString()}`}
                                </p>
                              )}

                              <p className="text-xs text-gray-500 mt-1">{formatDateTime(item.timestamp)}</p>
                            </div>

                            {/* Trade button */}
                            {(item.player_name || item.data?.players_mentioned?.[0]) && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const playerName = item.player_name || item.data?.players_mentioned?.[0];
                                  const market = markets.find(m =>
                                    m.player_name?.toLowerCase() === playerName?.toLowerCase() ||
                                    m.ticker === item.ticker
                                  );
                                  setTradeOpportunity({
                                    player_name: playerName,
                                    ticker: market?.ticker || item.ticker || "",
                                    current_price: market?.yes_price || 50,
                                    confidence: item.data?.confidence_tier || "Serious",
                                    reason: isTwitter ? `Tweet by @${item.data?.author}` : item.data?.description || item.type,
                                    suggested_contracts: Math.round(settings.base_contract_count / 2),
                                    source: isTwitter ? "twitter" : "price_spike",
                                  });
                                }}
                                className="px-3 py-1.5 bg-green-600 hover:bg-green-500 rounded text-sm font-medium shrink-0"
                              >
                                Trade
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Signal Detail Modal */}
        {selectedSignal && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setSelectedSignal(null)}>
            <div className="bg-gray-800 rounded-lg max-w-2xl w-full max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between p-4 border-b border-gray-700">
                <div className="flex items-center gap-3">
                  {selectedSignal.meta?.player_name && (
                    <img
                      src={getPlayerHeadshot(selectedSignal.meta.player_name)}
                      alt=""
                      className="w-12 h-12 rounded-full bg-gray-600"
                    />
                  )}
                  <div>
                    <h2 className="text-xl font-bold">{selectedSignal.meta?.player_name || selectedSignal.market_id}</h2>
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        selectedSignal.signal_type === "twitter_signal" ? "bg-blue-600" :
                        selectedSignal.signal_type === "price_movement" ? "bg-orange-600" :
                        selectedSignal.signal_type === "large_order" ? "bg-purple-600" : "bg-gray-600"
                      }`}>
                        {selectedSignal.signal_type.replace(/_/g, " ").toUpperCase()}
                      </span>
                      {selectedSignal.meta?.confidence_tier && <TierBadge tier={selectedSignal.meta.confidence_tier} />}
                    </div>
                  </div>
                </div>
                <button onClick={() => setSelectedSignal(null)} className="text-gray-400 hover:text-white text-2xl">×</button>
              </div>
              <div className="p-4 space-y-4 overflow-y-auto max-h-[calc(80vh-140px)]">
                <div className="text-sm text-gray-400">
                  <strong>Time:</strong> {new Date(selectedSignal.ts).toLocaleString()}
                </div>
                <div className="text-sm text-gray-400">
                  <strong>Market:</strong> {selectedSignal.market_id}
                </div>

                {selectedSignal.signal_type === "twitter_signal" && selectedSignal.meta && (
                  <div className="bg-gray-700/50 rounded-lg p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <img src={getTwitterAvatar(selectedSignal.meta.author || "")} alt="" className="w-10 h-10 rounded-full" />
                      <div>
                        <p className="font-medium text-blue-400">@{selectedSignal.meta.author}</p>
                        <p className="text-xs text-gray-500">{formatDateTime(selectedSignal.ts)}</p>
                      </div>
                    </div>
                    <p className="text-gray-200 whitespace-pre-wrap">{selectedSignal.meta.tweet_text}</p>
                    {selectedSignal.meta.reasoning && (
                      <div className="bg-purple-900/30 rounded p-3 mt-2">
                        <p className="text-xs text-purple-400 font-semibold mb-1">AI Analysis</p>
                        <p className="text-sm text-gray-300">{selectedSignal.meta.reasoning}</p>
                      </div>
                    )}
                  </div>
                )}

                {selectedSignal.signal_type === "price_movement" && selectedSignal.meta && (
                  <div className="bg-gray-700/50 rounded-lg p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs text-gray-400">Direction</p>
                        <p className={`text-lg font-bold ${selectedSignal.meta.direction === "UP" ? "text-green-400" : "text-red-400"}`}>
                          {selectedSignal.meta.direction} {((selectedSignal.meta.pct_change || 0) * 100).toFixed(1)}%
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400">Price Change</p>
                        <p className="text-lg">
                          {((selectedSignal.meta.old_price || 0) * 100).toFixed(0)}¢ → {((selectedSignal.meta.new_price || 0) * 100).toFixed(0)}¢
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400">Volume</p>
                        <p className="text-lg">{(selectedSignal.meta.volume || 0).toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400">Open Interest</p>
                        <p className="text-lg">{(selectedSignal.meta.open_interest || 0).toLocaleString()}</p>
                      </div>
                    </div>
                  </div>
                )}

                {selectedSignal.signal_type === "large_order" && selectedSignal.meta && (
                  <div className="bg-gray-700/50 rounded-lg p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs text-gray-400">Order Type</p>
                        <p className={`text-lg font-bold ${selectedSignal.meta.direction === "buy" ? "text-green-400" : "text-red-400"}`}>
                          {selectedSignal.meta.direction === "buy" ? "BUY" : "SELL"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400">Contracts</p>
                        <p className="text-lg">{(selectedSignal.meta.contracts_consumed || 0).toLocaleString()}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Raw metadata for debugging */}
                <details className="bg-gray-900 rounded p-3">
                  <summary className="text-xs text-gray-500 cursor-pointer">Raw Signal Data</summary>
                  <pre className="text-xs text-gray-400 mt-2 overflow-x-auto">
                    {JSON.stringify(selectedSignal, null, 2)}
                  </pre>
                </details>
              </div>
              <div className="p-4 border-t border-gray-700 flex gap-2">
                {selectedSignal.meta?.player_name && (
                  <button
                    onClick={() => {
                      setTradeOpportunity({
                        player_name: selectedSignal.meta.player_name,
                        ticker: selectedSignal.market_id,
                        current_price: Math.round((selectedSignal.meta?.new_price || 0.5) * 100),
                        confidence: selectedSignal.meta?.confidence_tier || "Serious",
                        reason: `Signal: ${selectedSignal.signal_type.replace(/_/g, " ")}`,
                        suggested_contracts: Math.round(settings.base_contract_count / 2),
                        source: selectedSignal.signal_type === "twitter_signal" ? "twitter" : "price_spike",
                      });
                      setSelectedSignal(null);
                    }}
                    className="flex-1 py-2 bg-green-600 hover:bg-green-500 rounded-lg font-medium"
                  >
                    Trade Now
                  </button>
                )}
                <button
                  onClick={() => {
                    if (selectedSignal.meta?.player_name) {
                      const market = markets.find(m => m.ticker === selectedSignal.market_id);
                      if (market) {
                        openPlayerDetail(selectedSignal.meta.player_name, market);
                      }
                    }
                    setSelectedSignal(null);
                  }}
                  className="flex-1 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg font-medium"
                >
                  View Player
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === "settings" && (
          <div className="max-w-3xl space-y-6">
            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Twitter-Based Trading</h2>
              <p className="text-sm text-gray-400 mb-4">These are the safest trades - based on intel from trusted NBA reporters.</p>
              <div className="space-y-4">
                <NumberInput label="Base Contract Count" value={settings.base_contract_count} onChange={(v) => setSettings({ ...settings, base_contract_count: v })} min={10} max={500} />
                <NumberInput label="Max Price - Confirmed (¢)" value={settings.max_price_confirmed} onChange={(v) => setSettings({ ...settings, max_price_confirmed: v })} min={50} max={99} />
                <NumberInput label="Max Price - Imminent (¢)" value={settings.max_price_imminent} onChange={(v) => setSettings({ ...settings, max_price_imminent: v })} min={40} max={95} />
                <NumberInput label="Max Price - Serious (¢)" value={settings.max_price_serious} onChange={(v) => setSettings({ ...settings, max_price_serious: v })} min={30} max={90} />
              </div>
            </div>

            {/* Price Spike Settings with Warning */}
            <div className={`rounded-lg p-6 border-2 ${settings.features.price_spike_trading ? "bg-orange-900/20 border-orange-500" : "bg-gray-800 border-gray-700"}`}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-xl font-semibold">Price Spike Auto-Trading</h2>
                  <p className="text-sm text-orange-400 mt-1">⚠️ Higher risk - can buy at peaks</p>
                </div>
                <Toggle label="" enabled={settings.features.price_spike_trading} onChange={(v) => setSettings({ ...settings, features: { ...settings.features, price_spike_trading: v } })} />
              </div>

              {settings.features.price_spike_trading && (
                <div className="bg-orange-900/30 border border-orange-600 rounded-lg p-3 mb-4">
                  <p className="text-sm text-orange-300">
                    <strong>Warning:</strong> Price spike trading is reactive and can result in buying at the top of a spike.
                    The safeguards below help reduce this risk, but consider keeping this OFF and using spike signals
                    as alerts for manual evaluation instead.
                  </p>
                </div>
              )}

              <div className="space-y-4">
                <NumberInput
                  label="Spike Threshold (%)"
                  value={settings.price_spike_threshold}
                  onChange={(v) => setSettings({ ...settings, price_spike_threshold: v })}
                  min={5} max={50}
                />
                <NumberInput
                  label="Max Entry Price - Spike Only (¢)"
                  value={settings.price_spike_max_entry}
                  onChange={(v) => setSettings({ ...settings, price_spike_max_entry: v })}
                  min={50} max={95}
                />
                <p className="text-xs text-gray-500 -mt-2 ml-4">
                  Only for spike trades without twitter. Twitter trades use confidence limits (99¢/92¢/80¢).
                </p>
                <NumberInput
                  label="Cooldown Before Buy (minutes)"
                  value={settings.price_spike_cooldown_minutes}
                  onChange={(v) => setSettings({ ...settings, price_spike_cooldown_minutes: v })}
                  min={0} max={10}
                />
                <NumberInput
                  label="Max Contracts Per Spike"
                  value={settings.price_spike_position_limit}
                  onChange={(v) => setSettings({ ...settings, price_spike_position_limit: v })}
                  min={10} max={200}
                />
                <Toggle
                  label="Require Twitter Confirmation"
                  enabled={settings.price_spike_require_twitter}
                  onChange={(v) => setSettings({ ...settings, price_spike_require_twitter: v })}
                />
                <NumberInput
                  label="Min Volume for Auto-Buy"
                  value={settings.min_volume_for_auto_buy}
                  onChange={(v) => setSettings({ ...settings, min_volume_for_auto_buy: v })}
                  min={5000} max={100000} step={1000}
                />
              </div>

              <div className="mt-4 p-3 bg-gray-900/50 rounded text-xs text-gray-400">
                <p><strong>Safeguards Active:</strong></p>
                <ul className="list-disc list-inside mt-1 space-y-1">
                  <li>Won't buy if price already above {settings.price_spike_max_entry}¢</li>
                  <li>Waits {settings.price_spike_cooldown_minutes} minute{settings.price_spike_cooldown_minutes !== 1 ? "s" : ""} after spike to buy (lets price stabilize)</li>
                  <li>Max {settings.price_spike_position_limit} contracts per spike (limits exposure)</li>
                  {settings.price_spike_require_twitter && <li>Only buys spikes with Twitter confirmation</li>}
                  <li>Requires minimum volume of {settings.min_volume_for_auto_buy.toLocaleString()}</li>
                </ul>
              </div>
            </div>

            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Other Features</h2>
              <div className="space-y-4">
                <Toggle label="Twitter Monitoring" enabled={settings.features.twitter_monitoring} onChange={(v) => setSettings({ ...settings, features: { ...settings.features, twitter_monitoring: v } })} />
                <Toggle label="Orderbook Monitoring" enabled={settings.features.orderbook_monitoring} onChange={(v) => setSettings({ ...settings, features: { ...settings.features, orderbook_monitoring: v } })} />
                <Toggle label="Profit Taking (Auto-Sell at 94%+)" enabled={settings.features.profit_taking} onChange={(v) => setSettings({ ...settings, features: { ...settings.features, profit_taking: v } })} />
                <Toggle label="Telegram Notifications" enabled={settings.features.telegram_notifications} onChange={(v) => setSettings({ ...settings, features: { ...settings.features, telegram_notifications: v } })} />
                <NumberInput label="Min Volume for Alert" value={settings.min_volume_for_alert} onChange={(v) => setSettings({ ...settings, min_volume_for_alert: v })} min={1000} max={50000} step={1000} />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={() => saveSettings(settings)}
                disabled={settingsSaved === "saving"}
                className={`px-6 py-2 rounded-lg font-medium transition-all ${
                  settingsSaved === "saving"
                    ? "bg-gray-600 cursor-not-allowed"
                    : "bg-pink-600 hover:bg-pink-500"
                }`}
              >
                {settingsSaved === "saving" ? "Saving..." : "Save Settings"}
              </button>
              {settingsSaved === "saved" && (
                <span className="text-yellow-400 flex items-center gap-2">
                  <span className="animate-pulse">●</span> Saved, pushing to bot...
                </span>
              )}
              {settingsSaved === "bot_updated" && (
                <span className="text-green-400 flex items-center gap-2">
                  ✓ Bot updated!
                </span>
              )}
            </div>

            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Trading Logic Summary</h2>
              <div className="text-sm text-gray-300 space-y-3">
                <div>
                  <p className="font-semibold text-blue-400">Twitter Monitoring (Primary Strategy)</p>
                  <p className="text-gray-400">Monitors @ShamsCharania, @TheSteinLine, @ChrisBHaynes, @WindhorstESPN, @TimBontemps, @JakeLFischer, @BobbyMarks42</p>
                </div>

                <div>
                  <p className="font-semibold text-green-400">Confidence Tiers & Max Prices</p>
                  <ul className="list-disc list-inside ml-4 space-y-1 text-gray-400">
                    <li><span className="text-green-400">Confirmed</span>: 100% position ({settings.base_contract_count} contracts), max <strong>{settings.max_price_confirmed}¢</strong></li>
                    <li><span className="text-yellow-400">Imminent</span>: 50% position ({Math.round(settings.base_contract_count * 0.5)} contracts), max <strong>{settings.max_price_imminent}¢</strong></li>
                    <li><span className="text-orange-400">Serious</span>: 25% position ({Math.round(settings.base_contract_count * 0.25)} contracts), max <strong>{settings.max_price_serious}¢</strong></li>
                    <li><span className="text-gray-400">Exploring</span>: Alert only, no auto-trade</li>
                    <li><span className="text-red-400">Negative</span>: 50% NO position</li>
                  </ul>
                  <p className="text-xs text-green-400 mt-2">
                    ✓ These are the ONLY price limits for twitter-based trades. Price spike limits don't apply.
                  </p>
                </div>

                <div>
                  <p className="font-semibold text-yellow-400">Smart Recommendations</p>
                  <p className="text-gray-400">
                    Position recommendations consider: entry price vs current price (P&L), recent signal confidence,
                    price momentum (6hr trend), and implied probability. Not just current price.
                  </p>
                </div>

                <div>
                  <p className="font-semibold text-purple-400">Profit Taking</p>
                  <p className="text-gray-400">Auto-sells at 94%+ only if ≥10¢ profit per contract</p>
                </div>
              </div>
            </div>

            {/* Market Metrics Explanation */}
            <div className="bg-gray-800 rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Understanding Market Metrics</h2>
              <div className="text-sm space-y-4">
                <div className="bg-gray-700/50 rounded-lg p-4">
                  <p className="font-semibold text-orange-400 mb-2">📈 Price Change (Momentum)</p>
                  <p className="text-gray-300 mb-2">
                    <strong>What it is:</strong> The difference in price over a time period (e.g., last 6 hours).
                  </p>
                  <p className="text-gray-400 mb-2">
                    <strong>How it's calculated:</strong> Current price minus price from X hours ago. Shown as +/- cents.
                  </p>
                  <p className="text-gray-400">
                    <strong>Trading use:</strong> Upward momentum (+5¢+) suggests growing confidence in a trade happening.
                    However, rapid spikes can also indicate you're late to the news. Used in recommendations but not for auto-buy triggers.
                  </p>
                </div>

                <div className="bg-gray-700/50 rounded-lg p-4">
                  <p className="font-semibold text-blue-400 mb-2">📊 Volume</p>
                  <p className="text-gray-300 mb-2">
                    <strong>What it is:</strong> Total number of contracts traded on this market (cumulative, all-time).
                  </p>
                  <p className="text-gray-400 mb-2">
                    <strong>How it's calculated:</strong> Kalshi tracks every fill. Each buy/sell adds to volume.
                  </p>
                  <p className="text-gray-400">
                    <strong>Trading use:</strong> Higher volume = more liquid market, easier to enter/exit.
                    We require minimum volume ({settings.min_volume_for_auto_buy.toLocaleString()}) before auto-buying on price spikes
                    to avoid illiquid markets where a few trades can cause misleading price moves.
                  </p>
                </div>

                <div className="bg-gray-700/50 rounded-lg p-4">
                  <p className="font-semibold text-purple-400 mb-2">🔓 Open Interest</p>
                  <p className="text-gray-300 mb-2">
                    <strong>What it is:</strong> Total number of outstanding contracts currently held (not yet settled).
                  </p>
                  <p className="text-gray-400 mb-2">
                    <strong>How it's calculated:</strong> When you buy YES, open interest increases. When you sell to close, it decreases.
                    It represents the total "skin in the game" across all traders.
                  </p>
                  <p className="text-gray-400">
                    <strong>Trading use:</strong> Rising open interest + rising price = strong conviction (new money entering bullish).
                    Falling open interest + rising price = short covering (less conviction).
                    High OI also means more potential sellers at resolution, which affects liquidity.
                  </p>
                </div>

                <div className="bg-gray-700/50 rounded-lg p-4">
                  <p className="font-semibold text-green-400 mb-2">🎯 How Metrics Affect Auto-Buy Logic</p>
                  <table className="w-full text-sm mt-2">
                    <thead>
                      <tr className="text-left text-gray-400 border-b border-gray-600">
                        <th className="pb-2">Metric</th>
                        <th className="pb-2">Used For</th>
                        <th className="pb-2">Threshold</th>
                      </tr>
                    </thead>
                    <tbody className="text-gray-300">
                      <tr className="border-b border-gray-700">
                        <td className="py-2">Volume</td>
                        <td>Spike auto-buy gate</td>
                        <td>≥{settings.min_volume_for_auto_buy.toLocaleString()}</td>
                      </tr>
                      <tr className="border-b border-gray-700">
                        <td className="py-2">Price Change %</td>
                        <td>Spike detection</td>
                        <td>≥{settings.price_spike_threshold}% move</td>
                      </tr>
                      <tr className="border-b border-gray-700">
                        <td className="py-2">Momentum</td>
                        <td>Recommendation scoring</td>
                        <td>+5¢ = bullish, -5¢ = bearish</td>
                      </tr>
                      <tr>
                        <td className="py-2">Open Interest</td>
                        <td>Displayed only</td>
                        <td>Not used in auto-buy (yet)</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {showTweetModal && (
        <TweetModal
          title={modalTitle}
          tweets={modalTweets}
          onClose={() => setShowTweetModal(false)}
          onPlayerClick={(player) => { setShowTweetModal(false); setTimeout(() => showPlayerTweets(player), 100); }}
          onHandleClick={(handle) => { setShowTweetModal(false); setTimeout(() => showHandleTweets(handle), 100); }}
        />
      )}

      {selectedAnalysis && (
        <AnalysisModal analysis={selectedAnalysis} onClose={() => setSelectedAnalysis(null)} />
      )}

      {selectedPlayer && (
        <PlayerDetailModal
          playerName={selectedPlayer.name}
          ticker={selectedPlayer.ticker}
          currentPrice={selectedPlayer.price}
          priceHistory={playerPriceHistory}
          events={playerEvents}
          tweets={tweets}
          exposure={playerExposure[selectedPlayer.name.toLowerCase()]}
          onClose={() => { setSelectedPlayer(null); setPlayerPriceHistory([]); setPlayerEvents([]); }}
          onTrade={setTradeOpportunity}
        />
      )}

      {tradeOpportunity && (
        <TradeModal
          opportunity={tradeOpportunity}
          onClose={() => setTradeOpportunity(null)}
          onExecute={(contracts, maxPrice) => executeTrade(tradeOpportunity.ticker, contracts, maxPrice)}
        />
      )}
    </div>
  );
}
