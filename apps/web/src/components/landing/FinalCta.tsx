import Link from "next/link";
import { ArrowRight } from "lucide-react";

export default function FinalCta() {
  return (
    <section className="py-20 bg-gradient-to-b from-[#071A33] to-[#0B2A4A] text-white text-center relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(81,184,242,0.15)_0,transparent_70%)] pointer-events-none" />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10 space-y-6">
        <span className="text-xs font-semibold tracking-wider text-[#51B8F2] uppercase bg-[#176BCE]/20 px-3.5 py-1.5 rounded-full border border-[#51B8F2]/30">
          TAKE THE NEXT STEP
        </span>

        <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
          Stop managing important agreements through scattered messages.
        </h2>

        <p className="text-base sm:text-lg text-[#EAF6FD]/80 max-w-2xl mx-auto leading-relaxed">
          Create a clear agreement, define what proves completion, and know exactly what must happen before payment can move.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
          <Link
            href="/agreements/new"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#176BCE] hover:bg-[#1258b3] text-white font-semibold px-8 py-4 rounded-xl shadow-lg transition-all hover:scale-[1.02]"
          >
            Create an agreement
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/demo"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 border border-white/20 text-white font-semibold px-8 py-4 rounded-xl transition-all"
          >
            Book a 20-minute demo
          </Link>
        </div>
      </div>
    </section>
  );
}
