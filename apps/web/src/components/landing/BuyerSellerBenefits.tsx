"use client";

import { useState } from "react";
import { CheckCircle2, ArrowRight } from "lucide-react";
import Link from "next/link";

export default function BuyerSellerBenefits() {
  const [activeTab, setActiveTab] = useState<"buyer" | "seller">("buyer");

  return (
    <section className="py-20 bg-white border-b border-[#DCE6EF]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-12">
          <span className="text-xs font-semibold tracking-wider text-[#176BCE] uppercase bg-[#EAF6FD] px-3 py-1 rounded-full border border-[#DCE6EF]">
            PARTICIPANT ADVANTAGE
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold text-[#071A33] mt-3 mb-4">
            Designed for both sides of the table.
          </h2>
          <p className="text-[#526273] text-base sm:text-lg">
            Complete transparency and protection whether you are purchasing services or delivering work.
          </p>

          {/* Switcher Toggle */}
          <div className="inline-flex bg-[#F7FAFC] border border-[#DCE6EF] p-1.5 rounded-2xl mt-8">
            <button
              onClick={() => setActiveTab("buyer")}
              className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                activeTab === "buyer"
                  ? "bg-[#071A33] text-white shadow-sm"
                  : "text-[#526273] hover:text-[#071A33]"
              }`}
            >
              For Buyers
            </button>
            <button
              onClick={() => setActiveTab("seller")}
              className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                activeTab === "seller"
                  ? "bg-[#071A33] text-white shadow-sm"
                  : "text-[#526273] hover:text-[#071A33]"
              }`}
            >
              For Sellers & Providers
            </button>
          </div>
        </div>

        {/* Content Panel */}
        <div className="max-w-4xl mx-auto bg-[#F7FAFC] border border-[#DCE6EF] rounded-2xl p-8 sm:p-12 shadow-sm">
          {activeTab === "buyer" ? (
            <div className="space-y-6">
              <div>
                <span className="text-xs font-bold text-[#176BCE] uppercase tracking-wider">Buyer Assurance</span>
                <h3 className="text-2xl font-bold text-[#071A33] mt-1">Know what you are approving.</h3>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                {[
                  "Define what successful delivery means before work starts.",
                  "See verifiable evidence before approving milestone completion.",
                  "Understand precisely why payment is held, eligible or released.",
                  "Keep changes and disputes within one traceable process.",
                ].map((text, i) => (
                  <div key={i} className="flex items-start gap-3 bg-white p-4 rounded-xl border border-[#DCE6EF]">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                    <span className="text-sm text-[#526273]">{text}</span>
                  </div>
                ))}
              </div>

              <div className="pt-4">
                <Link
                  href="/agreements/new"
                  className="inline-flex items-center gap-2 bg-[#176BCE] text-white font-semibold px-6 py-3 rounded-xl hover:bg-[#1258b3] transition-colors text-sm shadow-sm"
                >
                  Protect a purchase <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div>
                <span className="text-xs font-bold text-[#176BCE] uppercase tracking-wider">Provider Assurance</span>
                <h3 className="text-2xl font-bold text-[#071A33] mt-1">Prove the work. Protect your path to payment.</h3>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                {[
                  "Start with a clear, mutually accepted scope of deliverables.",
                  "Know exactly what evidence is required to prove performance.",
                  "Track reviews, feedback, and requested changes transparently.",
                  "Maintain a reliable record of completed work and payment status.",
                ].map((text, i) => (
                  <div key={i} className="flex items-start gap-3 bg-white p-4 rounded-xl border border-[#DCE6EF]">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                    <span className="text-sm text-[#526273]">{text}</span>
                  </div>
                ))}
              </div>

              <div className="pt-4">
                <Link
                  href="/agreements/new"
                  className="inline-flex items-center gap-2 bg-[#176BCE] text-white font-semibold px-6 py-3 rounded-xl hover:bg-[#1258b3] transition-colors text-sm shadow-sm"
                >
                  Protect a sale <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
