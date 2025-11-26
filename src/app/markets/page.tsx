import { MarketsTable } from './MarketsTable';

export default function MarketsPage() {
  return (
    <div className="bg-edgelord-surface p-4 rounded-lg">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Prediction Markets</h1>
      </div>
      <MarketsTable />
    </div>
  );
}
