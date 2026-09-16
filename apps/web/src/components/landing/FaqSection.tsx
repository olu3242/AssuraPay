"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

export default function FaqSection() {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  const faqs = [
    {
      q: "What is AssuraPay?",
      a: "AssuraPay is an execution-assurance platform that connects agreements, milestones, evidence, approvals and conditional payment workflows in one shared workspace.",
    },
    {
      q: "Is AssuraPay a bank or escrow provider?",
      a: "AssuraPay provides the commercial agreement and assurance workflow. Where funding or settlement is supported, regulated financial providers custody and move funds.",
    },
    {
      q: "Can I use an existing contract?",
      a: "Yes. You can upload an existing contract or start with an invoice, proposal, statement of work or a brand new agreement.",
    },
    {
      q: "Does AI approve agreements or release funds?",
      a: "No. AI can organize information, identify gaps and make recommendations. Material acceptance, completion approval and payment authorization remain governed human actions.",
    },
    {
      q: "What happens when delivery is disputed?",
      a: "The relevant milestone can move into a structured exception or dispute process, preserving the agreement, submitted evidence, decisions and activity history.",
    },
    {
      q: "Does AssuraPay support multiple currencies?",
      a: "AssuraPay can represent transaction and settlement currencies and make applicable conversion details visible. Actual currency availability depends on the connected payment provider and market.",
    },
  ];

  return (
    <section className="py-20 bg-[#F7FAFC]">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <span className="text-xs font-semibold tracking-wider text-[#176BCE] uppercase bg-[#EAF6FD] px-3 py-1 rounded-full border border-[#DCE6EF]">
            QUESTIONS & ANSWERS
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold text-[#071A33] mt-3 mb-4">
            Frequently asked questions
          </h2>
          <p className="text-[#526273]">
            Everything you need to know about AssuraPay agreements and conditional payment workflows.
          </p>
        </div>

        <div className="space-y-4">
          {faqs.map((faq, idx) => {
            const isOpen = openIdx === idx;
            return (
              <div
                key={idx}
                className="bg-white border border-[#DCE6EF] rounded-2xl overflow-hidden shadow-sm transition-all"
              >
                <button
                  onClick={() => setOpenIdx(isOpen ? null : idx)}
                  className="w-full flex items-center justify-between p-6 text-left font-semibold text-[#071A33] hover:text-[#176BCE] transition-colors"
                >
                  <span>{faq.q}</span>
                  <ChevronDown className={`w-5 h-5 text-[#526273] transition-transform ${isOpen ? "rotate-180 text-[#176BCE]" : ""}`} />
                </button>
                {isOpen && (
                  <div className="px-6 pb-6 text-sm text-[#526273] leading-relaxed border-t border-[#DCE6EF] pt-4">
                    {faq.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
