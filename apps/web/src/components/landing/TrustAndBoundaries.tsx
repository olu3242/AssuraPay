import { ShieldCheck, Lock, FileCheck, CheckCircle2 } from "lucide-react";

export default function TrustAndBoundaries() {
  const points = [
    "Material terms require explicit bilateral agreement.",
    "Evidence remains securely connected to the relevant milestone.",
    "Approvals follow defined stakeholder roles and conditions.",
    "Payment instructions require authorized human actions.",
    "Exceptions and disputes remain fully traceable.",
    "Regulated financial institutions custody and move funds where applicable.",
    "Activity history supports operational review and auditability.",
  ];

  return (
    <section id="trust" className="py-20 bg-white border-b border-[#DCE6EF]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <span className="text-xs font-semibold tracking-wider text-[#176BCE] uppercase bg-[#EAF6FD] px-3 py-1 rounded-full border border-[#DCE6EF]">
            TRUST & GOVERNANCE
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold text-[#071A33] mt-3 mb-4">
            Every important action has an owner, reason and record.
          </h2>
          <p className="text-[#526273] text-base sm:text-lg">
            Engineered for strict accountability across every commercial transaction.
          </p>
        </div>

        <div className="max-w-4xl mx-auto bg-[#F7FAFC] border border-[#DCE6EF] rounded-2xl p-8 sm:p-12 shadow-sm grid md:grid-cols-2 gap-6 items-center">
          <div className="space-y-4">
            <div className="w-12 h-12 rounded-xl bg-[#176BCE] text-white flex items-center justify-center">
              <Lock className="w-6 h-6" />
            </div>
            <h3 className="text-2xl font-bold text-[#071A33]">
              Institutional-grade operational accountability
            </h3>
            <p className="text-[#526273] text-sm leading-relaxed">
              AssuraPay ensures complete auditability by linking every milestone deliverable directly to authorized sign-offs and connected financial rails.
            </p>
          </div>

          <div className="space-y-3">
            {points.map((pt, i) => (
              <div key={i} className="flex items-start gap-3 bg-white p-3 rounded-xl border border-[#DCE6EF]">
                <CheckCircle2 className="w-4 h-4 text-[#176BCE] shrink-0 mt-1" />
                <span className="text-xs text-[#526273] font-medium leading-relaxed">{pt}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
