"use client";

import { useEffect, useState, useCallback } from "react";

// =============================================================================
// TYPES
// =============================================================================

type NextTeamOutcome = {
  team: string;
  price: number;
};

type Signal = {
  id: string;
  source: string;
  player_name: string;
  text: string;
  classification: string;
  created_at: string;
  action_taken?: string;
};

type PlayerCard = {
  name: string;
  current_team: string;
  trade_price: number;
  next_team_outcomes: NextTeamOutcome[];
  sentiment: "up" | "down" | "neutral";
  signal_count_48h: number;
  latest_signal?: Signal;
  position_held?: {
    side: string;
    contracts: number;
    avg_entry: number;
    current_value: number;
    unrealized_pnl: number;
  };
  signals?: Signal[];
  analyst_context?: string;
  trade_history?: TradeHistoryEntry[];
  overrides?: {
    blocked: boolean;
    max_price?: number;
    confidence_boost: number;
  };
};

type TradeHistoryEntry = {
  id: string;
  side: string;
  action: string;
  price: number;
  count: number;
  created_at: string;
  reason?: string;
};

type BotStatus = {
  running: boolean;
  balance_cents: number;
  total_pnl_cents: number;
  active_positions: number;
  last_signal_at: string | null;
  kill_switch: boolean;
  size_multiplier: number;
};

type TeamInfo = {
  name: string;
  abbreviation: string;
  needs: { position: string; level: "high_need" | "moderate_need" | "filled" }[];
  recent_moves: string[];
  linked_players: { name: string; confidence: number }[];
};

type MarketPlayer = {
  player_name: string;
  trade_market: { ticker: string; yes_price: number; title: string } | null;
  next_team_markets: { ticker: string; team: string; yes_price: number; title: string }[];
  total_markets: number;
};

// =============================================================================
// NFL TEAM DATA
// =============================================================================

const NFL_TEAM_ABBREVS: Record<string, string> = {
  "Cardinals": "ARI", "Falcons": "ATL", "Ravens": "BAL", "Bills": "BUF",
  "Panthers": "CAR", "Bears": "CHI", "Bengals": "CIN", "Browns": "CLE",
  "Cowboys": "DAL", "Broncos": "DEN", "Lions": "DET", "Packers": "GB",
  "Texans": "HOU", "Colts": "IND", "Jaguars": "JAX", "Chiefs": "KC",
  "Raiders": "LV", "Chargers": "LAC", "Rams": "LAR", "Dolphins": "MIA",
  "Vikings": "MIN", "Patriots": "NE", "Saints": "NO", "Giants": "NYG",
  "Jets": "NYJ", "Eagles": "PHI", "Steelers": "PIT", "49ers": "SF",
  "Seahawks": "SEA", "Buccaneers": "TB", "Titans": "TEN", "Commanders": "WAS",
};

// ESPN team logo CDN - works for all 32 teams
function getTeamLogoUrl(teamName: string): string {
  const ESPN_TEAM_IDS: Record<string, number> = {
    "Cardinals": 22, "Falcons": 1, "Ravens": 33, "Bills": 2,
    "Panthers": 29, "Bears": 3, "Bengals": 4, "Browns": 5,
    "Cowboys": 6, "Broncos": 7, "Lions": 8, "Packers": 9,
    "Texans": 34, "Colts": 11, "Jaguars": 30, "Chiefs": 12,
    "Raiders": 13, "Chargers": 24, "Rams": 14, "Dolphins": 15,
    "Vikings": 16, "Patriots": 17, "Saints": 18, "Giants": 19,
    "Jets": 20, "Eagles": 21, "Steelers": 23, "49ers": 25,
    "Seahawks": 26, "Buccaneers": 27, "Titans": 10, "Commanders": 28,
  };
  const id = ESPN_TEAM_IDS[teamName];
  if (!id) return "";
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${NFL_TEAM_ABBREVS[teamName]?.toLowerCase()}.png`;
}

// =============================================================================
// HELPERS
// =============================================================================

function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function getTradePriceColor(price: number): string {
  if (price >= 80) return "text-green-400";
  if (price >= 40) return "text-yellow-400";
  return "text-red-400";
}

function getSentimentIcon(sentiment: "up" | "down" | "neutral"): string {
  if (sentiment === "up") return "\u2191";
  if (sentiment === "down") return "\u2193";
  return "\u2192";
}

function getSentimentColor(sentiment: "up" | "down" | "neutral"): string {
  if (sentiment === "up") return "text-green-400";
  if (sentiment === "down") return "text-red-400";
  return "text-yellow-400";
}

function getClassificationColor(classification: string): string {
  switch (classification) {
    case "confirmed":
      return "bg-green-500/20 text-green-400";
    case "strong_intel":
      return "bg-yellow-500/20 text-yellow-400";
    case "developing":
      return "bg-blue-500/20 text-blue-400";
    case "speculation":
    default:
      return "bg-zinc-500/20 text-zinc-400";
  }
}

function getStalenessColor(lastSignalAt: string | null): string {
  if (!lastSignalAt) return "text-red-400";
  const diffMins = (Date.now() - new Date(lastSignalAt).getTime()) / 60000;
  if (diffMins > 15) return "text-red-400";
  if (diffMins > 5) return "text-yellow-400";
  return "text-green-400";
}

function getNeedColor(level: string): string {
  switch (level) {
    case "high_need":
      return "bg-red-500/20 text-red-400 border-red-500/30";
    case "moderate_need":
      return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    case "filled":
      return "bg-green-500/20 text-green-400 border-green-500/30";
    default:
      return "bg-zinc-500/20 text-zinc-400 border-zinc-500/30";
  }
}

// =============================================================================
// COMPONENTS
// =============================================================================

function StatusBar({
  status,
  onToggleKillSwitch,
  onSizeMultiplier,
}: {
  status: BotStatus | null;
  onToggleKillSwitch: () => void;
  onSizeMultiplier: (value: number) => void;
}) {
  if (!status) {
    return (
      <div className="bg-edgelord-surface border border-edgelord-border rounded-lg p-4">
        <p className="text-edgelord-text-secondary text-sm">Loading bot status...</p>
      </div>
    );
  }

  return (
    <div className="bg-edgelord-surface border border-edgelord-border rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-4 sm:gap-6">
        {/* Bot status indicator */}
        <div className="flex items-center gap-2">
          <div
            className={`w-3 h-3 rounded-full ${
              status.running && !status.kill_switch ? "bg-green-500 animate-pulse" : "bg-red-500"
            }`}
          />
          <span className="text-sm font-medium">
            {status.kill_switch ? "KILLED" : status.running ? "RUNNING" : "OFFLINE"}
          </span>
        </div>

        {/* Kill switch */}
        <button
          onClick={onToggleKillSwitch}
          className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
            status.kill_switch
              ? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
              : "bg-red-500/20 text-red-400 hover:bg-red-500/30"
          }`}
        >
          {status.kill_switch ? "RESUME BOT" : "KILL SWITCH"}
        </button>

        {/* Balance */}
        <div className="text-sm">
          <span className="text-edgelord-text-secondary">Balance: </span>
          <span className="font-semibold">${(status.balance_cents / 100).toFixed(2)}</span>
        </div>

        {/* P&L */}
        <div className="text-sm">
          <span className="text-edgelord-text-secondary">P&L: </span>
          <span
            className={`font-semibold ${
              status.total_pnl_cents >= 0 ? "text-green-400" : "text-red-400"
            }`}
          >
            {status.total_pnl_cents >= 0 ? "+" : ""}${(status.total_pnl_cents / 100).toFixed(2)}
          </span>
        </div>

        {/* Active positions */}
        <div className="text-sm">
          <span className="text-edgelord-text-secondary">Positions: </span>
          <span className="font-semibold">{status.active_positions}</span>
        </div>

        {/* Last signal */}
        <div className="text-sm">
          <span className="text-edgelord-text-secondary">Last Signal: </span>
          <span className={`font-semibold ${getStalenessColor(status.last_signal_at)}`}>
            {status.last_signal_at ? getTimeAgo(new Date(status.last_signal_at)) : "never"}
          </span>
        </div>

        {/* Size multiplier */}
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs text-edgelord-text-secondary mr-1">Size:</span>
          {[0.5, 1, 2].map((v) => (
            <button
              key={v}
              onClick={() => onSizeMultiplier(v)}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                status.size_multiplier === v
                  ? "bg-edgelord-primary/20 text-edgelord-primary"
                  : "bg-edgelord-bg text-edgelord-text-secondary hover:text-edgelord-text-primary"
              }`}
            >
              {v}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlayerCardComponent({
  player,
  isExpanded,
  onToggleExpand,
  onOverride,
}: {
  player: PlayerCard;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onOverride: (body: Record<string, unknown>) => void;
}) {
  const [maxPriceInput, setMaxPriceInput] = useState(
    player.overrides?.max_price?.toString() ?? ""
  );

  return (
    <div
      className={`bg-edgelord-surface border border-edgelord-border rounded-lg p-4 cursor-pointer transition-all ${
        isExpanded ? "col-span-1 sm:col-span-2 lg:col-span-3" : ""
      }`}
      onClick={() => !isExpanded && onToggleExpand()}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          {getTeamLogoUrl(player.current_team) && (
            <img src={getTeamLogoUrl(player.current_team)} alt="" className="w-8 h-8 object-contain" />
          )}
          <div>
            <h3 className="font-semibold text-lg">{player.name}</h3>
            <p className="text-xs text-edgelord-text-secondary">{player.current_team}</p>
          </div>
        </div>
        <div className="text-right flex items-center gap-3">
          <span className={`text-2xl font-bold ${getTradePriceColor(player.trade_price)}`}>
            {player.trade_price}c
          </span>
          <span className={`text-lg ${getSentimentColor(player.sentiment)}`}>
            {getSentimentIcon(player.sentiment)}
          </span>
        </div>
      </div>

      {/* Signal count badge */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs bg-edgelord-primary/20 text-edgelord-primary px-2 py-0.5 rounded">
          {player.signal_count_48h} signals (48h)
        </span>
        {player.position_held && (
          <span
            className={`text-xs px-2 py-0.5 rounded ${
              player.position_held.unrealized_pnl >= 0
                ? "bg-green-500/20 text-green-400"
                : "bg-red-500/20 text-red-400"
            }`}
          >
            P&L: {player.position_held.unrealized_pnl >= 0 ? "+" : ""}$
            {(player.position_held.unrealized_pnl / 100).toFixed(2)}
          </span>
        )}
        {player.overrides?.blocked && (
          <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded">BLOCKED</span>
        )}
      </div>

      {/* Top 3 NEXTTEAM outcomes */}
      <div className="space-y-1.5 mb-3">
        {player.next_team_outcomes.slice(0, 3).map((outcome) => (
          <div key={outcome.team} className="flex items-center gap-2">
            {getTeamLogoUrl(outcome.team) && (
              <img src={getTeamLogoUrl(outcome.team)} alt="" className="w-4 h-4 object-contain" />
            )}
            <span className="text-xs text-edgelord-text-secondary w-16 truncate">
              {outcome.team}
            </span>
            <div className="flex-1 bg-edgelord-bg rounded-full h-3 relative">
              <div
                className={`h-3 rounded-full ${
                  outcome.price >= 50 ? "bg-green-500" : "bg-blue-500"
                }`}
                style={{ width: `${Math.max(outcome.price, 2)}%` }}
              />
            </div>
            <span className="text-xs font-medium w-10 text-right">{outcome.price}c</span>
          </div>
        ))}
      </div>

      {/* Latest signal preview */}
      {player.latest_signal && (
        <div className="bg-edgelord-bg rounded p-2 text-xs">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-edgelord-primary font-medium">
              @{player.latest_signal.source}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] ${getClassificationColor(
                player.latest_signal.classification
              )}`}
            >
              {player.latest_signal.classification}
            </span>
            <span className="text-edgelord-text-secondary ml-auto">
              {getTimeAgo(new Date(player.latest_signal.created_at))}
            </span>
          </div>
          <p className="text-edgelord-text-secondary line-clamp-2">{player.latest_signal.text}</p>
        </div>
      )}

      {/* Position info */}
      {player.position_held && (
        <div className="grid grid-cols-3 gap-2 text-xs text-edgelord-text-secondary mt-3 pt-3 border-t border-edgelord-border">
          <div>
            Side:{" "}
            <span className="text-edgelord-text-primary">
              {player.position_held.side.toUpperCase()}
            </span>
          </div>
          <div>
            Contracts:{" "}
            <span className="text-edgelord-text-primary">{player.position_held.contracts}</span>
          </div>
          <div>
            Entry:{" "}
            <span className="text-edgelord-text-primary">{player.position_held.avg_entry}c</span>
          </div>
        </div>
      )}

      {/* EXPANDED VIEW */}
      {isExpanded && (
        <div
          className="mt-4 pt-4 border-t border-edgelord-border space-y-4"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close button */}
          <div className="flex justify-end">
            <button
              onClick={onToggleExpand}
              className="text-xs text-edgelord-text-secondary hover:text-edgelord-text-primary"
            >
              Collapse
            </button>
          </div>

          {/* Analyst brain context */}
          {player.analyst_context && (
            <div className="bg-edgelord-bg rounded-lg p-3">
              <h4 className="text-sm font-semibold mb-2">Analyst Context</h4>
              <p className="text-xs text-edgelord-text-secondary whitespace-pre-wrap">
                {player.analyst_context}
              </p>
            </div>
          )}

          {/* All NEXTTEAM outcomes */}
          <div>
            <h4 className="text-sm font-semibold mb-2">All NEXTTEAM Outcomes</h4>
            <div className="space-y-1.5">
              {player.next_team_outcomes.map((outcome) => (
                <div key={outcome.team} className="flex items-center gap-2">
                  <span className="text-xs text-edgelord-text-secondary w-20 truncate">
                    {outcome.team}
                  </span>
                  <div className="flex-1 bg-edgelord-bg rounded-full h-3">
                    <div
                      className={`h-3 rounded-full ${
                        outcome.price >= 50 ? "bg-green-500" : "bg-blue-500"
                      }`}
                      style={{ width: `${Math.max(outcome.price, 2)}%` }}
                    />
                  </div>
                  <span className="text-xs font-medium w-10 text-right">{outcome.price}c</span>
                </div>
              ))}
            </div>
          </div>

          {/* Full signal timeline */}
          {player.signals && player.signals.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2">Signal Timeline</h4>
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {player.signals.map((sig) => (
                  <div key={sig.id} className="bg-edgelord-bg rounded p-2 text-xs">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-edgelord-primary font-medium">@{sig.source}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] ${getClassificationColor(
                          sig.classification
                        )}`}
                      >
                        {sig.classification}
                      </span>
                      {sig.action_taken && (
                        <span className="text-[10px] bg-edgelord-primary/20 text-edgelord-primary px-1.5 py-0.5 rounded">
                          {sig.action_taken}
                        </span>
                      )}
                      <span className="text-edgelord-text-secondary ml-auto">
                        {getTimeAgo(new Date(sig.created_at))}
                      </span>
                    </div>
                    <p className="text-edgelord-text-secondary">{sig.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Trade history */}
          {player.trade_history && player.trade_history.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2">Trade History</h4>
              <div className="bg-edgelord-bg rounded-lg overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-edgelord-border text-edgelord-text-secondary">
                      <th className="text-left p-2">Side</th>
                      <th className="text-left p-2">Action</th>
                      <th className="text-right p-2">Price</th>
                      <th className="text-right p-2">Qty</th>
                      <th className="text-right p-2">Time</th>
                      <th className="text-left p-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {player.trade_history.map((t) => (
                      <tr key={t.id} className="border-b border-edgelord-border/30">
                        <td className="p-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] ${
                              t.side === "yes"
                                ? "bg-green-500/20 text-green-400"
                                : "bg-red-500/20 text-red-400"
                            }`}
                          >
                            {t.side.toUpperCase()}
                          </span>
                        </td>
                        <td className="p-2 capitalize">{t.action}</td>
                        <td className="p-2 text-right">{t.price}c</td>
                        <td className="p-2 text-right">{t.count}</td>
                        <td className="p-2 text-right text-edgelord-text-secondary">
                          {getTimeAgo(new Date(t.created_at))}
                        </td>
                        <td className="p-2 text-edgelord-text-secondary truncate max-w-[150px]">
                          {t.reason ?? "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Override controls */}
          <div>
            <h4 className="text-sm font-semibold mb-2">Override Controls</h4>
            <div className="flex flex-wrap items-center gap-3">
              {/* Block/Allow toggle */}
              <button
                onClick={() =>
                  onOverride({
                    type: "kill_player",
                    action: player.overrides?.blocked ? "remove" : "add",
                    player: player.name,
                  })
                }
                className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                  player.overrides?.blocked
                    ? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
                    : "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                }`}
              >
                {player.overrides?.blocked ? "ALLOW" : "BLOCK"}
              </button>

              {/* Max price */}
              <div className="flex items-center gap-1">
                <span className="text-xs text-edgelord-text-secondary">Max Price:</span>
                <input
                  type="number"
                  value={maxPriceInput}
                  onChange={(e) => setMaxPriceInput(e.target.value)}
                  placeholder="--"
                  className="w-16 bg-edgelord-bg border border-edgelord-border rounded px-2 py-1 text-xs"
                />
                <button
                  onClick={() => {
                    const val = parseInt(maxPriceInput);
                    if (!isNaN(val))
                      onOverride({ type: "max_price", player: player.name, value: val });
                  }}
                  className="px-2 py-1 rounded text-xs bg-edgelord-primary/20 text-edgelord-primary hover:bg-edgelord-primary/30"
                >
                  Set
                </button>
              </div>

              {/* Confidence boost */}
              <div className="flex items-center gap-1">
                <span className="text-xs text-edgelord-text-secondary">Confidence:</span>
                {[-1, 0, 1].map((v) => (
                  <button
                    key={v}
                    onClick={() =>
                      onOverride({
                        type: "confidence_boost",
                        player: player.name,
                        value: v,
                      })
                    }
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                      player.overrides?.confidence_boost === v
                        ? "bg-edgelord-primary/20 text-edgelord-primary"
                        : "bg-edgelord-bg text-edgelord-text-secondary hover:text-edgelord-text-primary"
                    }`}
                  >
                    {v > 0 ? `+${v}` : v}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SignalFeedItem({ signal }: { signal: Signal }) {
  return (
    <div className="bg-edgelord-surface border border-edgelord-border rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs text-edgelord-text-secondary">
          {getTimeAgo(new Date(signal.created_at))}
        </span>
        <span className="text-xs text-edgelord-primary font-medium">@{signal.source}</span>
        <span className="text-xs font-semibold text-edgelord-text-primary">
          {signal.player_name}
        </span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ml-auto ${getClassificationColor(
            signal.classification
          )}`}
        >
          {signal.classification}
        </span>
      </div>
      <p className="text-xs text-edgelord-text-secondary line-clamp-2">{signal.text}</p>
      {signal.action_taken && (
        <p className="text-[10px] text-edgelord-primary mt-1">Action: {signal.action_taken}</p>
      )}
    </div>
  );
}

function TeamCard({ team }: { team: TeamInfo }) {
  const logoUrl = getTeamLogoUrl(team.name);
  return (
    <div className="bg-edgelord-surface border border-edgelord-border rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2">
        {logoUrl && (
          <img src={logoUrl} alt={team.name} className="w-8 h-8 object-contain" />
        )}
        <h4 className="font-semibold text-sm">
          {team.name}{" "}
          <span className="text-edgelord-text-secondary font-normal">({team.abbreviation})</span>
        </h4>
      </div>

      {/* Needs pills */}
      <div className="flex flex-wrap gap-1 mb-2">
        {team.needs.map((need) => (
          <span
            key={need.position}
            className={`text-[10px] px-1.5 py-0.5 rounded border ${getNeedColor(need.level)}`}
          >
            {need.position}
          </span>
        ))}
      </div>

      {/* Recent moves */}
      {team.recent_moves.length > 0 && (
        <div className="mb-2">
          <p className="text-[10px] text-edgelord-text-secondary mb-1">Recent Moves:</p>
          {team.recent_moves.slice(0, 3).map((move, i) => (
            <p key={i} className="text-[10px] text-edgelord-text-primary truncate">
              {move}
            </p>
          ))}
        </div>
      )}

      {/* Linked players */}
      {team.linked_players.length > 0 && (
        <div>
          <p className="text-[10px] text-edgelord-text-secondary mb-1">Linked Players:</p>
          {team.linked_players.map((lp) => (
            <div key={lp.name} className="flex items-center justify-between text-[10px]">
              <span className="text-edgelord-text-primary">{lp.name}</span>
              <span
                className={`${
                  lp.confidence >= 70
                    ? "text-green-400"
                    : lp.confidence >= 40
                    ? "text-yellow-400"
                    : "text-zinc-400"
                }`}
              >
                {lp.confidence}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export default function NflFaPage() {
  const [players, setPlayers] = useState<PlayerCard[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [positions, setPositions] = useState<any[]>([]);
  const [marketPlayers, setMarketPlayers] = useState<MarketPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);
  const [showTeamView, setShowTeamView] = useState(false);
  const [activeTab, setActiveTab] = useState<"signals" | "markets">("signals");

  const fetchPlayers = useCallback(async () => {
    try {
      const resp = await fetch("/api/nfl/players");
      const data = await resp.json();
      if (data.players) {
        const mapped: PlayerCard[] = data.players.map((p: any) => {
          // Look up market data for this player
          const mkt = marketPlayers.find(
            m => m.player_name.toLowerCase() === (p.entity_name || "").toLowerCase()
          );
          return {
          name: p.entity_name,
          current_team: p.meta?.current_team ?? p.linked_entities?.current_team ?? "Unknown",
          trade_price: mkt?.trade_market?.yes_price ?? 0,
          next_team_outcomes: (mkt?.next_team_markets ?? []).map(t => ({
            team: t.team,
            price: t.yes_price,
          })),
          sentiment: p.sentiment_trajectory === "rising" ? "up" as const : p.sentiment_trajectory === "falling" ? "down" as const : "neutral" as const,
          signal_count_48h: p.signal_count ?? 0,
          latest_signal: p.recent_signals?.[0] ? {
            id: p.recent_signals[0].id,
            source: p.recent_signals[0].source_author,
            player_name: p.recent_signals[0].player_name,
            text: p.recent_signals[0].raw_text,
            classification: p.recent_signals[0].confidence_tier,
            created_at: p.recent_signals[0].created_at,
          } : undefined,
          signals: (p.recent_signals ?? []).map((s: any) => ({
            id: s.id,
            source: s.source_author,
            player_name: s.player_name,
            text: s.raw_text,
            classification: s.confidence_tier,
            created_at: s.created_at,
          })),
          analyst_context: p.context_summary,
          trade_history: (p.trades ?? []).map((t: any) => ({
            id: t.id,
            side: t.side,
            action: t.action,
            price: t.price_cents,
            count: t.quantity,
            created_at: t.created_at,
            reason: `${t.meta?.event_type ?? ""} ${t.market_type ?? ""} ${t.market_ticker ?? ""}`,
          })),
          position_held: (() => {
            const playerTrades = p.trades ?? [];
            const tickers = playerTrades.map((t: any) => t.market_ticker).filter(Boolean);
            const pos = positions.find((pos: any) => tickers.includes(pos.ticker));
            if (!pos) return undefined;
            const side = pos.position > 0 ? "yes" : "no";
            const contracts = pos.position > 0 ? pos.position : pos.no_position;
            const avgEntry = pos.average_price_paid ?? 0;
            const currentValue = side === "yes" ? (pos.market_price ?? 0) : (100 - (pos.market_price ?? 0));
            return {
              side,
              contracts,
              avg_entry: avgEntry,
              current_value: currentValue,
              unrealized_pnl: (currentValue - avgEntry) * contracts,
            };
          })(),
        }});
        setPlayers(mapped);
      }
    } catch (e) {
      console.error("Failed to fetch players:", e);
    } finally {
      setLoading(false);
    }
  }, [positions, marketPlayers]);

  const fetchSignals = useCallback(async () => {
    try {
      const resp = await fetch("/api/nfl/signals");
      const data = await resp.json();
      if (data.signals) {
        const mapped: Signal[] = data.signals.map((s: any) => ({
          id: s.id,
          source: s.source_author,
          player_name: s.player_name,
          text: s.raw_text,
          classification: s.confidence_tier,
          created_at: s.created_at,
        }));
        setSignals(mapped);
      }
    } catch (e) {
      console.error("Failed to fetch signals:", e);
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const resp = await fetch("/api/nfl/status");
      const data = await resp.json();
      const bs = data.bot_status;
      setBotStatus({
        running: bs?.status === "running",
        balance_cents: Math.round((data.balance?.cash ?? 0) * 100),
        total_pnl_cents: 0,
        active_positions: data.active_positions ?? 0,
        last_signal_at: bs?.last_poll_at ?? null,
        kill_switch: bs?.meta?.overrides?.killedPlayers?.length > 0 || false,
        size_multiplier: bs?.meta?.overrides?.positionSizeMultiplier ?? 1,
      });
      if (data.positions) {
        setPositions(data.positions);
      }
    } catch (e) {
      console.error("Failed to fetch bot status:", e);
    }
  }, []);

  const fetchTeams = useCallback(async () => {
    try {
      const resp = await fetch("/api/nfl/teams");
      const data = await resp.json();
      if (data.teams) {
        const mapped: TeamInfo[] = data.teams.map((t: any) => ({
          name: t.entity_name,
          abbreviation: NFL_TEAM_ABBREVS[t.entity_name] ?? t.entity_name.slice(0, 3).toUpperCase(),
          needs: (t.positional_needs?.needed ?? []).map((pos: string) => ({
            position: pos,
            level: "high_need" as const,
          })),
          recent_moves: [],
          linked_players: [],
        }));
        setTeams(mapped);
      }
    } catch (e) {
      console.error("Failed to fetch teams:", e);
    }
  }, []);

  const fetchMarkets = useCallback(async () => {
    try {
      const resp = await fetch("/api/nfl/markets");
      const data = await resp.json();
      if (data.players) {
        setMarketPlayers(data.players);
      }
    } catch (e) {
      console.error("Failed to fetch markets:", e);
    }
  }, []);

  const sendOverride = useCallback(async (body: Record<string, unknown>) => {
    try {
      await fetch("/api/nfl/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // Refresh status and players after override
      fetchStatus();
      fetchPlayers();
    } catch (e) {
      console.error("Failed to send override:", e);
    }
  }, [fetchStatus, fetchPlayers]);

  const handleToggleKillSwitch = useCallback(() => {
    sendOverride({
      type: "kill_switch",
      action: botStatus?.kill_switch ? "disable" : "enable",
    });
  }, [botStatus, sendOverride]);

  const handleSizeMultiplier = useCallback(
    (value: number) => {
      sendOverride({ type: "size_multiplier", value });
    },
    [sendOverride]
  );

  useEffect(() => {
    fetchMarkets();
    fetchPlayers();
    fetchSignals();
    fetchStatus();
    fetchTeams();

    const marketInterval = setInterval(fetchMarkets, 15000);
    const playerInterval = setInterval(fetchPlayers, 15000);
    const signalInterval = setInterval(fetchSignals, 10000);
    const statusInterval = setInterval(fetchStatus, 15000);
    const teamInterval = setInterval(fetchTeams, 60000);

    return () => {
      clearInterval(marketInterval);
      clearInterval(playerInterval);
      clearInterval(signalInterval);
      clearInterval(statusInterval);
      clearInterval(teamInterval);
    };
  }, [fetchMarkets, fetchPlayers, fetchSignals, fetchStatus, fetchTeams]);

  // Sort players by most recent signal activity
  const sortedPlayers = [...players].sort((a, b) => {
    const aTime = a.latest_signal ? new Date(a.latest_signal.created_at).getTime() : 0;
    const bTime = b.latest_signal ? new Date(b.latest_signal.created_at).getTime() : 0;
    return bTime - aTime;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-edgelord-text-secondary">Loading NFL Free Agency dashboard...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
            <span>🏈</span> NFL Free Agency
          </h1>
          <p className="text-edgelord-text-secondary text-xs sm:text-sm mt-1">
            Player movement signals and trading dashboard
          </p>
        </div>
      </div>

      {/* Status Bar */}
      <StatusBar
        status={botStatus}
        onToggleKillSwitch={handleToggleKillSwitch}
        onSizeMultiplier={handleSizeMultiplier}
      />

      {/* Tab Switcher */}
      <div className="flex gap-1 bg-edgelord-surface rounded-lg p-1 w-fit border border-edgelord-border">
        <button
          onClick={() => setActiveTab("signals")}
          className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
            activeTab === "signals"
              ? "bg-edgelord-primary text-white"
              : "text-edgelord-text-secondary hover:text-edgelord-text-primary"
          }`}
        >
          Signals ({sortedPlayers.length} players)
        </button>
        <button
          onClick={() => setActiveTab("markets")}
          className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
            activeTab === "markets"
              ? "bg-edgelord-primary text-white"
              : "text-edgelord-text-secondary hover:text-edgelord-text-primary"
          }`}
        >
          Markets ({marketPlayers.length} players)
        </button>
      </div>

      {/* Main Content */}
      {activeTab === "markets" ? (
        <div className="space-y-4">
          <p className="text-xs text-edgelord-text-secondary">
            All players with active Kalshi markets. Prices update every 15s.
          </p>
          <div className="bg-edgelord-surface rounded-lg border border-edgelord-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edgelord-border text-edgelord-text-secondary text-xs">
                  <th className="text-left p-3">Player</th>
                  <th className="text-right p-3">Trade YES</th>
                  <th className="text-right p-3">Trade NO</th>
                  <th className="text-left p-3">Top Destinations</th>
                  <th className="text-right p-3">Markets</th>
                </tr>
              </thead>
              <tbody>
                {marketPlayers.map((mp) => (
                  <tr key={mp.player_name} className="border-b border-edgelord-border/30 hover:bg-edgelord-bg/50">
                    <td className="p-3 font-medium">{mp.player_name}</td>
                    <td className="p-3 text-right">
                      {mp.trade_market ? (
                        <span className={`font-mono ${mp.trade_market.yes_price >= 50 ? "text-green-400" : "text-edgelord-text-primary"}`}>
                          {mp.trade_market.yes_price}c
                        </span>
                      ) : (
                        <span className="text-edgelord-text-secondary">-</span>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      {mp.trade_market ? (
                        <span className="font-mono text-edgelord-text-secondary">
                          {100 - mp.trade_market.yes_price}c
                        </span>
                      ) : (
                        <span className="text-edgelord-text-secondary">-</span>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1.5">
                        {mp.next_team_markets.slice(0, 4).map((t) => (
                          <span
                            key={t.ticker}
                            className="inline-flex items-center gap-1 text-xs bg-edgelord-bg px-2 py-0.5 rounded"
                          >
                            {getTeamLogoUrl(t.team) && (
                              <img src={getTeamLogoUrl(t.team)} alt="" className="w-3 h-3 object-contain" />
                            )}
                            <span className="text-edgelord-text-secondary">{t.team}</span>
                            <span className={`font-mono ${t.yes_price >= 30 ? "text-green-400" : "text-edgelord-text-primary"}`}>
                              {t.yes_price}c
                            </span>
                          </span>
                        ))}
                        {mp.next_team_markets.length > 4 && (
                          <span className="text-xs text-edgelord-text-secondary">
                            +{mp.next_team_markets.length - 4} more
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-right text-edgelord-text-secondary">{mp.total_markets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Player Cards Grid - 3 columns */}
        <div className="lg:col-span-3 space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span>👤</span> Player Cards
            <span className="text-xs text-edgelord-text-secondary font-normal">
              ({sortedPlayers.length} players)
            </span>
          </h2>

          {sortedPlayers.length === 0 ? (
            <div className="text-center text-edgelord-text-secondary py-8 bg-edgelord-surface rounded-lg border border-edgelord-border">
              No player data available yet. Waiting for signals...
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {sortedPlayers.map((player) => (
                <PlayerCardComponent
                  key={player.name}
                  player={player}
                  isExpanded={expandedPlayer === player.name}
                  onToggleExpand={() =>
                    setExpandedPlayer(expandedPlayer === player.name ? null : player.name)
                  }
                  onOverride={sendOverride}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right Sidebar - Live Signal Feed */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span>📡</span> Live Signals
            <span className="text-xs text-edgelord-text-secondary font-normal">
              ({signals.length})
            </span>
          </h2>
          <div className="space-y-2 max-h-[400px] sm:max-h-[800px] overflow-y-auto pr-1">
            {signals.length === 0 ? (
              <div className="text-center text-edgelord-text-secondary py-8 bg-edgelord-surface rounded-lg border border-edgelord-border">
                <p>No signals yet</p>
                <p className="text-xs mt-1">Waiting for intel...</p>
              </div>
            ) : (
              signals.map((signal) => <SignalFeedItem key={signal.id} signal={signal} />)
            )}
          </div>
        </div>
      </div>
      )}

      {/* Bottom Panel - Team View */}
      <div className="space-y-4">
        <button
          onClick={() => setShowTeamView(!showTeamView)}
          className="flex items-center gap-2 text-sm font-semibold text-edgelord-primary hover:text-edgelord-primarySoft transition-colors"
        >
          <span>{showTeamView ? "\u25BC" : "\u25B6"}</span>
          Team View ({teams.length} teams)
        </button>

        {showTeamView && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {teams.length === 0 ? (
              <div className="col-span-full text-center text-edgelord-text-secondary py-8 bg-edgelord-surface rounded-lg border border-edgelord-border">
                No team data available
              </div>
            ) : (
              teams.map((team) => <TeamCard key={team.abbreviation} team={team} />)
            )}
          </div>
        )}
      </div>
    </div>
  );
}
