"use client";

import { useState } from "react";
import Link from "next/link";
import { FileText, Cpu, CheckSquare, ShieldCheck, ArrowRight } from "lucide-react";

export default function AgreementRoomShowcase() {
  const [activeTab, setActiveTab] = useState(0);

  const tabs = [
    {
      id: "material",
      label: "Original material",
      icon: FileText,
      title: "Upload any format: invoice, proposal, SOW or contract",
      description: "Start with whatever you already have. AssuraPay ingests informal messages, PDF quotes, or formal documents instantly.",
      previewContent: {
        type: "Source Document",
        title: "Proposal_Apex_Renovation_v3.pdf",
        details: "Includes scope of work, material estimates, and preliminary payment terms agreed via email exchange.",
        status: "Uploaded & Ready for Extraction"
      }
    },
    {
      id: "structured",
      label: "Structured agreement",
      icon: Cpu,
      title: "Extracted into clear, governed terms",
      description: "AI assists in organizing parties, total amounts, dates, and preliminary milestones while highlighting any missing information.",
      previewContent: {
        type: "Structured Terms",
        title: "Agreement #APX-8842",
        details: "Parties: Apex Ltd & Northstar | Total: $48,000 | 4 Defined Milestones | 0 Unresolved Gaps",
        status: "Agreement Ready for Review"
      }
    },
    {
      id: "execution",
      label: "Milestone execution",
      icon: CheckSquare,
      title: "Track deliverables and completion criteria",
      description: "Both parties share a single workspace to review exact definitions of done, deadlines, and assigned responsibilities.",
      previewContent: {
        type: "Milestone Tracker",
        title: "Milestone 2: Framing & Subfloors",
        details: "Definition of done: Structural inspection passed and photo evidence uploaded. Due: Oct 15.",
        status: "Evidence Submitted"
      }
    },
    {
      id: "eligibility",
      label: "Verification & payment",
      icon: ShieldCheck,
      title: "Authorized approval unlocks payment eligibility",
      description: "Once evidence is verified and approved, payment instructions safely progress to connected financial providers.",
      previewContent: {
        type: "Payment Status",
        title: "Milestone 2 Release Authorization",
        details: "Approved by Alex Morgan (Apex Ltd). Payment instruction routed to regulated partner.",
        status: "Eligible for Release"
      }
    }
  ];

  return (
    <section id="product" className="py-20 bg-[#F7FAFC]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-14">
          <span className="text-xs font-semibold tracking-wider text-[#176BCE] uppercase bg-[#EAF6FD] px-3 py-1 rounded-full border border-[#DCE6EF]">
            THE AGREEMENT ROOM
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold text-[#071A33] mt-3 mb-4">
            Watch a deal become an executable agreement.
          </h2>
          <p className="text-[#526273] text-base sm:text-lg">
            AssuraPay brings the agreement, milestones, evidence, approvals, payment status and activity history into one shared workspace.
          </p>
        </div>

        {/* Tab Navigation */}
        <div className="flex flex-wrap justify-center gap-2 mb-8">
          {tabs.map((tab, idx) => {
            const Icon = tab.icon;
            const isActive = activeTab === idx;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(idx)}
                className={`flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold transition-all ${
                  isActive
                    ? "bg-[#071A33] text-white shadow-md"
                    : "bg-white text-[#526273] hover:bg-[#EAF6FD] border border-[#DCE6EF]"
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? "text-[#51B8F2]" : "text-[#176BCE]"}`} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Active Tab Panel Card */}
        <div className="bg-white border border-[#DCE6EF] rounded-2xl p-6 sm:p-10 shadow-sm max-w-5xl mx-auto grid md:grid-cols-12 gap-8 items-center">
          <div className="md:col-span-6 space-y-4">
            <span className="text-xs font-bold uppercase tracking-wider text-[#176BCE]">
              Step 0{activeTab + 1} Workflow View
            </span>
            <h3 className="text-2xl font-bold text-[#071A33]">
              {tabs[activeTab].title}
            </h3>
            <p className="text-[#526273] leading-relaxed">
              {tabs[activeTab].description}
            </p>
            <div className="pt-2">
              <Link
                href="/agreements/new"
                className="inline-flex items-center gap-2 text-sm font-semibold text-[#176BCE] hover:text-[#0B2A4A]"
              >
                Explore agreement workspace <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>

          <div className="md:col-span-6 bg-[#071A33] text-white p-6 rounded-xl border border-white/10 shadow-inner space-y-4">
            <div className="flex justify-between items-center pb-3 border-b border-white/10">
              <span className="text-xs text-[#51B8F2] font-mono uppercase">{tabs[activeTab].previewContent.type}</span>
              <span className="text-xs bg-[#176BCE]/30 text-[#51B8F2] px-2.5 py-1 rounded font-medium">
                {tabs[activeTab].previewContent.status}
              </span>
            </div>
            <div className="space-y-2">
              <h4 className="font-semibold text-lg">{tabs[activeTab].previewContent.title}</h4>
              <p className="text-xs text-white/70 leading-relaxed bg-white/5 p-3 rounded-lg border border-white/5">
                {tabs[activeTab].previewContent.details}
              </p>
            </div>
            <div className="pt-2 flex items-center justify-between text-[11px] text-white/50">
              <span>Secure workspace session active</span>
              <span className="text-emerald-400 font-medium">● Verified Record</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
