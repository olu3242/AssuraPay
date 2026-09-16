import { Briefcase, Building2, Package, Globe, Cpu, FileSpreadsheet, Layers, ShieldAlert } from "lucide-react";

export default function TransactionTypes() {
  const types = [
    {
      icon: Briefcase,
      title: "Professional services",
      description: "Define billable milestones and deliverable sign-offs for agency and consulting work.",
    },
    {
      icon: Building2,
      title: "Projects and contractors",
      description: "Manage phased construction, renovation, or technical contracting deliverables.",
    },
    {
      icon: Package,
      title: "Physical goods",
      description: "Govern commercial shipments with shipping and inspection verification criteria.",
    },
    {
      icon: FileSpreadsheet,
      title: "Procurement",
      description: "Structure vendor purchases with strict delivery sign-off conditions.",
    },
    {
      icon: Cpu,
      title: "Digital deliverables",
      description: "Protect software development sprints, design assets, and digital licenses.",
    },
    {
      icon: Layers,
      title: "Retainers and recurring work",
      description: "Establish monthly periodic milestones and performance verification.",
    },
    {
      icon: ShieldAlert,
      title: "Public-sector engagements",
      description: "Maintain transparent compliance records and audit trails for public projects.",
    },
    {
      icon: Globe,
      title: "Cross-border commercial transactions",
      description: "Bridge international trading partners with clear multi-currency conditions.",
    },
  ];

  return (
    <section id="use-cases" className="py-20 bg-[#F7FAFC]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <span className="text-xs font-semibold tracking-wider text-[#176BCE] uppercase bg-[#EAF6FD] px-3 py-1 rounded-full border border-[#DCE6EF]">
            SUPPORTED USE CASES
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold text-[#071A33] mt-3 mb-4">
            Built for work that needs clear delivery and payment conditions.
          </h2>
          <p className="text-[#526273] text-base sm:text-lg">
            Every transaction pattern engineered for operational clarity and trust.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {types.map((item, idx) => {
            const Icon = item.icon;
            return (
              <div
                key={idx}
                className="bg-white border border-[#DCE6EF] rounded-xl p-6 shadow-sm hover:border-[#176BCE] transition-all group"
              >
                <div className="w-10 h-10 rounded-xl bg-[#EAF6FD] text-[#176BCE] flex items-center justify-center mb-4 group-hover:bg-[#176BCE] group-hover:text-white transition-colors">
                  <Icon className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-[#071A33] mb-2">{item.title}</h3>
                <p className="text-xs text-[#526273] leading-relaxed">{item.description}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
