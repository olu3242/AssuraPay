import { Cpu, UserCheck, ShieldCheck, ArrowRight } from "lucide-react";

export default function AiGovernance() {
  return (
    <section className="py-20 bg-[#F7FAFC]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <span className="text-xs font-semibold tracking-wider text-[#176BCE] uppercase bg-[#EAF6FD] px-3 py-1 rounded-full border border-[#DCE6EF]">
            GOVERNED INTELLIGENCE
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold text-[#071A33] mt-3 mb-4">
            AI helps structure the work. People remain in control.
          </h2>
          <p className="text-[#526273] text-base sm:text-lg">
            AssuraPay utilizes intelligent extraction to accelerate setup, while reserving all authorization strictly for human participants.
          </p>
        </div>

        {/* Workflow Diagram */}
        <div className="max-w-4xl mx-auto bg-white border border-[#DCE6EF] rounded-2xl p-8 sm:p-10 shadow-sm mb-12">
          <div className="grid sm:grid-cols-4 gap-6 text-center">
            <div className="space-y-2 p-4 rounded-xl bg-[#F7FAFC] border border-[#DCE6EF]">
              <div className="w-10 h-10 rounded-xl bg-[#EAF6FD] text-[#176BCE] flex items-center justify-center mx-auto">
                <Cpu className="w-5 h-5" />
              </div>
              <h4 className="font-semibold text-sm text-[#071A33]">AI Recommendation</h4>
              <p className="text-xs text-[#526273]">Extracts terms & outlines milestones</p>
            </div>

            <div className="space-y-2 p-4 rounded-xl bg-[#F7FAFC] border border-[#DCE6EF]">
              <div className="w-10 h-10 rounded-xl bg-[#EAF6FD] text-[#176BCE] flex items-center justify-center mx-auto">
                <UserCheck className="w-5 h-5" />
              </div>
              <h4 className="font-semibold text-sm text-[#071A33]">Human Review</h4>
              <p className="text-xs text-[#526273]">Parties inspect and agree to terms</p>
            </div>

            <div className="space-y-2 p-4 rounded-xl bg-[#F7FAFC] border border-[#DCE6EF]">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <h4 className="font-semibold text-sm text-[#071A33]">Authorized Action</h4>
              <p className="text-xs text-[#526273]">Designated user signs off execution</p>
            </div>

            <div className="space-y-2 p-4 rounded-xl bg-[#F7FAFC] border border-[#DCE6EF]">
              <div className="w-10 h-10 rounded-xl bg-[#071A33] text-[#51B8F2] flex items-center justify-center mx-auto">
                <ArrowRight className="w-5 h-5" />
              </div>
              <h4 className="font-semibold text-sm text-[#071A33]">Recorded Outcome</h4>
              <p className="text-xs text-[#526273]">Auditable activity log updated</p>
            </div>
          </div>
        </div>

        <div className="max-w-3xl mx-auto bg-[#071A33] text-white p-6 rounded-xl border border-white/10 text-center">
          <p className="text-sm text-[#EAF6FD]/90">
            <strong>Important Boundary:</strong> AssuraPay’s AI does not accept agreements, certify completion, resolve disputes or release funds autonomously. Human authorization is mandatory at every critical threshold.
          </p>
        </div>
      </div>
    </section>
  );
}
