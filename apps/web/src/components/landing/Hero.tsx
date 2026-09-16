import Link from "next/link";
import { ArrowRight, CheckCircle2, Shield, FileText, Check } from "lucide-react";

export default function Hero() {
  return (
    <section className="relative pt-12 pb-20 md:pt-20 md:pb-28 overflow-hidden bg-gradient-to-b from-[#071A33] via-[#0B2A4A] to-[#071A33] text-white">
      {/* Subtle background glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[350px] bg-[#176BCE]/20 blur-[120px] rounded-full pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <div className="grid lg:grid-cols-12 gap-12 items-center">
          
          {/* Left Text Column */}
          <div className="lg:col-span-6 space-y-6 text-center lg:text-left">
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#176BCE]/20 border border-[#51B8F2]/30 text-[#51B8F2] text-xs font-semibold tracking-wider uppercase">
              <Shield className="w-3.5 h-3.5" />
              AGREEMENT-TO-PAYMENT ASSURANCE
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.15]">
              Clear agreements. <span className="text-[#51B8F2]">Confident payments.</span>
            </h1>

            <p className="text-lg text-[#EAF6FD]/80 max-w-xl mx-auto lg:mx-0 font-normal leading-relaxed">
              Turn an invoice, proposal, conversation or contract into a protected transaction—with clear milestones, proof of completion and controlled payment release.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-4 pt-2">
              <Link
                href="/agreements/new"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#176BCE] hover:bg-[#1258b3] text-white font-semibold px-7 py-3.5 rounded-xl shadow-lg transition-all hover:scale-[1.02]"
              >
                Create an agreement
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                href="/demo"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 border border-white/20 text-white font-semibold px-7 py-3.5 rounded-xl transition-all"
              >
                Book a demo
              </Link>
            </div>

            <p className="text-xs text-[#EAF6FD]/60 pt-2 flex items-center justify-center lg:justify-start gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-[#51B8F2]" />
              Both parties agree on what must happen before payment becomes eligible for release.
            </p>
          </div>

          {/* Right Product Visual Column */}
          <div className="lg:col-span-6">
            <div className="bg-[#0B2A4A]/80 border border-white/10 rounded-2xl p-5 shadow-2xl backdrop-blur-md relative overflow-hidden">
              {/* Window Header Bar */}
              <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-red-400/80" />
                  <div className="w-3 h-3 rounded-full bg-yellow-400/80" />
                  <div className="w-3 h-3 rounded-full bg-green-400/80" />
                  <span className="text-xs text-white/50 ml-2 font-mono">AssuraPay Agreement Room</span>
                </div>
                <span className="text-[11px] px-2.5 py-1 rounded bg-[#51B8F2]/20 text-[#51B8F2] font-medium">
                  Active Transaction
                </span>
              </div>

              {/* Agreement Metadata */}
              <div className="space-y-4">
                <div className="bg-[#071A33] p-4 rounded-xl border border-white/5">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <span className="text-xs text-[#51B8F2] font-medium uppercase tracking-wider">Project Agreement</span>
                      <h3 className="text-lg font-semibold text-white">Retail Store Renovation</h3>
                    </div>
                    <span className="text-emerald-400 text-sm font-bold bg-emerald-950/50 px-2.5 py-1 rounded-lg border border-emerald-500/20">
                      $48,000 USD
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-white/70 pt-2 border-t border-white/5">
                    <span>Buyer: <strong className="text-white">Apex Retail Ltd.</strong></span>
                    <span>•</span>
                    <span>Provider: <strong className="text-white">Northstar Projects</strong></span>
                  </div>
                </div>

                {/* Progress & Milestone Card */}
                <div className="bg-[#071A33] p-4 rounded-xl border border-white/5 space-y-3">
                  <div className="flex justify-between text-xs font-medium">
                    <span className="text-white/70">Milestone Progress</span>
                    <span className="text-[#51B8F2]">2 of 4 milestones completed</span>
                  </div>
                  <div className="w-full bg-white/10 h-2 rounded-full overflow-hidden">
                    <div className="bg-[#51B8F2] h-full rounded-full w-1/2" />
                  </div>

                  <div className="pt-2 flex items-center justify-between text-xs bg-white/5 p-3 rounded-lg border border-white/5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-6 h-6 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-xs">
                        2
                      </div>
                      <div>
                        <p className="font-medium text-white">Milestone 2 awaiting review</p>
                        <p className="text-[11px] text-white/60">Evidence submitted • Flooring & Framing</p>
                      </div>
                    </div>
                    <span className="text-xs bg-amber-500/20 text-amber-300 px-2 py-1 rounded font-medium">
                      Awaiting Review
                    </span>
                  </div>
                </div>

                {/* Footer status bar */}
                <div className="flex items-center justify-between text-xs text-white/60 pt-1">
                  <span>Funding Assurance: Confirmed</span>
                  <span className="text-[#51B8F2] font-medium">Next: Authorized Approval</span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}
