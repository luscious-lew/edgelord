import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex items-center justify-center text-center">
      <div className="bg-edgelord-surface p-8 rounded-lg shadow-lg max-w-md">
        <h1 className="text-4xl font-bold text-edgelord-primary">EdgeLord</h1>
        <p className="text-edgelord-text-muted mt-4">
          Dumb name. Smart edges. A dashboard for monitoring prediction markets
          and spotting mispricing.
        </p>
        <Link
          href="/markets"
          className="mt-6 inline-block bg-edgelord-primary hover:bg-edgelord-primarySoft text-white font-bold py-2 px-4 rounded"
        >
          View Markets
        </Link>
      </div>
    </div>
  );
}

