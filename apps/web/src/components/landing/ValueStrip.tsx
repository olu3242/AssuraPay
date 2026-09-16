import { CheckCircle2, ShieldCheck, FileCheck, Landmark } from "lucide-react";

export default function ValueStrip() {
  const pillars = [
    {
      icon: FileCheck,
      title: "Clear obligations",
      description: "Transform unstructured deals into verified milestones and crystal-clear terms.",
    },
    {
      icon: ShieldCheck,
      title: "Evidence-backed completion",
      description: "Require verifiable proof of performance before any milestone is marked complete.",
    },
    {
      icon: CheckCircle2,
      title: "Authorized approvals",
      description: "Ensure designated stakeholders formally review and authorize every stage of work.",
    },
    {
      icon: Landmark,
      title: "Traceable payment decisions",
      description: "Route payment instructions securely through connected regulated financial providers.",
    },
  ];

  return (
    <section className="bg-white border-b border-[#DCE6EF] py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
          {pillars.map((pillar, idx) => {
            const Icon = pillar.icon;
            return (
              <div key={idx} className="flex gap-4 items-start">
                <div className="w-10 h-10 rounded-xl bg-[#EAF6FD] text-[#176BCE] flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-[#071A33] mb-1">{pillar.title}</h3>
                  <p className="text-sm text-[#526273] leading-relaxed">{pillar.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
